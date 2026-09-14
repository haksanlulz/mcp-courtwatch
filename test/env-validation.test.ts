// Numeric environment settings, and what happens when one of them is garbage.
//
// These live in their own file because the three settings are read once at
// module load: the only way to exercise a bad value is to set it BEFORE the
// module is evaluated, so every test here resets the module registry and
// re-imports server.ts. The main suite imports it normally, once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const NUMERIC_ENV = ["CL_HTTP_ATTEMPTS", "CL_CACHE_TTL_MS", "CL_CACHE_MAX"] as const;

let fetchMock: ReturnType<typeof vi.fn>;
let stderr: ReturnType<typeof vi.spyOn>;

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => JSON.stringify(body),
  };
}

/** Re-evaluate server.ts with whatever env is set right now, and connect a client to it. */
async function freshClient(): Promise<Client> {
  vi.resetModules();
  const { createServer } = await import("../server.js");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function payload(result: any) {
  return JSON.parse(result.content[0].text);
}

/** Every stderr line this module wrote, joined. */
function stderrText(): string {
  return stderr.mock.calls.map((c) => c.join(" ")).join("\n");
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  // The warning is written at import time, so the spy has to exist first.
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const name of NUMERIC_ENV) delete process.env[name];
  delete process.env.COURTLISTENER_API_TOKEN;
});

afterEach(() => {
  for (const name of NUMERIC_ENV) delete process.env[name];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("numeric env settings", () => {
  // The value a caller most plausibly gets wrong, on the setting whose NaN is
  // worst: Number("abc") made the withRetry loop skip its body entirely, so the
  // tool issued ZERO requests and rethrew an unassigned `last`.
  it("CL_HTTP_ATTEMPTS=abc still issues the request and returns a normal result", async () => {
    process.env.CL_HTTP_ATTEMPTS = "abc";
    const client = await freshClient();
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0, next: null, results: [] }));

    const res: any = await client.callTool({ name: "opinion_search", arguments: { q: "miranda" } });

    expect(res.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(payload(res).returned).toBe(0);
    expect(stderrText()).toContain("CL_HTTP_ATTEMPTS");
  });

  it.each([
    ["abc", "not a number"],
    ["", "empty"],
    ["-1", "below the minimum"],
  ])("each numeric setting falls back to its default on %s input, with one stderr line each", async (value) => {
    for (const name of NUMERIC_ENV) process.env[name] = value;
    const client = await freshClient();

    // One line per bad setting, naming it — not a silent coercion.
    expect(stderr).toHaveBeenCalledTimes(NUMERIC_ENV.length);
    for (const name of NUMERIC_ENV) expect(stderrText()).toContain(name);

    // Defaults in force: three attempts on a retryable status (CL_HTTP_ATTEMPTS),
    // and a live cache serving the repeat read (CL_CACHE_TTL_MS / CL_CACHE_MAX).
    fetchMock.mockResolvedValue(jsonResponse({ detail: "throttled" }, { ok: false, status: 429 }));
    const failed: any = await client.callTool({ name: "opinion_search", arguments: { q: "x" } });
    expect(failed.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockResolvedValue(jsonResponse({ count: 0, next: null, results: [] }));
    await client.callTool({ name: "opinion_search", arguments: { q: "cached" } });
    const afterFirst = fetchMock.mock.calls.length;
    await client.callTool({ name: "opinion_search", arguments: { q: "cached" } });
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
  });

  it("a valid value is used and says nothing", async () => {
    process.env.CL_HTTP_ATTEMPTS = "1";
    const client = await freshClient();
    expect(stderr).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(jsonResponse({ detail: "throttled" }, { ok: false, status: 429 }));
    const res: any = await client.callTool({ name: "opinion_search", arguments: { q: "x" } });
    expect(res.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one attempt, as asked
  });

  it("CL_CACHE_TTL_MS=0 legitimately disables the cache (0 is a value, not a fallback)", async () => {
    process.env.CL_CACHE_TTL_MS = "0";
    const client = await freshClient();
    expect(stderr).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(jsonResponse({ count: 0, next: null, results: [] }));
    await client.callTool({ name: "opinion_search", arguments: { q: "roe" } });
    await client.callTool({ name: "opinion_search", arguments: { q: "roe" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("non-Error throws", () => {
  // "Error: undefined" is what a caller saw for every tool while
  // CL_HTTP_ATTEMPTS was unvalidated. Whatever else a handler throws, the
  // message has to name the tool.
  it("a handler that throws undefined produces a message naming the tool, never 'Error: undefined'", async () => {
    process.env.CL_HTTP_ATTEMPTS = "1"; // one attempt: no retry backoff to sit through
    const client = await freshClient();
    fetchMock.mockImplementation(() => {
      throw undefined;
    });

    const res: any = await client.callTool({ name: "opinion_search", arguments: { q: "x" } });

    expect(res.isError).toBe(true);
    const text = res.content[0].text as string;
    expect(text).not.toBe("Error: undefined");
    expect(text).toContain("opinion_search");
    expect(text).toContain("non-Error value");
  });
});
