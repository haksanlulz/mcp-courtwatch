import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";

// serverInfo.version is a hand-written literal in server.ts. Nothing but this
// test keeps it equal to package.json: it had stayed at 1.3.0 through the
// 2.0.0 release, so every client and registry read the wrong version.
// (Same guard as mcp-nychousing's "serverInfo version" block.)

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as T;
}

describe("serverInfo version", () => {
  it("matches package.json", async () => {
    const pkg = readJson<{ version: string }>("../package.json");
    const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([createServer().connect(serverTransport), client.connect(clientTransport)]);
    const info = client.getServerVersion();
    expect(info?.name).toBe("mcp-courtwatch");
    expect(info?.version).toBe(pkg.version);
    await client.close();
  });

  it("the .mcpb manifest carries the same version", () => {
    const pkg = readJson<{ version: string }>("../package.json");
    const manifest = readJson<{ version: string }>("../manifest.json");
    expect(manifest.version).toBe(pkg.version);
  });
});
