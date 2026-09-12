package nuri

import (
	"fmt"
	"math"
	"strings"
)

func parseHexColor(hex string) (r, g, b float64, ok bool) {
	hex = strings.TrimSpace(hex)
	if !strings.HasPrefix(hex, "#") {
		return 0, 0, 0, false
	}
	hex = hex[1:]

	var ri, gi, bi uint64
	switch len(hex) {
	case 3, 4:
		_, err := fmt.Sscanf(hex[:3], "%1x%1x%1x", &ri, &gi, &bi)
		if err != nil {
			return 0, 0, 0, false
		}
		ri = ri*16 + ri
		gi = gi*16 + gi
		bi = bi*16 + bi
	case 6, 8:
		_, err := fmt.Sscanf(hex[:6], "%2x%2x%2x", &ri, &gi, &bi)
		if err != nil {
			return 0, 0, 0, false
		}
	default:
		return 0, 0, 0, false
	}

	return float64(ri) / 255.0, float64(gi) / 255.0, float64(bi) / 255.0, true
}

func linearize(c float64) float64 {
	if c <= 0.04045 {
		return c / 12.92
	}
	return math.Pow((c+0.055)/1.055, 2.4)
}

func relativeLuminance(r, g, b float64) float64 {
	return 0.2126*linearize(r) + 0.7152*linearize(g) + 0.0722*linearize(b)
}

func contrastRatio(fg, bg string) float64 {
	fr, fg2, fb, ok1 := parseHexColor(fg)
	br, bg2, bb, ok2 := parseHexColor(bg)
	if !ok1 || !ok2 {
		return 1
	}
	l1 := relativeLuminance(fr, fg2, fb)
	l2 := relativeLuminance(br, bg2, bb)
	if l1 < l2 {
		l1, l2 = l2, l1
	}
	return (l1 + 0.05) / (l2 + 0.05)
}

func toHex(r, g, b float64) string {
	clamp := func(v float64) uint8 {
		if v < 0 {
			return 0
		}
		if v > 1 {
			return 255
		}
		return uint8(math.Round(v * 255))
	}
	return fmt.Sprintf("#%02x%02x%02x", clamp(r), clamp(g), clamp(b))
}

func adjustForeground(fg, bg string, minRatio float64) string {
	if contrastRatio(fg, bg) >= minRatio {
		return fg
	}

	fr, fg2, fb, ok1 := parseHexColor(fg)
	_, _, _, ok2 := parseHexColor(bg)
	if !ok1 || !ok2 {
		return fg
	}

	bgLum := relativeLuminance(parseHexColorMust(bg))

	// Binary search toward white or black depending on background luminance.
	// Try both directions, pick the one that meets contrast first with
	// minimal color shift.
	type result struct {
		color string
		step  float64
	}
	var best *result

	for _, toWhite := range []bool{bgLum > 0.5, bgLum <= 0.5} {
		lo, hi := 0.0, 1.0
		for range 32 {
			mid := (lo + hi) / 2
			var cr, cg, cb float64
			if toWhite {
				cr = fr + (1-fr)*mid
				cg = fg2 + (1-fg2)*mid
				cb = fb + (1-fb)*mid
			} else {
				cr = fr * (1 - mid)
				cg = fg2 * (1 - mid)
				cb = fb * (1 - mid)
			}
			candidate := toHex(cr, cg, cb)
			if contrastRatio(candidate, bg) >= minRatio {
				hi = mid
			} else {
				lo = mid
			}
		}
		candidate := toHex(mixChannel(fr, toWhite, hi), mixChannel(fg2, toWhite, hi), mixChannel(fb, toWhite, hi))
		if contrastRatio(candidate, bg) >= minRatio {
			if best == nil || hi < best.step {
				best = &result{color: candidate, step: hi}
			}
		}
	}

	if best != nil {
		return best.color
	}

	if bgLum > 0.5 {
		return "#000000"
	}
	return "#ffffff"
}

func mixChannel(c float64, toWhite bool, step float64) float64 {
	if toWhite {
		return c + (1-c)*step
	}
	return c * (1 - step)
}

func parseHexColorMust(hex string) (float64, float64, float64) {
	r, g, b, _ := parseHexColor(hex)
	return r, g, b
}
