package renderer

import (
	"fmt"
	"math"
	"strconv"

	"github.com/frostybee/nuri/ast"
)

type paletteEntry struct {
	r, g, b uint8
	fgCode  string // e.g. "31" or "38;5;196" or "38;2;255;0;0"
	bgCode  string // e.g. "41" or "48;5;196" or "48;2;255;0;0"
}

type palette struct {
	depth   ast.ColorDepth
	entries []paletteEntry
	fgCache map[string]string
	bgCache map[string]string
}

func newPalette(depth ast.ColorDepth) *palette {
	p := &palette{
		depth:   depth,
		fgCache: make(map[string]string),
		bgCache: make(map[string]string),
	}
	switch depth {
	case ast.ColorDepth8:
		p.entries = ansi8Palette
	case ast.ColorDepth16:
		p.entries = ansi16Palette
	case ast.ColorDepth256:
		p.entries = ansi256Palette
	}
	return p
}

// resolveFG returns the ANSI SGR parameter string for a foreground color.
func (p *palette) resolveFG(hex string) string {
	if hex == "" {
		return ""
	}
	if s, ok := p.fgCache[hex]; ok {
		return s
	}
	s := p.resolve(hex, false)
	p.fgCache[hex] = s
	return s
}

// resolveBG returns the ANSI SGR parameter string for a background color.
func (p *palette) resolveBG(hex string) string {
	if hex == "" {
		return ""
	}
	if s, ok := p.bgCache[hex]; ok {
		return s
	}
	s := p.resolve(hex, true)
	p.bgCache[hex] = s
	return s
}

func (p *palette) resolve(hex string, bg bool) string {
	r, g, b, ok := parseHex(hex)
	if !ok {
		return ""
	}

	if p.depth == ast.ColorDepthTruecolor || p.depth == 0 {
		if bg {
			return fmt.Sprintf("48;2;%d;%d;%d", r, g, b)
		}
		return fmt.Sprintf("38;2;%d;%d;%d", r, g, b)
	}

	best := 0
	bestDist := math.MaxFloat64
	for i, e := range p.entries {
		d := colorDistance(r, g, b, e.r, e.g, e.b)
		if d < bestDist {
			bestDist = d
			best = i
			if d == 0 {
				break
			}
		}
	}

	if bg {
		return p.entries[best].bgCode
	}
	return p.entries[best].fgCode
}

// parseHex converts "#rgb", "#rrggbb", or "#rrggbbaa" to r, g, b components.
func parseHex(hex string) (r, g, b uint8, ok bool) {
	if len(hex) == 0 || hex[0] != '#' {
		return 0, 0, 0, false
	}
	hex = hex[1:]
	switch len(hex) {
	case 3, 4:
		rv, err1 := strconv.ParseUint(hex[0:1]+hex[0:1], 16, 8)
		gv, err2 := strconv.ParseUint(hex[1:2]+hex[1:2], 16, 8)
		bv, err3 := strconv.ParseUint(hex[2:3]+hex[2:3], 16, 8)
		if err1 != nil || err2 != nil || err3 != nil {
			return 0, 0, 0, false
		}
		return uint8(rv), uint8(gv), uint8(bv), true
	case 6, 8:
		rv, err1 := strconv.ParseUint(hex[0:2], 16, 8)
		gv, err2 := strconv.ParseUint(hex[2:4], 16, 8)
		bv, err3 := strconv.ParseUint(hex[4:6], 16, 8)
		if err1 != nil || err2 != nil || err3 != nil {
			return 0, 0, 0, false
		}
		return uint8(rv), uint8(gv), uint8(bv), true
	}
	return 0, 0, 0, false
}

// colorDistance returns weighted perceptual distance between two RGB colors.
// Uses the Compuphase formula which weights red more heavily based on
// mean brightness, approximating human color perception.
func colorDistance(r1, g1, b1, r2, g2, b2 uint8) float64 {
	rmean := (int(r1) + int(r2)) / 2
	dr := int(r1) - int(r2)
	dg := int(g1) - int(g2)
	db := int(b1) - int(b2)
	return math.Sqrt(float64(
		(((512 + rmean) * dr * dr) >> 8) + 4*dg*dg + (((767 - rmean) * db * db) >> 8),
	))
}

// Standard 8 ANSI colors.
var ansi8Palette = []paletteEntry{
	{0, 0, 0, "30", "40"},
	{205, 49, 49, "31", "41"},
	{13, 188, 121, "32", "42"},
	{229, 229, 16, "33", "43"},
	{36, 114, 200, "34", "44"},
	{188, 63, 188, "35", "45"},
	{17, 168, 205, "36", "46"},
	{229, 229, 229, "37", "47"},
}

// Standard 16 ANSI colors (8 dark + 8 bright using 90-97/100-107 codes).
var ansi16Palette = func() []paletteEntry {
	p := make([]paletteEntry, 16)
	copy(p, ansi8Palette)
	bright := []paletteEntry{
		{102, 102, 102, "90", "100"},
		{241, 76, 76, "91", "101"},
		{35, 209, 139, "92", "102"},
		{245, 245, 67, "93", "103"},
		{59, 142, 234, "94", "104"},
		{214, 112, 214, "95", "105"},
		{41, 184, 219, "96", "106"},
		{229, 229, 229, "97", "107"},
	}
	copy(p[8:], bright)
	return p
}()

// 256-color palette: 16 base + 216 color cube (6x6x6) + 24 grayscale.
var ansi256Palette = func() []paletteEntry {
	p := make([]paletteEntry, 256)
	copy(p[:16], ansi16Palette)

	// 216 color cube (indices 16-231): 6 levels per channel.
	cubeLevels := [6]uint8{0, 95, 135, 175, 215, 255}
	for i := 0; i < 216; i++ {
		idx := 16 + i
		r := cubeLevels[i/36]
		g := cubeLevels[(i/6)%6]
		b := cubeLevels[i%6]
		p[idx] = paletteEntry{
			r, g, b,
			fmt.Sprintf("38;5;%d", idx),
			fmt.Sprintf("48;5;%d", idx),
		}
	}

	// 24 grayscale (indices 232-255): #080808 to #eeeeee.
	for i := 0; i < 24; i++ {
		idx := 232 + i
		v := uint8(i*10 + 8)
		p[idx] = paletteEntry{
			v, v, v,
			fmt.Sprintf("38;5;%d", idx),
			fmt.Sprintf("48;5;%d", idx),
		}
	}

	return p
}()
