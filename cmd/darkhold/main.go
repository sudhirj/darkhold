package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"darkhold-go/internal/config"
	"darkhold-go/internal/events"
	browserfs "darkhold-go/internal/fs"
	"darkhold-go/internal/server"
)

func main() {
	cfg, err := config.Parse(os.Args[1:])
	if err != nil {
		log.Fatal(err)
	}

	if _, err := browserfs.SetBrowserRoot(cfg.BasePath); err != nil {
		log.Fatal(err)
	}

	eventsTmpRoot := filepath.Join(os.TempDir(), fmt.Sprintf("darkhold-go-events-%d", os.Getpid()))
	if err := os.MkdirAll(eventsTmpRoot, 0o755); err != nil {
		log.Fatal(err)
	}
	store := events.NewStore(eventsTmpRoot)
	srv := server.New(cfg, store)

	httpServer := &http.Server{
		Addr:    fmt.Sprintf("%s:%d", cfg.Bind, cfg.Port),
		Handler: srv.Handler(),
	}

	allowListNote := ""
	if len(cfg.AllowCIDRs) > 0 {
		allowListNote = fmt.Sprintf(" (allowed CIDRs: %s, plus localhost)", strings.Join(cfg.AllowCIDRs, ", "))
	}
	fmt.Printf("darkhold-go listening on http://%s:%d%s (base path: %s, app-server transport: stdio per session)\n",
		cfg.Bind,
		cfg.Port,
		allowListNote,
		browserfs.GetHomeRoot(),
	)

	errCh := make(chan error, 1)
	go func() {
		errCh <- httpServer.ListenAndServe()
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-sigCh:
		fmt.Printf("received %s, shutting down...\n", sig)
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
	_ = srv.Shutdown(ctx)
	_ = store.Cleanup()
}
