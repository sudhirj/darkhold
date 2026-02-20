package events

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var threadIDSanitizer = regexp.MustCompile(`[^a-zA-Z0-9._-]`)

type Store struct {
	RootDir string
}

func NewStore(rootDir string) *Store {
	return &Store{RootDir: rootDir}
}

func (s *Store) filePath(threadID string) string {
	safe := threadIDSanitizer.ReplaceAllString(threadID, "_")
	return filepath.Join(s.RootDir, safe+".jsonl")
}

func (s *Store) lockPath(threadID string) string {
	safe := threadIDSanitizer.ReplaceAllString(threadID, "_")
	return filepath.Join(s.RootDir, safe+".lock")
}

func (s *Store) withThreadFileLock(threadID string, fn func() error) error {
	lock := s.lockPath(threadID)
	for {
		err := os.Mkdir(lock, 0o755)
		if err == nil {
			break
		}
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		time.Sleep(8 * time.Millisecond)
	}
	defer func() {
		_ = os.RemoveAll(lock)
	}()
	return fn()
}

func (s *Store) Append(threadID, payload string) error {
	return s.withThreadFileLock(threadID, func() error {
		f, err := os.OpenFile(s.filePath(threadID), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = f.WriteString(payload + "\n")
		return err
	})
}

func (s *Store) Read(threadID string) ([]string, error) {
	f, err := os.Open(s.filePath(threadID))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []string{}, nil
		}
		return nil, err
	}
	defer f.Close()

	lines := make([]string, 0, 128)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		lines = append(lines, line)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return lines, nil
}

func (s *Store) RehydrateFromThreadRead(threadID string, readResult map[string]any) error {
	thread, _ := readResult["thread"].(map[string]any)
	turns, _ := thread["turns"].([]any)
	if len(turns) == 0 {
		return nil
	}

	lines := make([]string, 0, len(turns)*3)
	for turnIndex, turnAny := range turns {
		turn, _ := turnAny.(map[string]any)
		items, _ := turn["items"].([]any)
		for _, itemAny := range items {
			summary, ok := summarizeThreadReadItem(itemAny)
			if !ok {
				continue
			}
			payload := map[string]any{
				"method": "darkhold/thread-event",
				"params": map[string]any{
					"threadId": threadID,
					"type":     summary.Type,
					"message":  summary.Message,
					"source":   "thread/read",
				},
			}
			encoded, _ := json.Marshal(payload)
			lines = append(lines, string(encoded))
		}

		completed := map[string]any{
			"method": "turn/completed",
			"params": map[string]any{
				"threadId":   threadID,
				"source":     "thread/read",
				"turnNumber": turnIndex + 1,
			},
		}
		completedEncoded, _ := json.Marshal(completed)
		lines = append(lines, string(completedEncoded))

		status, _ := turn["status"].(string)
		errorObj, _ := turn["error"].(map[string]any)
		errorMessage, _ := errorObj["message"].(string)
		if status == "failed" && strings.TrimSpace(errorMessage) != "" {
			failed := map[string]any{
				"method": "darkhold/thread-event",
				"params": map[string]any{
					"threadId": threadID,
					"type":     "turn.error",
					"message":  errorMessage,
					"source":   "thread/read",
				},
			}
			failedEncoded, _ := json.Marshal(failed)
			lines = append(lines, string(failedEncoded))
		}
	}

	payload := strings.Join(lines, "\n")
	if payload != "" {
		payload += "\n"
	}
	return s.withThreadFileLock(threadID, func() error {
		return os.WriteFile(s.filePath(threadID), []byte(payload), 0o644)
	})
}

func (s *Store) Cleanup() error {
	return os.RemoveAll(s.RootDir)
}

type itemSummary struct {
	Type    string
	Message string
}

func summarizeThreadReadItem(itemAny any) (itemSummary, bool) {
	item, ok := itemAny.(map[string]any)
	if !ok {
		return itemSummary{}, false
	}
	itemType, _ := item["type"].(string)
	if itemType == "" {
		return itemSummary{}, false
	}

	switch itemType {
	case "userMessage":
		content, _ := item["content"].([]any)
		parts := make([]string, 0, len(content))
		for _, contentAny := range content {
			entry, _ := contentAny.(map[string]any)
			entryType, _ := entry["type"].(string)
			text, _ := entry["text"].(string)
			if entryType == "text" && text != "" {
				parts = append(parts, text)
			}
		}
		message := strings.TrimSpace(strings.Join(parts, "\n"))
		if message == "" {
			message = "[non-text input]"
		}
		return itemSummary{Type: "user.input", Message: message}, true
	case "agentMessage":
		text, _ := item["text"].(string)
		if text == "" {
			return itemSummary{}, false
		}
		return itemSummary{Type: "assistant.output", Message: text}, true
	case "fileChange":
		changes, _ := item["changes"].([]any)
		return itemSummary{Type: "file.change", Message: fmt.Sprintf("%d file(s) changed", len(changes))}, true
	default:
		return itemSummary{}, false
	}
}
