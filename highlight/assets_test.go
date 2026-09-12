package highlight

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"
)

func TestEmbeddedAssetIntegrity(t *testing.T) {
	source, err := fs.Sub(assets, "assets")
	if err != nil {
		t.Fatal(err)
	}
	if err := validateAssetManifest(source); err != nil {
		t.Fatal(err)
	}
}

func TestAssetManifestDetectsChangedAndMissingFiles(t *testing.T) {
	const manifest = `{"themes/example.json":"770e607624d689265ca6c44884d0807d9b054d23c473c106c72be9de08b7376c"}`
	for _, test := range []struct {
		name string
		data []byte
	}{{"changed", []byte("bad")}, {"missing", nil}} {
		t.Run(test.name, func(t *testing.T) {
			source := fstest.MapFS{"SHA256SUMS.json": &fstest.MapFile{Data: []byte(manifest)}}
			if test.data != nil {
				source["themes/example.json"] = &fstest.MapFile{Data: test.data}
			}
			err := validateAssetManifest(source)
			if err == nil || !strings.Contains(err.Error(), "themes/example.json") {
				t.Fatalf("error %v should identify asset", err)
			}
		})
	}
}

// validateAssetManifest runs only in offline Go tests; no runtime I/O is added.
func validateAssetManifest(source fs.FS) error {
	data, err := fs.ReadFile(source, "SHA256SUMS.json")
	if err != nil {
		return err
	}
	var hashes map[string]string
	if err := json.Unmarshal(data, &hashes); err != nil {
		return fmt.Errorf("SHA256SUMS.json: %w", err)
	}
	if len(hashes) == 0 {
		return fmt.Errorf("SHA256SUMS.json: empty manifest")
	}
	for name, want := range hashes {
		data, err := fs.ReadFile(source, name)
		if err != nil {
			return err
		}
		if got := fmt.Sprintf("%x", sha256.Sum256(data)); got != want {
			return fmt.Errorf("%s: SHA256 %s, want %s", name, got, want)
		}
	}
	return fs.WalkDir(source, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() && name != "SHA256SUMS.json" && hashes[name] == "" {
			return fmt.Errorf("%s: missing from SHA256SUMS.json", name)
		}
		return nil
	})
}
