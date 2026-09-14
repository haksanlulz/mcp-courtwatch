# GAUNTLET — mcp-courtwatch

Constraint state for this server (SSoT). Created by `/gauntlet convert` 2026-07-29. Operator owns §1 and §5; Claude maintains §2–§4 and §6, transcribing operator rulings only.

One of four near-identical civic servers converted together on 2026-07-29 (`mcp-fairrent` is the pilot and carries the fullest escape log). Sibling precedent: `mcp-scryfall/GAUNTLET.md`.

## §1 Oracle — done-definition

- **It is**: a stdio MCP server over the CourtListener REST API. Tools (11) — `opinion_search`, `docket_lookup`, `court_list`, `case_detail`, `citation_lookup`, `judge_lookup`, `cited_by`, `case_authorities`, `docket_entries`, `oral_arguments`, `oral_argument_transcript`. It exists so that case law, dockets and citation verification are grounded in CourtListener — `citation_lookup` exists specifically so a fabricated citation comes back unfound rather than plausible. ⚠️ **This list read six tools from the 1.1.0 release (2026-08-23) until 2026-09-14**, while `server.ts` registered ten and `test/server.test.ts` asserted ten. Five tools, including the free citator that is the project's headline keyless feature, were missing from the section that defines what this thing is. Corrected; and the list is now mechanically checked — `verify:mcpb` fails when the manifest's tool list and the served `tools/list` disagree, mutation-probed by deleting one entry.
- **DONE means**: (a) an MCP client sees every tool and a real lookup round-trips over stdio; (b) results carry the underlying values so a caller can cite rather than trust; (c) every upstream request is serialized, spaced, timed out, and identifies itself.
- **Non-goals**: legal advice, predicting rulings, anything that asserts a citation is good without checking it.

- **MUST NEVER** (operator, 2026-07-29): *"It's treated as legal advice."* The reader downstream of the model is often a pro-se litigant or an overworked legal-aid worker, and court records are exactly the raw material a person converts into a decision. Output stays records-only, and says so in the payload. Locked by SPEC `records-not-advice`.

⚠️ The three bullets above the MUST NEVER line are still transcribed from the README rather than elicited; the MUST NEVER clause is operator-authored.

## §2 Channel map

**A test suite is one channel; it is never the artifact's channel.**

| Artifact | Real channel | Pass condition | Rung? |
|---|---|---|---|
| server process | an MCP client spawns it and speaks JSON-RPC over **stdio** | initialize handshake · tools/list returns the documented set · a real lookup round-trips | ✅ **`npm run verify:pack` spawns the installed binary and speaks real stdio** (added 2026-07-29). ⚠️ `npm run smoke` and `test/` are BOTH `InMemoryTransport` — an earlier version of this table claimed smoke drove real stdio; it does not, and that claim was wrong when written. |
| upstream API contract | live the CourtListener REST API | endpoints answer; token absence is reported, not crashed | ✅ `npm run smoke` (skips loudly without a free CourtListener API token) |
| public repo | a stranger clones and runs `npm test` | suite green, typecheck clean, build emits | ✅ **GitHub Actions, Node 18/20/22** (added 2026-07-29): `npm ci` → typecheck → build → test, plus a separate `package` job running `verify:pack` |
| **npm package** | a stranger runs `npx @haksanlulz/mcp-courtwatch` having never cloned | bin shim resolves · server boots · handshake answers · tools/list is well-formed | ✅ **`npm run verify:pack`** — builds, packs, installs the tarball into a throwaway project, launches **through the bin shim**, speaks MCP. Mutation-probed against the real historical defect: restoring the `npx tsx` shebang turns it red. Wired into CI. |
| **.mcpb bundle** | a person double-clicks the bundle and their client installs it | manifest validates · the bundle carries no sources or secrets · the declared `entry_point` starts · `tools/list` matches the tools the manifest declares · a keyless call round-trips | ✅ **`npm run verify:mcpb`** (added 2026-09-14) — packs a staged tree, unpacks the real `.mcpb`, reads the manifest **out of the bundle**, launches through its own `mcp_config` with `${__dirname}` substituted and `COURTLISTENER_API_TOKEN` stripped from the child env. Mutation-probed three ways: a nonexistent `entry_point` fails the pack; an `entry_point` pointing at a real file that is not an entry point (`dist/server.js`) fails the probe with *no initialize response*; deleting one tool from the manifest fails on the tool-list disagreement. Wired into CI. |
| registry listing (LobeHub, Glama) | a stranger reads the README there and follows it cold | documented install produces a working server | 🔴 **NO RUNG** — the README is the consumed artifact on those sites and nothing checks it stays executable |

## §3 Invariants — scans

| Invariant | Scan | Status |
|---|---|---|
| Concurrent calls cannot breach the throttle | vitest: *"serializes concurrent requests through the throttle queue"* (`test/throttle.test.ts`) | ✅ **added 2026-09-14, mutation-probed red.** ⚠️ This row said "present" from 2026-08-23 to 2026-09-14 and **the test did not exist** — an exhaustive grep of `test/` and `smoke.ts` found neither it nor the row below. The User-Agent row further down *is* real, which is what made two false rows in the same block easy to read past. |
| Spacing is start-to-start, not gap+latency | vitest: *"spaces request STARTS by the throttle gap"* (`test/throttle.test.ts`) | ✅ **added 2026-09-14, mutation-probed red** (same false-"present" history as the row above). Fake clock, asserting call-START timestamps; neutering `throttled()` to a pass-through turns both red. |
| A garbage numeric env setting cannot poison arithmetic | vitest: *"CL_HTTP_ATTEMPTS=abc still issues the request and returns a normal result"* + the per-setting `abc` / empty / `-1` cases in `test/env-validation.test.ts` | ✅ **added 2026-09-14, mutation-probed red.** `CL_HTTP_ATTEMPTS=abc` made `withRetry`'s loop skip its body and rethrow an unassigned variable: every tool answered the literal text `Error: undefined` with zero network calls. |
| An unexpected envelope is never reported as zero matches | vitest: *"an unexpected response envelope"*, asserted across all eight list/search tools | ✅ **added 2026-09-14, mutation-probed red.** The legitimate-empty test stays green beside it; that contrast is the invariant. |
| No tool result can read `Error: undefined` | vitest: *"a handler that throws undefined produces a message naming the tool, never 'Error: undefined'"* | ✅ **added 2026-09-14, mutation-probed red** |
| A disowned transcript is never presented as a record | vitest: *"stt_status 1 is the ONLY value that yields text"* + *"withholds a status-3 transcript while still saying the text exists"* | ✅ **added 2026-09-14, mutation-probed red** (removing the usability gate turns 8 transcript tests red). CourtListener flags 708 of 103,278 audio records as transcripts that do not match their audio, and those records still carry text. |
| One hung request cannot wedge later calls | `AbortSignal.timeout(15_000)` on every fetch | ✅ present (assertion via the header test) |
| Every request identifies itself to CourtListener | vitest asserts `User-Agent` matches `^mcp-courtwatch/\d` | ✅ **added 2026-07-29, mutation-probed red** |
| Token never enters the query string | vitest asserts header-only auth | ✅ present |
| Published tarball ships no tests/tooling | `files` whitelist + `npm pack --dry-run` | ✅ **added 2026-07-29** — `files: ["dist"]`; `verify:pack` fails if any source, test or tsconfig appears in the tarball |
| Every result is framed records-only (SPEC `records-not-advice`) | vitest, asserted across multiple tools so a tool added outside the shared envelope is caught | ✅ **added 2026-07-29**, written RED first |

## §4 Ladder

| Class | Rungs |
|---|---|
| docs-only | none |
| code-touch (`server.ts` / `index.ts` / `test/`) | `npm test` + `npm run typecheck` + §3 scans · **this is a public commit** |
| behavior-change (tool names, schemas, output shape) | + `npm run smoke` with a live token + README tool table + §5 specs |
| artifact-affecting (`package.json`, deps, shebang, tsconfig, `manifest.json`, `scripts/`) | + **`npm run verify:pack`** + **`npm run verify:mcpb`** — two install channels, two rungs; neither sees the other's failures |
| release (tag / npm publish / bundle) | + the full §2 channel map + `npm run smoke` with a live token + §5 specs |

**Hard gate:** a skipped rung makes the done-report say **BLOCKED**, not done. `prepublishOnly` (`build && typecheck && test`) enforces the code half mechanically. The npm channel itself is covered by `verify:pack`, which CI runs on every push.

## §5 Acceptance specs

### SPEC records-not-advice
```
Given any successful tool call
When the result is returned to a model
Then it carries an explicit records-only framing
```
The framing rides the **payload**, not the tool description. The model has the payload in hand at the moment it writes the sentence a person actually reads; it may no longer be holding the description. The text also carries the docket caveat — entries record what was filed, not what was decided — and states that the absence of a record is not evidence that nothing happened.

Check: `test/server.test.ts` (tagged `spec: records-not-advice`), asserted across multiple tools rather than one, so a new tool added outside the shared envelope is caught. **Red-capable:** written RED first; failed before `withDisclaimer` existed (2026-07-29).

*Slots 2 and 3 are open and operator-owned.*

## §6 Escape log

**2026-07-29 · The npm package cannot work, and the install line I recommended was wrong.** Adding `bin` + `files` + a scoped name and then actually exercising the channel — `npm pack`, install the tarball into a clean project, spawn the installed binary and speak MCP to it — showed the binary dies on launch. `index.ts` carries `#!/usr/bin/env -S npx tsx`, and npm's generated shim cannot honour that: it resolves `npx-cli.js` inside the *consumer's* `node_modules/npm/`, which does not exist. Isolated to packaging, not code — the installed source runs correctly when `tsx` is invoked directly, and the repo's own smoke still passes. **RESOLVED same day by operator ruling** ("bring it up to our best"): a compile step went in. `tsc` already had `outDir`/`rootDir`/`nodenext` configured and every relative import already carried a `.js` extension, so the build cost was the shebang and the wiring — `#!/usr/bin/env node`, `bin` → `dist/index.js`, `files: ["dist"]`, `prepublishOnly`. **⚑ And the first version of the new rung was toothless.** It spawned `node dist/index.js` directly, which bypasses the shebang — so it passed against the broken package. Caught by mutation-probing the rung itself; it now launches through the **bin shim**, and restoring the `npx tsx` shebang turns it red. **This is the founding-incident shape twice over** — 33 green tests plus a passing smoke over an artifact that could not start, and then a rung that could not see it.

**2026-07-29 · `mcp-wagewatch` shipped with no User-Agent at all; 21 green tests never noticed.** It called a free federal API as an anonymous Node client while all three siblings identified themselves. Fixed, and the missing assertion added to all four — mutation-probed in each. **New rung** (§3): every server asserts its own UA.

**2026-07-29 · Four of my own probes returned confident wrong answers in one session.** `npm pack --dry-run` writes no file, so an install test ran against a tarball that never existed and reported "no bin linked". A UA mutation probe grepped stdout for `"User-Agent"`, which also appears in a *passing* run because it is in the test name. A test-count grep missed fairrent entirely because it runs vitest 2.1.9 with ANSI codes while the siblings run 4.1.10. A rate-limiter read called fairrent's throttle naive when it is correctly serialized. **Standing rule for this repo: a probe that cannot be shown to return a negative is not evidence** (workspace Audit Discipline Rules 22/23).

### 2026-08-23 — 1.1.0: citator + RECAP + oral arguments (behavior-change class)

`cited_by` (cites:() operator, keyless — verified live: 470 citing opinions for Obergefell's majority), `case_authorities` (/opinions-cited/, 401-gated), `docket_entries` (/docket-entries/, 401-gated), `oral_arguments` (type=oa, fields taken from a live probe). Fixes: docket_number now rides the FIELDED docketNumber:"..." operator (live: 6 matches vs thousands free-text); a complete court-table walk is cached in-process 24h (CL's docs bless caching that table), with a test-only reset because the cache is a module singleton and would otherwise leak across tests. Rungs: typecheck, verify:pack, and the offline suite. ⚠️ **This entry read "43 tests" against a suite that ran 54; corrected 2026-09-14 to name no number at all.** A count written into prose has no owner and drifts on the next commit, and a stale one reads as a measurement. The live figure is whatever `npm test` prints; the README's Testing section carries it with a date and the command that reproduces it. ⚠️ **It also said "this machine has no token", which was false on 2026-09-14** — a real `COURTLISTENER_API_TOKEN` is set in the environment here, and `npm run smoke` ran 10/10 live with it that morning (at `COURTWATCH_THROTTLE_MS=15000`; the account is on the documented 5 requests/minute new-account limit, and at the 200ms default the last five checks all draw HTTP 429). ⚠️ **That 10/10 was 10 of the 10 CHECKS, not of the 11 tools** — `oral_argument_transcript` had no check to pass. It has one as of 2026-09-14 (below), and the pacing figure is incomplete besides: the per-minute limit is not the binding one.

### 2026-09-14 — correctness sweep, a transcript tool, a bundle, and four false rows in this file

**The four false rows first, because this file is the thing that is supposed to catch that.** §1 listed 6 of the 10 registered tools. §3 recorded both throttle invariants as "present" and neither test existed. §6's 1.1.0 entry said "43 tests" against a suite of 54 and said this machine has no CourtListener token when it has one. Every one of those is a claim about coverage that no rung could contradict, in the document whose job is to say what is actually checked. The tool list is now mechanically checked by `verify:mcpb`; the throttle rows now name tests that a grep of `test/` finds; §6 no longer writes a test count into prose at all.

**Fixes, each mutation-probed before being recorded here.** `CL_HTTP_ATTEMPTS=abc` made `withRetry` skip its loop body and rethrow an unassigned variable, so every tool answered the literal text `Error: undefined` having issued zero requests; the two cache settings failed the same way more quietly. `extractResults` returned `[]` for any unexpected envelope, so a changed API shape would have read as `returned: 0` — "there are no cases like this" — across all eight list and search tools. A `docket_number` ending in a backslash escaped the closing quote of the fielded operator, drew HTTP 500, and was then *retried twice* against a nonprofit's search cluster. A present-but-invalid token got DRF's bare "Invalid token." while a missing one got careful setup guidance. `opinion_search` threw away the opinion ids it already had in hand, so the keyless citator's only documented input route ran through a 401-gated endpoint.

**New: `oral_argument_transcript`.** Both of its design constraints came from live measurement rather than taste — transcripts run past 100,000 characters so the text pages instead of riding a search result, and `stt_status` is an enum whose failure values are common enough to matter (708 of 103,278 records flagged as not matching their audio, and those records still carry text). A status-3 record is withheld rather than presented as a transcript.

**New channel: the `.mcpb` bundle** (§2), with the API token as an optional `user_config` field because seven of the eleven tools need no account. ⚠️ **This sentence, the manifest's install-dialog copy and the bundle probe's header all said "six" and "the other five"** until 2026-09-14; `requireAuth: true` appears at five call sites across exactly four tools (`case_detail` twice, `citation_lookup`, `case_authorities`, `docket_entries`), and the `user_config.description` sitting two fields below the wrong sentence in the same file enumerated the right 7/4 split the whole time.

**A live run caught a bad assertion inside this session's own work.** The status-3 test asserted the payload did not contain "Beaverdam", a word from that record's transcript — but live, audio 106047's `case_name` *is* "Beaverdam Creek Holdings, LLC v. Commissioner of Internal Revenue", so the word is legitimately in the metadata and the assertion was measuring the fixture rather than the behavior. It would have passed forever while proving nothing. Replaced with a sentinel that exists only in the transcript. This is the §6 2026-07-29 lesson again: a probe that cannot be shown to return a negative is not evidence.

### Dependency advisories — 2026-09-14

`npm audit` reports **7 (4 low, 2 moderate, 1 high)**. Scoped, because the number alone is not the finding:

- **Runtime (`npm audit --omit=dev`): 2 moderate, both transitive through the MCP SDK's HTTP transports** — `hono` and `qs` (via `express`). Neither is reachable: this server speaks stdio and imports no HTTP transport, which is what `test/no-http-stack.test.ts` pins and refuses to relax. Fixes exist and will arrive with an SDK bump; nothing here is exploitable in the meantime.
- **The other 5 are dev-only and all trace to one new devDependency**, `@anthropic-ai/mcpb`, through its `@inquirer/prompts` → `external-editor` → `tmp` chain (the high is `tmp`, no fix available upstream). It is a packaging tool that runs on this machine and in CI, is never installed by a consumer, and ships in neither the tarball (`files: ["dist"]`) nor the bundle (`npm install --omit=dev` in the stage).

Re-scope rather than re-count on the next sweep: a raw total mixes a reachable runtime path with a build-time one and reads the same either way.

## Known gaps, ranked by blast radius

1. **README-as-artifact.** It is what LobeHub and Glama render, and nothing checks that the install lines in it execute. The clone-and-point-tsx-at-it text is gone (the npm line and, since 2026-09-14, the `.mcpb` line are what it documents), and both of those channels now have rungs — but the rungs exercise the *artifact*, not the *README's description of it*. A wrong command in the install block is still invisible. **Highest-value remaining item.**
2. **§5 holds one spec of a planned three** — the operator's stated MUST-NEVER for this server is authored, implemented and linked (2026-07-29). Slots 2 and 3 are open. §1's descriptive bullets are still transcribed from the README rather than elicited; only the MUST NEVER clause is in his words.
3. **vitest version drift** — fairrent 2.1.9, the siblings 4.1.10, for no recorded reason.
4. **`smoke` is in-memory, not stdio.** `verify:pack` now covers the real-stdio channel, so smoke's remaining job is the live upstream contract. Its name oversells it.
5. **Nothing is published yet.** The package is verified publishable and the bundle is verified installable; `npm publish` and releasing the `.mcpb` are operator actions.
6. **`oral_arguments`' `transcript_status` is opt-in and therefore usually `NOT_CHECKED`** (2026-09-14). The search index does not carry `stt_status` and `/audio/` has no batch id filter — `?id__in=` is rejected as an unknown parameter, and the vendor's `AudioFilter` gives `id` only the `INTEGER_LOOKUPS` set, which has no `in` — so a real status costs one request per row. If CourtListener ever adds `stt_status` to the `type=oa` search hit, or an `id__in` lookup, this becomes free and should stop being opt-in.
