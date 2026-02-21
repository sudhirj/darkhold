/**
 * Darkhold server smoke tests.
 *
 * Run against a live server with real codex backend. Exercises the full
 * HTTP stack from a separate process: health, filesystem, RPC, SSE
 * streaming, parallel reads, reconnection, and multi-turn conversations.
 *
 * Usage:
 *   npx tsx smoke.test.ts              # defaults to http://127.0.0.1:3275
 *   BASE_URL=http://localhost:4000 npx tsx smoke.test.ts
 */

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3275";
// Simple prompts that complete without command approval (no tool use)
const SIMPLE_PROMPT = "What is 2+2? Reply with just the number.";
// Longer timeout for turns that go through the real LLM
const TURN_TIMEOUT = 30_000;

// ── Helpers ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  const t0 = performance.now();
  try {
    await fn();
    const ms = (performance.now() - t0).toFixed(0);
    console.log(`  ✓ ${name} (${ms}ms)`);
    passed++;
  } catch (err: any) {
    const ms = (performance.now() - t0).toFixed(0);
    console.log(`  ✗ ${name} (${ms}ms)`);
    console.log(`    ${err.message ?? err}`);
    failed++;
    failures.push(name);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected)
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function jsonFetch<T = any>(
  path: string,
  opts?: RequestInit & { expectStatus?: number }
): Promise<{ status: number; body: T }> {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const res = await fetch(url, opts);
  const body = (await res.json().catch(() => null)) as T;
  if (opts?.expectStatus !== undefined) {
    assertEqual(
      res.status,
      opts.expectStatus,
      `${opts.method ?? "GET"} ${path} status`
    );
  }
  return { status: res.status, body };
}

async function postJSON<T = any>(
  path: string,
  data: any,
  expectStatus?: number
) {
  return jsonFetch<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    expectStatus,
  });
}

async function rpc<T = any>(method: string, params: any = {}) {
  const { body } = await postJSON<T>("/api/rpc", { method, params }, 200);
  return body;
}

// ── SSE helpers ──────────────────────────────────────────────────────

interface SSEEvent {
  id: string;
  data: string;
  parsed: any;
}

class SSEReader {
  private controller: AbortController;
  private events: SSEEvent[] = [];
  private seenEventIds = new Set<string>();
  private waiters: Array<{
    pred: (e: SSEEvent) => boolean;
    resolve: (e: SSEEvent) => void;
    reject: (e: Error) => void;
  }> = [];
  public connected = false;
  public error: string | null = null;

  constructor(
    public readonly threadId: string,
    lastEventId?: string
  ) {
    this.controller = new AbortController();
    this.start(lastEventId);
  }

  private async start(lastEventId?: string) {
    const url = `${BASE}/api/thread/events/stream?threadId=${this.threadId}`;
    const headers: Record<string, string> = {};
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;

    try {
      const res = await fetch(url, {
        headers,
        signal: this.controller.signal,
      });
      if (res.status !== 200) {
        this.error = `SSE open failed: ${res.status}`;
        return;
      }
      this.connected = true;
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!;
        let currentId = "";
        let currentData: string[] = [];
        for (const line of lines) {
          if (line.startsWith("id:")) {
            currentId = line.slice(3).trim();
          } else if (line.startsWith("data:")) {
            currentData.push(line.slice(5).trim());
          } else if (line.startsWith(":")) {
            // comment
          } else if (line.trim() === "") {
            if (currentData.length > 0) {
              const dataStr = currentData.join("\n");
              let parsed: any = null;
              try {
                parsed = JSON.parse(dataStr);
              } catch {}
              const event: SSEEvent = {
                id: currentId,
                data: dataStr,
                parsed,
              };
              this.events.push(event);
              if (currentId) this.seenEventIds.add(currentId);
              for (let i = this.waiters.length - 1; i >= 0; i--) {
                if (this.waiters[i].pred(event)) {
                  this.waiters[i].resolve(event);
                  this.waiters.splice(i, 1);
                }
              }
            }
            currentId = "";
            currentData = [];
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        this.error = err.message;
      }
    }
  }

  waitFor(
    pred: (e: SSEEvent) => boolean,
    timeoutMs = TURN_TIMEOUT
  ): Promise<SSEEvent> {
    const existing = this.events.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(
          new Error(
            `SSE waitFor timed out after ${timeoutMs}ms (${this.events.length} events buffered)`
          )
        );
      }, timeoutMs);
      this.waiters.push({
        pred,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
        reject,
      });
    });
  }

  /** Wait for a NEW event (not already seen) matching the method. */
  waitForNewMethod(method: string, timeoutMs = TURN_TIMEOUT): Promise<SSEEvent> {
    const alreadySeen = new Set(this.events.map((e) => e.id));
    return this.waitFor(
      (e) => e.parsed?.method === method && !alreadySeen.has(e.id),
      timeoutMs
    );
  }

  waitForMethod(
    method: string,
    timeoutMs = TURN_TIMEOUT
  ): Promise<SSEEvent> {
    return this.waitFor((e) => e.parsed?.method === method, timeoutMs);
  }

  allEvents() {
    return [...this.events];
  }

  lastEventId() {
    return this.events.length > 0
      ? this.events[this.events.length - 1].id
      : "";
  }

  close() {
    this.controller.abort();
    for (const w of this.waiters) {
      w.reject(new Error("SSE reader closed"));
    }
    this.waiters = [];
  }
}

// ── Wait for a turn to complete (handles approval if needed) ─────────

async function waitTurnCompleted(
  threadId: string,
  sse: SSEReader
): Promise<SSEEvent> {
  // Real codex may or may not send an approval request depending on the
  // prompt.  We race both possibilities.
  const alreadySeen = new Set(sse.allEvents().map((e) => e.id));

  return new Promise<SSEEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `waitTurnCompleted timed out (${sse.allEvents().length} events)`
        )
      );
    }, TURN_TIMEOUT);

    const checkEvent = async (e: SSEEvent) => {
      if (alreadySeen.has(e.id)) return;
      const method = e.parsed?.method;

      if (method === "turn/completed") {
        clearTimeout(timeout);
        resolve(e);
        return;
      }

      if (method === "darkhold/interaction/request") {
        // Auto-accept
        const requestId = e.parsed.params?.requestId;
        if (requestId) {
          try {
            await postJSON(
              "/api/thread/interaction/respond",
              { threadId, requestId, result: { decision: "accept" } },
              200
            );
          } catch {
            // May have been accepted already by another client
          }
        }
      }
    };

    // Check buffered events
    for (const e of sse.allEvents()) {
      checkEvent(e);
    }

    // Also wait for new events
    const poll = setInterval(() => {
      for (const e of sse.allEvents()) {
        checkEvent(e);
      }
    }, 100);

    // Also use waitFor as primary mechanism
    sse
      .waitFor(
        (e) => e.parsed?.method === "turn/completed" && !alreadySeen.has(e.id),
        TURN_TIMEOUT
      )
      .then((e) => {
        clearTimeout(timeout);
        clearInterval(poll);
        resolve(e);
      })
      .catch(() => {});

    // Also handle approval inline
    sse
      .waitFor(
        (e) =>
          e.parsed?.method === "darkhold/interaction/request" &&
          !alreadySeen.has(e.id),
        TURN_TIMEOUT
      )
      .then((e) => checkEvent(e))
      .catch(() => {});
  });
}

async function runFullTurn(
  threadId: string,
  prompt: string,
  sse: SSEReader
): Promise<SSEEvent> {
  await rpc("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt }],
  });
  return waitTurnCompleted(threadId, sse);
}

// ═════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════

async function runSuite() {
  console.log(`\nDarkhold smoke tests against ${BASE}\n`);

  // ── 1. Health & meta endpoints ─────────────────────────────────

  console.log("─── Health & Meta ───");

  await test("GET /api/health returns 200 with ok:true", async () => {
    const { status, body } = await jsonFetch("/api/health");
    assertEqual(status, 200, "status");
    assertEqual(body.ok, true, "body.ok");
    assert(typeof body.basePath === "string", "basePath is string");
  });

  await test("POST /api/health returns 405", async () => {
    const res = await fetch(`${BASE}/api/health`, { method: "POST" });
    assertEqual(res.status, 405, "status");
  });

  await test("GET /api/missing returns 404", async () => {
    const res = await fetch(`${BASE}/api/missing`);
    assertEqual(res.status, 404, "status");
  });

  await test("GET / returns HTML with no-store cache", async () => {
    const res = await fetch(`${BASE}/`);
    assertEqual(res.status, 200, "status");
    const cc = res.headers.get("cache-control");
    assert(
      cc === "no-store",
      `cache-control should be no-store, got ${cc}`
    );
    const text = await res.text();
    assert(
      text.includes("<!doctype html") || text.includes("<!DOCTYPE html"),
      "should be HTML"
    );
  });

  // ── 2. FS endpoint ─────────────────────────────────────────────

  console.log("\n─── FS List ───");

  await test("GET /api/fs/list without path returns entries", async () => {
    const { status, body } = await jsonFetch("/api/fs/list");
    assertEqual(status, 200, "status");
    assert(Array.isArray(body.entries), "entries should be array");
    assert(body.entries.length > 0, "should have at least one entry");
    // The response has "root" for the base path
    assert(
      typeof body.root === "string" || typeof body.basePath === "string",
      "should have root or basePath"
    );
  });

  await test("GET /api/fs/list with subpath returns entries", async () => {
    const { status, body } = await jsonFetch("/api/fs/list");
    // Pick the first directory from the listing
    const dir = body.entries?.find((e: any) => e.kind === "directory");
    if (!dir) return; // skip if no directories
    const { status: s2, body: b2 } = await jsonFetch(
      `/api/fs/list?path=${encodeURIComponent(dir.path)}`
    );
    assertEqual(s2, 200, "subpath status");
    assert(Array.isArray(b2.entries), "subpath entries should be array");
  });

  await test("GET /api/fs/list with bad path returns 400", async () => {
    const { status } = await jsonFetch("/api/fs/list?path=/");
    assertEqual(status, 400, "status");
  });

  await test("POST /api/fs/list returns 405", async () => {
    const res = await fetch(`${BASE}/api/fs/list`, { method: "POST" });
    assertEqual(res.status, 405, "status");
  });

  // ── 3. RPC validation ──────────────────────────────────────────

  console.log("\n─── RPC Validation ───");

  await test("POST /api/rpc with empty body returns 400", async () => {
    const { status } = await postJSON("/api/rpc", {});
    assertEqual(status, 400, "status");
  });

  await test("POST /api/rpc with no method returns 400", async () => {
    const { status } = await postJSON("/api/rpc", { params: {} });
    assertEqual(status, 400, "status");
  });

  await test("POST /api/rpc with invalid JSON returns 400", async () => {
    const res = await fetch(`${BASE}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    assertEqual(res.status, 400, "status");
  });

  await test("GET /api/rpc returns 405", async () => {
    const res = await fetch(`${BASE}/api/rpc`);
    assertEqual(res.status, 405, "status");
  });

  // ── 4. Interaction respond validation ──────────────────────────

  console.log("\n─── Interaction Respond Validation ───");

  await test(
    "POST /api/thread/interaction/respond missing requestId returns 400",
    async () => {
      const { status } = await postJSON(
        "/api/thread/interaction/respond",
        { threadId: "x" }
      );
      assertEqual(status, 400, "status");
    }
  );

  await test(
    "POST /api/thread/interaction/respond unknown thread returns 409",
    async () => {
      const { status } = await postJSON(
        "/api/thread/interaction/respond",
        { threadId: "nonexistent", requestId: "fake-req", result: {} }
      );
      assertEqual(status, 409, "status");
    }
  );

  await test(
    "POST /api/thread/interaction/respond with invalid JSON returns 400",
    async () => {
      const res = await fetch(
        `${BASE}/api/thread/interaction/respond`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        }
      );
      assertEqual(res.status, 400, "status");
    }
  );

  // ── 5. Thread events validation ────────────────────────────────

  console.log("\n─── Thread Events Validation ───");

  await test("GET /api/thread/events without threadId returns 400", async () => {
    const { status } = await jsonFetch("/api/thread/events");
    assertEqual(status, 400, "status");
  });

  await test(
    "GET /api/thread/events for unknown thread returns empty list",
    async () => {
      const { status, body } = await jsonFetch(
        "/api/thread/events?threadId=nonexistent"
      );
      assertEqual(status, 200, "status");
      assert(Array.isArray(body.events), "events should be array");
      assertEqual(body.events.length, 0, "events count");
    }
  );

  await test(
    "GET /api/thread/events/stream without threadId returns 400",
    async () => {
      const { status } = await jsonFetch("/api/thread/events/stream");
      assertEqual(status, 400, "status");
    }
  );

  // ── 6. Thread lifecycle ────────────────────────────────────────

  console.log("\n─── Thread Lifecycle ───");

  let threadId = "";

  await test("thread/start creates a new thread", async () => {
    const result = await rpc<any>("thread/start", { cwd: "/tmp" });
    assert(result.thread != null, "thread should be present");
    assert(
      typeof result.thread.id === "string",
      "thread.id should be string"
    );
    threadId = result.thread.id;
  });

  // ── 7. SSE streaming + full turn ──────────────────────────────
  // (Run the first turn before thread/read/resume since codex requires
  //  a materialized thread — one that has at least one user message.)

  console.log("\n─── SSE + Turn Flow ───");

  let sse1: SSEReader | null = null;

  await test("SSE connects for thread", async () => {
    sse1 = new SSEReader(threadId);
    await sleep(500);
    assert(sse1.error === null, `SSE error: ${sse1.error}`);
  });

  await test("turn/start completes with response", async () => {
    assert(sse1 !== null, "SSE should be connected");
    const completed = await runFullTurn(threadId, SIMPLE_PROMPT, sse1!);
    assert(
      completed.parsed.params != null,
      "turn/completed should have params"
    );
  });

  await test("thread events persisted after turn", async () => {
    const { body } = await jsonFetch(
      `/api/thread/events?threadId=${threadId}`,
      { expectStatus: 200 }
    );
    assert(body.events.length > 0, "should have persisted events");
    const methods = body.events.map((e: string) => {
      try {
        return JSON.parse(e).method;
      } catch {
        return null;
      }
    });
    assert(
      methods.includes("turn/completed"),
      `should have turn/completed, got: ${methods.filter(Boolean).join(", ")}`
    );
    assert(
      methods.includes("turn/started"),
      "should have turn/started"
    );
  });

  await test("SSE events have ULID-style IDs in increasing order", async () => {
    assert(sse1 !== null, "SSE should be connected");
    const events = sse1!.allEvents();
    assert(
      events.length >= 2,
      `need at least 2 events, got ${events.length}`
    );
    for (let i = 1; i < events.length; i++) {
      assert(
        events[i].id > events[i - 1].id,
        `event IDs must increase: ${events[i - 1].id} -> ${events[i].id}`
      );
    }
  });

  // ── Thread read/resume (after materialization) ─────────────────

  console.log("\n─── Thread Read/Resume ───");

  await test("thread/list includes the created thread", async () => {
    const result = await rpc<any>("thread/list", {
      limit: 50,
      archived: false,
    });
    assert(Array.isArray(result.data), "data should be array");
    assert(result.data.length > 0, "should have at least one thread");
    const found = result.data.find((t: any) => t.id === threadId);
    assert(found != null, `thread ${threadId} should be in list`);
  });

  await test("thread/read returns thread data", async () => {
    const result = await rpc<any>("thread/read", {
      threadId,
      includeTurns: true,
    });
    assert(result.thread != null, "thread should be present");
    assertEqual(result.thread.id, threadId, "thread id");
  });

  await test("thread/resume returns thread data", async () => {
    const result = await rpc<any>("thread/resume", { threadId });
    assert(result.thread != null, "thread should be present");
    assertEqual(result.thread.id, threadId, "thread id");
  });

  // ── 8. Multi-turn on same thread ──────────────────────────────

  console.log("\n─── Multi-Turn ───");

  await test("second turn on same thread completes", async () => {
    assert(sse1 !== null, "SSE should be connected");
    await runFullTurn(threadId, "What is 3+3? Reply with just the number.", sse1!);
  });

  await test("third turn on same thread completes", async () => {
    assert(sse1 !== null, "SSE should be connected");
    await runFullTurn(threadId, "What is 5+5? Reply with just the number.", sse1!);
  });

  // ── 9. Parallel SSE clients ───────────────────────────────────

  console.log("\n─── Parallel SSE Clients ───");

  await test("multiple SSE clients all receive turn events", async () => {
    const sse2 = new SSEReader(threadId);
    const sse3 = new SSEReader(threadId);
    await sleep(500);
    assert(sse2.error === null, `SSE2 error: ${sse2.error}`);
    assert(sse3.error === null, `SSE3 error: ${sse3.error}`);

    // Mark what we've already seen so we only wait for new events
    const before1 = new Set(sse1!.allEvents().map((e) => e.id));
    const before2 = new Set(sse2.allEvents().map((e) => e.id));
    const before3 = new Set(sse3.allEvents().map((e) => e.id));

    await rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "What is 4+4? Reply with just the number." }],
    });

    // All three clients should see turn/completed
    const [c1, c2, c3] = await Promise.all([
      sse1!.waitFor(
        (e) => e.parsed?.method === "turn/completed" && !before1.has(e.id),
        TURN_TIMEOUT
      ),
      sse2.waitFor(
        (e) => e.parsed?.method === "turn/completed" && !before2.has(e.id),
        TURN_TIMEOUT
      ),
      sse3.waitFor(
        (e) => e.parsed?.method === "turn/completed" && !before3.has(e.id),
        TURN_TIMEOUT
      ),
    ]);

    // All should have the same event ID for the turn/completed
    assertEqual(c1.id, c2.id, "sse1 and sse2 turn/completed id");
    assertEqual(c2.id, c3.id, "sse2 and sse3 turn/completed id");

    sse2.close();
    sse3.close();
  });

  // ── 10. SSE reconnection with Last-Event-ID ──────────────────

  console.log("\n─── SSE Reconnection ───");

  await test(
    "SSE reconnect with Last-Event-ID skips earlier events",
    async () => {
      const lastId = sse1!.lastEventId();
      assert(lastId.length > 0, "should have a lastEventId");

      const sseReconnect = new SSEReader(threadId, lastId);
      await sleep(500);
      assert(
        sseReconnect.error === null,
        `reconnect SSE error: ${sseReconnect.error}`
      );

      // Fire another turn
      const beforeReconnect = new Set(
        sseReconnect.allEvents().map((e) => e.id)
      );
      await rpc("turn/start", {
        threadId,
        input: [
          { type: "text", text: "What is 6+6? Reply with just the number." },
        ],
      });

      const completed = await sseReconnect.waitFor(
        (e) =>
          e.parsed?.method === "turn/completed" &&
          !beforeReconnect.has(e.id),
        TURN_TIMEOUT
      );
      assert(
        completed.id > lastId,
        "reconnected event ID should be after lastEventId"
      );

      // Verify no events before our cursor were re-sent
      const reconnectEvents = sseReconnect.allEvents();
      for (const e of reconnectEvents) {
        if (e.id) {
          assert(
            e.id > lastId,
            `reconnected event ${e.id} should be after ${lastId}`
          );
        }
      }

      // Also wait for sse1 to see it (so it stays in sync)
      await sse1!.waitFor(
        (e) => e.id === completed.id,
        TURN_TIMEOUT
      );

      sseReconnect.close();
    }
  );

  // ── 11. Parallel reads ─────────────────────────────────────────

  console.log("\n─── Parallel Reads ───");

  await test(
    "concurrent GET /api/thread/events from 10 clients",
    async () => {
      const promises = Array.from({ length: 10 }, () =>
        jsonFetch(`/api/thread/events?threadId=${threadId}`)
      );
      const results = await Promise.all(promises);
      for (const r of results) {
        assertEqual(r.status, 200, "status");
        assert(Array.isArray(r.body.events), "events should be array");
        assert(r.body.events.length > 0, "events should be non-empty");
      }
      const counts = results.map((r) => r.body.events.length);
      assert(
        counts.every((c) => c === counts[0]),
        `all clients should see same event count, got: ${counts.join(",")}`
      );
    }
  );

  await test("concurrent thread/read RPC from 10 clients", async () => {
    const promises = Array.from({ length: 10 }, () =>
      rpc("thread/read", { threadId, includeTurns: true })
    );
    const results = await Promise.all(promises);
    for (const r of results) {
      assert(r.thread != null, "thread should be present");
      assertEqual(r.thread.id, threadId, "thread id");
    }
  });

  await test(
    "concurrent thread/list + thread/read + events + health + fs/list",
    async () => {
      const promises = [
        rpc("thread/list", { limit: 50, archived: false }),
        rpc("thread/read", { threadId, includeTurns: true }),
        jsonFetch(`/api/thread/events?threadId=${threadId}`),
        jsonFetch("/api/health"),
        jsonFetch("/api/fs/list"),
      ];
      const results = await Promise.all(promises);
      assert(results.length === 5, "all 5 requests completed");
    }
  );

  await test("5 SSE clients all see the same turn", async () => {
    const clients: SSEReader[] = [];
    for (let i = 0; i < 5; i++) {
      clients.push(new SSEReader(threadId));
    }
    await sleep(500);

    const befores = clients.map(
      (c) => new Set(c.allEvents().map((e) => e.id))
    );

    await rpc("turn/start", {
      threadId,
      input: [
        { type: "text", text: "What is 7+7? Reply with just the number." },
      ],
    });

    const completions = await Promise.all(
      clients.map((c, i) =>
        c.waitFor(
          (e) =>
            e.parsed?.method === "turn/completed" && !befores[i].has(e.id),
          TURN_TIMEOUT
        )
      )
    );

    // All should have the same completion event ID
    const ids = completions.map((c) => c.id);
    assert(
      ids.every((id) => id === ids[0]),
      `all clients should see same turn/completed id, got: ${ids.join(",")}`
    );

    // Also sync sse1
    await sse1!.waitFor(
      (e) => e.id === ids[0],
      TURN_TIMEOUT
    );

    for (const c of clients) c.close();
  });

  // ── 12. New thread on same server ──────────────────────────────

  console.log("\n─── Second Thread ───");

  let threadId2 = "";

  await test("can start a second thread", async () => {
    const result = await rpc<any>("thread/start", { cwd: "/tmp" });
    threadId2 = result.thread.id;
    assert(
      threadId2 !== threadId,
      "second thread should have different id"
    );
  });

  await test("second thread has independent events", async () => {
    const sseB = new SSEReader(threadId2);
    await sleep(500);

    await runFullTurn(threadId2, SIMPLE_PROMPT, sseB);

    const { body: body1 } = await jsonFetch(
      `/api/thread/events?threadId=${threadId}`
    );
    const { body: body2 } = await jsonFetch(
      `/api/thread/events?threadId=${threadId2}`
    );

    // Thread 1 had many turns, thread 2 had just one
    assert(
      body1.events.length > body2.events.length,
      `thread 1 (${body1.events.length} events) should have more events than thread 2 (${body2.events.length})`
    );

    sseB.close();
  });

  await test("thread/list returns both threads", async () => {
    const result = await rpc<any>("thread/list", {
      limit: 50,
      archived: false,
    });
    const ids = result.data.map((t: any) => t.id);
    assert(ids.includes(threadId), "should include thread 1");
    assert(ids.includes(threadId2), "should include thread 2");
  });

  // ── 13. Rapid sequential turns ────────────────────────────────

  console.log("\n─── Rapid Sequential Turns ───");

  await test("3 rapid sequential turns complete without errors", async () => {
    const sseSeq = new SSEReader(threadId);
    await sleep(500);

    for (let i = 0; i < 3; i++) {
      await runFullTurn(
        threadId,
        `What is ${i + 10}+${i + 10}? Reply with just the number.`,
        sseSeq
      );
    }

    sseSeq.close();
  });

  // ── 14. Event ordering ─────────────────────────────────────────

  console.log("\n─── Event Ordering ───");

  await test("SSE event IDs are strictly increasing", async () => {
    const events = sse1!.allEvents();
    assert(events.length >= 5, `need several events, got ${events.length}`);
    for (let i = 1; i < events.length; i++) {
      if (events[i].id && events[i - 1].id) {
        assert(
          events[i].id > events[i - 1].id,
          `event IDs must increase: ${events[i - 1].id} -> ${events[i].id}`
        );
      }
    }
  });

  await test("persisted events contain expected methods", async () => {
    const { body } = await jsonFetch(
      `/api/thread/events?threadId=${threadId}`
    );
    const methods = new Set<string>();
    for (const e of body.events) {
      try {
        const parsed = JSON.parse(e);
        if (parsed.method) methods.add(parsed.method);
      } catch {}
    }
    assert(methods.has("turn/started"), "should have turn/started");
    assert(methods.has("turn/completed"), "should have turn/completed");
    assert(
      methods.has("item/agentMessage/delta") || methods.has("item/completed"),
      "should have agent message events"
    );
  });

  // ── 15. Concurrent load ────────────────────────────────────────

  console.log("\n─── Concurrent Load ───");

  await test("20 concurrent health checks", async () => {
    const promises = Array.from({ length: 20 }, () =>
      jsonFetch("/api/health")
    );
    const results = await Promise.all(promises);
    for (const r of results) {
      assertEqual(r.status, 200, "status");
      assertEqual(r.body.ok, true, "ok");
    }
  });

  await test("20 concurrent fs/list requests", async () => {
    const promises = Array.from({ length: 20 }, () =>
      jsonFetch("/api/fs/list")
    );
    const results = await Promise.all(promises);
    for (const r of results) {
      assertEqual(r.status, 200, "status");
      assert(Array.isArray(r.body.entries), "entries should be array");
    }
  });

  await test(
    "mixed parallel: 5 health + 5 fs/list + 5 thread/events + 5 rpc",
    async () => {
      const promises = [
        ...Array.from({ length: 5 }, () => jsonFetch("/api/health")),
        ...Array.from({ length: 5 }, () => jsonFetch("/api/fs/list")),
        ...Array.from({ length: 5 }, () =>
          jsonFetch(`/api/thread/events?threadId=${threadId}`)
        ),
        ...Array.from({ length: 5 }, () =>
          rpc("thread/read", { threadId, includeTurns: true })
        ),
      ];
      const results = await Promise.all(promises);
      assert(results.length === 20, "all 20 requests should complete");
    }
  );

  // ── Cleanup ────────────────────────────────────────────────────

  sse1?.close();

  // ── Summary ────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════");
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log("═══════════════════════════════════════\n");

  if (failures.length > 0) {
    console.log("Failures:");
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    console.log();
  }

  process.exit(failed > 0 ? 1 : 0);
}

runSuite().catch((err) => {
  console.error("FATAL:", err);
  process.exit(2);
});
