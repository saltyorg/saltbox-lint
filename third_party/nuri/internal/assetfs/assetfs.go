// Package assetfs provides a filesystem wrapper that transparently
// decompresses gzip stored assets. Bundle packages store grammar and theme
// JSON as <name>.json.gz to keep consumer binaries small; this wrapper
// presents each such file under its virtual <name>.json name so the rest
// of the codebase reads plain JSON paths unchanged.
package assetfs

import (
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"io/fs"
	"path"
	"sort"
	"strings"
	"time"
)

// New wraps base so that any file stored as <path>.gz is also readable at
// <path> with transparent gzip decompression. Plain files pass through
// unchanged; when both <path> and <path>.gz exist, the plain file wins.
// Decompression happens eagerly and per call, with no caching: callers
// (registry, theme store) cache parsed results, so raw bytes are read once.
func New(base fs.FS) fs.FS {
	return &assetFS{base: base}
}

type assetFS struct {
	base fs.FS
}

var _ fs.FS = (*assetFS)(nil)
var _ fs.ReadFileFS = (*assetFS)(nil)
var _ fs.ReadDirFS = (*assetFS)(nil)
var _ fs.SubFS = (*assetFS)(nil)

// Open opens the named file. If the name does not exist but name+".gz"
// does, the compressed file is decompressed fully into memory and returned
// as a virtual file reporting the requested name and the decompressed size.
// Corrupt compressed data surfaces here as a *fs.PathError for the
// requested name. Directories are wrapped so their listings show virtual
// names consistent with ReadDir.
func (f *assetFS) Open(name string) (fs.File, error) {
	file, err := f.base.Open(name)
	if err == nil {
		info, statErr := file.Stat()
		if statErr == nil && info.IsDir() {
			return &dirFile{File: file, fsys: f, name: name}, nil
		}
		return file, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}

	gzFile, gzErr := f.base.Open(name + ".gz")
	if gzErr != nil {
		// Keep the original error so the caller sees the requested name.
		return nil, err
	}
	defer gzFile.Close()

	var modTime time.Time
	if info, statErr := gzFile.Stat(); statErr == nil {
		modTime = info.ModTime()
	}
	data, decErr := gunzip(gzFile)
	if decErr != nil {
		return nil, &fs.PathError{Op: "open", Path: name, Err: decErr}
	}
	return &memFile{
		reader: *bytes.NewReader(data),
		info: memFileInfo{
			name:    path.Base(name),
			size:    int64(len(data)),
			modTime: modTime,
		},
	}, nil
}

// ReadFile returns the contents of the named file, decompressing a stored
// name+".gz" twin when the plain name is absent.
func (f *assetFS) ReadFile(name string) ([]byte, error) {
	data, err := fs.ReadFile(f.base, name)
	if err == nil || !errors.Is(err, fs.ErrNotExist) {
		return data, err
	}
	gzData, gzErr := fs.ReadFile(f.base, name+".gz")
	if gzErr != nil {
		return nil, err
	}
	out, decErr := gunzip(bytes.NewReader(gzData))
	if decErr != nil {
		return nil, &fs.PathError{Op: "open", Path: name, Err: decErr}
	}
	return out, nil
}

// ReadDir lists the directory with compressed entries renamed to their
// virtual names (the ".gz" suffix trimmed). When a plain twin exists in the
// same listing the compressed entry is skipped. Entries are re sorted by
// name because renaming can perturb the underlying sorted order.
func (f *assetFS) ReadDir(dir string) ([]fs.DirEntry, error) {
	entries, err := fs.ReadDir(f.base, dir)
	if err != nil {
		return nil, err
	}

	plain := make(map[string]bool, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			plain[e.Name()] = true
		}
	}

	out := make([]fs.DirEntry, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".gz") && len(e.Name()) > len(".gz") {
			virtual := strings.TrimSuffix(e.Name(), ".gz")
			if plain[virtual] {
				continue
			}
			out = append(out, &virtualDirEntry{fsys: f, dir: dir, name: virtual, raw: e})
			continue
		}
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name() < out[j].Name() })
	return out, nil
}

// Sub returns the wrapped filesystem rooted at dir. Wrapping the sub
// filesystem (rather than letting fs.Sub wrap this one generically)
// keeps ReadFile and ReadDir on their direct fast paths.
func (f *assetFS) Sub(dir string) (fs.FS, error) {
	if dir == "." {
		return f, nil
	}
	sub, err := fs.Sub(f.base, dir)
	if err != nil {
		return nil, err
	}
	return &assetFS{base: sub}, nil
}

func gunzip(r io.Reader) ([]byte, error) {
	zr, err := gzip.NewReader(r)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(zr)
	if err != nil {
		return nil, err
	}
	if err := zr.Close(); err != nil {
		return nil, err
	}
	return data, nil
}

// memFile is a decompressed in memory file.
type memFile struct {
	reader bytes.Reader
	info   memFileInfo
}

func (f *memFile) Stat() (fs.FileInfo, error) { return &f.info, nil }
func (f *memFile) Read(p []byte) (int, error) { return f.reader.Read(p) }
func (f *memFile) Close() error               { return nil }

type memFileInfo struct {
	name    string
	size    int64
	modTime time.Time
}

func (i *memFileInfo) Name() string       { return i.name }
func (i *memFileInfo) Size() int64        { return i.size }
func (i *memFileInfo) Mode() fs.FileMode  { return 0o444 }
func (i *memFileInfo) ModTime() time.Time { return i.modTime }
func (i *memFileInfo) IsDir() bool        { return false }
func (i *memFileInfo) Sys() any           { return nil }

// virtualDirEntry presents a compressed file under its virtual name.
// Info decompresses the file to report the accurate decompressed size;
// nothing on a hot path calls Info, only filesystem conformance checks.
type virtualDirEntry struct {
	fsys *assetFS
	dir  string
	name string
	raw  fs.DirEntry
}

func (d *virtualDirEntry) Name() string      { return d.name }
func (d *virtualDirEntry) IsDir() bool       { return false }
func (d *virtualDirEntry) Type() fs.FileMode { return d.raw.Type() }

func (d *virtualDirEntry) Info() (fs.FileInfo, error) {
	file, err := d.fsys.Open(path.Join(d.dir, d.name))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return file.Stat()
}

// dirFile wraps an opened directory so that reading entries through it
// agrees with ReadDir on virtual names.
type dirFile struct {
	fs.File
	fsys    *assetFS
	name    string
	entries []fs.DirEntry
	loaded  bool
	offset  int
}

var _ fs.ReadDirFile = (*dirFile)(nil)

func (d *dirFile) ReadDir(n int) ([]fs.DirEntry, error) {
	if !d.loaded {
		entries, err := d.fsys.ReadDir(d.name)
		if err != nil {
			return nil, err
		}
		d.entries = entries
		d.loaded = true
	}
	if n <= 0 {
		rest := d.entries[d.offset:]
		d.offset = len(d.entries)
		return rest, nil
	}
	if d.offset >= len(d.entries) {
		return nil, io.EOF
	}
	end := min(d.offset+n, len(d.entries))
	out := d.entries[d.offset:end]
	d.offset = end
	return out, nil
}
