// Package replay remembers request identifiers the agent has already handled.
//
// The invariant matters more than it looks today. Every capability here is
// read-only, so replaying one is harmless; the guard exists before mutating
// capabilities arrive, because retrofitting replay protection onto an operation
// that restarts a container is how a duplicated request becomes a duplicated
// action.
package replay

import (
	"container/list"
	"sync"
	"time"
)

// Cache is a bounded, time-limited set of seen identifiers.
//
// Bounded on purpose: an unbounded cache is a memory-exhaustion path for anyone
// able to send requests. Entries leave by age or, once the cache is full, by
// being the oldest.
type Cache struct {
	mu       sync.Mutex
	ttl      time.Duration
	capacity int
	entries  map[string]*list.Element
	order    *list.List
	now      func() time.Time
}

type entry struct {
	id     string
	seenAt time.Time
}

// New builds a cache holding at most capacity identifiers for ttl each.
func New(capacity int, ttl time.Duration) *Cache {
	if capacity < 1 {
		capacity = 1
	}

	return &Cache{
		ttl:      ttl,
		capacity: capacity,
		entries:  make(map[string]*list.Element, capacity),
		order:    list.New(),
		now:      time.Now,
	}
}

// Observe records an identifier and reports whether it had been seen before.
//
// Recording and checking are one operation, so two requests carrying the same
// identifier cannot both be treated as new.
func (c *Cache) Observe(id string) (seen bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.now()
	c.evictExpired(now)

	if element, exists := c.entries[id]; exists {
		element.Value.(*entry).seenAt = now
		c.order.MoveToBack(element)

		return true
	}

	c.entries[id] = c.order.PushBack(&entry{id: id, seenAt: now})

	for c.order.Len() > c.capacity {
		c.removeOldest()
	}

	return false
}

// Len reports how many identifiers are currently remembered.
func (c *Cache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.evictExpired(c.now())

	return c.order.Len()
}

func (c *Cache) evictExpired(now time.Time) {
	for {
		oldest := c.order.Front()

		if oldest == nil || now.Sub(oldest.Value.(*entry).seenAt) < c.ttl {
			return
		}

		c.remove(oldest)
	}
}

func (c *Cache) removeOldest() {
	if oldest := c.order.Front(); oldest != nil {
		c.remove(oldest)
	}
}

func (c *Cache) remove(element *list.Element) {
	delete(c.entries, element.Value.(*entry).id)
	c.order.Remove(element)
}
