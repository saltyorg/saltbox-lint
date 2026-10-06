package lint

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// junction creates the same mount-point reparse tag as Node's "junction"
// fixture. Unlike a symbolic link, this requires no developer-mode privilege.
func junction(t *testing.T, name, target string) {
	t.Helper()
	if err := os.MkdirAll(name, 0o755); err != nil {
		t.Fatal(err)
	}
	path, err := windows.UTF16PtrFromString(name)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(path, windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = windows.CloseHandle(handle) }()
	substitute, err := windows.UTF16FromString(`\??\` + target)
	if err != nil {
		t.Fatal(err)
	}
	printName, err := windows.UTF16FromString(target)
	if err != nil {
		t.Fatal(err)
	}
	data := make([]byte, 16+2*(len(substitute)+len(printName)))
	binary.LittleEndian.PutUint32(data, windows.IO_REPARSE_TAG_MOUNT_POINT)
	binary.LittleEndian.PutUint16(data[4:], uint16(len(data)-8))
	binary.LittleEndian.PutUint16(data[10:], uint16(2*(len(substitute)-1)))
	binary.LittleEndian.PutUint16(data[12:], uint16(2*len(substitute)))
	binary.LittleEndian.PutUint16(data[14:], uint16(2*(len(printName)-1)))
	for i, character := range append(substitute, printName...) {
		binary.LittleEndian.PutUint16(data[16+2*i:], character)
	}
	var returned uint32
	if err := windows.DeviceIoControl(handle, windows.FSCTL_SET_REPARSE_POINT, &data[0], uint32(len(data)), nil, 0, &returned, nil); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsJunctionReferenceContext(t *testing.T) {
	root := t.TempDir()
	text := "# 😀é\r\n- debug: {msg: \"😀 {{ lookup('role_var', '_port', role='navtarget') }}\"}\r\n"
	filename := putFile(t, root, "roles/navsource/tasks/main.yml", text)
	putFile(t, root, "roles/navtarget/defaults/main.yml", "navtarget_role_port: 1234\nnavtarget_name: navalias\nnavalias_port: 4321\n")
	putFile(t, root, "roles/navtarget/vars/main.yml", "navtarget_role_port: 5678\n")
	putFile(t, root, "roles/readonly-directory/tasks/config.yaml", "{{ value }}")
	alias := filepath.Join(root, "roles/readonly-directory/templates")
	junction(t, alias, filepath.Join(root, "roles/readonly-directory/tasks"))

	result, err := Query(t.Context(), QueryRequest{Root: root, Filename: filename, Source: []byte(text), Operation: "definition", Offset: strings.Index(text, "_port") + 2})
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "ambiguous" || len(result.Locations) != 3 {
		t.Fatalf("junction context lost declaration layers: %+v", result)
	}
	for _, path := range []string{"roles/navtarget/defaults/main.yml", "roles/navtarget/vars/main.yml"} {
		if _, found := result.TargetHashes[path]; !found {
			t.Fatalf("missing declaration target %s", path)
		}
	}
	if got, err := os.ReadFile(filename); err != nil || string(got) != text {
		t.Fatal("query changed source bytes")
	}
}

func TestWindowsJunctionTemplateSelectionRemainsReadOnly(t *testing.T) {
	root := t.TempDir()
	text := " \t😀\r\n{% raw -%}{{ {% unmatched{%- endraw %}\r\n{{ lookup('role_var', '_port', role='navtarget') }}  "
	for _, basename := range []string{"config", "config.yaml", "config.j2"} {
		putFile(t, root, "roles/demo/tasks/"+basename, text)
	}
	alias := filepath.Join(root, "roles/demo/templates")
	junction(t, alias, filepath.Join(root, "roles/demo/tasks"))
	for _, basename := range []string{"config", "config.yaml", "config.j2"} {
		filename := filepath.Join(root, "roles/demo/tasks", basename)
		spelling := filepath.Join(alias, basename)
		for _, opts := range []Options{
			{Root: root, Paths: []string{spelling}},
			{Root: root, StdinFilename: spelling, Stdin: []byte(text)},
			{Root: root, StdinFilename: filename, StdinSourceFilename: spelling, Stdin: []byte(text)},
		} {
			p, err := Load(t.Context(), opts)
			if err != nil {
				t.Fatal(err)
			}
			source := p.Sources["roles/demo/tasks/"+basename]
			if source == nil || source.Kind != Template || string(source.Data) != text || RequireWritableSelection(p) == nil {
				t.Fatalf("junction spelling lost template capability: %+v", source)
			}
			for _, diagnostic := range Analyze(p, Rules()) {
				if diagnostic.Fix != nil || diagnostic.RuleID == "jinja-layout" {
					t.Fatalf("junction template acquired writable policy: %+v", diagnostic)
				}
			}
			if got, err := os.ReadFile(filename); err != nil || string(got) != text {
				t.Fatal("junction template bytes changed")
			}
		}
	}
}

func TestWindowsJunctionEscapedContextIsRefused(t *testing.T) {
	root := t.TempDir()
	filename := putFile(t, root, "roles/demo/tasks/main.yml", "- debug: {msg: value}\n")
	outside := t.TempDir()
	putFile(t, outside, "config.yaml", "private: value\n")
	alias := filepath.Join(root, "roles/demo/templates")
	junction(t, alias, outside)
	if _, err := Load(t.Context(), Options{Root: root, Paths: []string{filename}, referenceContext: true}); !errors.Is(err, errOutsideRoot) {
		t.Fatalf("escaped junction context admitted: %v", err)
	}
	for _, name := range []string{"config.yaml", "missing.yaml"} {
		if _, err := ownedSourcePath(root, filepath.Join(alias, name)); !errors.Is(err, errOutsideRoot) {
			t.Fatalf("escaped junction %s admitted: %v", name, err)
		}
	}
}

func TestWindowsJunctionRootAndSelectionOwnership(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "project")
	filename := putFile(t, root, "roles/demo/tasks/main.yml", "- debug: {msg: value}\n")
	alias := filepath.Join(base, "project-alias")
	junction(t, alias, root)
	p, err := Load(t.Context(), Options{Root: alias, Paths: []string{filepath.Join(alias, "roles/demo/tasks/main.yml")}})
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := resolveSourcePath(root)
	if err != nil || p.Root != canonical || !p.Selected["roles/demo/tasks/main.yml"] {
		t.Fatalf("junction root did not establish canonical ownership: %s %v", p.Root, err)
	}
	if err := RequireWritableSelection(p); err != nil {
		t.Fatalf("ordinary YAML under an admitted junction root became read-only: %v", err)
	}
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(base, "other")
	putFile(t, other, "roles/demo/tasks/main.yml", "- debug: {msg: changed}\n")
	junction(t, alias, other)
	if err := RequireWritableSelection(p); err == nil {
		t.Fatal("retargeted junction spelling retained write authority")
	}
	if got, err := os.ReadFile(filename); err != nil || string(got) != "- debug: {msg: value}\n" {
		t.Fatal("ownership preflight changed source bytes")
	}
}

func TestWindowsDanglingJunctionCannotOwnSourceBuffer(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "owner")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "alias.j2")
	junction(t, alias, target)
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	text := []byte("{{ value }}")
	if _, err := Load(t.Context(), Options{Root: root, StdinFilename: alias, Stdin: text}); err == nil {
		t.Fatal("dangling junction fabricated a source buffer owner")
	}
	p, err := Load(t.Context(), Options{Root: root, StdinFilename: filepath.Join(root, "new.j2"), Stdin: text})
	if err != nil || p.Sources["new.j2"] == nil || p.Sources["new.j2"].Kind != Template {
		t.Fatalf("absent template lost logical buffer identity: %v", err)
	}
}
