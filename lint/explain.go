package lint

import (
	"context"
	"fmt"
	"os"
	"slices"
)

// FixDecision describes an observed decision, never permission to write. A
// generic decline stays generic when a provider has no more specific evidence.
type DecisionSpan struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

type FixDecision struct {
	Path   string       `json:"path"`
	RuleID string       `json:"rule_id"`
	Span   DecisionSpan `json:"span"`
	State  string       `json:"state"`
	Reason string       `json:"reason"`
}
type ObservedSource struct {
	Path             string   `json:"path"`
	Kind             Kind     `json:"source_kind"`
	ParseState       string   `json:"parse_state"`
	ParseDiagnostics []string `json:"parse_diagnostics"`
	CoverageReasons  []string `json:"coverage_reasons,omitempty"`
}
type Explanation struct {
	SchemaVersion        int              `json:"schema_version"`
	Root                 string           `json:"root"`
	Source               ObservedSource   `json:"source"`
	Input                string           `json:"input"`
	DirectoryWouldSelect bool             `json:"directory_would_select"`
	ExplicitSelection    string           `json:"explicit_selection"`
	ApplicablePolicies   []string         `json:"applicable_policies"`
	LoadedContext        []ObservedSource `json:"loaded_context"`
	Dependencies         *AnalysisRecord  `json:"dependencies"`
	FixDecisions         []FixDecision    `json:"fix_decisions"`
	Unsupported          []string         `json:"unsupported"`
}

// Explain uses the same loader, analysis and fix planner as check. Templates
// are explicitly checkable and always read-only.
func Explain(ctx context.Context, opts Options) (Explanation, error) {
	result := Explanation{SchemaVersion: 1, ApplicablePolicies: []string{}, LoadedContext: []ObservedSource{}, FixDecisions: []FixDecision{}, Unsupported: []string{}}
	if (len(opts.Paths) == 1) == (opts.StdinFilename != "") || len(opts.Paths) > 1 {
		return result, fmt.Errorf("explain requires exactly one source or stdin buffer")
	}
	if len(opts.Paths) == 1 {
		info, err := os.Stat(opts.Paths[0])
		if err != nil {
			return result, fmt.Errorf("inspect explanation source: %w", err)
		}
		if !info.Mode().IsRegular() {
			return result, fmt.Errorf("explain requires a regular source file")
		}
	}
	opts.IncludeAnalysis = true
	project, err := load(ctx, opts)
	if err != nil {
		return result, err
	}
	names := sortedKeys(project.Selected)
	source := project.Sources[names[0]]
	result.Root = project.Root
	result.Source = observedSource(source)
	result.Input = "file"
	if opts.StdinFilename != "" {
		result.Input = "stdin"
	}
	result.DirectoryWouldSelect = project.discoverable[source.Path]
	result.ExplicitSelection = "selected; explicit files override directory admission and Git ignores"
	if source.Kind == Template {
		result.ExplicitSelection = "selected; template checking and navigation are read-only"
		result.Unsupported = append(result.Unsupported, "template formatting, fixes, completion edits, rename and runtime evaluation are unavailable")
		result.Unsupported = append(result.Unsupported, scanTemplate(source).reasonMessages()...)
	}
	for _, rule := range Registry().Rules {
		if len(rule.Kinds) == 0 || slices.Contains(rule.Kinds, source.Kind) {
			result.ApplicablePolicies = append(result.ApplicablePolicies, rule.ID)
		}
	}
	for _, name := range sortedKeys(project.Sources) {
		if !project.Selected[name] {
			result.LoadedContext = append(result.LoadedContext, observedSource(project.Sources[name]))
		}
	}
	result.Dependencies = project.Dependencies
	diagnostics := Analyze(project, Rules())
	if _, err := planFixes(project, diagnostics, &result.FixDecisions); err != nil {
		return result, err
	}
	for _, decision := range result.FixDecisions {
		if decision.State == "unsupported-syntax" {
			result.Unsupported = append(result.Unsupported, decision.Reason)
		}
	}
	return result, ctx.Err()
}
func observedSource(source *Source) ObservedSource {
	result := ObservedSource{Path: source.Path, Kind: source.Kind, ParseState: "parsed", ParseDiagnostics: []string{}}
	if source.Kind == Template {
		result.ParseState = "static-template"
		scan := scanTemplate(source)
		result.CoverageReasons = scan.reasonMessages()
		if len(scan.reasons) > 0 {
			result.ParseState = "partial-template"
		}
		if len(scan.diagnostics) > 0 {
			result.ParseState = "template-error"
		}
		for _, d := range scan.diagnostics {
			result.ParseDiagnostics = append(result.ParseDiagnostics, d.Message)
		}
	}
	if len(source.parseDiagnostics) > 0 {
		result.ParseState = "parse-error"
	}
	for _, d := range source.parseDiagnostics {
		result.ParseDiagnostics = append(result.ParseDiagnostics, d.Message)
	}
	return result
}

// ChangedExplanation reports the same affected selection and authoritative fix
// decisions as check, without applying edits or executing templates.
type ChangedExplanation struct {
	SchemaVersion int              `json:"schema_version"`
	Root          string           `json:"root"`
	Selection     *SelectionRecord `json:"selection"`
	Dependencies  *AnalysisRecord  `json:"dependencies"`
	FixDecisions  []FixDecision    `json:"fix_decisions"`
}

func ExplainChanged(ctx context.Context, opts Options) (ChangedExplanation, error) {
	result := ChangedExplanation{SchemaVersion: 1, FixDecisions: []FixDecision{}}
	if opts.ChangedSince == "" {
		return result, fmt.Errorf("changed explanation requires a revision")
	}
	opts.IncludeAnalysis = true
	project, err := Load(ctx, opts)
	if err != nil {
		return result, err
	}
	result.Root, result.Selection, result.Dependencies = project.Root, project.Selection, project.Dependencies
	if _, err := planFixes(project, Analyze(project, Rules()), &result.FixDecisions); err != nil {
		return result, err
	}
	return result, ctx.Err()
}
