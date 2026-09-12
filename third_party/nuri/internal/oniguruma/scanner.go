package oniguruma

import (
	"context"
	"encoding/binary"
	"fmt"
	"unsafe"
)

const maxResultSlots = 2 + 64*2

type Scanner struct {
	inst *instance
	ptr  uint32
}

// FindNextMatch searches text from pos and returns the leftmost match.
//
// Text upload is elided when text shares a backing array with (and is no
// longer than) the previously uploaded slice — callers must not mutate text
// contents between calls that pass the same backing array. The tokenizer
// guarantees this: a line is immutable while it is being scanned, and
// capture retokenization searches prefixes of the already-uploaded line.
func (s *Scanner) FindNextMatch(ctx context.Context, text []byte, pos int, options SearchOptions) (*Match, error) {
	if len(text) == 0 {
		return nil, nil
	}
	inst := s.inst

	if inst.resultPtr == 0 {
		ptr, err := inst.wasmAlloc(ctx, maxResultSlots*4)
		if err != nil {
			return nil, fmt.Errorf("oniguruma: alloc result buf: %w", err)
		}
		inst.resultPtr = ptr
	}

	// Pin check: skip the upload when text is a prefix of the live
	// uploaded buffer. Searching a prefix of the uploaded bytes with
	// str_len = len(text) is byte-identical to uploading the prefix.
	pinned := len(inst.curText) > 0 &&
		unsafe.SliceData(text) == unsafe.SliceData(inst.curText) &&
		len(text) <= len(inst.curText)
	if !pinned {
		if uint32(len(text)) > inst.textCap {
			newCap := inst.textCap * 2
			if newCap < uint32(len(text)) {
				newCap = uint32(len(text))
			}
			if newCap < 4096 {
				newCap = 4096
			}
			if inst.textPtr != 0 {
				inst.wasmFree(ctx, inst.textPtr)
				inst.textPtr = 0
				inst.textCap = 0
			}
			ptr, err := inst.wasmAlloc(ctx, newCap)
			if err != nil {
				inst.curText = nil
				return nil, fmt.Errorf("oniguruma: alloc text: %w", err)
			}
			inst.textPtr = ptr
			inst.textCap = newCap
		}
		inst.mem.Write(inst.textPtr, text)
		inst.curText = text
	}

	stack := inst.callStack[:]
	stack[0] = uint64(s.ptr)
	stack[1] = uint64(inst.textPtr)
	stack[2] = uint64(len(text))
	stack[3] = uint64(pos)
	stack[4] = uint64(inst.resultPtr)
	stack[5] = uint64(maxResultSlots)
	stack[6] = uint64(uint32(options))
	if err := inst.fnFindNextMatch.CallWithStack(ctx, stack); err != nil {
		return nil, fmt.Errorf("oniguruma: find_next_match call: %w", err)
	}

	numCaptures := int32(uint32(stack[0]))
	if numCaptures < 0 {
		if numCaptures == -1 {
			return nil, nil
		}
		return nil, fmt.Errorf("oniguruma: find_next_match error code %d", numCaptures)
	}

	slotsToRead := uint32(2+numCaptures*2) * 4
	raw, ok := inst.mem.Read(inst.resultPtr, slotsToRead)
	if !ok {
		return nil, fmt.Errorf("oniguruma: cannot read result buffer")
	}

	// raw is a view into WASM memory — decode immediately, never retain it
	// across a call that can malloc.
	patternIndex := int(int32(binary.LittleEndian.Uint32(raw[0:])))

	captures := make([]Capture, numCaptures)
	for i := int32(0); i < numCaptures; i++ {
		off := (2 + i*2) * 4
		captures[i] = Capture{
			Start: int(int32(binary.LittleEndian.Uint32(raw[off:]))),
			End:   int(int32(binary.LittleEndian.Uint32(raw[off+4:]))),
		}
	}

	return &Match{
		Index:    patternIndex,
		Captures: captures,
	}, nil
}

func (s *Scanner) Free(ctx context.Context) {
	if s.ptr != 0 {
		s.inst.fnFreeScanner.Call(ctx, uint64(s.ptr))
		s.ptr = 0
	}
}

func (s *Scanner) FindNextMatchCtx(ctx context.Context, text []byte, startPos int, options SearchOptions) (*Match, error) {
	return s.FindNextMatch(ctx, text, startPos, options)
}

func (s *Scanner) Close() error {
	s.Free(context.Background())
	return nil
}
