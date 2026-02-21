package server

import (
	"bufio"
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
	sse "github.com/tmaxmax/go-sse"
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
	activeTurnIDs  map[string]struct{}
	lastActivityAt time.Time
	closed         bool
	stopRequested  bool
}

type pendingInteraction struct {
	sessionID int
	requestID int64
	method    string
	params    any
}

type threadSummary struct {
	ID        string `json:"id"`
	Cwd       string `json:"cwd"`
	UpdatedAt int64  `json:"updatedAt"`
}

type Server struct {
	cfg config.Config

	eventStore *events.Store
	shutdownMu sync.Once
	reaperStop chan struct{}

	sessionsMu       sync.RWMutex
	sessions         map[int]*session
	threadToSession  map[string]int
	nextSessionID    int
	pendingResponses map[string]map[string]pendingInteraction
	threadsMu        sync.RWMutex
	knownThreads     map[string]threadSummary

	sseProvider sse.Provider

	publishMu sync.Mutex

	sessionTimingMu     sync.RWMutex
	sessionIdleTTL      time.Duration
	sessionReapInterval time.Duration
}

type channelMessageWriter struct {
	ch chan *sse.Message
}

func (w *channelMessageWriter) Send(message *sse.Message) error {
	select {
	case w.ch <- message.Clone():
		return nil
	default:
		return errors.New("sse subscriber is backpressured")
	}
}

func (w *channelMessageWriter) Flush() error {
	return nil
}

func New(cfg config.Config, eventStore *events.Store) *Server {
	replayer, err := sse.NewValidReplayer(24*time.Hour, false)
	if err != nil {
		panic(err)
	}
	provider := &sse.Joe{Replayer: replayer}
	s := &Server{
		cfg:                 cfg,
		eventStore:          eventStore,
		reaperStop:          make(chan struct{}),
		sessions:            map[int]*session{},
		threadToSession:     map[string]int{},
		pendingResponses:    map[string]map[string]pendingInteraction{},
		knownThreads:        map[string]threadSummary{},
		sseProvider:         provider,
		sessionIdleTTL:      5 * time.Minute,
		sessionReapInterval: 5 * time.Second,
	}
	go s.sessionIdleReaper()
	return s
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
	history, err := s.eventStore.ReadRecords(threadID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}

	sess, err := sse.Upgrade(w, r)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	ready := &sse.Message{}
	ready.AppendComment("ready")
	if err := sess.Send(ready); err != nil {
		return
	}
	_ = sess.Flush()

	for _, record := range history {
		if lastEventIDRaw != "" && record.ID <= lastEventIDRaw {
			continue
		}
		if err := sendSSEMessage(sess, record.ID, record.Payload); err != nil {
			return
		}
	}
	_ = sess.Flush()
	replayCursor := lastEventIDRaw
	for _, record := range history {
		if replayCursor == "" || record.ID > replayCursor {
			replayCursor = record.ID
		}
	}
	writer := &channelMessageWriter{ch: make(chan *sse.Message, 128)}
	sub := sse.Subscription{
		Client: writer,
		Topics: []string{threadID},
	}
	if replayCursor != "" {
		sub.LastEventID = sse.ID(replayCursor)
	}
	subscribeErr := make(chan error, 1)
	go func() {
		subscribeErr <- s.sseProvider.Subscribe(r.Context(), sub)
	}()
	for {
		select {
		case <-r.Context().Done():
			return
		case err := <-subscribeErr:
			if err != nil && !errors.Is(err, context.Canceled) {
				return
			}
			return
		case message := <-writer.ch:
			if err := sess.Send(message); err != nil {
				return
			}
			_ = sess.Flush()
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
	if requestPath == "api" || strings.HasPrefix(requestPath, "api/") {
		http.NotFound(w, r)
		return
	}
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

	eventID, err := s.eventStore.Append(threadID, payload)
	if err != nil {
		return
	}
	msg := &sse.Message{ID: sse.ID(eventID)}
	msg.AppendData(payload)
	_ = s.sseProvider.Publish(msg, []string{threadID})
}

func sendSSEMessage(sess *sse.Session, id, payload string) error {
	msg := &sse.Message{ID: sse.ID(id)}
	msg.AppendData(payload)
	return sess.Send(msg)
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
	now := time.Now()
	sess := &session{
		id:             s.nextSessionID,
		cmd:            cmd,
		stdin:          stdin,
		pending:        map[int64]chan map[string]any{},
		knownThreadIDs: map[string]struct{}{},
		activeTurnIDs:  map[string]struct{}{},
		lastActivityAt: now,
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
	s.markSessionActivity(sess)

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
	s.trackSessionTurnState(sess, method, params)
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
	s.markSessionActivity(sess)
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
	s.shutdownMu.Do(func() {
		close(s.reaperStop)
	})

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
		_ = s.sseProvider.Shutdown(ctx)
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) sessionIdleReaper() {
	for {
		select {
		case <-s.reaperStop:
			return
		case <-time.After(s.getSessionReapInterval()):
		}
		now := time.Now()
		s.sessionsMu.RLock()
		sessions := make([]*session, 0, len(s.sessions))
		for _, sess := range s.sessions {
			sessions = append(sessions, sess)
		}
		s.sessionsMu.RUnlock()
		for _, sess := range sessions {
			if s.shouldReapSession(sess, now) {
				s.requestSessionStop(sess)
			}
		}
	}
}

func (s *Server) shouldReapSession(sess *session, now time.Time) bool {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.closed || sess.stopRequested {
		return false
	}
	if len(sess.activeTurnIDs) > 0 {
		return false
	}
	return now.Sub(sess.lastActivityAt) >= s.getSessionIdleTTL()
}

func (s *Server) setSessionTiming(idleTTL, reapInterval time.Duration) {
	s.sessionTimingMu.Lock()
	s.sessionIdleTTL = idleTTL
	s.sessionReapInterval = reapInterval
	s.sessionTimingMu.Unlock()
}

func (s *Server) getSessionIdleTTL() time.Duration {
	s.sessionTimingMu.RLock()
	defer s.sessionTimingMu.RUnlock()
	return s.sessionIdleTTL
}

func (s *Server) getSessionReapInterval() time.Duration {
	s.sessionTimingMu.RLock()
	defer s.sessionTimingMu.RUnlock()
	return s.sessionReapInterval
}

func (s *Server) requestSessionStop(sess *session) {
	sess.mu.Lock()
	if sess.closed || sess.stopRequested {
		sess.mu.Unlock()
		return
	}
	sess.stopRequested = true
	sess.mu.Unlock()

	if sess.cmd.Process != nil {
		_ = sess.cmd.Process.Signal(os.Interrupt)
	}
}

func (s *Server) markSessionActivity(sess *session) {
	sess.mu.Lock()
	sess.lastActivityAt = time.Now()
	sess.mu.Unlock()
}

func (s *Server) trackSessionTurnState(sess *session, method string, params map[string]any) {
	turnID := ""
	if params != nil {
		if v, ok := params["turnId"].(string); ok {
			turnID = v
		}
		if turnID == "" {
			if turnObj, ok := params["turn"].(map[string]any); ok {
				if v, ok := turnObj["id"].(string); ok {
					turnID = v
				}
			}
		}
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	switch method {
	case "turn/started":
		if turnID != "" {
			sess.activeTurnIDs[turnID] = struct{}{}
		}
	case "turn/completed", "turn/aborted", "turn/failed":
		if turnID != "" {
			delete(sess.activeTurnIDs, turnID)
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
