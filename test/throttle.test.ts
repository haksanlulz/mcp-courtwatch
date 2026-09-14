// The outbound throttle, which is what keeps this server polite toward a
// nonprofit's free endpoint and usable on the documented 5-requests/minute
// new-account limit.
//
// GAUNTLET §3 recorded both of these invariants as "present" from 2026-08-23
// until 2026-09-14; neither test existed. They are written here against a FAKE
// clock, asserting call-START timestamps: a wall-clock version of a spacing
// test is slow, then flaky, then skipped.
//
// Own file, because both need server.ts re-evaluated with a known
// COURTWATCH_THROTTLE_MS — the value is read once at module load, and the rest
// of the offline suite runs at 0 so 82 mocked tests do not pay a real gap.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/** A gap big enough to read in the assertions, small enough to advance over. */
const GAP = 1000;

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

const EMPTY_PAGE = { count: 0, next: null, previous: null, results: [] };

/** Re-evaluate server.ts at the current COURTWATCH_THROTTLE_MS and connect a client. */
async function freshClient(): Promise<Client> {
  vi.resetModules();
  const { createServer } = await import("../server.js");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Distinct queries: the response cache would otherwise serve the second call with no fetch. */
function search(client: Client, q: string) {
  return client.callTool({ name: "opinion_search", arguments: { q } });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.COURTLISTENER_API_TOKEN;
  process.env.COURTWATCH_THROTTLE_MS = String(GAP);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.COURTWATCH_THROTTLE_MS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("throttle", () => {
  // Three tool calls issued together must not become three simultaneous
  // requests against CourtListener. The queue is a single promise chain, so
  // "serialized" here means: the second request does not start until the first
  // has settled, however long that takes.
  it("serializes concurrent requests through the throttle queue", async () => {
    const client = await freshClient();

    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const firstRequestGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    fetchMock.mockImplementation(async () => {
      const isFirst = fetchMock.mock.calls.length === 1;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (isFirst) await firstRequestGate; // hold request one open
      inFlight--;
      return jsonResponse(EMPTY_PAGE);
    });

    const calls = [search(client, "a"), search(client, "b"), search(client, "c")];

    // Plenty of time for every gap to elapse — but request one is still open,
    // so nothing behind it may have started.
    await vi.advanceTimersByTimeAsync(10 * GAP);
    expect(fetchMock, "a queued request started while the first was still open").toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(10 * GAP);
    await Promise.all(calls);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(maxInFlight, "two requests were open at once").toBe(1);
  });

  // The gap rides the internal queue chain, so it is measured from one
  // request's START to the next request's START — not tacked onto however long
  // the previous response happened to take. server.ts carries a comment
  // defending exactly this; nothing measured it until now.
  it("spaces request STARTS by the throttle gap", async () => {
    const client = await freshClient();

    const starts: number[] = [];
    fetchMock.mockImplementation(async () => {
      starts.push(Date.now());
      return jsonResponse(EMPTY_PAGE);
    });

    const calls = [search(client, "a"), search(client, "b"), search(client, "c")];
    await vi.advanceTimersByTimeAsync(10 * GAP);
    await Promise.all(calls);

    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0], "start 1 -> start 2").toBeGreaterThanOrEqual(GAP);
    expect(starts[2] - starts[1], "start 2 -> start 3").toBeGreaterThanOrEqual(GAP);
  });

  it("the rest of the suite runs at COURTWATCH_THROTTLE_MS=0, which is a value and not a fallback", async () => {
    process.env.COURTWATCH_THROTTLE_MS = "0";
    const client = await freshClient();

    const starts: number[] = [];
    fetchMock.mockImplementation(async () => {
      starts.push(Date.now());
      return jsonResponse(EMPTY_PAGE);
    });

    const calls = [search(client, "a"), search(client, "b")];
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(calls);

    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBe(0);
  });
});

// COURTWATCH_THROTTLE_MS is the fourth numeric setting and it kept an ad-hoc
// reader through the round that validated the other three. `Number("")` is 0,
// so an empty value in a client config removed the throttle silently — the one
// setting whose failure mode is "hammer a nonprofit's free endpoint".
describe("COURTWATCH_THROTTLE_MS validation", () => {
  /** The two request STARTS a fresh server issues at whatever gap is in force. */
  async function measureGap(): Promise<number> {
    const client = await freshClient();
    const starts: number[] = [];
    fetchMock.mockImplementation(async () => {
      starts.push(Date.now());
      return jsonResponse(EMPTY_PAGE);
    });
    const calls = [search(client, "a"), search(client, "b")];
    await vi.advanceTimersByTimeAsync(10 * GAP);
    await Promise.all(calls);
    expect(starts).toHaveLength(2);
    return starts[1] - starts[0];
  }

  it("an empty value is not a zero gap", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.COURTWATCH_THROTTLE_MS = "";

    expect(await measureGap(), "an empty setting removed the throttle").toBeGreaterThanOrEqual(200);
    expect(stderr.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("COURTWATCH_THROTTLE_MS");
  });

  it("an unparseable value falls back and says so on stderr", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.COURTWATCH_THROTTLE_MS = "abc";

    expect(await measureGap()).toBeGreaterThanOrEqual(200);
    // The fallback was already right here; the silence was not. Three sibling
    // settings name themselves on stderr and this one did not.
    expect(stderr.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("COURTWATCH_THROTTLE_MS");
  });

  it("a valid value is used and says nothing", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.COURTWATCH_THROTTLE_MS = "750";

    expect(await measureGap()).toBeGreaterThanOrEqual(750);
    expect(stderr).not.toHaveBeenCalled();
  });
});
