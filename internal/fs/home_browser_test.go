package fs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListFolderAndSafety(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "project")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".hidden"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := SetBrowserRoot(root); err != nil {
		t.Fatal(err)
	}

	listing, err := ListFolder("")
	if err != nil {
		t.Fatal(err)
	}
	if listing.Root == "" || listing.Path == "" {
		t.Fatalf("unexpected listing: %+v", listing)
	}
	for _, entry := range listing.Entries {
		if entry.Name == ".hidden" {
			t.Fatal("hidden file should not be listed")
		}
	}

	outside := filepath.Dir(root)
	if _, err := ListFolder(outside); err == nil {
		t.Fatal("expected outside-root listing to fail")
	}
}
