package assetfs

// IndexFileName is the virtual name of the grammar metadata index inside a
// bundle grammars directory. On disk it is stored as IndexFileName + ".gz".
// "index" is therefore a reserved grammar name; devtool sync fails if
// upstream ever ships a grammar with this name, and the registry fallback
// scan skips it. The name must not start with "_" or "." because go:embed
// directory patterns exclude such files.
const IndexFileName = "index.json"

// IndexVersion is the current index schema version. Readers fall back to a
// directory scan when they encounter an unsupported version.
const IndexVersion = 1

// Index is the generated grammar metadata index. It carries exactly the
// fields the registry needs to build its lookup tables at construction
// time, so no grammar file has to be read until a language is requested.
type Index struct {
	Version  int                    `json:"version"`
	Grammars map[string]GrammarMeta `json:"grammars"`
}

// GrammarMeta mirrors the metadata probe the registry extracts from each
// grammar JSON when no index is present.
type GrammarMeta struct {
	ScopeName      string   `json:"scopeName,omitempty"`
	FileTypes      []string `json:"fileTypes,omitempty"`
	InjectTo       []string `json:"injectTo,omitempty"`
	FirstLineMatch string   `json:"firstLineMatch,omitempty"`
}
