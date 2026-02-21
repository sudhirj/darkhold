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

	"github.com/oklog/ulid/v2"
)

var threadIDSanitizer = regexp.MustCompile(`[^a-zA-Z0-9._-]`)

type Store struct {
	RootDir string
}

type Record struct {
	ID      string `json:"id"`
	Payload string `json:"payload"`
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

const (
	lockStaleDuration = 30 * time.Second
	lockTimeout       = 10 * time.Second
	lockPollInterval  = 8 * time.Millisecond
)

func (s *Store) withThreadFileLock(threadID string, fn func() error) error {
	lock := s.lockPath(threadID)
	deadline := time.Now().Add(lockTimeout)
	for {
		err := os.Mkdir(lock, 0o755)
		if err == nil {
			break
		}
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		// Break stale locks left by crashed processes.
		if info, statErr := os.Stat(lock); statErr == nil {
			if time.Since(info.ModTime()) > lockStaleDuration {
				_ = os.RemoveAll(lock)
				continue
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out acquiring lock for thread %s", threadID)
		}
		time.Sleep(lockPollInterval)
	}
	defer func() {
		_ = os.RemoveAll(lock)
	}()
	return fn()
}

func (s *Store) Append(threadID, payload string) (string, error) {
	eventID, err := nextULID()
	if err != nil {
		return "", err
	}
	line := eventID + ":" + payload
	err = s.withThreadFileLock(threadID, func() error {
		f, err := os.OpenFile(s.filePath(threadID), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = f.WriteString(line + "\n")
		return err
	})
	if err != nil {
		return "", err
	}
	return eventID, nil
}

func (s *Store) ReadRecords(threadID string) ([]Record, error) {
	f, err := os.Open(s.filePath(threadID))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []Record{}, nil
		}
		return nil, err
	}
	defer f.Close()

	records := make([]Record, 0, 128)
	scanner := bufio.NewScanner(f)
	legacyIndex := 0
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		if len(line) > 27 && line[26] == ':' {
			records = append(records, Record{
				ID:      line[:26],
				Payload: line[27:],
			})
			continue
		}

		var record Record
		if err := json.Unmarshal([]byte(line), &record); err == nil && strings.TrimSpace(record.ID) != "" && record.Payload != "" {
			records = append(records, record)
			continue
		}
		legacyIndex++
		records = append(records, Record{
			ID:      fmt.Sprintf("LEGACY-%020d", legacyIndex),
			Payload: line,
		})
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return records, nil
}

func (s *Store) Read(threadID string) ([]string, error) {
	records, err := s.ReadRecords(threadID)
	if err != nil {
		return nil, err
	}
	lines := make([]string, 0, len(records))
	for _, record := range records {
		lines = append(lines, record.Payload)
	}
	return lines, nil
}

func (s *Store) RehydrateFromThreadRead(threadID string, readResult map[string]any) error {
	return nil
}

func (s *Store) Cleanup() error {
	return os.RemoveAll(s.RootDir)
}

func nextULID() (string, error) {
	id := ulid.Make()
	return id.String(), nil
}
