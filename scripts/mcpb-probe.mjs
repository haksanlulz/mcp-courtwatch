#!/usr/bin/env node
/**
 * CHANNEL RUNG — the .mcpb bundle, exercised the way a person installing it is.
 *
 * Sibling of scripts/pack-probe.mjs, which covers the npm channel. Neither
 * substitutes for the other: the npm channel resolves a bin shim, the bundle
 * channel launches whatever `server.mcp_config` in the manifest says. A typo in
 * entry_point is invisible to every test in this repo and to pack-probe, and
 * fatal to every installer.
 *
 * It unpacks the real .mcpb, reads the manifest OUT OF THE BUNDLE, builds the
 * command from mcp_config with ${__dirname} substituted the way a host does,
 * spawns it, and speaks MCP JSON-RPC over stdio.
 *
 * COURTLISTENER_API_TOKEN is stripped from the child's environment. The token
 * is optional by design and seven tools are keyless; a probe that inherited the
 * author's token would prove nothing about the keyless path and would quietly
 * become a test that needs a secret.
 *
 * Run: npm run verify:mcpb   (packs first, then probes)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};
const ok = (m) => console.log(`  ok  ${m}`);

/**
 * Error text that says something about the network or about CourtListener, and
 * nothing about this bundle. Matching means SKIP-and-name, never PASS.
 */
const NOT_A_VERDICT_ON_THE_BUNDLE =
  /HTTP (429|5\d\d)|throttled|timed? ?out|fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network/i;

const manifestSrc = JSON.parse(readFileSync(join(repo, "manifest.json"), "utf8"));
const bundle =
  process.env.MCPB_BUNDLE ?? join(repo, "build", `${manifestSrc.name}-${manifestSrc.version}.mcpb`);
if (!existsSync(bundle)) fail(`no bundle at ${bundle} — run npm run mcpb:pack first`);
console.log(`mcpb-probe: ${bundle}`);

const dir = mkdtempSync(join(tmpdir(), "mcpbprobe-"));
let child;
try {
  // --- 1. unpack, as an installer's host does ------------------------------
  const unpacked = spawnSync("npx", ["mcpb", "unpack", bundle, dir], {
    shell: true,
    encoding: "utf8",
  });
  if (unpacked.status !== 0) fail(`mcpb unpack failed: ${(unpacked.stdout ?? "") + (unpacked.stderr ?? "")}`);

  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) fail("the bundle carries no manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  ok(`unpacked ${manifest.name}@${manifest.version}, manifest_version ${manifest.manifest_version}`);

  // --- 2. the bundle must not ship sources, tests or secrets ---------------
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(relative(dir, p).split("\\").join("/"));
    }
  })(dir);
  const leaked = files.filter((f) => /^(test\/|smoke\.ts|server\.ts|index\.ts|tsconfig|vitest\.config|\.env)/.test(f));
  if (leaked.length) fail(`bundle leaks non-shippable files: ${leaked.slice(0, 10).join(", ")}`);
  ok(`bundle is ${files.length} files, no sources, tests or env files`);

  // --- 3. the declared entry point has to exist ----------------------------
  const entry = manifest.server?.entry_point;
  if (!entry) fail("manifest declares no server.entry_point");
  const entryPath = join(dir, entry);
  if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
    fail(`server.entry_point "${entry}" does not exist in the bundle`);
  }
  ok(`entry_point ${entry} exists`);

  // --- 4. launch through mcp_config, the way a host does -------------------
  const cfg = manifest.server?.mcp_config;
  if (!cfg?.command || !Array.isArray(cfg.args)) fail("manifest declares no usable server.mcp_config");
  const subst = (s) => String(s).replaceAll("${__dirname}", dir);
  const args = cfg.args.map(subst);

  // This models ONE of the two things a host can do with an env entry whose
  // user_config value the user left unset (the token is required: false, so
  // that case is the normal one): drop the entry. The other is to pass the
  // "${user_config...}" placeholder through verbatim, and nothing in the mcpb
  // package documents which — so server.ts treats a bare placeholder as no
  // token rather than sending it as one.
  const childEnv = { ...process.env };
  delete childEnv.COURTLISTENER_API_TOKEN;
  for (const [k, v] of Object.entries(cfg.env ?? {})) {
    if (/\$\{user_config\./.test(String(v))) continue;
    childEnv[k] = subst(v);
  }
  ok(`launching: ${cfg.command} ${args.map((a) => (a === args[0] ? "<bundle>/" + entry : a)).join(" ")} (no token in env)`);

  child = spawn(cfg.command, args, { stdio: ["pipe", "pipe", "pipe"], cwd: dir, env: childEnv, shell: true });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const waitFor = async (id, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const msg = out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .find((m) => m && m.id === id);
      if (msg) return msg;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcpb-probe", version: "1.0.0" } },
  });
  const init = await waitFor(1, 15000);
  if (!init?.result) fail(`no initialize response. stderr: ${err.slice(0, 600)}`);
  ok(`initialize -> ${init.result.serverInfo?.name}@${init.result.serverInfo?.version}`);

  send({ jsonrpc: "2.0", id: 2, method: "notifications/initialized", params: {} });
  send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  const listed = await waitFor(3, 15000);
  const tools = listed?.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) fail(`tools/list returned nothing. stderr: ${err.slice(0, 600)}`);

  const served = tools.map((t) => t.name).sort();
  const declared = (manifest.tools ?? []).map((t) => t.name).sort();
  if (declared.length === 0) fail("manifest declares no tools");
  if (JSON.stringify(served) !== JSON.stringify(declared)) {
    fail(`the manifest's tool list and the server's disagree.\n  manifest: ${declared.join(", ")}\n  served:   ${served.join(", ")}`);
  }
  const malformed = tools.filter((t) => !t.name || !t.description || !t.inputSchema);
  if (malformed.length) fail(`tools missing name/description/inputSchema: ${malformed.map((t) => t.name).join(", ")}`);
  ok(`tools/list -> ${served.length}, matching the manifest: ${served.join(", ")}`);

  // --- 5. a keyless call has to round-trip, or the bundle is a brochure ----
  send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "opinion_search", arguments: { q: "warranty of habitability", court: "ny", limit: 1 } },
  });
  const called = await waitFor(4, 45000);
  if (!called?.result) fail(`no tools/call response. stderr: ${err.slice(0, 600)}`);
  const text = called.result.content?.[0]?.text ?? "";
  if (called.result.isError) {
    // A throttle or an upstream outage is not a verdict on this bundle. It is
    // also not a pass: it is reported as a skip and named.
    //
    // Transport failures belong in this set and were missing from it. A DNS or
    // socket failure surfaces as fetch's own message — "fetch failed",
    // ENOTFOUND, ECONNRESET — which matched none of HTTP 429/5xx, "throttled"
    // or "timeout", so a network blip on a CI runner reported the BUNDLE as
    // broken. This rung runs on every push, which makes the false red the
    // likely one.
    if (NOT_A_VERDICT_ON_THE_BUNDLE.test(text)) {
      console.log(`  SKIP keyless opinion_search: upstream said "${text.slice(0, 160)}"`);
      console.log("PASS (with 1 skipped) — the bundle starts and serves its tools; the live call could not be made.");
      process.exit(0);
    }
    fail(`keyless opinion_search returned an error: ${text.slice(0, 400)}`);
  }
  const body = JSON.parse(text);
  if (!Array.isArray(body.results)) fail("keyless opinion_search returned no results array");
  if (typeof body.disclaimer !== "string") fail("keyless opinion_search returned no records-only disclaimer");
  ok(`keyless opinion_search -> ${body.returned} result(s): ${body.results[0]?.case_name ?? "(none)"}`);

  console.log("PASS — the bundle installs, starts through its own mcp_config, and answers a keyless call.");
} finally {
  try {
    child?.kill();
  } catch {
    /* already gone */
  }
  // Windows holds the directory until the child really exits; an EBUSY during
  // teardown is not a verdict on the artifact.
  await new Promise((r) => setTimeout(r, 500));
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* leave it to the OS */
  }
}
