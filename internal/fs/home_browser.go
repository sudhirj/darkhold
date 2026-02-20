package fs

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

type FolderEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Kind string `json:"kind"`
}

type FolderListing struct {
	Root    string        `json:"root"`
	Path    string        `json:"path"`
	Parent  *string       `json:"parent"`
	Entries []FolderEntry `json:"entries"`
}

var (
	rootMu         sync.RWMutex
	configuredRoot string
	configuredReal string
)

func init() {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = "/"
	}
	resolved := filepath.Clean(home)
	real := resolved
	if resolvedReal, err := filepath.EvalSymlinks(resolved); err == nil {
		real = resolvedReal
	}
	configuredRoot = resolved
	configuredReal = real
}

func SetBrowserRoot(basePath string) (string, error) {
	if strings.TrimSpace(basePath) == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		basePath = home
	}
	resolved := filepath.Clean(basePath)
	real, err := filepath.EvalSymlinks(resolved)
	if err != nil {
		return "", err
	}

	rootMu.Lock()
	configuredRoot = resolved
	configuredReal = real
	rootMu.Unlock()
	return real, nil
}

func GetHomeRoot() string {
	rootMu.RLock()
	defer rootMu.RUnlock()
	return configuredReal
}

func resolveWithinRoot(target string) (string, string, error) {
	rootMu.RLock()
	root := configuredRoot
	rootReal := configuredReal
	rootMu.RUnlock()

	if strings.TrimSpace(target) == "" {
		target = root
	}
	resolved := filepath.Clean(target)
	real, err := filepath.EvalSymlinks(resolved)
	if err != nil {
		return "", "", err
	}
	if real != rootReal && !strings.HasPrefix(real, rootReal+string(filepath.Separator)) {
		return "", "", errors.New("path must be inside the configured base path")
	}
	return real, rootReal, nil
}

func ListFolder(inputPath string) (FolderListing, error) {
	current, rootReal, err := resolveWithinRoot(inputPath)
	if err != nil {
		return FolderListing{}, err
	}

	dirEntries, err := os.ReadDir(current)
	if err != nil {
		return FolderListing{}, err
	}

	entries := make([]FolderEntry, 0, len(dirEntries))
	for _, entry := range dirEntries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		kind := "file"
		if entry.IsDir() {
			kind = "directory"
		}
		entries = append(entries, FolderEntry{
			Name: entry.Name(),
			Path: filepath.Join(current, entry.Name()),
			Kind: kind,
		})
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Kind != entries[j].Kind {
			return entries[i].Kind == "directory"
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})

	var parent *string
	if current != rootReal {
		p := filepath.Dir(current)
		parent = &p
	}

	return FolderListing{
		Root:    rootReal,
		Path:    current,
		Parent:  parent,
		Entries: entries,
	}, nil
}

func FileInfoKind(info fs.FileInfo) string {
	if info.IsDir() {
		return "directory"
	}
	return "file"
}
