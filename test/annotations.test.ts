// MCP security audit 2026-11-25: no tool here declared annotations, which clients
// use to decide what to ask the person about. Every tool now declares all four
// hints, and this table is the spec: a new tool fails here until it is classified.
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";

const EXPECTED: Record<string, Record<string, boolean>> = {
  opinion_search: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  docket_lookup: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  court_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  case_detail: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  citation_lookup: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  cited_by: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  case_authorities: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  docket_entries: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  oral_arguments: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  judge_lookup: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  oral_argument_transcript: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

describe("tool annotations", () => {
  it("every tool declares the hints in EXPECTED, and no tool is unclassified", async () => {
    const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const t of tools) {
      const a = t.annotations ?? {};
      for (const [k, v] of Object.entries(EXPECTED[t.name])) expect(a[k as keyof typeof a], `${t.name}.${k}`).toBe(v);
    }
  });
});
