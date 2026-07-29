#!/usr/bin/env node
/**
 * CHANNEL RUNG — the npm package, exercised the way a stranger consumes it.
 *
 * A test suite is one channel; it is never the artifact's channel. This one
 * packs the real tarball, installs it into a throwaway project with no clone
 * and no source on disk, spawns the installed binary as a child process, and
 * speaks MCP JSON-RPC to it over stdio.
 *
 * It exists because on 2026-07-29 this package had a green suite, a passing
 * smoke, and a binary that could not start: index.ts carried a
 * `#!/usr/bin/env -S npx tsx` shebang, and npm's generated shim resolved
 * `npx-cli.js` inside the CONSUMER's node_modules, which does not exist.
 * Nothing in the repo could have caught that, because nothing ran the artifact.
 *
 * Run: npm run verify:pack
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
const ok = (m) => console.log(`  ok  ${m}`);

console.log(`pack-probe: ${pkg.name}@${pkg.version}`);

// --- 1. build + pack -------------------------------------------------------
if (spawnSync("npm", ["run", "build"], { cwd: repo, shell: true }).status !== 0) fail("build");
const packed = spawnSync("npm", ["pack", "--silent"], { cwd: repo, shell: true, encoding: "utf8" });
if (packed.status !== 0) fail("npm pack");
const tgz = packed.stdout.trim().split("\n").pop().trim();
ok(`packed ${tgz}`);

// The tarball must not carry sources, tests or tooling.
const listing = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: repo, shell: true, encoding: "utf8" });
const files = JSON.parse(listing.stdout)[0].files.map((f) => f.path);
const leaked = files.filter((f) => /^(test|smoke|tsconfig|\.env|server\.ts|index\.ts)/.test(f));
if (leaked.length) fail(`tarball leaks non-shippable files: ${leaked.join(", ")}`);
ok(`tarball is ${files.length} files, no sources or tests`);

// --- 2. install cold, no clone --------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "packprobe-"));
try {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "packprobe", version: "1.0.0", private: true }));
  const inst = spawnSync("npm", ["install", "--silent", join(repo, tgz)], { cwd: dir, shell: true, encoding: "utf8" });
  if (inst.status !== 0) fail(`cold install failed: ${inst.stderr?.slice(0, 400)}`);
  ok("installed into a clean project");

  const binName = Object.keys(pkg.bin ?? {})[0];
  if (!binName) fail("package declares no bin — npx cannot run it");

  // Launch through the INSTALLED BIN SHIM, not `node <path>`. This is the whole
  // point: the 2026-07-29 defect lived in the shim, and a probe that spawns the
  // entry file directly bypasses the shebang and passes against a broken package.
  // (That toothless version was written first and caught by mutation-probing it.)
  const isWin = process.platform === "win32";
  const shim = resolve(dir, "node_modules", ".bin", isWin ? `${binName}.cmd` : binName);
  const child = spawn(`"${shim}"`, [], { stdio: ["pipe", "pipe", "pipe"], cwd: dir, shell: true });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

  send({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pack-probe", version: "1.0.0" } } });
  await new Promise((r) => setTimeout(r, 1200));
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  await new Promise((r) => setTimeout(r, 2000));
  child.kill();
  // Windows keeps a lock on the install dir until the child is really gone;
  // without this wait, teardown throws EBUSY and masks the probe's own verdict.
  await new Promise((r) => { child.once("exit", r); setTimeout(r, 3000); });

  const msgs = out.split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = msgs.find((m) => m.id === 1);
  const tools = msgs.find((m) => m.id === 2);

  if (!init?.result) fail(`no initialize response. stderr: ${err.slice(0, 500)}`);
  ok(`initialize -> ${init.result.serverInfo?.name}@${init.result.serverInfo?.version}`);

  const list = tools?.result?.tools;
  if (!Array.isArray(list) || list.length === 0) fail(`tools/list returned nothing. stderr: ${err.slice(0, 500)}`);
  const malformed = list.filter((t) => !t.name || !t.description || !t.inputSchema);
  if (malformed.length) fail(`tools missing name/description/inputSchema: ${malformed.map((t) => t.name).join(", ")}`);
  ok(`tools/list -> ${list.length}: ${list.map((t) => t.name).join(", ")}`);

  console.log("PASS — the published artifact starts and serves its tools.");
} finally {
  // Teardown is best-effort and must never decide the verdict: an EBUSY on a
  // temp directory is not a failure of the artifact under test.
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* leave it to the OS */ }
  try { rmSync(join(repo, tgz ?? ""), { force: true }); } catch { /* ignore */ }
}
