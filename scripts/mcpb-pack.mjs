#!/usr/bin/env node
/**
 * Build the .mcpb bundle — the one-click install channel.
 *
 * An .mcpb is a self-contained zip: the manifest, the built server, and the
 * runtime dependencies. It cannot be the repo directory, which carries
 * devDependencies, tests and sources, so this stages a clean tree and packs
 * that.
 *
 * Staged tree (build/mcpb/):
 *   manifest.json          copied from the repo root
 *   package.json           name/version/type only, plus the ONE runtime dep
 *   dist/                  tsc output; manifest entry_point points here
 *   node_modules/          npm install --omit=dev in the stage
 *   README.md, LICENSE
 *
 * `"type": "module"` in the staged package.json is load-bearing: dist/*.js are
 * ESM, and without it node reads them as CommonJS and the bundle cannot start.
 *
 * Run: npm run mcpb:pack   (or npm run verify:mcpb, which packs then probes)
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(repo, "build", "mcpb");

const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};
const ok = (m) => console.log(`  ok  ${m}`);

const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(repo, "manifest.json"), "utf8"));

// Two files carrying one version is two chances to publish the wrong one.
if (manifest.version !== pkg.version) {
  fail(`manifest.json version ${manifest.version} != package.json version ${pkg.version}`);
}
ok(`manifest.json and package.json agree on ${pkg.version}`);

const entry = manifest.server?.entry_point;
if (!entry) fail("manifest declares no server.entry_point");

// --- 1. build --------------------------------------------------------------
if (spawnSync("npm", ["run", "build"], { cwd: repo, shell: true, stdio: "inherit" }).status !== 0) {
  fail("npm run build");
}

// --- 2. stage --------------------------------------------------------------
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

cpSync(join(repo, "manifest.json"), join(stage, "manifest.json"));
cpSync(join(repo, "dist"), join(stage, "dist"), { recursive: true });
for (const f of ["README.md", "LICENSE"]) {
  if (existsSync(join(repo, f))) cpSync(join(repo, f), join(stage, f));
}

writeFileSync(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      private: true,
      // dist/*.js are ESM. Without this the bundle cannot start.
      type: "module",
      dependencies: pkg.dependencies ?? {},
    },
    null,
    2,
  ) + "\n",
);

if (!existsSync(join(stage, entry))) fail(`entry_point ${entry} is not in the staged tree`);
ok(`staged manifest, ${entry}, and the runtime dependency list`);

// --- 3. production dependencies only ---------------------------------------
const install = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"], {
  cwd: stage,
  shell: true,
  encoding: "utf8",
});
if (install.status !== 0) fail(`staged install failed: ${install.stderr?.slice(0, 400)}`);
ok("installed runtime dependencies into the stage (no devDependencies)");

// --- 4. validate, then pack ------------------------------------------------
const mcpb = (args, opts = {}) => spawnSync("npx", ["mcpb", ...args], { shell: true, encoding: "utf8", ...opts });

const validated = mcpb(["validate", "manifest.json"], { cwd: stage });
if (validated.status !== 0) {
  fail(`manifest failed validation:\n${(validated.stdout ?? "") + (validated.stderr ?? "")}`);
}
ok(`manifest validates at manifest_version ${manifest.manifest_version}`);

const out = join(repo, "build", `${manifest.name}-${manifest.version}.mcpb`);
rmSync(out, { force: true });
const packed = mcpb(["pack", stage, out], { cwd: repo });
if (packed.status !== 0) {
  fail(`mcpb pack failed:\n${(packed.stdout ?? "") + (packed.stderr ?? "")}`);
}
if (!existsSync(out)) fail(`mcpb pack reported success but ${out} does not exist`);
ok(`packed ${out}`);

// The bundle's contents are checked in scripts/mcpb-probe.mjs, which has to
// unpack it anyway; doing it twice would be two chances to disagree.
console.log(out);
