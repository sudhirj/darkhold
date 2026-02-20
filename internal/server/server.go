package server

import (
	"bufio"
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"darkhold-go/internal/config"
	"darkhold-go/internal/events"
	browserfs "darkhold-go/internal/fs"
)

//go:embed webdist/*
var webDist embed.FS

var embeddedWebRoot = func() fs.FS {
	root, err := fs.Sub(webDist, "webdist")
	if err != nil {
		return nil
	}
	return root
}()

type session struct {
	id int

	cmd   *exec.Cmd
	stdin io.WriteCloser

	upstreamInitialized atomic.Bool
	nextRequestID       int64

	mu             sync.Mutex
	pending        map[int64]chan map[string]any
	knownThreadIDs map[string]struct{}
	closed         bool
}

type pendingInteraction struct {
	sessionID int
	requestID int64
	method    string
	params    any
}

type Server struct {
	cfg config.Config

	eventStore *events.Store

	sessionsMu       sync.RWMutex
	sessions         map[int]*session
	threadToSession  map[string]int
	nextSessionID    int
	pendingResponses map[string]map[string]pendingInteraction

	sseMu          sync.Mutex
	sseSubs        map[string]map[int]chan string
	sseNextEventID map[string]int
	nextSSESubID   int

	publishMu sync.Mutex
}

func New(cfg config.Config, eventStore *events.Store) *Server {
	return &Server{
		cfg:              cfg,
		eventStore:       eventStore,
		sessions:         map[int]*session{},
		threadToSession:  map[string]int{},
		pendingResponses: map[string]map[string]pendingInteraction{},
		sseSubs:          map[string]map[int]chan string{},
		sseNextEventID:   map[string]int{},
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/fs/list", s.handleFSList)
	mux.HandleFunc("/api/thread/events", s.handleThreadEvents)
	mux.HandleFunc("/api/thread/events/stream", s.handleThreadEventsStream)
	mux.HandleFunc("/api/rpc", s.handleRPC)
	mux.HandleFunc("/api/thread/interaction/respond", s.handleInteractionRespond)
	mux.HandleFunc("/", s.handleWeb)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.allowClient(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "Forbidden for client IP."})
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) allowClient(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return config.IsAllowedClient(ip, s.cfg.AllowCIDRs)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"basePath": browserfs.GetHomeRoot(),
	})
}

func (s *Server) handleFSList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	listing, err := browserfs.ListFolder(r.URL.Query().Get("path"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, listing)
}

func (s *Server) handleThreadEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	threadID := strings.TrimSpace(r.URL.Query().Get("threadId"))
	if threadID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "threadId is required."})
		return
	}
	events, err := s.eventStore.Read(threadID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"threadId": threadID, "events": events})
}

func (s *Server) handleThreadEventsStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	threadID := strings.TrimSpace(r.URL.Query().Get("threadId"))
	if threadID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "threadId is required."})
		return
	}

	lastEventIDRaw := strings.TrimSpace(r.Header.Get("Last-Event-ID"))
	if lastEventIDRaw == "" {
		lastEventIDRaw = strings.TrimSpace(r.URL.Query().Get("lastEventId"))
	}
	startEventID := 1
	if lastEventIDRaw != "" {
		if parsed, err := strconv.Atoi(lastEventIDRaw); err == nil && parsed >= 0 {
			startEventID = parsed + 1
		}
	}

	history, err := s.eventStore.Read(threadID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "streaming is not supported"})
		return
	}

	s.sseMu.Lock()
	nextFromHistory := len(history) + 1
	if existing := s.sseNextEventID[threadID]; existing < nextFromHistory {
		s.sseNextEventID[threadID] = nextFromHistory
	}
	s.nextSSESubID++
	subID := s.nextSSESubID
	subs := s.sseSubs[threadID]
	if subs == nil {
		subs = map[int]chan string{}
		s.sseSubs[threadID] = subs
	}
	ch := make(chan string, 128)
	subs[subID] = ch
	s.sseMu.Unlock()

	defer func() {
		s.sseMu.Lock()
		if subs := s.sseSubs[threadID]; subs != nil {
			delete(subs, subID)
			if len(subs) == 0 {
				delete(s.sseSubs, threadID)
			}
		}
		s.sseMu.Unlock()
	}()

	for idx := max(0, startEventID-1); idx < len(history); idx++ {
		if _, err := io.WriteString(w, sseFrame(idx+1, history[idx])); err != nil {
			return
		}
	}
	flusher.Flush()

	keepAlive := time.NewTicker(15 * time.Second)
	defer keepAlive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case frame := <-ch:
			if _, err := io.WriteString(w, frame); err != nil {
				return
			}
			flusher.Flush()
		case <-keepAlive.C:
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) handleRPC(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	var request struct {
		Method string `json:"method"`
		Params any    `json:"params"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid JSON body."})
		return
	}
	request.Method = strings.TrimSpace(request.Method)
	if request.Method == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "method is required."})
		return
	}

	threadIDHint := ""
	if paramsMap, ok := request.Params.(map[string]any); ok {
		if tid, ok := paramsMap["threadId"].(string); ok {
			threadIDHint = tid
		}
	}

	sess, err := s.selectSession(threadIDHint)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if threadIDHint != "" {
		s.bindThreadToSession(threadIDHint, sess)
	}

	if request.Method != "initialize" {
		if err := s.ensureInitialized(sess); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
	}

	response, err := s.callSessionRPC(r.Context(), sess, request.Method, request.Params)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}

	if errObj, ok := response["error"].(map[string]any); ok {
		message, _ := errObj["message"].(string)
		if message == "" {
			message = "RPC error"
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": message})
		return
	}

	if request.Method == "thread/start" || request.Method == "thread/read" || request.Method == "thread/resume" {
		if result, ok := response["result"].(map[string]any); ok {
			if threadObj, ok := result["thread"].(map[string]any); ok {
				if threadID, ok := threadObj["id"].(string); ok && threadID != "" {
					s.bindThreadToSession(threadID, sess)
					if request.Method == "thread/read" || request.Method == "thread/resume" {
						_ = s.eventStore.RehydrateFromThreadRead(threadID, result)
					}
				}
			}
		}
	}

	writeJSON(w, http.StatusOK, response["result"])
}

func (s *Server) handleInteractionRespond(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	var request struct {
		ThreadID  string `json:"threadId"`
		RequestID string `json:"requestId"`
		Result    any    `json:"result"`
		Error     any    `json:"error"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid JSON body."})
		return
	}
	request.ThreadID = strings.TrimSpace(request.ThreadID)
	request.RequestID = strings.TrimSpace(request.RequestID)
	if request.ThreadID == "" || request.RequestID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "threadId and requestId are required."})
		return
	}

	s.sessionsMu.Lock()
	threadPending := s.pendingResponses[request.ThreadID]
	if threadPending == nil {
		s.sessionsMu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "interaction request not found or already resolved."})
		return
	}
	pending, ok := threadPending[request.RequestID]
	if !ok {
		s.sessionsMu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "interaction request not found or already resolved."})
		return
	}
	delete(threadPending, request.RequestID)
	if len(threadPending) == 0 {
		delete(s.pendingResponses, request.ThreadID)
	}
	sess := s.sessions[pending.sessionID]
	s.sessionsMu.Unlock()

	if sess == nil {
		writeJSON(w, http.StatusGone, map[string]any{"error": "app-server session is unavailable."})
		return
	}

	payload := map[string]any{"id": pending.requestID}
	if request.Error != nil {
		payload["error"] = request.Error
	} else {
		payload["result"] = request.Result
	}
	line, _ := json.Marshal(payload)
	if err := s.writeSessionLine(sess, string(line)); err != nil {
		writeJSON(w, http.StatusGone, map[string]any{"error": "app-server session is unavailable."})
		return
	}

	resolvedPayload := map[string]any{
		"method": "darkhold/interaction/resolved",
		"params": map[string]any{"threadId": request.ThreadID, "requestId": request.RequestID, "source": "http"},
	}
	resolvedLine, _ := json.Marshal(resolvedPayload)
	s.publishThreadEvent(request.ThreadID, string(resolvedLine))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleWeb(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.NotFound(w, r)
		return
	}
	if embeddedWebRoot == nil {
		http.NotFound(w, r)
		return
	}

	requestPath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if requestPath == "" || requestPath == "." {
		requestPath = "index.html"
	}

	data, err := fs.ReadFile(embeddedWebRoot, requestPath)
	if err != nil {
		data, err = fs.ReadFile(embeddedWebRoot, "index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		requestPath = "index.html"
	}

	contentType := mime.TypeByExtension(path.Ext(requestPath))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if strings.HasPrefix(contentType, "text/") || strings.Contains(contentType, "javascript") || strings.Contains(contentType, "json") {
		contentType += "; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}

func (s *Server) publishThreadEvent(threadID, payload string) {
	s.publishMu.Lock()
	defer s.publishMu.Unlock()

	if err := s.eventStore.Append(threadID, payload); err != nil {
		return
	}
	nextID := s.sseNextEventID[threadID]
	if nextID == 0 {
		history, err := s.eventStore.Read(threadID)
		if err != nil {
			return
		}
		nextID = len(history)
	}
	nextID++
	s.sseNextEventID[threadID] = nextID
	frame := sseFrame(nextID, payload)

	s.sseMu.Lock()
	subs := s.sseSubs[threadID]
	for id, ch := range subs {
		select {
		case ch <- frame:
		default:
			delete(subs, id)
		}
	}
	if len(subs) == 0 {
		delete(s.sseSubs, threadID)
	}
	s.sseMu.Unlock()
}

func sseFrame(id int, payload string) string {
	parts := strings.Split(payload, "\n")
	var b bytes.Buffer
	b.WriteString(fmt.Sprintf("id: %d\n", id))
	for _, part := range parts {
		b.WriteString("data: ")
		b.WriteString(part)
		b.WriteString("\n")
	}
	b.WriteString("\n")
	return b.String()
}

func (s *Server) bindThreadToSession(threadID string, sess *session) {
	if threadID == "" || sess == nil {
		return
	}
	sess.mu.Lock()
	sess.knownThreadIDs[threadID] = struct{}{}
	sess.mu.Unlock()

	s.sessionsMu.Lock()
	s.threadToSession[threadID] = sess.id
	s.sessionsMu.Unlock()
}

func (s *Server) selectSession(threadIDHint string) (*session, error) {
	s.sessionsMu.RLock()
	if threadIDHint != "" {
		if sessionID, ok := s.threadToSession[threadIDHint]; ok {
			if sess, ok := s.sessions[sessionID]; ok {
				s.sessionsMu.RUnlock()
				return sess, nil
			}
		}
	}
	for _, sess := range s.sessions {
		s.sessionsMu.RUnlock()
		return sess, nil
	}
	s.sessionsMu.RUnlock()

	return s.spawnSession()
}

func (s *Server) spawnSession() (*session, error) {
	cmd := exec.Command("codex", "app-server")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	s.sessionsMu.Lock()
	s.nextSessionID++
	sess := &session{
		id:             s.nextSessionID,
		cmd:            cmd,
		stdin:          stdin,
		pending:        map[int64]chan map[string]any{},
		knownThreadIDs: map[string]struct{}{},
	}
	s.sessions[sess.id] = sess
	s.sessionsMu.Unlock()

	go s.readSessionStdout(sess, stdout)
	go s.readSessionStderr(sess, stderr)
	go s.waitSessionExit(sess)
	return sess, nil
}

func (s *Server) readSessionStdout(sess *session, reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		s.handleSessionLine(sess, line)
	}
}

func (s *Server) readSessionStderr(sess *session, reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		_, _ = fmt.Fprintf(os.Stderr, "[app-server session=%d] %s\n", sess.id, scanner.Text())
	}
}

func (s *Server) waitSessionExit(sess *session) {
	_ = sess.cmd.Wait()

	s.sessionsMu.Lock()
	delete(s.sessions, sess.id)
	for threadID, id := range s.threadToSession {
		if id == sess.id {
			delete(s.threadToSession, threadID)
		}
	}
	for threadID, pending := range s.pendingResponses {
		for requestID, entry := range pending {
			if entry.sessionID == sess.id {
				delete(pending, requestID)
			}
		}
		if len(pending) == 0 {
			delete(s.pendingResponses, threadID)
		}
	}
	s.sessionsMu.Unlock()

	sess.mu.Lock()
	sess.closed = true
	for reqID, ch := range sess.pending {
		delete(sess.pending, reqID)
		close(ch)
	}
	sess.mu.Unlock()
}

func (s *Server) handleSessionLine(sess *session, line string) {
	var parsed map[string]any
	if err := json.Unmarshal([]byte(line), &parsed); err != nil {
		return
	}

	if idFloat, ok := parsed["id"].(float64); ok {
		if _, hasResult := parsed["result"]; hasResult || parsed["error"] != nil {
			requestID := int64(idFloat)
			sess.mu.Lock()
			ch := sess.pending[requestID]
			delete(sess.pending, requestID)
			sess.mu.Unlock()
			if ch != nil {
				ch <- parsed
			}
			return
		}
	}

	method, _ := parsed["method"].(string)
	if method == "" {
		return
	}

	params, _ := parsed["params"].(map[string]any)
	threadID, _ := params["threadId"].(string)
	if threadID == "" {
		if inferred := s.inferThreadID(sess); inferred != "" {
			threadID = inferred
		}
	}

	if idFloat, ok := parsed["id"].(float64); ok {
		if threadID == "" {
			return
		}
		s.bindThreadToSession(threadID, sess)
		requestID := strconv.FormatInt(int64(idFloat), 10)

		s.sessionsMu.Lock()
		threadPending := s.pendingResponses[threadID]
		if threadPending == nil {
			threadPending = map[string]pendingInteraction{}
			s.pendingResponses[threadID] = threadPending
		}
		threadPending[requestID] = pendingInteraction{
			sessionID: sess.id,
			requestID: int64(idFloat),
			method:    method,
			params:    params,
		}
		s.sessionsMu.Unlock()

		payload := map[string]any{
			"method": "darkhold/interaction/request",
			"params": map[string]any{
				"threadId":  threadID,
				"requestId": requestID,
				"method":    method,
				"params":    params,
			},
		}
		encoded, _ := json.Marshal(payload)
		s.publishThreadEvent(threadID, string(encoded))
		return
	}

	if threadID != "" {
		s.bindThreadToSession(threadID, sess)
		s.publishThreadEvent(threadID, line)
	}
}

func (s *Server) inferThreadID(sess *session) string {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if len(sess.knownThreadIDs) != 1 {
		return ""
	}
	for threadID := range sess.knownThreadIDs {
		return threadID
	}
	return ""
}

func (s *Server) ensureInitialized(sess *session) error {
	if sess.upstreamInitialized.Load() {
		return nil
	}
	response, err := s.callSessionRPC(context.Background(), sess, "initialize", map[string]any{
		"clientInfo":   map[string]any{"name": "darkhold-go", "title": "Darkhold Go", "version": "0.1.0"},
		"capabilities": map[string]any{"experimentalApi": true},
	})
	if err != nil {
		return err
	}
	if errObj, ok := response["error"].(map[string]any); ok {
		message, _ := errObj["message"].(string)
		if !strings.Contains(strings.ToLower(message), "already initialized") {
			return errors.New(message)
		}
	}
	sess.upstreamInitialized.Store(true)
	return nil
}

func (s *Server) callSessionRPC(ctx context.Context, sess *session, method string, params any) (map[string]any, error) {
	requestID := atomic.AddInt64(&sess.nextRequestID, 1_000_000)
	responseCh := make(chan map[string]any, 1)

	sess.mu.Lock()
	if sess.closed {
		sess.mu.Unlock()
		return nil, errors.New("app-server session is unavailable")
	}
	sess.pending[requestID] = responseCh
	sess.mu.Unlock()

	payload := map[string]any{"id": requestID, "method": method, "params": params}
	encoded, _ := json.Marshal(payload)
	if err := s.writeSessionLine(sess, string(encoded)); err != nil {
		sess.mu.Lock()
		delete(sess.pending, requestID)
		sess.mu.Unlock()
		return nil, err
	}

	select {
	case <-ctx.Done():
		sess.mu.Lock()
		delete(sess.pending, requestID)
		sess.mu.Unlock()
		return nil, ctx.Err()
	case <-time.After(20 * time.Second):
		sess.mu.Lock()
		delete(sess.pending, requestID)
		sess.mu.Unlock()
		return nil, fmt.Errorf("RPC request timed out: %s", method)
	case response, ok := <-responseCh:
		if !ok {
			return nil, errors.New("app-server session closed")
		}
		return response, nil
	}
}

func (s *Server) writeSessionLine(sess *session, line string) error {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.closed {
		return errors.New("app-server session is unavailable")
	}
	_, err := io.WriteString(sess.stdin, line+"\n")
	return err
}

func (s *Server) Shutdown(ctx context.Context) error {
	done := make(chan struct{})
	go func() {
		s.sessionsMu.RLock()
		sessions := make([]*session, 0, len(s.sessions))
		for _, sess := range s.sessions {
			sessions = append(sessions, sess)
		}
		s.sessionsMu.RUnlock()
		for _, sess := range sessions {
			if sess.cmd.Process != nil {
				_ = sess.cmd.Process.Signal(os.Interrupt)
			}
		}
		close(done)
	}()

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
