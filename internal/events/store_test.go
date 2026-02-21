package events

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestAppendAndRead(t *testing.T) {
	root := filepath.Join(t.TempDir(), "events")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	store := NewStore(root)

	if _, err := store.Append("thread-1", `{"method":"turn/started"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append("thread-1", `{"method":"turn/completed"}`); err != nil {
		t.Fatal(err)
	}

	events, err := store.Read("thread-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}
}

func TestConcurrentAppend(t *testing.T) {
	root := filepath.Join(t.TempDir(), "events")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	store := NewStore(root)

	var wg sync.WaitGroup
	for i := 1; i <= 50; i++ {
		wg.Add(1)
		go func(v int) {
			defer wg.Done()
			_, _ = store.Append("thread-2", `{"method":"event","seq":`+jsonNumber(v)+`}`)
		}(i)
	}
	wg.Wait()

	events, err := store.Read("thread-2")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 50 {
		t.Fatalf("expected 50 events, got %d", len(events))
	}
}

func TestRehydrateFromThreadRead(t *testing.T) {
	root := filepath.Join(t.TempDir(), "events")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	store := NewStore(root)

	_, _ = store.Append("thread-3", `{"method":"stale"}`)

	readResult := map[string]any{
		"thread": map[string]any{
			"turns": []any{
				map[string]any{
					"status": "completed",
					"items": []any{
						map[string]any{"type": "userMessage", "content": []any{map[string]any{"type": "text", "text": "hello"}}},
						map[string]any{"type": "agentMessage", "text": "world"},
						map[string]any{"type": "fileChange", "changes": []any{"a", "b"}},
					},
				},
				map[string]any{
					"status": "failed",
					"error":  map[string]any{"message": "boom"},
					"items":  []any{},
				},
			},
		},
	}
	if err := store.RehydrateFromThreadRead("thread-3", readResult); err != nil {
		t.Fatal(err)
	}

	events, err := store.Read("thread-3")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("rehydrate should not transform events; got %d event(s)", len(events))
	}
	if !contains(events[0], "stale") {
		t.Fatal("original raw event should remain unchanged")
	}
}

func TestCleanup(t *testing.T) {
	root := filepath.Join(t.TempDir(), "events")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	store := NewStore(root)
	if _, err := store.Append("thread-4", `{"method":"turn/started"}`); err != nil {
		t.Fatal(err)
	}
	if err := store.Cleanup(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(root); err == nil {
		t.Fatal("root should be removed")
	}
}

func jsonNumber(v int) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func joinLines(lines []string) string {
	out := ""
	for i, line := range lines {
		if i > 0 {
			out += "\n"
		}
		out += line
	}
	return out
}

func contains(haystack, needle string) bool {
	return len(needle) == 0 || (len(haystack) >= len(needle) && stringContains(haystack, needle))
}

func stringContains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
