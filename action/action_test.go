package action_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func shell(t *testing.T, script string, env map[string]string) (string, int) {
	t.Helper()
	path, err := filepath.Abs(script)
	if err != nil {
		t.Fatal(err)
	}
	c := exec.CommandContext(t.Context(), "bash", path)
	c.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + t.TempDir()}
	for k, v := range env {
		c.Env = append(c.Env, k+"="+v)
	}
	out, err := c.CombinedOutput()
	if err == nil {
		return string(out), 0
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return string(out), ee.ExitCode()
	}
	t.Fatal(err)
	return "", -1
}

func archive(t *testing.T, binary []byte) []byte {
	t.Helper()
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "saltbox-lint", Mode: 0o755, Size: int64(len(binary))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(binary); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestInstallValidatesReleaseAndDownload(t *testing.T) {
	binary := []byte("#!/usr/bin/env bash\nprintf 'saltbox-lint version 1.2.3\\n'\n")
	good := archive(t, binary)
	tests := []struct {
		name, version, os, arch, damage string
		want                            int
	}{
		{"amd64", "v1.2.3", "Linux", "X64", "", 0},
		{"arm64", "v1.2.3", "Linux", "ARM64", "", 0},
		{"missing version", "", "Linux", "X64", "", 2},
		{"latest", "latest", "Linux", "X64", "", 2},
		{"partial version", "v1.2", "Linux", "X64", "", 2},
		{"bare version", "1.2.3", "Linux", "X64", "", 2},
		{"leading zero", "v01.2.3", "Linux", "X64", "", 2},
		{"version injection", "v1.2.3; touch injected", "Linux", "X64", "", 2},
		{"windows", "v1.2.3", "Windows", "X64", "", 2},
		{"unsupported cpu", "v1.2.3", "Linux", "X86", "", 2},
		{"corrupt archive", "v1.2.3", "Linux", "X64", "corrupt", 2},
		{"missing checksum", "v1.2.3", "Linux", "X64", "missing", 2},
		{"suffix match is insufficient", "v1.2.3", "Linux", "X64", "suffix", 2},
		{"duplicate checksum", "v1.2.3", "Linux", "X64", "duplicate", 2},
		{"invalid checksum", "v1.2.3", "Linux", "X64", "invalid", 2},
		{"HTTP failure", "v1.2.3", "Linux", "X64", "404", 2},
		{"malformed archive with matching checksum", "v1.2.3", "Linux", "X64", "gzip", 2},
		{"wrong binary version", "v1.2.3", "Linux", "X64", "version", 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data := good
			if tt.damage == "version" {
				data = archive(t, []byte("#!/usr/bin/env bash\nprintf 'saltbox-lint version 1.2.4\\n'\n"))
			}
			if tt.damage == "gzip" {
				data = []byte("not gzip")
			}
			arch := "amd64"
			if tt.arch == "ARM64" {
				arch = "arm64"
			}
			name := "saltbox-lint_1.2.3_linux_" + arch + ".tar.gz"
			checksum := fmt.Sprintf("%x  %s\n", sha256.Sum256(data), name)
			switch tt.damage {
			case "corrupt":
				data = []byte("damaged")
			case "missing":
				checksum = ""
			case "suffix":
				checksum = strings.ReplaceAll(checksum, name, "prefix-"+name)
			case "duplicate":
				checksum += checksum
			case "invalid":
				checksum = "not-a-checksum  " + name + "\n"
			}
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if tt.damage == "404" {
					http.NotFound(w, r)
					return
				}
				switch r.URL.Path {
				case "/v1.2.3/" + name:
					_, _ = w.Write(data)
				case "/v1.2.3/checksums.txt":
					_, _ = w.Write([]byte(checksum))
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			temp := filepath.Join(t.TempDir(), "runner temp")
			if err := os.MkdirAll(temp, 0o755); err != nil {
				t.Fatal(err)
			}
			output := filepath.Join(temp, "output")
			out, code := shell(t, "install.sh", map[string]string{"INPUT_VERSION": tt.version, "RUNNER_OS": tt.os, "RUNNER_ARCH": tt.arch, "RUNNER_TEMP": temp, "GITHUB_OUTPUT": output, "SALTBOX_LINT_DOWNLOAD_BASE_URL": server.URL})
			if code != tt.want {
				t.Fatalf("exit %d, want %d: %s", code, tt.want, out)
			}
			got, _ := os.ReadFile(output)
			if code == 0 {
				path := strings.TrimSuffix(strings.TrimPrefix(string(got), "binary="), "\n")
				actual, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(actual, binary) {
					t.Fatal("installed different bytes")
				}
				if !strings.HasPrefix(path, temp+string(filepath.Separator)) {
					t.Fatalf("installed outside runner temp: %s", path)
				}
			} else if len(got) != 0 {
				t.Fatalf("failed install exposed output: %s", got)
			}
			if tt.damage == "" && tt.want != 0 && requests.Load() != 0 {
				t.Fatalf("invalid input made %d downloads", requests.Load())
			}
		})
	}
}

func buildBinary(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "saltbox-lint")
	c := exec.CommandContext(t.Context(), "go", "build", "-ldflags", "-X main.version=1.2.3", "-o", path, "..")
	if out, err := c.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	return path
}

func TestRunPathsAreDataAndStatusesArePreserved(t *testing.T) {
	binary := buildBinary(t)
	workspace := t.TempDir()
	root := filepath.Join(workspace, "sandbox with spaces")
	writeFile(t, filepath.Join(root, "sandbox.yml"), []byte("[]\n"))
	for _, name := range []string{"inventory.yml", "good file.yml", "second.yml", "--report.yml", "$(touch injected).yml", "`touch injected`.yml", "semi; touch injected.yml"} {
		writeFile(t, filepath.Join(root, name), []byte("v: true\n"))
	}
	for _, name := range []string{"--fix", "--format=json"} {
		writeFile(t, filepath.Join(root, name, "inventory.yml"), []byte("v: true\n"))
	}
	// A real fixable finding proves inputs cannot opt in to writes.
	original, err := os.ReadFile("../examples.yaml")
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(root, "finding.yml"), original)
	tests := []struct {
		name, wd, paths string
		want            int
		contains        string
	}{
		{"default directory", "sandbox with spaces", ".", 0, ""},
		{"empty input", "sandbox with spaces", "", 0, ""},
		{"multiple paths and spaces", "sandbox with spaces", "good file.yml\nsecond.yml\n", 0, ""},
		{"CRLF", "sandbox with spaces", "good file.yml\r\nsecond.yml\r\n", 0, ""},
		{"shell metacharacters", "sandbox with spaces", "$(touch injected).yml\n`touch injected`.yml\nsemi; touch injected.yml", 0, ""},
		{"leading options are paths", "sandbox with spaces", "--fix\n--format=json", 2, "no supported sources selected"},
		{"leading filename", "sandbox with spaces", "--report.yml", 0, ""},
		{"missing file", "sandbox with spaces", "missing.yml", 2, ""},
		{"missing working directory", "missing", ".", 2, ""},
		{"findings and no implicit fix", "sandbox with spaces", "finding.yml\n--fix", 1, "::error file=sandbox with spaces/finding.yml"},
		{"path cannot change format", "sandbox with spaces", "finding.yml\n--format=json", 1, "::error file=sandbox with spaces/finding.yml"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			summary := filepath.Join(t.TempDir(), "summary")
			out, code := shell(t, "run.sh", map[string]string{"SALTBOX_LINT_BINARY": binary, "GITHUB_WORKSPACE": workspace, "GITHUB_STEP_SUMMARY": summary, "INPUT_WORKING_DIRECTORY": tt.wd, "INPUT_PATHS": tt.paths})
			if code != tt.want || !strings.Contains(out, tt.contains) {
				t.Fatalf("exit=%d want=%d out=%s", code, tt.want, out)
			}
			if code < 2 {
				data, err := os.ReadFile(summary)
				if err != nil || !bytes.Contains(data, []byte("Saltbox Lint")) {
					t.Fatalf("summary: %q %v", data, err)
				}
			}
		})
	}
	if _, err := os.Stat(filepath.Join(root, "injected")); !os.IsNotExist(err) {
		t.Fatal("path text was evaluated")
	}
	after, err := os.ReadFile(filepath.Join(root, "finding.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(after, original) {
		t.Fatal("path input enabled fixes")
	}
}

func TestInstallAndRunActualBinary(t *testing.T) {
	binary, err := os.ReadFile(buildBinary(t))
	if err != nil {
		t.Fatal(err)
	}
	data := archive(t, binary)
	const name = "saltbox-lint_1.2.3_linux_amd64.tar.gz"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.2.3/" + name:
			_, _ = w.Write(data)
		case "/v1.2.3/checksums.txt":
			_, _ = fmt.Fprintf(w, "%x  %s\n", sha256.Sum256(data), name)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	temp := t.TempDir()
	output := filepath.Join(temp, "output")
	out, code := shell(t, "install.sh", map[string]string{"INPUT_VERSION": "v1.2.3", "RUNNER_OS": "Linux", "RUNNER_ARCH": "X64", "RUNNER_TEMP": temp, "GITHUB_OUTPUT": output, "SALTBOX_LINT_DOWNLOAD_BASE_URL": server.URL})
	if code != 0 {
		t.Fatalf("install exit %d: %s", code, out)
	}
	installed, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	path := strings.TrimSuffix(strings.TrimPrefix(string(installed), "binary="), "\n")
	workspace := t.TempDir()
	original, err := os.ReadFile("../examples.yaml")
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(workspace, "sandbox", "inventory.yml"), original)
	out, code = shell(t, "run.sh", map[string]string{"SALTBOX_LINT_BINARY": path, "GITHUB_WORKSPACE": workspace, "INPUT_WORKING_DIRECTORY": "sandbox", "INPUT_PATHS": "inventory.yml"})
	if code != 1 || !strings.Contains(out, "::error file=sandbox/inventory.yml") {
		t.Fatalf("installed binary check exit %d: %s", code, out)
	}
}

func TestRunLaunchFailuresAreOperational(t *testing.T) {
	for _, name := range []string{"missing", "non-executable", "missing interpreter"} {
		t.Run(name, func(t *testing.T) {
			workspace := t.TempDir()
			binary := filepath.Join(workspace, "saltbox-lint")
			if name != "missing" {
				writeFile(t, binary, []byte("#!/missing/interpreter\n"))
				if name == "missing interpreter" {
					if err := os.Chmod(binary, 0o755); err != nil {
						t.Fatal(err)
					}
				}
			}
			out, code := shell(t, "run.sh", map[string]string{"SALTBOX_LINT_BINARY": binary, "GITHUB_WORKSPACE": workspace})
			if code != 2 || !strings.Contains(out, "unable to start check") {
				t.Fatalf("exit=%d want=2 output=%s", code, out)
			}
		})
	}
}
