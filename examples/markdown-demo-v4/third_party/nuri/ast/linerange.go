package ast

// LineRange represents a 1-based inclusive range of lines.
type LineRange struct {
	Start int
	End   int
}

// Range returns a LineRange from start to end (1-based, inclusive).
func Range(start, end int) LineRange {
	return LineRange{Start: start, End: end}
}

// Lines returns a slice of single-line LineRanges.
func Lines(nums ...int) []LineRange {
	ranges := make([]LineRange, len(nums))
	for i, n := range nums {
		ranges[i] = LineRange{Start: n, End: n}
	}
	return ranges
}

// Contains reports whether the range includes line (1-based).
func (r LineRange) Contains(line int) bool {
	return line >= r.Start && line <= r.End
}

// InRanges reports whether line is contained in any of the given ranges.
func InRanges(ranges []LineRange, line int) bool {
	for _, r := range ranges {
		if r.Contains(line) {
			return true
		}
	}
	return false
}
