package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"darkhold-go/internal/config"
	"darkhold-go/internal/events"
	browserfs "darkhold-go/internal/fs"
)

type integrationServer struct {
	t *testing.T

	baseDir string
	store   *events.Store
	app     *Server
	http    *httptest.Server
}

func canUseLoopbackSockets() bool {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return false
	}
	_ = listener.Close()
	return true
}

func startIntegrationServer(t *testing.T) *integrationServer {
	t.Helper()
	if !canUseLoopbackSockets() {
		t.Skip("loopback sockets are not available in this environment")
	}
	baseDir := t.TempDir()
	fakeBinDir := filepath.Join(baseDir, "bin")
	if err := os.MkdirAll(fakeBinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	codexPath := filepath.Join(fakeBinDir, "codex")
	codexScript := `#!/usr/bin/env node
const readline = require('node:readline');
let threadId = null;
let cwd = '/tmp';
let updatedAt = Math.floor(Date.now() / 1000);
const turns = [];
let turnCounter = 0;
let initialized = false;
let pendingApprovalRequestId = null;
let pendingApprovalThreadId = null;
let pendingApprovalTurnId = null;
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
if (process.argv[2] !== 'app-server') { process.exit(2); }
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (typeof msg.id === 'number' && typeof msg.method !== 'string') {
    if (pendingApprovalRequestId !== null && msg.id === pendingApprovalRequestId) {
      const approvalThreadId = pendingApprovalThreadId || threadId || ('thread-' + process.pid);
      const approvalTurnId = pendingApprovalTurnId || 'turn-' + (turnCounter || 1);
      send({ method: 'item/agentMessage/delta', params: { threadId: approvalThreadId, turnId: approvalTurnId, delta: 'delta-from-' + process.pid } });
      turns.push({
        status: 'completed',
        error: null,
        items: [
          { type: 'userMessage', content: [{ type: 'text', text: 'prompt' }] },
          { type: 'agentMessage', text: 'response-' + process.pid },
        ],
      });
      updatedAt = Math.floor(Date.now() / 1000);
      send({ method: 'turn/completed', params: { threadId: approvalThreadId, turnId: approvalTurnId, turn: { id: approvalTurnId, status: 'completed', error: null } } });
      pendingApprovalRequestId = null;
      pendingApprovalThreadId = null;
      pendingApprovalTurnId = null;
    }
    return;
  }
  if (typeof msg.method !== 'string') { return; }
  const id = msg.id;
  const p = msg.params || {};
  if (msg.method === 'initialize') {
    if (initialized) {
      send({ id, error: { message: 'Already initialized' } });
      return;
    }
    initialized = true;
    send({ id, result: {} });
    return;
  }
  if (msg.method === 'thread/start') {
    threadId = threadId || ('thread-' + process.pid);
    cwd = typeof p.cwd === 'string' ? p.cwd : cwd;
    updatedAt = Math.floor(Date.now() / 1000);
    send({ id, result: { thread: { id: threadId, cwd, updatedAt } } });
    return;
  }
  if (msg.method === 'thread/list') {
    const data = threadId ? [{ id: threadId, cwd, updatedAt }] : [];
    send({ id, result: { data } });
    return;
  }
  if (msg.method === 'thread/read' || msg.method === 'thread/resume') {
    const requestedId = typeof p.threadId === 'string' ? p.threadId : threadId;
    send({ id, result: { thread: { id: requestedId || ('thread-' + process.pid), cwd, updatedAt, turns } } });
    return;
  }
  if (msg.method === 'turn/start') {
    turnCounter += 1;
    const activeThreadId = typeof p.threadId === 'string' ? p.threadId : (threadId || ('thread-' + process.pid));
    threadId = activeThreadId;
    const turnId = 'turn-' + turnCounter;
    send({ id, result: { ok: true } });
    send({ method: 'turn/started', params: { threadId: activeThreadId, turnId, turn: { id: turnId, status: 'inProgress' } } });
    pendingApprovalRequestId = 7000 + turnCounter;
    pendingApprovalThreadId = activeThreadId;
    pendingApprovalTurnId = turnId;
    setTimeout(() => {
      if (pendingApprovalRequestId !== null) {
        send({
          id: pendingApprovalRequestId,
          method: 'execCommandApproval',
          params: { threadId: activeThreadId, command: 'echo from-fake-codex' },
        });
      }
    }, 20);
    return;
  }
  send({ id, result: {} });
});
`
	if err := os.WriteFile(codexPath, []byte(codexScript), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", fakeBinDir+":"+os.Getenv("PATH"))
	if _, err := browserfs.SetBrowserRoot(baseDir); err != nil {
		t.Fatal(err)
	}

	eventRoot := filepath.Join(baseDir, "events")
	if err := os.MkdirAll(eventRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	store := events.NewStore(eventRoot)
	app := New(config.Config{Bind: "127.0.0.1", Port: 0}, store)
	httpSrv := httptest.NewServer(app.Handler())

	return &integrationServer{t: t, baseDir: baseDir, store: store, app: app, http: httpSrv}
}

func (s *integrationServer) close() {
	_ = s.app.Shutdown(context.Background())
	s.http.Close()
	_ = s.store.Cleanup()
}

func postRPC[T any](t *testing.T, baseURL, method string, params any) T {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"method": method, "params": params})
	resp, err := http.Post(baseURL+"/api/rpc", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var payload T
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var errPayload map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&errPayload)
		t.Fatalf("RPC %s failed: %v", method, errPayload)
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

type sseEvent struct {
	ID   int
	Data string
}

func openSSE(t *testing.T, baseURL, threadID string, lastEventID int) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, baseURL+"/api/thread/events/stream?threadId="+threadID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if lastEventID > 0 {
		req.Header.Set("Last-Event-ID", strconv.Itoa(lastEventID))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		var payload map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&payload)
		t.Fatalf("SSE open failed: %v", payload)
	}
	return resp
}

func waitForSSEEvent(t *testing.T, resp *http.Response, predicate func(sseEvent) bool, timeout time.Duration) sseEvent {
	t.Helper()
	scanner := bufio.NewScanner(resp.Body)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		id := 0
		dataLines := []string{}
		for scanner.Scan() {
			line := scanner.Text()
			if strings.TrimSpace(line) == "" {
				break
			}
			if strings.HasPrefix(line, ":") {
				continue
			}
			if strings.HasPrefix(line, "id:") {
				parsed, _ := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "id:")))
				id = parsed
			}
			if strings.HasPrefix(line, "data:") {
				dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			}
		}
		if len(dataLines) == 0 {
			continue
		}
		event := sseEvent{ID: id, Data: strings.Join(dataLines, "\n")}
		if predicate(event) {
			return event
		}
	}
	t.Fatal("sse event timeout")
	return sseEvent{}
}

func parseJSON(t *testing.T, raw string) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func acceptNextApproval(t *testing.T, baseURL, threadID string, sse *http.Response) {
	t.Helper()
	event := waitForSSEEvent(t, sse, func(event sseEvent) bool {
		parsed := parseJSON(t, event.Data)
		if parsed["method"] != "darkhold/interaction/request" {
			return false
		}
		params, _ := parsed["params"].(map[string]any)
		tid, _ := params["threadId"].(string)
		return tid == threadID
	}, 10*time.Second)
	parsed := parseJSON(t, event.Data)
	params, _ := parsed["params"].(map[string]any)
	requestID, _ := params["requestId"].(string)
	if requestID == "" {
		t.Fatal("missing requestId")
	}

	body, _ := json.Marshal(map[string]any{"threadId": threadID, "requestId": requestID, "result": map[string]any{"decision": "accept"}})
	resp, err := http.Post(baseURL+"/api/thread/interaction/respond", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var payload map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&payload)
		t.Fatalf("approval failed: %v", payload)
	}
}

func TestRehydrateThreadEventCacheFromThreadRead(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	started := postRPC[map[string]any](t, s.http.URL, "thread/start", map[string]any{"cwd": s.baseDir})
	thread := started["thread"].(map[string]any)
	threadID := thread["id"].(string)
	sse := openSSE(t, s.http.URL, threadID, 0)
	defer sse.Body.Close()

	_ = postRPC[map[string]any](t, s.http.URL, "turn/start", map[string]any{"threadId": threadID, "input": []any{map[string]any{"type": "text", "text": "hi"}}})
	acceptNextApproval(t, s.http.URL, threadID, sse)
	waitForSSEEvent(t, sse, func(event sseEvent) bool {
		parsed := parseJSON(t, event.Data)
		return parsed["method"] == "turn/completed"
	}, 10*time.Second)

	_ = postRPC[map[string]any](t, s.http.URL, "thread/read", map[string]any{"threadId": threadID, "includeTurns": true})
	resp, err := http.Get(s.http.URL + "/api/thread/events?threadId=" + threadID)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	eventsAny, _ := body["events"].([]any)
	if len(eventsAny) == 0 {
		t.Fatal("expected events")
	}
}

func TestBroadcastsThreadEventsToMultipleSSEClientsAndReconnect(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	started := postRPC[map[string]any](t, s.http.URL, "thread/start", map[string]any{"cwd": s.baseDir})
	threadID := started["thread"].(map[string]any)["id"].(string)
	sse1 := openSSE(t, s.http.URL, threadID, 0)
	defer sse1.Body.Close()
	sse2 := openSSE(t, s.http.URL, threadID, 0)
	defer sse2.Body.Close()

	_ = postRPC[map[string]any](t, s.http.URL, "turn/start", map[string]any{"threadId": threadID, "input": []any{map[string]any{"type": "text", "text": "first"}}})
	acceptNextApproval(t, s.http.URL, threadID, sse1)
	delta1 := waitForSSEEvent(t, sse1, func(event sseEvent) bool {
		return parseJSON(t, event.Data)["method"] == "item/agentMessage/delta"
	}, 10*time.Second)
	delta2 := waitForSSEEvent(t, sse2, func(event sseEvent) bool {
		return parseJSON(t, event.Data)["method"] == "item/agentMessage/delta"
	}, 10*time.Second)
	if !strings.Contains(parseJSON(t, delta1.Data)["params"].(map[string]any)["delta"].(string), "delta-from-") {
		t.Fatal("missing delta in client 1")
	}
	if !strings.Contains(parseJSON(t, delta2.Data)["params"].(map[string]any)["delta"].(string), "delta-from-") {
		t.Fatal("missing delta in client 2")
	}

	sse2Reconnect := openSSE(t, s.http.URL, threadID, delta2.ID)
	defer sse2Reconnect.Body.Close()

	_ = postRPC[map[string]any](t, s.http.URL, "turn/start", map[string]any{"threadId": threadID, "input": []any{map[string]any{"type": "text", "text": "second"}}})
	acceptNextApproval(t, s.http.URL, threadID, sse1)
	_ = waitForSSEEvent(t, sse1, func(event sseEvent) bool { return parseJSON(t, event.Data)["method"] == "item/agentMessage/delta" }, 10*time.Second)
	_ = waitForSSEEvent(t, sse2Reconnect, func(event sseEvent) bool { return parseJSON(t, event.Data)["method"] == "item/agentMessage/delta" }, 10*time.Second)
}

func TestAllowsTurnStartFromSeparateHTTPCallersOnSameThread(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	started := postRPC[map[string]any](t, s.http.URL, "thread/start", map[string]any{"cwd": s.baseDir})
	threadID := started["thread"].(map[string]any)["id"].(string)
	sse := openSSE(t, s.http.URL, threadID, 0)
	defer sse.Body.Close()

	first := postRPC[map[string]any](t, s.http.URL, "turn/start", map[string]any{"threadId": threadID, "input": []any{map[string]any{"type": "text", "text": "first"}}})
	if ok, _ := first["ok"].(bool); !ok {
		t.Fatal("first turn/start did not return ok")
	}
	acceptNextApproval(t, s.http.URL, threadID, sse)
	_ = waitForSSEEvent(t, sse, func(event sseEvent) bool { return parseJSON(t, event.Data)["method"] == "turn/completed" }, 10*time.Second)

	second := postRPC[map[string]any](t, s.http.URL, "turn/start", map[string]any{"threadId": threadID, "input": []any{map[string]any{"type": "text", "text": "second"}}})
	if ok, _ := second["ok"].(bool); !ok {
		t.Fatal("second turn/start did not return ok")
	}
	acceptNextApproval(t, s.http.URL, threadID, sse)
	_ = waitForSSEEvent(t, sse, func(event sseEvent) bool { return parseJSON(t, event.Data)["method"] == "turn/completed" }, 10*time.Second)
}

func TestBroadcastsApprovalRequestsToAllSSEClientsAndAcceptsFirstResponse(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	started := postRPC[map[string]any](t, s.http.URL, "thread/start", map[string]any{"cwd": s.baseDir})
	threadID := started["thread"].(map[string]any)["id"].(string)
	sse1 := openSSE(t, s.http.URL, threadID, 0)
	defer sse1.Body.Close()
	sse2 := openSSE(t, s.http.URL, threadID, 0)
	defer sse2.Body.Close()

	_ = postRPC[map[string]any](t, s.http.URL, "turn/start", map[string]any{"threadId": threadID, "input": []any{map[string]any{"type": "text", "text": "needs approval"}}})
	approval1 := waitForSSEEvent(t, sse1, func(event sseEvent) bool { return parseJSON(t, event.Data)["method"] == "darkhold/interaction/request" }, 10*time.Second)
	approval2 := waitForSSEEvent(t, sse2, func(event sseEvent) bool { return parseJSON(t, event.Data)["method"] == "darkhold/interaction/request" }, 10*time.Second)

	requestID := parseJSON(t, approval2.Data)["params"].(map[string]any)["requestId"].(string)
	if requestID == "" {
		t.Fatal("missing request id")
	}

	body, _ := json.Marshal(map[string]any{"threadId": threadID, "requestId": requestID, "result": map[string]any{"decision": "accept"}})
	resp, err := http.Post(s.http.URL+"/api/thread/interaction/respond", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	dupResp, err := http.Post(s.http.URL+"/api/thread/interaction/respond", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer dupResp.Body.Close()
	if dupResp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 on duplicate, got %d", dupResp.StatusCode)
	}

	_ = waitForSSEEvent(t, sse1, func(event sseEvent) bool { return parseJSON(t, event.Data)["method"] == "turn/completed" }, 10*time.Second)
	if approval1.ID == 0 || approval2.ID == 0 {
		t.Fatal("expected non-zero sse ids")
	}
}

func TestSSEResumeWithLastEventID(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	started := postRPC[map[string]any](t, s.http.URL, "thread/start", map[string]any{"cwd": s.baseDir})
	threadID := started["thread"].(map[string]any)["id"].(string)
	sse := openSSE(t, s.http.URL, threadID, 0)
	defer sse.Body.Close()

	_ = postRPC[map[string]any](t, s.http.URL, "turn/start", map[string]any{"threadId": threadID, "input": []any{map[string]any{"type": "text", "text": "resume"}}})
	acceptNextApproval(t, s.http.URL, threadID, sse)
	firstDelta := waitForSSEEvent(t, sse, func(event sseEvent) bool { return parseJSON(t, event.Data)["method"] == "item/agentMessage/delta" }, 10*time.Second)

	resumed := openSSE(t, s.http.URL, threadID, firstDelta.ID)
	defer resumed.Body.Close()

	_ = postRPC[map[string]any](t, s.http.URL, "turn/start", map[string]any{"threadId": threadID, "input": []any{map[string]any{"type": "text", "text": "resume-2"}}})
	acceptNextApproval(t, s.http.URL, threadID, sse)
	_ = waitForSSEEvent(t, resumed, func(event sseEvent) bool {
		parsed := parseJSON(t, event.Data)
		return parsed["method"] == "item/agentMessage/delta"
	}, 10*time.Second)
}

func TestHTTPRPCValidation(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	resp, err := http.Post(s.http.URL+"/api/rpc", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestThreadInteractionRespondValidation(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	resp, err := http.Post(s.http.URL+"/api/thread/interaction/respond", "application/json", strings.NewReader(`{"threadId":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestHealthAndFSList(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	resp, err := http.Get(s.http.URL + "/api/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	fsResp, err := http.Get(s.http.URL + "/api/fs/list")
	if err != nil {
		t.Fatal(err)
	}
	defer fsResp.Body.Close()
	if fsResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", fsResp.StatusCode)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	req, err := http.NewRequest(http.MethodPost, s.http.URL+"/api/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", resp.StatusCode)
	}
}

func TestThreadEventsRequiresThreadID(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	resp, err := http.Get(s.http.URL + "/api/thread/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestSSERequiresThreadID(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	resp, err := http.Get(s.http.URL + "/api/thread/events/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestUnknownRoute(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	resp, err := http.Get(s.http.URL + "/api/missing")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", resp.StatusCode)
	}
}

func TestInteractionResolvedEventPublished(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	started := postRPC[map[string]any](t, s.http.URL, "thread/start", map[string]any{"cwd": s.baseDir})
	threadID := started["thread"].(map[string]any)["id"].(string)
	sse := openSSE(t, s.http.URL, threadID, 0)
	defer sse.Body.Close()

	_ = postRPC[map[string]any](t, s.http.URL, "turn/start", map[string]any{"threadId": threadID, "input": []any{map[string]any{"type": "text", "text": "resolve-event"}}})
	approval := waitForSSEEvent(t, sse, func(event sseEvent) bool {
		return parseJSON(t, event.Data)["method"] == "darkhold/interaction/request"
	}, 10*time.Second)
	requestID := parseJSON(t, approval.Data)["params"].(map[string]any)["requestId"].(string)
	body, _ := json.Marshal(map[string]any{"threadId": threadID, "requestId": requestID, "result": map[string]any{"decision": "accept"}})
	resp, err := http.Post(s.http.URL+"/api/thread/interaction/respond", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	_ = waitForSSEEvent(t, sse, func(event sseEvent) bool {
		return parseJSON(t, event.Data)["method"] == "darkhold/interaction/resolved"
	}, 10*time.Second)
}

func TestFSListPathValidation(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	resp, err := http.Get(s.http.URL + "/api/fs/list?path=/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestCIDRFilter(t *testing.T) {
	if !canUseLoopbackSockets() {
		t.Skip("loopback sockets are not available in this environment")
	}
	cfg := config.Config{Bind: "127.0.0.1", Port: 0, AllowCIDRs: []string{"10.0.0.0/8"}}
	store := events.NewStore(filepath.Join(t.TempDir(), "events"))
	if _, err := browserfs.SetBrowserRoot(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	app := New(cfg, store)
	httpSrv := httptest.NewServer(app.Handler())
	defer httpSrv.Close()
	defer store.Cleanup()

	resp, err := http.Get(httpSrv.URL + "/api/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("loopback should still be allowed, got %d", resp.StatusCode)
	}
}

func TestThreadInteractionConflictWhenUnknown(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	resp, err := http.Post(s.http.URL+"/api/thread/interaction/respond", "application/json", strings.NewReader(`{"threadId":"a","requestId":"b","result":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409, got %d", resp.StatusCode)
	}
}

func TestThreadEventsReadEmpty(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	resp, err := http.Get(s.http.URL + "/api/thread/events?threadId=unknown")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	eventsAny, _ := payload["events"].([]any)
	if len(eventsAny) != 0 {
		t.Fatalf("expected empty events, got %d", len(eventsAny))
	}
}

func TestRPCThreadList(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	_ = postRPC[map[string]any](t, s.http.URL, "thread/start", map[string]any{"cwd": s.baseDir})
	list := postRPC[map[string]any](t, s.http.URL, "thread/list", map[string]any{"limit": 50, "archived": false})
	data, _ := list["data"].([]any)
	if len(data) == 0 {
		t.Fatal("expected thread/list data")
	}
}

func TestRPCThreadResumeFallsBackToRead(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	started := postRPC[map[string]any](t, s.http.URL, "thread/start", map[string]any{"cwd": s.baseDir})
	threadID := started["thread"].(map[string]any)["id"].(string)
	resumed := postRPC[map[string]any](t, s.http.URL, "thread/resume", map[string]any{"threadId": threadID})
	thread, _ := resumed["thread"].(map[string]any)
	if thread["id"].(string) != threadID {
		t.Fatalf("expected thread %s", threadID)
	}
}

func TestSSEKeepsOrderByID(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	started := postRPC[map[string]any](t, s.http.URL, "thread/start", map[string]any{"cwd": s.baseDir})
	threadID := started["thread"].(map[string]any)["id"].(string)
	sse := openSSE(t, s.http.URL, threadID, 0)
	defer sse.Body.Close()

	_ = postRPC[map[string]any](t, s.http.URL, "turn/start", map[string]any{"threadId": threadID, "input": []any{map[string]any{"type": "text", "text": "order"}}})
	acceptNextApproval(t, s.http.URL, threadID, sse)
	e1 := waitForSSEEvent(t, sse, func(event sseEvent) bool { return parseJSON(t, event.Data)["method"] == "turn/started" }, 10*time.Second)
	e2 := waitForSSEEvent(t, sse, func(event sseEvent) bool { return parseJSON(t, event.Data)["method"] == "item/agentMessage/delta" }, 10*time.Second)
	if e2.ID <= e1.ID {
		t.Fatalf("expected increasing ids, got %d then %d", e1.ID, e2.ID)
	}
}

func TestShutdownDoesNotError(t *testing.T) {
	s := startIntegrationServer(t)
	if err := s.app.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	s.http.Close()
}

func TestNoMethodInRPC(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	resp, err := http.Post(s.http.URL+"/api/rpc", "application/json", strings.NewReader(`{"params":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestInvalidJSONInRPC(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	resp, err := http.Post(s.http.URL+"/api/rpc", "application/json", strings.NewReader(`{`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestInvalidJSONInInteractionRespond(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	resp, err := http.Post(s.http.URL+"/api/thread/interaction/respond", "application/json", strings.NewReader(`{`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestWebIndexRoute(t *testing.T) {
	s := startIntegrationServer(t)
	defer s.close()

	resp, err := http.Get(s.http.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	cacheControl := resp.Header.Get("Cache-Control")
	if cacheControl != "no-store" {
		t.Fatalf("expected no-store cache control, got %q", cacheControl)
	}
	buf := make([]byte, 15)
	_, _ = resp.Body.Read(buf)
	_ = fmt.Sprintf("%s", string(buf))
}
