package gateway

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
)

// ErrMessageTooLarge reports a peer that exceeded the bound before sending a
// delimiter.
var ErrMessageTooLarge = errors.New("message exceeds the permitted size")

/*
lineScanner reads newline-delimited messages under a hard size bound.

bufio.Scanner would be the obvious choice, but its token limit is silent: it
stops with an error the caller must remember to distinguish from end of input.
Here an oversized message is an explicit error, because a peer that sends one is
either broken or probing.
*/
type lineScanner struct {
	reader *bufio.Reader
	limit  int
	buffer []byte
}

func newLineScanner(reader *bufio.Reader, limit int) *lineScanner {
	return &lineScanner{reader: reader, limit: limit}
}

// next returns the next complete line, or nil for an empty one.
func (s *lineScanner) next() ([]byte, error) {
	s.buffer = s.buffer[:0]

	for {
		chunk, err := s.reader.ReadSlice('\n')

		if len(s.buffer)+len(chunk) > s.limit {
			return nil, fmt.Errorf("%w: over %d bytes", ErrMessageTooLarge, s.limit)
		}

		s.buffer = append(s.buffer, chunk...)

		if errors.Is(err, bufio.ErrBufferFull) {
			// A long line arriving in pieces; keep accumulating.
			continue
		}

		if err != nil {
			if errors.Is(err, io.EOF) && len(s.buffer) > 0 {
				// A final line without a trailing newline is still a message.
				return bytes.TrimSpace(s.buffer), nil
			}

			return nil, err
		}

		line := bytes.TrimSpace(s.buffer)

		if len(line) == 0 {
			return nil, nil
		}

		return line, nil
	}
}
