package gateway

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/dockplane/dockplane/agent/internal/capability"
	"github.com/dockplane/dockplane/agent/internal/protocol"
)

/*
Streaming capabilities.

A stream is one request that answers over time rather than once. The lifecycle
is explicit on the wire — started, chunks, end — so both sides always agree on
whether one is running, and either side can end it.

Everything about a stream is bound to the connection it was opened on. A stream
belongs to one socket, and the agent stops all of them when that socket goes: a
chunk produced for a connection that has been replaced must never be delivered
on the new one, where it would be read as an answer to a different request.
*/

// running is one active stream on this connection.
type running struct {
	streamID string
	cancel   context.CancelFunc
}

// streams tracks what is in flight for the current connection.
type streams struct {
	mu     sync.Mutex
	active map[string]running
}

func newStreams() *streams {
	return &streams{active: make(map[string]running)}
}

func (s *streams) add(requestID, streamID string, cancel context.CancelFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.active[requestID] = running{streamID: streamID, cancel: cancel}
}

func (s *streams) remove(requestID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.active, requestID)
}

/*
cancel ends one stream, but only when the identifiers agree.

A cancel that names a stream identifier the agent never issued is ignored. The
identifier is the server's, echoed back at the start, so this is what stops a
cancel for an earlier stream from ending a later one that reused the request.
*/
func (s *streams) cancel(requestID, streamID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	stream, exists := s.active[requestID]

	if !exists || stream.streamID != streamID {
		return false
	}

	stream.cancel()

	return true
}

// cancelAll ends everything running, used when a connection goes away.
func (s *streams) cancelAll() {
	s.mu.Lock()
	defer s.mu.Unlock()

	for requestID, stream := range s.active {
		stream.cancel()
		delete(s.active, requestID)
	}
}

func (s *streams) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return len(s.active)
}

/*
handleStream runs one streaming capability to its end.

The chunks are written to the connection the request arrived on, and the write
is checked: a failed write means the server is gone, which ends the stream
rather than being retried. Nothing about the log content is logged — the agent
reports how many chunks a stream carried, never what was in them.
*/
func (c *Client) handleStream(ctx context.Context, message *protocol.ServerMessage) {
	started := time.Now()
	streamID := message.StreamID

	if streamID == "" {
		c.reply(protocol.NewFailure(
			message.ID, message.Capability, "VALIDATION_FAILED", "The request carried no stream."))

		return
	}

	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	c.streams.add(message.ID, streamID, cancel)
	defer c.streams.remove(message.ID)

	if err := c.send(protocol.NewStreamStarted(message.ID, message.Capability, streamID)); err != nil {
		return
	}

	c.logger.Info("stream opened",
		"event", "stream_opened",
		"requestId", message.ID,
		"streamId", streamID,
		"capability", message.Capability)

	sequence := 0

	err := c.options.Registry.InvokeStream(
		streamCtx,
		message.Capability,
		message.Payload,
		func(chunk capability.Chunk) error {
			if streamCtx.Err() != nil {
				return context.Canceled
			}

			if err := c.send(protocol.NewStreamChunk(
				message.ID, streamID, sequence, chunk.Payload, chunk.Dropped,
			)); err != nil {
				return err
			}

			sequence++

			return nil
		},
	)

	reason, failure := endState(streamCtx, err)

	c.logger.Info("stream closed",
		"event", "stream_closed",
		"requestId", message.ID,
		"streamId", streamID,
		"capability", message.Capability,
		"chunks", sequence,
		"reason", reason,
		"durationMs", time.Since(started).Milliseconds())

	if err := c.send(protocol.NewStreamEnd(message.ID, streamID, reason, failure)); err != nil {
		c.logger.Warn("could not report the end of a stream",
			"event", "stream_end_failed",
			"requestId", message.ID,
			"streamId", streamID,
			"error", errorText(err))
	}
}

/*
endState turns however a stream finished into what the server is told.

A cancelled stream is not a failure: the server asked for it to stop, or the
connection went away. Only a genuine error carries a code, and the code comes
from the capability vocabulary rather than from a Docker client's wording.
*/
func endState(ctx context.Context, err error) (string, *protocol.ResponseError) {
	/*
	 * The context is asked first.
	 *
	 * A handler that stops because it was cancelled returns cleanly, so a nil
	 * error says nothing on its own: reading it as success would report a
	 * cancelled stream as one that ran to the end of the container's output.
	 */
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded), errors.Is(err, context.DeadlineExceeded):
		return protocol.StreamExpired, nil

	case ctx.Err() != nil, errors.Is(err, context.Canceled):
		return protocol.StreamCancelled, nil

	case err == nil:
		return protocol.StreamCompleted, nil

	default:
		return protocol.StreamFailed, &protocol.ResponseError{
			Code:    capability.Code(err),
			Message: err.Error(),
		}
	}
}
