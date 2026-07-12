// Live smoke test: one real call per tool against the CourtListener API.
// Gated on COURTLISTENER_API_TOKEN: prints a skip notice and exits 0 when the
// token is unset, so it is safe to wire into CI without a secret.
//
// (opinion_search, docket_lookup, court_list, and judge_lookup actually work
// unauthenticated; the whole smoke is still token-gated for consistency, and
// case_detail requires the token.)
//
//   npm run smoke
//
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

const TOKEN_SIGNUP_URL = "https://www.courtlistener.com/help/api/rest/";

if (!process.env.COURTLISTENER_API_TOKEN?.trim()) {
  console.log(`smoke: skipped, set COURTLISTENER_API_TOKEN to run live checks (free token: ${TOKEN_SIGNUP_URL})`);
  process.exit(0);
}

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

async function main(): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  let failures = 0;
  const run = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`ok   ${label}`);
    } catch (err) {
      failures++;
      console.error(`FAIL ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  let sampleClusterId: number | null = null;

  await run("opinion_search", async () => {
    const body = parse(
      await client.callTool({ name: "opinion_search", arguments: { q: "miranda", court: "scotus", limit: 3 } }),
    );
    console.log(`     -> ${body.returned} result(s) of ${body.total_matches ?? "?"}; first: ${body.results[0]?.case_name ?? "(none)"}`);
    sampleClusterId = body.results[0]?.cluster_id ?? null;
  });

  await run("docket_lookup", async () => {
    const body = parse(
      await client.callTool({ name: "docket_lookup", arguments: { q: "eviction", limit: 3 } }),
    );
    console.log(`     -> ${body.returned} docket(s); first: ${body.results[0]?.case_name ?? "(none)"}`);
  });

  await run("court_list", async () => {
    const body = parse(await client.callTool({ name: "court_list", arguments: { q: "ninth circuit", limit: 5 } }));
    console.log(`     -> ${body.returned} court(s); first id: ${body.courts[0]?.id ?? "(none)"}`);
  });

  await run("judge_lookup", async () => {
    const body = parse(await client.callTool({ name: "judge_lookup", arguments: { name_last: "Ginsburg", limit: 3 } }));
    console.log(`     -> ${body.returned} person(s); first: ${body.results[0]?.name ?? "(none)"}`);
  });

  await run("case_detail", async () => {
    if (sampleClusterId == null) {
      console.log("     -> skipped (no cluster id from opinion_search)");
      return;
    }
    const body = parse(await client.callTool({ name: "case_detail", arguments: { id: sampleClusterId, type: "cluster" } }));
    console.log(`     -> cluster ${sampleClusterId}: ${body.case_name ?? "(no name)"}; ${(body.citations ?? []).length} citation(s), ${(body.sub_opinion_ids ?? []).length} opinion(s)`);
  });

  await client.close();
  await server.close();

  if (failures > 0) {
    console.error(`\nsmoke: ${failures} tool(s) failed`);
    process.exit(1);
  }
  console.log("\nsmoke: all tools ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
