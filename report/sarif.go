package report

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"path/filepath"
	"slices"
	"strings"

	"github.com/saltyorg/saltbox-lint/lint"
)

const sarifSchema = "https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json"
const sarifSourceRoot = "%SRCROOT%"
const sarifFingerprintVersion = "saltboxLintContext/v1"
const toolURL = "https://github.com/saltyorg/saltbox-lint"

type sarifMessage struct {
	Text string `json:"text"`
}
type sarifRule struct {
	ID               string       `json:"id"`
	ShortDescription sarifMessage `json:"shortDescription"`
	FullDescription  sarifMessage `json:"fullDescription"`
	Help             sarifMessage `json:"help"`
	HelpURI          string       `json:"helpUri"`
}
type sarifDriver struct {
	Name           string      `json:"name"`
	Version        string      `json:"version"`
	InformationURI string      `json:"informationUri"`
	Rules          []sarifRule `json:"rules"`
}
type sarifArtifact struct {
	URI       string `json:"uri"`
	URIBaseID string `json:"uriBaseId,omitempty"`
}
type sarifRegion struct {
	StartLine   int `json:"startLine"`
	StartColumn int `json:"startColumn"`
	EndLine     int `json:"endLine"`
	EndColumn   int `json:"endColumn"`
}
type sarifPhysical struct {
	ArtifactLocation sarifArtifact `json:"artifactLocation"`
	Region           sarifRegion   `json:"region"`
}
type sarifLocation struct {
	ID               int           `json:"id,omitempty"`
	PhysicalLocation sarifPhysical `json:"physicalLocation"`
	Message          *sarifMessage `json:"message,omitempty"`
}
type sarifResult struct {
	RuleID              string            `json:"ruleId"`
	RuleIndex           int               `json:"ruleIndex"`
	Level               string            `json:"level"`
	Message             sarifMessage      `json:"message"`
	Locations           []sarifLocation   `json:"locations"`
	RelatedLocations    []sarifLocation   `json:"relatedLocations,omitempty"`
	PartialFingerprints map[string]string `json:"partialFingerprints"`
}
type sarifRun struct {
	Tool struct {
		Driver sarifDriver `json:"driver"`
	} `json:"tool"`
	ColumnKind         string                   `json:"columnKind"`
	OriginalURIBaseIDs map[string]sarifArtifact `json:"originalUriBaseIds"`
	Invocations        []sarifInvocation        `json:"invocations"`
	Results            []sarifResult            `json:"results"`
}
type sarifInvocation struct {
	WorkingDirectory    sarifArtifact `json:"workingDirectory"`
	ExecutionSuccessful bool          `json:"executionSuccessful"`
}
type sarifLog struct {
	Schema  string     `json:"$schema"`
	Version string     `json:"version"`
	Runs    []sarifRun `json:"runs"`
}

func sarifReport(w io.Writer, p *lint.Project, ds []Diagnostic, version string) error {
	root, err := filepath.Abs(p.Root)
	if err != nil {
		return fmt.Errorf("SARIF source root: %w", err)
	}
	rootPath := filepath.ToSlash(root)
	if !strings.HasPrefix(rootPath, "/") {
		rootPath = "/" + rootPath
	}
	base := sarifArtifact{URI: (&url.URL{Scheme: "file", Path: strings.TrimRight(rootPath, "/") + "/"}).String()}
	if version == "" {
		version = "dev"
	}
	run := sarifRun{ColumnKind: "utf16CodeUnits", OriginalURIBaseIDs: map[string]sarifArtifact{sarifSourceRoot: base}, Invocations: []sarifInvocation{{WorkingDirectory: base, ExecutionSuccessful: true}}, Results: []sarifResult{}}
	rules := sarifRules(ds)
	run.Tool.Driver = sarifDriver{Name: "saltbox-lint", Version: version, InformationURI: toolURL, Rules: rules}
	indices := map[string]int{}
	for i, rule := range rules {
		indices[rule.ID] = i
	}
	for _, d := range ds {
		message := d.Message
		if d.Expected != "" {
			message += "\n" + d.Expected
		}
		result := sarifResult{RuleID: d.RuleID, RuleIndex: indices[d.RuleID], Level: d.Severity, Message: sarifMessage{message}, Locations: []sarifLocation{sarifSourceLocation(p, d.Location)}, PartialFingerprints: map[string]string{sarifFingerprintVersion: sarifFingerprint(p, d)}}
		for i, related := range d.Related {
			loc := sarifSourceLocation(p, related.Location)
			loc.ID = i + 1
			loc.Message = &sarifMessage{related.Message}
			result.RelatedLocations = append(result.RelatedLocations, loc)
		}
		run.Results = append(run.Results, result)
	}
	return json.NewEncoder(w).Encode(sarifLog{sarifSchema, "2.1.0", []sarifRun{run}})
}

func sarifRules(ds []Diagnostic) []sarifRule {
	rules := map[string]sarifRule{}
	for _, rule := range lint.Registry().Rules {
		help := rule.Explanation + "\n\nValid example:\n" + rule.GoodExample + "\n\nInvalid example:\n" + rule.BadExample
		rules[rule.ID] = sarifRule{rule.ID, sarifMessage{rule.Summary}, sarifMessage{rule.Explanation}, sarifMessage{help}, toolURL + "/blob/main/docs/rules.md#" + rule.ID}
	}
	// YAML parser findings are outside the policy registry. Keep a stable
	// descriptor rather than deriving descriptions from a particular finding.
	rules["yaml-syntax"] = sarifRule{"yaml-syntax", sarifMessage{"Valid YAML syntax"}, sarifMessage{"Source must parse as YAML before policy checks can run."}, sarifMessage{"Correct the indicated YAML syntax, then run check again."}, toolURL + "/blob/main/docs/sarif.md"}
	for _, d := range ds {
		if _, ok := rules[d.RuleID]; !ok {
			rules[d.RuleID] = sarifRule{d.RuleID, sarifMessage{d.RuleID}, sarifMessage{"Source diagnostic reported by saltbox-lint."}, sarifMessage{"Correct the indicated source diagnostic, then run check again."}, toolURL + "/blob/main/docs/sarif.md"}
		}
	}
	ids := make([]string, 0, len(rules))
	for id := range rules {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	result := make([]sarifRule, 0, len(ids))
	for _, id := range ids {
		result = append(result, rules[id])
	}
	return result
}

func sarifSourceLocation(p *lint.Project, loc Location) sarifLocation {
	r := utf16Range(p.Sources[loc.Path], loc.Span)
	// URL.Path escapes literal %, #, ?, spaces and Unicode while preserving
	// path separators. Source identities already use root-relative slashes.
	uri := (&url.URL{Path: loc.Path}).EscapedPath()
	// A colon in the first segment must not be mistaken for a URI scheme.
	first, _, _ := strings.Cut(uri, "/")
	if strings.Contains(first, ":") {
		uri = "./" + uri
	}
	return sarifLocation{PhysicalLocation: sarifPhysical{sarifArtifact{uri, sarifSourceRoot}, sarifRegion{r.Start.Line, r.Start.Column, r.End.Line, r.End.Column}}}
}

// Context identities exclude physical line numbers and report-local fix IDs.
// Blank-only lines are omitted, while exact nonblank syntax and span columns
// distinguish nearby findings. Identical contexts use their source occurrence.
func sarifFingerprint(p *lint.Project, d Diagnostic) string {
	data := p.Sources[d.Path].Data
	start, end := min(max(d.Span.Start, 0), len(data)), min(max(d.Span.End, 0), len(data))
	lineStart := bytes.LastIndexByte(data[:start], '\n') + 1
	lineEnd := end
	if i := bytes.IndexByte(data[end:], '\n'); i >= 0 {
		lineEnd += i
	} else {
		lineEnd = len(data)
	}
	context := nonblankLines(string(data[lineStart:lineEnd]))
	prefix := nonblankLines(string(data[:lineStart]))
	occurrence := 0
	for i := 0; i+len(context) <= len(prefix); i++ {
		if slices.Equal(prefix[i:i+len(context)], context) {
			occurrence++
		}
	}
	message := d.Message
	if d.RuleID == "yaml-syntax" {
		// Parser messages can contain physical line numbers. Syntax context
		// identifies these findings without embedding those moving numbers.
		message = ""
	}
	parts := []any{sarifFingerprintVersion, d.RuleID, d.Path, d.Severity, message, d.Expected, context, string(data[lineStart:start]), string(data[end:lineEnd]), occurrence}
	encoded, _ := json.Marshal(parts)
	return fmt.Sprintf("%x", sha256.Sum256(encoded))
}

func nonblankLines(text string) []string {
	result := []string{}
	for line := range strings.SplitSeq(text, "\n") {
		line = strings.TrimSuffix(line, "\r")
		if strings.TrimSpace(line) != "" {
			result = append(result, line)
		}
	}
	return result
}
