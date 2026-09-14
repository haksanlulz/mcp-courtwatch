// Live smoke test: one real call per tool against the CourtListener API.
// Gated on COURTLISTENER_API_TOKEN: prints a skip notice and exits 0 when the
// token is unset, so it is safe to wire into CI without a secret.
//
// (opinion_search, docket_lookup, court_list, judge_lookup, cited_by,
// oral_arguments and oral_argument_transcript actually work unauthenticated;
// the whole smoke is still token-gated for consistency, and the other four
// require the token.)
//
// Every check asserts. A check that only logs passes on `returned: 0`, which is
// exactly what a query the index has stopped matching produces — and the
// queries here are hardcoded strings ("miranda", "eviction", "Ginsburg") that
// CourtListener's index is free to stop matching at any time.
//
// A check whose input could not be resolved reports SKIP and is counted
// separately. It is never counted ok: one upstream failure used to print two
// green lines, because case_detail and docket_entries each returned early from
// inside a `run` that treats "did not throw" as a pass.
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

/** Thrown by a check whose input could not be resolved. Not a pass, not a failure. */
class Skipped extends Error {}
function skip(reason: string): never {
  throw new Skipped(reason);
}

function parse(result: any) {
  const text = String(result?.content?.[0]?.text ?? "");
  // An isError result carries a plain message, not JSON. Surface it: parsing it
  // blind turns every real failure into "Unexpected token 'E'".
  if (result?.isError) throw new Error(text);
  const body = JSON.parse(text);
  // SPEC records-not-advice, on the live channel rather than only the mocked one.
  if (typeof body.disclaimer !== "string" || !body.disclaimer.toLowerCase().includes("not legal advice")) {
    throw new Error("result carries no records-only disclaimer");
  }
  return body;
}

function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function nonEmptyString(v: unknown, label: string): string {
  need(typeof v === "string" && v.trim() !== "", `${label} should be a non-empty string, got ${JSON.stringify(v)}`);
  return v as string;
}

function positiveInt(v: unknown, label: string): number {
  need(
    typeof v === "number" && Number.isInteger(v) && v > 0,
    `${label} should be a positive integer, got ${JSON.stringify(v)}`,
  );
  return v as number;
}

async function main(): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  let passed = 0;
  let failures = 0;
  let skipped = 0;
  const run = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
      passed++;
      console.log(`ok   ${label}`);
    } catch (err) {
      if (err instanceof Skipped) {
        skipped++;
        console.log(`SKIP ${label}: ${err.message}`);
        return;
      }
      failures++;
      console.error(`FAIL ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  let sampleClusterId: number | null = null;
  let sampleAudioId: number | null = null;

  await run("opinion_search", async () => {
    const body = parse(
      await client.callTool({ name: "opinion_search", arguments: { q: "miranda", court: "scotus", limit: 3 } }),
    );
    console.log(`     -> ${body.returned} result(s) of ${body.total_matches ?? "?"}; first: ${body.results[0]?.case_name ?? "(none)"}`);
    need(body.returned >= 1, `expected at least one scotus opinion matching "miranda", got ${body.returned}`);
    const hit = body.results[0];
    nonEmptyString(hit.case_name, "results[0].case_name");
    need(hit.court_id === "scotus", `the court filter should hold; got court_id ${JSON.stringify(hit.court_id)}`);
    positiveInt(hit.cluster_id, "results[0].cluster_id");
    // opinions[].id is the keyless input to cited_by; if the search index stops
    // carrying it, the documented token-free citator route is gone.
    need(
      body.results.some((r: any) => Array.isArray(r.opinions) && r.opinions.some((o: any) => Number.isInteger(o?.id))),
      "no hit carried an opinions[].id — the keyless route into cited_by is broken",
    );
    sampleClusterId = hit.cluster_id;
  });

  await run("docket_lookup", async () => {
    const body = parse(await client.callTool({ name: "docket_lookup", arguments: { q: "eviction", limit: 3 } }));
    console.log(`     -> ${body.returned} docket(s); first: ${body.results[0]?.case_name ?? "(none)"}`);
    need(body.returned >= 1, `expected at least one docket matching "eviction", got ${body.returned}`);
    nonEmptyString(body.results[0].case_name, "results[0].case_name");
    positiveInt(body.results[0].docket_id, "results[0].docket_id");
  });

  await run("court_list", async () => {
    // Jurisdiction filter, not a name filter: a name filter walks the FULL
    // ~168-page court table, which cannot finish inside one MCP request on a
    // rate-limited account (new CL accounts are 5 req/min). One page proves
    // the channel; the full-walk path is covered by the cache test.
    const body = parse(await client.callTool({ name: "court_list", arguments: { jurisdiction: "F", limit: 5 } }));
    console.log(`     -> ${body.returned} court(s); first id: ${body.courts[0]?.id ?? "(none)"}`);
    need(body.returned >= 1, `expected at least one federal court, got ${body.returned}`);
    nonEmptyString(body.courts[0].id, "courts[0].id");
    nonEmptyString(body.courts[0].full_name, "courts[0].full_name");
    const stray = body.courts.find((c: any) => c.jurisdiction !== "F");
    need(!stray, `the jurisdiction filter should hold; got ${JSON.stringify(stray?.jurisdiction)} for ${stray?.id}`);
  });

  await run("judge_lookup", async () => {
    const body = parse(await client.callTool({ name: "judge_lookup", arguments: { name_last: "Ginsburg", limit: 3 } }));
    console.log(`     -> ${body.returned} person(s); first: ${body.results[0]?.name ?? "(none)"}`);
    need(body.returned >= 1, `expected at least one judge named Ginsburg, got ${body.returned}`);
    const name = nonEmptyString(body.results[0].name, "results[0].name");
    need(name.includes("Ginsburg"), `the name filter should hold; got ${JSON.stringify(name)}`);
    positiveInt(body.results[0].id, "results[0].id");
  });

  await run("citation_lookup", async () => {
    // One real citation (Roe v. Wade) and one fabricated one: the fake must
    // come back flagged NOT_FOUND.
    const body = parse(
      await client.callTool({
        name: "citation_lookup",
        arguments: { text: "See Roe v. Wade, 410 U.S. 113 (1973). But see Smith v. Imaginary, 999 U.S. 9999 (2099)." },
      }),
    );
    console.log(
      `     -> ${body.citations_checked} citation(s): ${body.found} found, ${body.not_found} not found; ` +
        `first match: ${body.results[0]?.matches?.[0]?.case_name ?? "(none)"}`,
    );
    need(body.found >= 1, "expected the real citation (410 U.S. 113) to resolve");
    need(body.not_found >= 1, "expected the fabricated citation to come back NOT_FOUND");
  });

  await run("case_detail", async () => {
    if (sampleClusterId == null) skip("opinion_search produced no cluster id");
    const body = parse(await client.callTool({ name: "case_detail", arguments: { id: sampleClusterId, type: "cluster" } }));
    console.log(`     -> cluster ${sampleClusterId}: ${body.case_name ?? "(no name)"}; ${(body.citations ?? []).length} citation(s), ${(body.sub_opinion_ids ?? []).length} opinion(s)`);
    need(body.type === "cluster", `expected type "cluster", got ${JSON.stringify(body.type)}`);
    need(body.id === sampleClusterId, `expected the cluster we asked for (${sampleClusterId}), got ${JSON.stringify(body.id)}`);
    nonEmptyString(body.case_name, "case_name");
    need(Array.isArray(body.sub_opinion_ids), "sub_opinion_ids should be an array");
  });

  await run("cited_by", async () => {
    // Obergefell's majority opinion (id 2812209): a heavily cited modern case.
    const body = parse(await client.callTool({ name: "cited_by", arguments: { opinion_id: 2812209 } }));
    console.log(`     -> ${body.total_citing} citing opinion(s); newest: ${body.results[0]?.case_name ?? "(none)"} (${body.results[0]?.date_filed ?? "?"})`);
    need(typeof body.total_citing === "number" && body.total_citing >= 1, "expected at least one citing opinion");
    need(String(body.note).includes("treatment"), "the no-treatment-classification caveat should ride the payload");
  });

  await run("case_authorities", async () => {
    const body = parse(await client.callTool({ name: "case_authorities", arguments: { opinion_id: 2812209, limit: 10 } }));
    console.log(`     -> ${body.total_authorities} authorit(ies); deepest: opinion ${body.results[0]?.cited_opinion_id ?? "(none)"} depth ${body.results[0]?.depth ?? "?"}`);
    need(Array.isArray(body.results), "expected an authorities array");
    need(typeof body.total_reported === "boolean", "total_reported should say whether the count was reported");
  });

  await run("oral_arguments", async () => {
    const body = parse(await client.callTool({ name: "oral_arguments", arguments: { q: "miranda", court: "scotus", limit: 3 } }));
    console.log(`     -> ${body.total_matches} recording(s); first: ${body.results[0]?.case_name ?? "(none)"} argued ${body.results[0]?.date_argued ?? "?"}`);
    need(typeof body.total_matches === "number", "expected a match count");
    need(body.returned >= 1, `expected at least one scotus oral argument matching "miranda", got ${body.returned}`);
    nonEmptyString(body.results[0].case_name, "results[0].case_name");
    positiveInt(body.results[0].audio_id, "results[0].audio_id");
    sampleAudioId = body.results[0].audio_id;
  });

  await run("oral_argument_transcript", async () => {
    if (sampleAudioId == null) skip("oral_arguments produced no audio id");
    const body = parse(
      await client.callTool({
        name: "oral_argument_transcript",
        arguments: { audio_id: sampleAudioId, max_chars: 2000 },
      }),
    );
    console.log(
      `     -> audio ${sampleAudioId}: ${body.stt_verdict}, ${body.transcript_chars} char(s) on the record`,
    );
    nonEmptyString(body.stt_verdict, "stt_verdict");
    nonEmptyString(body.provenance, "provenance");
    need(body.machine_generated === true, "every transcript must declare itself machine-generated");
    // The usability gate, on the live channel: text rides a usable verdict and
    // nothing else. This is the half of the tool that exists to refuse — 708 of
    // 103,278 records are flagged as not matching their audio and still carry text.
    need(
      body.transcript_usable === (typeof body.text === "string"),
      `text is returned iff the transcript is usable; got transcript_usable ${body.transcript_usable} with text ${typeof body.text}`,
    );
    need(
      typeof body.text !== "string" || body.stt_verdict === "COMPLETE",
      `text was returned under verdict ${body.stt_verdict}; only COMPLETE may carry text`,
    );
    if (typeof body.text === "string") {
      need(body.returned_chars === body.text.length, "returned_chars must match the page actually returned");
    }
    // A COMPLETE verdict with nothing on the record is how a renamed
    // stt_transcript field would look: the status still parses, the text is gone.
    need(
      body.stt_verdict !== "COMPLETE" || body.transcript_chars > 0,
      "a COMPLETE transcription reported 0 characters — check whether stt_transcript was renamed upstream",
    );
  });

  await run("docket_entries", async () => {
    // Resolve a real docket id first, the way an agent would.
    const dockets = parse(await client.callTool({ name: "docket_lookup", arguments: { q: "New York" } }));
    const docketId = dockets.results?.find((r: any) => r.docket_id != null)?.docket_id;
    if (docketId == null) skip("docket_lookup produced no docket id");
    const body = parse(await client.callTool({ name: "docket_entries", arguments: { docket_id: docketId, limit: 5 } }));
    console.log(`     -> docket ${docketId}: ${body.total_entries ?? "(not reported)"} entr(ies); first: #${body.results[0]?.entry_number ?? "?"} ${body.results[0]?.date_filed ?? ""}`);
    need(Array.isArray(body.results), "expected an entries array");
    need(typeof body.total_reported === "boolean", "total_reported should say whether the count was reported");
    need(String(body.note).includes("PACER"), "the RECAP coverage caveat should ride the payload");
    // RECAP genuinely holds nothing for some dockets, so an empty page is a
    // real answer; what must hold is that a returned entry is well formed.
    if (body.results.length > 0) positiveInt(body.results[0].id, "results[0].id");
  });

  await client.close();
  await server.close();

  console.log(`\nsmoke: ${passed} passed, ${failures} failed, ${skipped} skipped`);
  if (failures > 0) process.exit(1);
  if (skipped > 0) {
    console.log(`${skipped} check(s) could not run — that is not a pass. Re-run when their input resolves.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
