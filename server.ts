// mcp-courtwatch: MCP server over CourtListener (the Free Law Project's open
// legal database) for free U.S. case-law and court-docket search.
//
// Built for legal-aid orgs, tenant-defense and pro-se litigants, and public-
// interest lawyers who cannot afford Westlaw/PACER.
//
// Data source: CourtListener REST API v4.
//   Base:   https://www.courtlistener.com/api/rest/v4
//   Auth:   Authorization: Token <token>   (free token; see token() below)
//
// Endpoint access (see README.md "Data source"):
//   /search/  (type=o opinions, type=r dockets), /courts/, /people/ all answer
//   unauthenticated at low rate, so those tools attach the token only when it is
//   set (a token raises the rate limit). /clusters/{id}/, /opinions/{id}/, and
//   POST /citation-lookup/ return HTTP 401 without a token, so case_detail and
//   citation_lookup require one.
//
// This module normalizes CourtListener's raw JSON (caseName, dateFiled,
// cluster_id, docket_absolute_url, ...) into clean, documented tool outputs
// rather than passing the raw envelope straight through.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// API constants
// ---------------------------------------------------------------------------

/** CourtListener REST API v4 base. */
const CL_API = "https://www.courtlistener.com/api/rest/v4";
/** Web host, for turning relative absolute_url paths into full links. */
const CL_WEB = "https://www.courtlistener.com";
/** Where to get a free API token (create an account, then Profile > API). */
const TOKEN_SIGNUP_URL = "https://www.courtlistener.com/help/api/rest/";
/** Descriptive User-Agent (CourtListener is a free public service; be identifiable). */
const UA = "mcp-courtwatch/1.0 (+https://github.com/haksanlulz/mcp-courtwatch)";

/**
 * Read an integer setting from the environment, falling back to the documented
 * default on anything unparseable, non-integer, or below `min`, and saying so
 * once on stderr.
 *
 * Every one of these numbers is arithmetic somebody downstream trusts, and NaN
 * does not throw — it makes a comparison false forever. An unvalidated
 * CL_HTTP_ATTEMPTS=abc skipped the whole retry loop and rethrew `undefined`; an
 * unvalidated CL_CACHE_TTL_MS=abc made every cached entry immortal; an
 * unvalidated CL_CACHE_MAX=abc removed the LRU bound. All three fail green.
 *
 * stderr, not stdout: stdout is the MCP stdio channel and any stray byte there
 * corrupts the JSON-RPC stream.
 */
function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  const n = Number(trimmed);
  if (trimmed === "" || !Number.isInteger(n) || n < min) {
    console.error(
      `mcp-courtwatch: ${name}=${JSON.stringify(raw)} is not an integer >= ${min}; using the default ${fallback}.`,
    );
    return fallback;
  }
  return n;
}

/** Minimum spacing between outbound API calls (polite throttle). New
 * CourtListener accounts are throttled at 5 requests/min; set
 * COURTWATCH_THROTTLE_MS=13000 to pace under that until the account limit
 * rises.
 *
 * The fourth numeric setting, and it kept its own ad-hoc reader through the
 * round that validated the other three: `Number("")` is 0, so a client config
 * carrying an empty "COURTWATCH_THROTTLE_MS": "" removed the outbound throttle
 * against a nonprofit's free endpoint and said nothing, and a non-numeric value
 * fell back with none of the stderr line its three siblings write. 0 is still a
 * legitimate value (the offline suite sets it deliberately) — envInt's minimum
 * is 0, and what it rejects is "" and everything unparseable. */
const THROTTLE_MS = envInt("COURTWATCH_THROTTLE_MS", 200, 0);
/** Upper bound on results returned by a single search/list tool call. */
const MAX_RESULTS = 50;
/**
 * True page size of the /search/ endpoint. CourtListener v4 search paginates by
 * cursor and returns a fixed page of ~20; it ignores page_size
 * (/search/?...&page_size=50 still yields 20 rows). A single call
 * therefore cannot return more than one page; more results come via next_cursor
 * (see opinion_search / docket_lookup), not a larger limit.
 */
const SEARCH_PAGE_SIZE = 20;
/**
 * True page size of /people/. The endpoint paginates by cursor and ignores
 * page_size: /people/?name_last=Smith and the same query with page_size=50 both
 * return 20 rows with a `next` (verified live 2026-09-14). judge_lookup exposes
 * no cursor, so 20 is everything one call can reach and advertising 50 promised
 * a number the endpoint cannot serve.
 */
const PEOPLE_PAGE_SIZE = 20;
/**
 * Safety cap on pages walked when scanning the full /courts/ table for a name
 * filter. /courts/ paginates by ?page=N and also ignores page_size (~20/page),
 * so the ~3,359 courts span ~168 pages; cap well
 * above that so every court is reachable without an unbounded loop.
 */
const MAX_COURT_PAGES = 200;
/** Cap on opinion full-text length returned by case_detail (chars). */
const TEXT_CAP = 50000;
/**
 * Oral-argument transcripts are long enough that they cannot ride a search
 * result. Measured live 2026-09-14: a 6,385-second SCOTUS argument (audio
 * 104586) is 101,707 characters of transcript; a 1,051-second circuit argument
 * (audio 106247) is 13,974. So oral_argument_transcript pages: `max_chars`
 * defaults to TRANSCRIPT_DEFAULT_CHARS, is capped at TRANSCRIPT_MAX_CHARS, and
 * a truncated page reports `truncated: true` with the `next_offset` to resume
 * from.
 */
const TRANSCRIPT_DEFAULT_CHARS = 15_000;
const TRANSCRIPT_MAX_CHARS = 50_000;
/**
 * Server-side cap on citation-lookup input text (chars): the request serializer
 * validates `text` at max_length 64,000 (CourtListener source,
 * cl/citations/api_serializers.py). citation_lookup enforces it pre-flight with
 * a clear error rather than letting the API 400, and never truncates.
 */
const CITATION_TEXT_CAP = 64_000;
/**
 * Citations actually checked per citation-lookup call (CourtListener's
 * MAX_CITATIONS_PER_REQUEST, default 250; cl/settings/project/citations.py).
 * Citations past the cap are still returned, each flagged status 429
 * ("Too many citations requested."), surfaced here as NOT_CHECKED_OVER_CAP.
 * The endpoint also rate-limits at 60 citations/min.
 */
const CITATION_MAX_PER_REQUEST = 250;

// CourtListener /search/ `type` enum. Only the two
// this server exposes are used; the rest are here for reference.
//   o  = case-law opinions (clusters)     r  = federal dockets (with documents)
//   rd = PACER filing documents           d  = federal dockets (metadata only)
//   p  = judges / people                  oa = oral-argument audio
const SEARCH_TYPE_OPINION = "o";
const SEARCH_TYPE_DOCKET = "r";
const SEARCH_TYPE_ORAL_ARGUMENT = "oa";

// opinion_search sort options -> the real CourtListener `order_by` values.
const ORDER_BY: Record<string, string> = {
  relevance: "score desc",
  newest: "dateFiled desc",
  oldest: "dateFiled asc",
  most_cited: "citeCount desc",
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * The token, or null. An unsubstituted placeholder is not a token.
 *
 * The .mcpb manifest declares
 * `"COURTLISTENER_API_TOKEN": "${user_config.courtlistener_api_token}"` for a
 * field that is `required: false`, so what arrives in this variable when the
 * user leaves the field blank is up to the host. The bundle probe asserts the
 * entry is dropped; the @anthropic-ai/mcpb package documents no such rule (its
 * README does not mention user_config and the v0.3 schema says nothing about
 * substitution), so that is an assumption about host behavior, not a contract.
 * A host that passes the placeholder through verbatim would otherwise have it
 * sent as `Authorization: Token ${user_config...}`, which 401s all seven
 * keyless tools — and, since a token WAS attached, answers with the guidance
 * that says the user's token is stale when they never set one.
 */
function rawToken(): string | null {
  const t = process.env.COURTLISTENER_API_TOKEN?.trim();
  if (!t || /^\$\{[^}]*\}$/.test(t)) return null;
  return t;
}

/**
 * Read the CourtListener API token from the environment, or throw a clear setup
 * error. Called by tools that hit auth-required endpoints (case_detail).
 */
function token(): string {
  const t = rawToken();
  if (!t) {
    throw new Error(
      `set COURTLISTENER_API_TOKEN (free at ${TOKEN_SIGNUP_URL}). ` +
        "This tool reads an authentication-only CourtListener endpoint.",
    );
  }
  return t;
}

/** The token if set, else null (no throw). Used to opportunistically raise the rate limit. */
function optionalToken(): string | null {
  return rawToken();
}

/**
 * Build request headers. When `requireAuth` is true, a missing token throws the
 * clear token() error BEFORE any network call. When false, the token is attached
 * only if present (the endpoint works without it, just at a lower rate limit).
 */
function buildHeaders(requireAuth: boolean): Record<string, string> {
  const t = requireAuth ? token() : optionalToken();
  const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json" };
  if (t) headers.Authorization = `Token ${t}`;
  return headers;
}

// ---------------------------------------------------------------------------
// Throttled fetch queue (serialize calls, >=THROTTLE_MS apart)
// ---------------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize outbound calls and space each start THROTTLE_MS after the previous
 * one settles (the gap rides the internal queue chain, not the caller's
 * returned promise). The queue
 * keeps flowing on both success and failure, so one error cannot wedge the chain
 * and callers still observe their own errors on `run`.
 */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => sleep(THROTTLE_MS),
    () => sleep(THROTTLE_MS),
  );
  return run;
}

// ---------------------------------------------------------------------------
// Low-level API access
// ---------------------------------------------------------------------------

// CourtListener is a shared public endpoint run by a nonprofit, so a 429 or a
// 5xx is a "come back", not a verdict. Ported from mcp-housing.
//
// Retried: 429, 5xx, transport errors. NOT retried: other 4xx (a 401 without a
// token, or a malformed query, answers identically however often it is asked)
// and a non-JSON body.
class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
class PermanentError extends Error {}

/** Total attempts per request, including the first. Minimum 1: zero attempts
 * would skip the loop body entirely and rethrow whatever `last` still held. */
const HTTP_ATTEMPTS = envInt("CL_HTTP_ATTEMPTS", 3, 1);
const RETRY_BACKOFF_MS = [500, 2000];
const RETRY_DEADLINE_MS = 40_000;
const HTTP_TIMEOUT_MS = 15_000;

function isRetryable(e: unknown): boolean {
  if (e instanceof PermanentError) return false;
  if (e instanceof HttpError) return e.status === 429 || e.status >= 500;
  return true; // transport error or abort
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  let last: unknown;
  for (let attempt = 0; attempt < HTTP_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt === HTTP_ATTEMPTS - 1 || !isRetryable(e)) break;
      const backoff = RETRY_BACKOFF_MS[attempt] ?? 2000;
      if (Date.now() - started + backoff + HTTP_TIMEOUT_MS > RETRY_DEADLINE_MS) break;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw last;
}

type Row = Record<string, unknown>;

type QueryValue = string | number | undefined | null;

/**
 * Read a CourtListener response: surface DRF errors ({"detail":"..."}) on
 * non-2xx, parse JSON on success, and reject non-JSON bodies (HTML error pages
 * / proxy interstitials arrive as non-JSON with a 200). Shared by clGet/clPost.
 */
async function readClResponse(
  res: { ok: boolean; status: number; text: () => Promise<string> },
  opts: { tokenAttached?: boolean } = {},
): Promise<unknown> {
  const text = await res.text();

  if (!res.ok) {
    // DRF errors come back as JSON like {"detail":"..."}; surface that when present.
    let detail = text.slice(0, 300).trim();
    try {
      const j = JSON.parse(text);
      if (j && typeof j === "object" && "detail" in j) detail = String((j as Row).detail);
    } catch {
      /* leave detail as the raw text slice */
    }
    let message = `CourtListener API request failed (HTTP ${res.status}): ${detail}`;
    // A 401 with no token is a setup step, and token() writes careful guidance
    // for it before any request leaves. A 401 WITH a token is the same setup
    // step failing later — optionalToken() only checks that the variable is
    // non-empty, so a wrong, expired, or quote/newline-mangled value sails
    // through and the user who did the setup gets DRF's bare "Invalid token."
    // Never echo the token or any part of it.
    if (res.status === 401 && opts.tokenAttached) {
      message +=
        ` A token WAS sent with this request, so CourtListener is rejecting the one you have.` +
        ` Check COURTLISTENER_API_TOKEN for a copy/paste error (surrounding quotes, a trailing` +
        ` newline, or the word "Token" included in the value), and regenerate it from your` +
        ` CourtListener profile's API page if it is stale (${TOKEN_SIGNUP_URL}).`;
    }
    throw new HttpError(message, res.status);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new PermanentError(`CourtListener API returned a non-JSON response: ${text.slice(0, 300).trim()}`);
  }
}

/**
 * Execute one GET against the CourtListener API and return the parsed JSON.
 * Undefined/null/empty params are omitted. Set opts.requireAuth for endpoints
 * that 401 without a token (case_detail); it throws the token error pre-flight.
 */
// Case law is immutable: an opinion published years ago does not change, and a
// docket's history only grows. A repeat lookup inside a session is asking a
// settled question, so a day is a conservative TTL. CourtListener is run by a
// nonprofit on donated infrastructure, which makes not re-asking a courtesy as
// well as a speedup.
//
// In memory, LRU-bounded, successful reads only -- caching an error would pin a
// transient failure for the life of the process. CL_CACHE_TTL_MS=0 disables it.
//
// GET only. clPost is the citation-lookup endpoint, whose body is the real key
// and whose results are already bounded per request.
const CACHE_TTL_MS = envInt("CL_CACHE_TTL_MS", 24 * 60 * 60 * 1000, 0);
const CACHE_MAX = envInt("CL_CACHE_MAX", 300, 1);
const respCache = new Map<string, { at: number; value: unknown }>();

function cacheGet(key: string): unknown | undefined {
  if (CACHE_TTL_MS <= 0) return undefined;
  const hit = respCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    respCache.delete(key);
    return undefined;
  }
  respCache.delete(key); // re-insert so Map order is LRU
  respCache.set(key, hit);
  return hit.value;
}

function cacheSet(key: string, value: unknown): void {
  if (CACHE_TTL_MS <= 0) return;
  respCache.set(key, { at: Date.now(), value });
  while (respCache.size > CACHE_MAX) {
    const oldest = respCache.keys().next();
    if (oldest.done) break;
    respCache.delete(oldest.value);
  }
}

/** Exported for tests: a cache that cannot be cleared makes the suite order-dependent. */
export function clearClCache(): void {
  respCache.clear();
}

async function clGet(
  path: string,
  params: Record<string, QueryValue> = {},
  opts: { requireAuth?: boolean; expectResults?: string } = {},
): Promise<unknown> {
  const headers = buildHeaders(opts.requireAuth === true); // may throw before fetch
  // Auth is part of the key: an authenticated read can return fields an
  // anonymous one does not, so the two must not share an entry.
  const cacheKey = `${path}?${JSON.stringify(params)}|auth=${opts.requireAuth === true}`;
  const hit = cacheGet(cacheKey);
  if (hit !== undefined) return hit;
  const url = new URL(`${CL_API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const value = await withRetry(async () => {
    const res = await throttled(() => fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }));
    return readClResponse(res, { tokenAttached: headers.Authorization !== undefined });
  });
  // Validate BEFORE writing the cache. extractResults throws on an unexpected
  // envelope, and the cache above this line would otherwise pin that one bad
  // body for CACHE_TTL_MS (24h by default): every identical query would keep
  // throwing, with zero network calls, long after CourtListener went back to
  // normal. The comment on the cache says "successful reads only -- caching an
  // error would pin a transient failure for the life of the process", and a
  // body that parses as JSON but carries no `results` became exactly that the
  // moment an unexpected envelope stopped being reported as zero matches.
  //
  // extractResults is pure, so the caller's own call is left in place.
  if (opts.expectResults !== undefined) extractResults(value, opts.expectResults);
  cacheSet(cacheKey, value);
  return value;
}

/**
 * Execute one POST against the CourtListener API (JSON body) and return the
 * parsed JSON. Same throttle, timeout, and error surfacing as clGet; the token
 * goes in the Authorization header, not the URL or the logs.
 */
async function clPost(
  path: string,
  body: Record<string, unknown>,
  opts: { requireAuth?: boolean } = {},
): Promise<unknown> {
  const headers = buildHeaders(opts.requireAuth === true); // may throw before fetch
  headers["Content-Type"] = "application/json";
  const url = new URL(`${CL_API}${path}`);

  return withRetry(async () => {
    const res = await throttled(() =>
      fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }),
    );
    return readClResponse(res, { tokenAttached: headers.Authorization !== undefined });
  });
}

/**
 * Pull the DRF `results` array out of a list/search envelope.
 *
 * An empty `results` array is a real answer: there are no matches. A body with
 * no `results` array is not an answer at all, and the two must never render the
 * same. Returning [] for both meant a renamed envelope key or a different
 * wrapper would make every list and search tool report `returned: 0,
 * results: []` behind an HTTP 200 — indistinguishable, to a caseworker, from
 * "there are no cases like this."
 *
 * All eight callers read a DRF list/search endpoint. citation_lookup is the one
 * bare-array response in this server and is unpacked at its own call site, not
 * here — where it now carries the equivalent check. This comment previously
 * said that call site was "checked, not assumed" while it was coercing a
 * non-array body to [], i.e. to "no citations were recognized".
 */
function extractResults(json: unknown, source: string): Row[] {
  const tail =
    "Reporting this as zero matches would be indistinguishable from there being none, " +
    "so it is surfaced as an error instead.";
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const results = (json as Row).results;
    if (Array.isArray(results)) return results as Row[];
    const keys = Object.keys(json as Row);
    throw new PermanentError(
      `CourtListener returned an unexpected envelope for ${source}: no \`results\` array. ` +
        `Keys received: ${keys.length ? keys.slice(0, 12).join(", ") : "(none)"}. ${tail}`,
    );
  }
  const got = Array.isArray(json) ? "a bare array" : json === null ? "null" : typeof json;
  throw new PermanentError(
    `CourtListener returned an unexpected body for ${source}: expected a { results: [...] } ` +
      `envelope, got ${got}. ${tail}`,
  );
}

/**
 * Assert a detail endpoint answered with the record that was asked for.
 *
 * extractResults refuses an unexpected LIST envelope; the detail endpoints had
 * no equivalent, so a body carrying no matching `id` — a list envelope, an
 * error object served with a 200, a changed serializer — normalized into a
 * record whose every field is null and was returned as a successful answer. A
 * case with no name, no date and no citations is a missing record, not a thin
 * one.
 *
 * `id` is the right anchor: all three detail responses echo it (live
 * 2026-09-14, /audio/106247/?fields=id,stt_status,duration -> {"id":106247,...};
 * /clusters/ and /opinions/ are token-gated, and both normalizers already read
 * `.id` off them).
 */
function expectDetail(json: unknown, id: number, source: string): Row {
  const isObject = json != null && typeof json === "object" && !Array.isArray(json);
  if (isObject && num((json as Row).id) === id) return json as Row;
  const got = isObject
    ? `keys: ${Object.keys(json as Row).slice(0, 12).join(", ") || "(none)"}`
    : Array.isArray(json)
      ? "an array"
      : json === null
        ? "null"
        : typeof json;
  throw new PermanentError(
    `CourtListener returned an unexpected body for ${source}: expected the record with id ${id}, got ${got}. ` +
      "Normalizing it would produce a record whose fields are all null, which is indistinguishable from a " +
      "real case with nothing on file, so it is surfaced as an error instead.",
  );
}

/**
 * Say what `limit` dropped from a page the caller may then try to page past.
 *
 * The four /search/ tools slice the page to `limit` but take next_cursor from
 * the full envelope, so the cursor begins at the row after the whole PAGE, not
 * after the last row returned. A caller who sets limit below the page size and
 * then pages silently loses every sliced-off row — while the `cursor` argument's
 * own description tells them to page exactly that way.
 *
 * Returns undefined when nothing was dropped, so the payload stays quiet in the
 * common case.
 */
function droppedNote(pageLength: number, kept: number): string | undefined {
  const dropped = pageLength - kept;
  if (dropped <= 0) return undefined;
  return (
    `limit kept ${kept} of the ${pageLength} rows CourtListener sent for this page. next_cursor begins at ` +
    `the next page, so paging with it skips the ${dropped} dropped row(s) — raise limit to ` +
    `${SEARCH_PAGE_SIZE} when you intend to page.`
  );
}

/**
 * Extract the opaque `cursor` value from a DRF envelope's `next` URL, or null
 * when there is no next page. CourtListener's /search/ `next` looks like
 * `.../search/?cursor=<value>&q=...`; we surface just the cursor so a caller can
 * pass it straight back as the `cursor` argument to page forward.
 */
function extractCursor(next: unknown): string | null {
  const s = str(next);
  if (!s) return null;
  try {
    return new URL(s).searchParams.get("cursor");
  } catch {
    // `next` may arrive as a relative path; resolve it against the web host.
    try {
      return new URL(s, CL_WEB).searchParams.get("cursor");
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Coerce an API value to a number, or null. */
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Coerce an API value to a trimmed non-empty string, or null. */
function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Coerce to boolean when the value truly is one, else null (never guess). */
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** Turn a relative CourtListener path (/opinion/123/...) into a full URL. */
function fullUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return `${CL_WEB}${s.startsWith("/") ? "" : "/"}${s}`;
}

/** Extract the highlighted snippet from a search hit's nested opinions[]. */
function firstSnippet(opinions: unknown): string | null {
  if (Array.isArray(opinions)) {
    for (const o of opinions) {
      if (o && typeof o === "object") {
        const s = str((o as Row).snippet);
        if (s) return s;
      }
    }
  }
  return null;
}

/**
 * Pull the opinion ids out of a type=o search hit's nested `opinions[]`.
 *
 * This is the only KEYLESS route to an opinion id, and cited_by — the free
 * citator — takes an opinion id, not a cluster id. The other documented route
 * (case_detail's sub_opinion_ids) reads /clusters/{id}/, which answers 401
 * without a token, so a token-less caller could not reach the keyless feature.
 * Entries with no id are dropped: they cannot be passed to anything.
 *
 * Live shape (unauthenticated, 2026-09-14):
 *   /search/?type=o&q=obergefell&court=scotus -> results[0].cluster_id 8174675,
 *   opinions [{"id": 8136452, "type": "lead-opinion", "snippet": "...", ...}]
 */
function normalizeHitOpinions(v: unknown): Array<{ id: number; type: string | null }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ id: number; type: string | null }> = [];
  for (const o of v) {
    if (o && typeof o === "object") {
      const id = num((o as Row).id);
      if (id != null) out.push({ id, type: str((o as Row).type) });
    }
  }
  return out;
}

/** Pull a trailing numeric id out of a resource URL (…/opinions/12345/). */
function idFromUrl(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const m = /\/(\d+)\/?$/.exec(s);
  return m ? Number(m[1]) : null;
}

/**
 * Normalize a citations value into display strings. CourtListener returns either
 * an array of strings ("347 U.S. 483") or an array of objects
 * {volume, reporter, page, type}; handle both, drop anything empty.
 */
function normalizeCitations(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const c of v) {
    if (typeof c === "string") {
      const s = c.trim();
      if (s) out.push(s);
    } else if (c && typeof c === "object") {
      const o = c as Row;
      const parts = [o.volume, o.reporter, o.page].map((x) => str(x)).filter(Boolean);
      if (parts.length) out.push(parts.join(" "));
    }
  }
  return out;
}

/** Strip HTML tags to plain text (for opinion bodies stored only as HTML/XML). */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Choose the best available opinion body, preferring plain text, then HTML/XML. */
function bestOpinionText(o: Row): { text: string | null; source: string | null; truncated: boolean } {
  const plain = str(o.plain_text);
  let text: string | null = null;
  let source: string | null = null;
  if (plain) {
    text = plain;
    source = "plain_text";
  } else {
    for (const f of ["html_with_citations", "html", "html_columbia", "html_lawbox", "html_anon_2020", "xml_harvard"]) {
      const h = str(o[f]);
      if (h) {
        text = stripTags(h);
        source = f;
        break;
      }
    }
  }
  if (text == null) return { text: null, source: null, truncated: false };
  if (text.length > TEXT_CAP) return { text: text.slice(0, TEXT_CAP), source, truncated: true };
  return { text, source, truncated: false };
}

// --- per-object normalizers ------------------------------------------------

/** Normalize one type=o (opinion) search hit. */
function normalizeOpinionHit(r: Row): Record<string, unknown> {
  return {
    case_name: str(r.caseName) ?? str(r.caseNameFull),
    court: str(r.court),
    court_id: str(r.court_id),
    date_filed: str(r.dateFiled),
    citations: normalizeCitations(r.citation),
    docket_number: str(r.docketNumber),
    cite_count: num(r.citeCount),
    status: str(r.status),
    snippet: firstSnippet(r.opinions) ?? str(r.snippet),
    // The opinion ids inside this case, keyless. Pass one to cited_by.
    opinions: normalizeHitOpinions(r.opinions),
    cluster_id: num(r.cluster_id),
    docket_id: num(r.docket_id),
    absolute_url: fullUrl(r.absolute_url),
  };
}

/** Normalize one type=r (docket) search hit. */
function normalizeDocketHit(r: Row): Record<string, unknown> {
  return {
    case_name: str(r.caseName) ?? str(r.case_name_full),
    court: str(r.court),
    court_id: str(r.court_id),
    docket_number: str(r.docketNumber),
    date_filed: str(r.dateFiled),
    date_terminated: str(r.dateTerminated),
    nature_of_suit: str(r.suitNature),
    docket_id: num(r.docket_id),
    absolute_url: fullUrl(r.docket_absolute_url),
  };
}

/** Normalize one type=oa (oral argument) search hit (fields verified live 2026-08-23). */
function normalizeOralArgumentHit(r: Row): Record<string, unknown> {
  return {
    case_name: str(r.caseName) ?? str(r.case_name_full),
    court: str(r.court),
    court_id: str(r.court_id),
    docket_number: str(r.docketNumber),
    date_argued: str(r.dateArgued),
    date_reargued: str(r.dateReargued),
    judges: str(r.judge),
    duration_seconds: num(r.duration),
    audio_id: num(r.id),
    docket_id: num(r.docket_id),
    download_url: str(r.download_url),
    // For type=oa the indexed text IS the Whisper transcript, so this excerpt is
    // machine speech-to-text, not a certified transcript. Live 2026-09-14 it is
    // byte-identical to the opening of the record's stt_transcript.
    snippet: str(r.snippet),
    // Filled in only when the caller asks (see oral_arguments): the search index
    // does not carry stt_status, and /audio/ has no batch id filter.
    transcript_status: "NOT_CHECKED",
    absolute_url: fullUrl(r.absolute_url),
  };
}

/**
 * Normalize an /audio/{id}/ record into a transcript page.
 *
 * Refuses to hand back text unless stt_status says the transcription completed.
 * `transcript_chars` reports the length that is ON THE RECORD even when the text
 * is withheld, so a caller can tell "nothing was transcribed" from "there is
 * text and it is disowned."
 */
function normalizeTranscript(
  a: Row,
  audioId: number,
  offset: number,
  maxChars: number,
): Record<string, unknown> {
  const status = num(a.stt_status);
  const meaning = sttVerdict(status);
  // Not str(): trimming would shift every offset away from what a live
  // /audio/<id>/ read returns.
  const full = typeof a.stt_transcript === "string" ? a.stt_transcript : "";
  const sourceCode = num(a.stt_source);

  const base = {
    audio_id: audioId,
    case_name: str(a.case_name) ?? str(a.case_name_full),
    judges: str(a.judges),
    duration_seconds: num(a.duration),
    docket_url: str(a.docket),
    download_url: str(a.download_url),
    absolute_url: fullUrl(a.absolute_url),
    stt_status: status,
    stt_verdict: meaning.verdict,
    stt_meaning: meaning.meaning,
    stt_source: sourceCode == null ? null : STT_SOURCES[sourceCode] ?? `STT_SOURCE_${sourceCode}`,
    machine_generated: true,
    provenance: TRANSCRIPT_PROVENANCE,
    transcript_chars: full.length,
  };

  if (!meaning.usable || full === "") {
    return {
      ...base,
      transcript_usable: false,
      offset,
      returned_chars: 0,
      truncated: false,
      next_offset: null,
      text: null,
      warning:
        `No usable transcript is returned for audio ${audioId}. ${meaning.meaning}` +
        (full.length > 0
          ? ` The record does carry ${full.length} characters of text, withheld here rather than passed off as a transcript.`
          : "") +
        (base.download_url ? ` The audio itself is at ${base.download_url}.` : ""),
    };
  }

  const page = full.slice(offset, offset + maxChars);
  const end = offset + page.length;
  const truncated = end < full.length;
  return {
    ...base,
    transcript_usable: true,
    offset,
    returned_chars: page.length,
    truncated,
    next_offset: truncated ? end : null,
    max_chars: maxChars,
    text: page,
  };
}

/** Normalize one /docket-entries/ record, defensively (auth-only endpoint). */
function normalizeDocketEntry(r: Row): Record<string, unknown> {
  const docs = Array.isArray(r.recap_documents) ? (r.recap_documents as Row[]) : [];
  return {
    id: num(r.id),
    entry_number: num(r.entry_number),
    date_filed: str(r.date_filed),
    description: str(r.description),
    recap_documents: docs.map((d) => ({
      id: num(d.id),
      document_number: str(d.document_number),
      attachment_number: num(d.attachment_number),
      description: str(d.description),
      short_description: str(d.description_short) ?? str(d.short_description),
      page_count: num(d.page_count),
      is_available: bool(d.is_available),
      filepath_local: str(d.filepath_local),
      absolute_url: fullUrl(d.absolute_url),
    })),
  };
}

// CourtListener's speech-to-text state for an oral-argument recording. This is
// an ENUM, not a flag, and its failure values are not rare: of 103,278 audio
// records on 2026-09-14, 708 are status 3, 154 are 4, 77 are 5, 46 are 2 and
// 16 are 0 (counted live, one /audio/?stt_status=N&count=on per value).
//
// Names and numbers from the vendor source, cl/audio/models.py:
//   0 STT_NEEDED  "Speech to Text Needed"
//   1 STT_COMPLETE  "Speech to Text Complete"
//   2 STT_FAILED  "Speech to Text Failed"
//   3 STT_HALLUCINATION  "Transcription does not match audio"
//   4 STT_FILE_TOO_BIG  "File size is bigger than 25 MB"
//   5 STT_NO_FILE  "File does not exist"
//
// Status 3 still carries text, and the text is worse than useless: audio 106047
// holds 9,450 characters that are the case caption repeated over and over.
// A status-3 record is never presented as a transcript.
const STT_VERDICTS: Record<number, { verdict: string; usable: boolean; meaning: string }> = {
  0: {
    verdict: "TRANSCRIPTION_NEEDED",
    usable: false,
    meaning: "CourtListener has not transcribed this recording yet (stt_status 0, Speech to Text Needed).",
  },
  1: {
    verdict: "COMPLETE",
    usable: true,
    meaning: "CourtListener's Whisper transcription of this recording completed (stt_status 1).",
  },
  2: {
    verdict: "TRANSCRIPTION_FAILED",
    usable: false,
    meaning: "Transcription was attempted and failed (stt_status 2, Speech to Text Failed).",
  },
  3: {
    verdict: "TRANSCRIPTION_DOES_NOT_MATCH_AUDIO",
    usable: false,
    meaning:
      "CourtListener flagged this transcript as not matching the audio (stt_status 3, a Whisper " +
      "hallucination). Text exists on the record and is withheld here: in the case measured, it was " +
      "the case caption repeated for thousands of characters. Listen to the audio instead.",
  },
  4: {
    verdict: "AUDIO_FILE_TOO_BIG",
    usable: false,
    meaning: "The recording is over the 25 MB transcription limit, so it was never transcribed (stt_status 4).",
  },
  5: {
    verdict: "AUDIO_FILE_MISSING",
    usable: false,
    meaning: "CourtListener has no audio file for this record, so there is nothing to transcribe (stt_status 5).",
  },
};

/** The verdict for an stt_status, never guessing on a value the enum does not carry. */
function sttVerdict(status: number | null): { verdict: string; usable: boolean; meaning: string } {
  if (status == null) {
    return {
      verdict: "STATUS_UNKNOWN",
      usable: false,
      meaning: "This record carried no stt_status, so nothing is claimed about its transcript.",
    };
  }
  return (
    STT_VERDICTS[status] ?? {
      verdict: `STATUS_${status}`,
      usable: false,
      meaning: `CourtListener reported stt_status ${status}, which this server does not recognize. Treated as unusable.`,
    }
  );
}

// stt_source, same vendor source: 1 = OpenAI API's whisper-1 model,
// 2 = self-hosted Whisper model.
const STT_SOURCES: Record<number, string> = {
  1: "OpenAI API whisper-1",
  2: "self-hosted Whisper",
};

/** Every transcript here is machine speech-to-text. Say so in the payload, every time. */
const TRANSCRIPT_PROVENANCE =
  "Machine-generated Whisper speech-to-text produced by CourtListener. This is NOT a court " +
  "reporter's certified transcript and is not part of the record: it mishears names, numbers and " +
  "citations, and it carries no speaker attribution. Quote from the audio, not from this text.";

/** Normalize one /opinions-cited/ record, defensively (auth-only endpoint). */
function normalizeCitedPair(r: Row): Record<string, unknown> {
  return {
    cited_opinion_id: idFromUrl(r.cited_opinion) ?? num(r.cited_opinion),
    citing_opinion_id: idFromUrl(r.citing_opinion) ?? num(r.citing_opinion),
    depth: num(r.depth), // how many times the citing opinion cites this authority
  };
}

/** Normalize one /courts/ record. */
function normalizeCourt(c: Row): Record<string, unknown> {
  return {
    id: str(c.id),
    full_name: str(c.full_name),
    short_name: str(c.short_name),
    jurisdiction: str(c.jurisdiction),
    citation_string: str(c.citation_string),
    in_use: bool(c.in_use),
    website: str(c.url),
    start_date: str(c.start_date),
    end_date: str(c.end_date),
  };
}

/** Normalize one /people/ (judge) record. */
function normalizeJudge(p: Row): Record<string, unknown> {
  const name =
    [p.name_first, p.name_middle, p.name_last, p.name_suffix].map((x) => str(x)).filter(Boolean).join(" ") ||
    null;
  return {
    id: num(p.id),
    name,
    date_of_birth: str(p.date_dob),
    date_of_death: str(p.date_dod),
    birth_city: str(p.dob_city),
    birth_state: str(p.dob_state),
    gender: str(p.gender),
    positions_count: Array.isArray(p.positions) ? p.positions.length : null,
    slug: str(p.slug),
    resource_uri: str(p.resource_uri),
  };
}

/** Normalize a /clusters/{id}/ detail object (the "case": grouping of opinions). */
function normalizeClusterDetail(c: Row): Record<string, unknown> {
  const subUrls = Array.isArray(c.sub_opinions) ? (c.sub_opinions as unknown[]) : [];
  return {
    type: "cluster",
    id: num(c.id),
    case_name: str(c.case_name) ?? str(c.case_name_full),
    case_name_full: str(c.case_name_full),
    case_name_short: str(c.case_name_short),
    date_filed: str(c.date_filed),
    citations: normalizeCitations(c.citations),
    precedential_status: str(c.precedential_status),
    citation_count: num(c.citation_count),
    judges: str(c.judges),
    nature_of_suit: str(c.nature_of_suit),
    posture: str(c.posture),
    syllabus: str(c.syllabus),
    attorneys: str(c.attorneys),
    docket_url: str(c.docket),
    sub_opinion_ids: subUrls.map(idFromUrl).filter((x): x is number => x != null),
    absolute_url: fullUrl(c.absolute_url),
  };
}

/** Normalize an /opinions/{id}/ detail object (one opinion's text + metadata). */
function normalizeOpinionDetail(o: Row): Record<string, unknown> {
  const body = bestOpinionText(o);
  return {
    type: "opinion",
    id: num(o.id),
    opinion_type: str(o.type),
    author: str(o.author_str),
    per_curiam: bool(o.per_curiam),
    page_count: num(o.page_count),
    download_url: str(o.download_url),
    cluster_url: str(o.cluster),
    text: body.text,
    text_source: body.source,
    text_truncated: body.truncated,
    absolute_url: fullUrl(o.absolute_url),
  };
}

// citation-lookup per-citation `status` codes, from CourtListener source
// (cl/citations/api_views.py): HTTP-style codes embedded per item.
//   200 found (one cluster)          300 found, multiple matching clusters
//   400 unknown reporter             404 no such citation in the database
//   429 past the per-request citation cap (not looked up)
const CITATION_VERDICTS: Record<number, { verdict: string; verified: boolean }> = {
  200: { verdict: "FOUND", verified: true },
  300: { verdict: "FOUND_MULTIPLE", verified: true },
  400: { verdict: "UNKNOWN_REPORTER", verified: false },
  404: { verdict: "NOT_FOUND", verified: false },
  429: { verdict: "NOT_CHECKED_OVER_CAP", verified: false },
};

/**
 * Normalize one cluster attached to a citation-lookup hit. Same snake_case
 * OpinionClusterSerializer shape as /clusters/{id}/, kept to the fields that
 * identify the case. NOTE: the cluster payload does not carry the court (that
 * lives on the docket); follow absolute_url or pass cluster_id to case_detail.
 */
function normalizeCitationMatch(c: Row): Record<string, unknown> {
  return {
    cluster_id: num(c.id),
    case_name: str(c.case_name) ?? str(c.case_name_full),
    date_filed: str(c.date_filed),
    citations: normalizeCitations(c.citations),
    precedential_status: str(c.precedential_status),
    citation_count: num(c.citation_count),
    judges: str(c.judges),
    docket_id: num(c.docket_id),
    absolute_url: fullUrl(c.absolute_url),
  };
}

/** Normalize one /citation-lookup/ item (one citation found in the text). */
function normalizeCitationResult(r: Row): Record<string, unknown> {
  const status = num(r.status);
  const meaning =
    status != null
      ? CITATION_VERDICTS[status] ?? { verdict: `STATUS_${status}`, verified: false }
      : { verdict: "UNKNOWN", verified: false }; // never guess on a shape we don't know
  const clusters = Array.isArray(r.clusters) ? (r.clusters as Row[]) : [];
  return {
    citation: str(r.citation),
    verified: meaning.verified,
    verdict: meaning.verdict,
    status,
    error_message: str(r.error_message),
    normalized_citations: Array.isArray(r.normalized_citations)
      ? (r.normalized_citations as unknown[]).map((x) => str(x)).filter((x): x is string => x != null)
      : [],
    start_index: num(r.start_index),
    end_index: num(r.end_index),
    matches: clusters.map(normalizeCitationMatch),
  };
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

function clampLimit(v: unknown, fallback: number, max: number = MAX_RESULTS): number {
  const n = num(v);
  if (n == null) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

/** Validate an optional ISO date (YYYY-MM-DD), or throw. Returns undefined when absent. */
function normDate(v: unknown, label: string): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`${label} must be an ISO date (YYYY-MM-DD); got: ${JSON.stringify(v)}`);
  }
  return s;
}

/**
 * Drop a dangling backslash from an outgoing query.
 *
 * A backslash with nothing left to escape makes CourtListener's query parser
 * answer HTTP 500 — verified live 2026-09-14:
 *   /search/?type=o&q=eviction\   -> HTTP 500 {"detail":"Internal Server Error..."}
 *   /search/?type=o&q=eviction    -> HTTP 200
 *   /search/?type=o&q=eviction\\  -> HTTP 200  (a balanced pair is a real escaped backslash)
 * and a 500 is retryable here, so one trailing backslash in a free-text query
 * becomes three 500s against a nonprofit's search cluster, on the most-used tool
 * in this server.
 *
 * Only the trailing run is touched, and only its odd character: a balanced pair
 * escapes a literal backslash and is part of what the caller asked for. Interior
 * escapes (`\"`, `\:`) are left alone — they have something to escape.
 */
function stripDanglingEscape(q: string): string {
  const run = /\\+$/.exec(q);
  if (!run) return q;
  const balanced = run[0].length - (run[0].length % 2);
  return q.slice(0, q.length - run[0].length) + "\\".repeat(balanced);
}

/**
 * Clean an outgoing free-text query, and refuse one that cleans away to nothing.
 *
 * stripDanglingEscape can empty a query made only of dangling escapes, and
 * clGet omits an empty parameter — so the search would leave with no `q` at
 * all. Live 2026-09-14: /search/?type=o with no q answers HTTP 200 with count
 * 8,310,312, every opinion in the database, which the payload then reports as
 * total_matches for the caller's query. That is the confusion docket_number is
 * already refused for one argument over, pointing the other way: there an
 * argument that sanitized away read as "no such docket", here as eight million
 * matches.
 */
function cleanQuery(raw: string, label: string): string {
  const cleaned = stripDanglingEscape(raw).trim();
  if (!cleaned) {
    throw new Error(
      `${label} ${JSON.stringify(raw)} is only escape characters; nothing is left to search for after ` +
        "dropping them. An empty query matches every record in CourtListener, so it is an error rather " +
        "than a result set.",
    );
  }
  return cleaned;
}

/**
 * Look up an allow-listed option, without Object.prototype answering for it.
 *
 * The option tables here are plain object literals, so they inherit
 * Object.prototype: `ORDER_BY["toString"]` is a truthy function and
 * `"constructor" in OA_ORDER_BY` is true. Both validators were written as a
 * truthiness check and an `in` check respectively, so `order_by: "toString"`
 * passed and was then stringified into the outgoing query as
 * "function toString() { [native code] }".
 *
 * The enum in the tool's inputSchema does not catch it either: the low-level
 * SDK Server does no inputSchema validation (no `inputSchema` reference in
 * node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js), so the
 * schema is advisory and the handler is the only gate.
 *
 * hasOwnProperty is the test, not truthiness: OA_ORDER_BY.relevance is
 * legitimately undefined (the search default), and that is a real option.
 */
function pickOption<T>(table: Record<string, T>, key: string, label: string): T {
  if (!Object.prototype.hasOwnProperty.call(table, key)) {
    throw new Error(`${label} must be one of: ${Object.keys(table).join(", ")}.`);
  }
  return table[key];
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: "opinion_search",
    description:
      "Full-text search of U.S. case law / court opinions (CourtListener type=o). " +
      "Returns the top matching page (up to `limit`) with case name, court, date filed, " +
      "citations, docket number, a snippet, citation count, and a link. Each hit also " +
      "carries `opinions`: the ids of the opinions in that case, which is the keyless " +
      "input to cited_by. Works without a " +
      "token; set COURTLISTENER_API_TOKEN for a higher rate limit.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: 'Search query. Supports plain terms and phrases (e.g. "warrantless search", "qualified immunity").',
        },
        court: {
          type: "string",
          description: 'Optional court id to filter to (e.g. "scotus", "ca9", "nysd"). Get ids from court_list.',
        },
        filed_after: { type: "string", description: "Optional ISO date (YYYY-MM-DD); only opinions filed on/after." },
        filed_before: { type: "string", description: "Optional ISO date (YYYY-MM-DD); only opinions filed on/before." },
        order_by: {
          type: "string",
          enum: ["relevance", "newest", "oldest", "most_cited"],
          description: "Sort order (default relevance).",
        },
        limit: {
          type: "integer",
          description: `Max results from this page (1-${SEARCH_PAGE_SIZE}, default ${SEARCH_PAGE_SIZE}). The /search/ endpoint returns one fixed page of ~${SEARCH_PAGE_SIZE}; to get more, pass the response's next_cursor back as cursor.`,
        },
        cursor: {
          type: "string",
          description: "Opaque pagination cursor from a previous response's next_cursor; fetches the next page (keep the other args the same).",
        },
      },
      required: ["q"],
      additionalProperties: false,
    },
  },
  {
    name: "docket_lookup",
    description:
      "Search court dockets (CourtListener type=r) by case name, free text, and/or docket number, " +
      "optionally scoped to a court. Returns case name, court, docket number, filed/terminated dates, " +
      "nature of suit, and a link. Works without a token.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Case name or free-text query (e.g. an employer or agency name)." },
        docket_number: { type: "string", description: 'Docket number to match (e.g. "1:20-cv-03590").' },
        court: { type: "string", description: 'Optional court id filter (e.g. "nysd"). Get ids from court_list.' },
        limit: {
          type: "integer",
          description: `Max results from this page (1-${SEARCH_PAGE_SIZE}, default ${SEARCH_PAGE_SIZE}). The /search/ endpoint returns one fixed page of ~${SEARCH_PAGE_SIZE}; to get more, pass the response's next_cursor back as cursor.`,
        },
        cursor: {
          type: "string",
          description: "Opaque pagination cursor from a previous response's next_cursor; fetches the next page (keep the other args the same).",
        },
      },
      // Requires at least one of q / docket_number (enforced in the handler).
      additionalProperties: false,
    },
  },
  {
    name: "court_list",
    description:
      "List CourtListener courts and their ids (the values used as the `court` filter in opinion_search / " +
      "docket_lookup). Optionally filter by jurisdiction code and/or a name substring. " +
      'Jurisdiction codes include "F" (federal appellate/other), "FD" (federal district), "FB" (bankruptcy), ' +
      '"S" (state), "SA" (state appellate), "SS" (state supreme). Works without a token.',
    inputSchema: {
      type: "object",
      properties: {
        jurisdiction: { type: "string", description: 'Optional jurisdiction code filter (e.g. "F", "FD", "S").' },
        q: {
          type: "string",
          description: "Optional case-insensitive substring matched against court id / full name / short name / citation string (applied to the fetched page).",
        },
        limit: { type: "integer", description: `Max courts to return (1-${MAX_RESULTS}, default 25).` },
      },
      additionalProperties: false,
    },
  },
  {
    name: "case_detail",
    description:
      "Fetch a full case by id: a cluster (the case: name, citations, date, judges, and its opinion ids) or a " +
      "single opinion (its full text). Requires COURTLISTENER_API_TOKEN (these endpoints are authentication-only). " +
      "Use the cluster_id from opinion_search results.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Numeric cluster id (default) or opinion id." },
        type: {
          type: "string",
          enum: ["cluster", "opinion"],
          description: 'Which resource `id` refers to (default "cluster"). A cluster is the case; an opinion is one document within it.',
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "citation_lookup",
    description:
      "Verify legal citations against CourtListener's database of real cases before relying on them; catches " +
      "fabricated or mangled citations. Pass free text (a brief, memo, or " +
      "draft) or a single citation string; every citation recognized in the text is checked. Per citation: " +
      "FOUND (with case name, date, and link) or an explicit NOT_FOUND / UNKNOWN_REPORTER flag. Requires " +
      `COURTLISTENER_API_TOKEN (authentication-only endpoint). Caps: ${CITATION_TEXT_CAP} characters of text and ` +
      `${CITATION_MAX_PER_REQUEST} citations per call (server rate limit: 60 citations/min).`,
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            `Free text to scan for citations (max ${CITATION_TEXT_CAP} characters), or a single citation string ` +
            `like "410 U.S. 113". The first ${CITATION_MAX_PER_REQUEST} citations recognized are looked up; any ` +
            "beyond that are returned flagged NOT_CHECKED_OVER_CAP.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "cited_by",
    description:
      "Every opinion that CITES a given opinion — the free version of a citator check ('is this " +
      "case still being relied on, and by whom'). Pass an opinion id. The keyless way to get one " +
      "is an opinion_search hit's `opinions[].id`; case_detail's sub_opinion_ids also gives it, " +
      "but that endpoint needs a token, so use opinion_search when you have none. Returns citing " +
      "opinions newest-first or most-cited-first with the same fields as opinion_search. Works " +
      "without a token. NOTE: this reports who cites the case; it does NOT classify the treatment " +
      "(followed/distinguished/overruled) — read the citing opinions.",
    inputSchema: {
      type: "object",
      properties: {
        opinion_id: {
          type: "integer",
          description:
            "Numeric OPINION id (not a cluster id). Keyless source: an opinion_search hit's opinions[].id. " +
            "With a token, case_detail on a cluster also lists its sub_opinion_ids.",
        },
        order_by: { type: "string", enum: ["newest", "oldest", "most_cited", "relevance"], description: "Sort order (default newest)." },
        limit: { type: "integer", description: `Max results from this page (1-${SEARCH_PAGE_SIZE}, default ${SEARCH_PAGE_SIZE}).` },
        cursor: { type: "string", description: "Opaque cursor from a previous response's next_cursor." },
      },
      required: ["opinion_id"],
      additionalProperties: false,
    },
  },
  {
    name: "case_authorities",
    description:
      "The reverse of cited_by: every authority a given opinion RELIES ON (its table of " +
      "authorities), with a depth count of how many times each is cited. Pass the citing opinion's " +
      "id. Requires COURTLISTENER_API_TOKEN (authentication-only endpoint). Returns cited opinion " +
      "ids; fetch interesting ones with case_detail (type opinion) or their clusters.",
    inputSchema: {
      type: "object",
      properties: {
        opinion_id: { type: "integer", description: "Numeric OPINION id whose authorities to list." },
        limit: { type: "integer", description: `Max authorities to return (1-${MAX_RESULTS}, default ${MAX_RESULTS}).` },
      },
      required: ["opinion_id"],
      additionalProperties: false,
    },
  },
  {
    name: "docket_entries",
    description:
      "The actual filing history of a federal docket from the RECAP archive: numbered entries, " +
      "dates, descriptions, and any archived PACER documents (with page counts and availability). " +
      "Pass a docket_id from docket_lookup. Requires COURTLISTENER_API_TOKEN (authentication-only " +
      "endpoint). Coverage note: RECAP holds what its users have bought from PACER — an entry or " +
      "document not present may still exist on PACER.",
    inputSchema: {
      type: "object",
      properties: {
        docket_id: { type: "integer", description: "Numeric docket id (from docket_lookup results)." },
        limit: { type: "integer", description: `Max entries to return (1-${MAX_RESULTS}, default ${MAX_RESULTS}).` },
        cursor: { type: "string", description: "Opaque cursor from a previous response's next_cursor." },
      },
      required: ["docket_id"],
      additionalProperties: false,
    },
  },
  {
    name: "oral_arguments",
    description:
      "Search oral-argument audio recordings (CourtListener type=oa): case name, court, argue " +
      "date, judges on the panel, duration, and an MP3 download link. Useful for hearing how an " +
      "issue was actually argued. Works without a token. The `snippet` on each hit is an excerpt " +
      "of a machine-generated Whisper transcript, not a certified one; for the transcript text " +
      "itself pass a hit's audio_id to oral_argument_transcript.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search query (case name, party, or topic)." },
        include_transcript_status: {
          type: "boolean",
          description:
            "Report each result's real transcript status (default false). Costs ONE extra API " +
            "request PER RESULT: the search index does not carry stt_status and /audio/ has no " +
            "batch id filter (id__in is rejected as an unknown parameter). Left off, every row " +
            'reads transcript_status "NOT_CHECKED". Lower `limit` before turning this on.',
        },
        court: { type: "string", description: 'Optional court id filter (e.g. "scotus", "ca2"). Get ids from court_list.' },
        order_by: { type: "string", enum: ["relevance", "newest", "oldest"], description: "Sort order (default relevance; newest/oldest sort by argue date)." },
        argued_after: { type: "string", description: "Optional ISO date (YYYY-MM-DD); only arguments on/after." },
        argued_before: { type: "string", description: "Optional ISO date (YYYY-MM-DD); only arguments on/before." },
        limit: { type: "integer", description: `Max results from this page (1-${SEARCH_PAGE_SIZE}, default ${SEARCH_PAGE_SIZE}).` },
        cursor: { type: "string", description: "Opaque cursor from a previous response's next_cursor." },
      },
      required: ["q"],
      additionalProperties: false,
    },
  },
  {
    name: "judge_lookup",
    description:
      "Look up judges / people in CourtListener's judiciary database (type via /people/) by last and/or first name. " +
      "Returns id, assembled name, birth/death dates and place, gender, and how many positions are on file. " +
      "Works without a token.",
    inputSchema: {
      type: "object",
      properties: {
        name_last: { type: "string", description: 'Last name to match (e.g. "Ginsburg").' },
        name_first: { type: "string", description: 'First name to match (e.g. "Ruth").' },
        limit: {
          type: "integer",
          description: `Max people to return (1-${PEOPLE_PAGE_SIZE}, default 10). /people/ serves one fixed page of ${PEOPLE_PAGE_SIZE} and ignores page_size.`,
        },
      },
      // Requires at least one of name_last / name_first (enforced in the handler).
      additionalProperties: false,
    },
  },
  {
    name: "oral_argument_transcript",
    description:
      "The text of an oral argument, from CourtListener's Whisper transcript of the recording " +
      "(/audio/{id}/). Pass an audio_id from oral_arguments. Works without a token. " +
      "READ THIS BEFORE QUOTING: the text is MACHINE speech-to-text, never a court reporter's " +
      "certified transcript — it mishears names, numbers and citations and carries no speaker " +
      "attribution. CourtListener's own status for the transcription is reported as stt_verdict, " +
      "and only a COMPLETE one returns text: a recording flagged " +
      "TRANSCRIPTION_DOES_NOT_MATCH_AUDIO (a Whisper hallucination — 708 of 103,278 records on " +
      "2026-09-14) has text on the record and it is withheld here rather than presented as a " +
      `transcript. Long arguments run past 100,000 characters, so text is paged: up to ` +
      `${TRANSCRIPT_MAX_CHARS} characters per call (default ${TRANSCRIPT_DEFAULT_CHARS}), with ` +
      "truncated and next_offset when there is more.",
    inputSchema: {
      type: "object",
      properties: {
        audio_id: {
          type: "integer",
          description: "Numeric audio id, from an oral_arguments hit's audio_id.",
        },
        offset: {
          type: "integer",
          description:
            "Character offset to start from (default 0). Pass a previous response's next_offset to continue.",
        },
        max_chars: {
          type: "integer",
          description: `Characters to return (1-${TRANSCRIPT_MAX_CHARS}, default ${TRANSCRIPT_DEFAULT_CHARS}).`,
        },
      },
      required: ["audio_id"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function opinionSearch(args: Row): Promise<unknown> {
  const q = str(args.q);
  if (!q) throw new Error("q is required (the search query).");
  // /search/ serves one fixed ~20-row page (ignores page_size); cap accordingly.
  const limit = clampLimit(args.limit, SEARCH_PAGE_SIZE, SEARCH_PAGE_SIZE);
  const court = str(args.court);
  const filedAfter = normDate(args.filed_after, "filed_after");
  const filedBefore = normDate(args.filed_before, "filed_before");
  const orderKey = str(args.order_by) ?? "relevance";
  const order_by = pickOption(ORDER_BY, orderKey, "order_by");
  const cursor = str(args.cursor);

  // Named once and handed to both: clGet validates the envelope before caching
  // it, and the result set is extracted here.
  const source = "opinion_search (/search/?type=o)";
  const json = await clGet(
    "/search/",
    {
      q: cleanQuery(q, "q"),
      type: SEARCH_TYPE_OPINION,
      court: court ?? undefined,
      filed_after: filedAfter,
      filed_before: filedBefore,
      order_by,
      cursor: cursor ?? undefined,
    },
    { expectResults: source },
  );
  const page = extractResults(json, source);
  const results = page.slice(0, limit).map(normalizeOpinionHit);
  return {
    query: {
      q,
      court: court ?? null,
      filed_after: filedAfter ?? null,
      filed_before: filedBefore ?? null,
      order_by: orderKey,
      cursor: cursor ?? null,
    },
    total_matches: num((json as Row).count),
    returned: results.length,
    dropped_from_this_page: page.length - results.length,
    next_cursor: extractCursor((json as Row).next),
    note: droppedNote(page.length, results.length),
    results,
  };
}

async function docketLookup(args: Row): Promise<unknown> {
  const q = str(args.q);
  const docketNumber = str(args.docket_number);
  const court = str(args.court);
  if (!q && !docketNumber) {
    throw new Error("Provide at least one of q (case name / text) or docket_number.");
  }
  // /search/ serves one fixed ~20-row page (ignores page_size); cap accordingly.
  const limit = clampLimit(args.limit, SEARCH_PAGE_SIZE, SEARCH_PAGE_SIZE);
  const cursor = str(args.cursor);
  // A docket number goes through the FIELDED operator, not free text: fielded
  // docketNumber:"1:20-cv-03590" matched 6 dockets live where the free-text
  // form matched thousands (verified 2026-08-23).
  //
  // Quotes AND backslashes are stripped. Stripping only quotes was not enough:
  // a trailing backslash escapes the closing quote instead of ending the value,
  // and CourtListener answers HTTP 500, which isRetryable() treats as a "come
  // back" — so one bad argument became three 500s against a nonprofit's search
  // cluster and the caller was told the server had failed. Verified live
  // 2026-09-14: q=docketNumber:"1:20-cv-03590\" -> HTTP 500
  // {"detail":"Internal Server Error..."}; the same query without the trailing
  // backslash -> HTTP 200, count 6.
  //
  // Stripping rather than escaping, to match the existing quote handling: no
  // real docket number contains either character, so nothing that could match
  // is lost.
  const cleanedNumber = docketNumber ? docketNumber.replace(/["\\]/g, "").trim() : null;
  if (docketNumber && !cleanedNumber) {
    // An argument made only of the stripped characters leaves docketNumber:""
    // behind, and that is a query CourtListener answers: HTTP 200, count 0
    // (verified live 2026-09-14). So a wholly invalid argument would render as
    // "there is no such docket" — the same confusion extractResults refuses one
    // layer up, arrived at through the sanitizer instead of through upstream.
    throw new Error(
      `docket_number ${JSON.stringify(docketNumber)} is only quote and backslash characters; nothing is ` +
        "left to match after stripping them. Reporting that as zero results would be indistinguishable " +
        "from there being no such docket, so it is an error instead.",
    );
  }
  const fielded = cleanedNumber ? `docketNumber:"${cleanedNumber}"` : null;
  // The free-text half gets the treatment opinion_search's q gets: a dangling
  // backslash draws the same HTTP 500 from the query parser, and here it would
  // also escape the space before the fielded operator rather than end a value.
  // `fielded` cannot end in a backslash — they are stripped above — so cleaning
  // the free-text half is enough to keep the joined query from ending in one.
  const freeText = q ? cleanQuery(q, "q") : null;
  const effectiveQ = [freeText, fielded].filter(Boolean).join(" ").trim();

  const source = "docket_lookup (/search/?type=r)";
  const json = await clGet(
    "/search/",
    {
      q: effectiveQ || undefined,
      type: SEARCH_TYPE_DOCKET,
      court: court ?? undefined,
      cursor: cursor ?? undefined,
    },
    { expectResults: source },
  );
  const page = extractResults(json, source);
  const results = page.slice(0, limit).map(normalizeDocketHit);
  return {
    query: { q: q ?? null, docket_number: docketNumber ?? null, court: court ?? null, cursor: cursor ?? null },
    total_matches: num((json as Row).count),
    returned: results.length,
    dropped_from_this_page: page.length - results.length,
    next_cursor: extractCursor((json as Row).next),
    note: droppedNote(page.length, results.length),
    results,
  };
}

/**
 * Page through /courts/ accumulating raw rows. The endpoint paginates by ?page=N
 * and ignores page_size (~20 rows/page), so we follow
 * the DRF `next` signal one page at a time. Stops when the API reports no next
 * page, once at least `stopAt` rows are collected (Infinity = whole table), or at
 * the MAX_COURT_PAGES safety cap.
 */
/**
 * In-process cache of a COMPLETE court-table walk. The table is ~3,359 rows
 * over ~168 pages at the polite throttle (~40s), and CourtListener's own docs
 * say the courts API "does not change often" and can be cached — so the walk
 * happens at most once per day per process, and every later name-filtered
 * court_list answers instantly. Only complete, unfiltered walks are cached
 * (a jurisdiction-filtered or partial walk is not the whole table).
 */
const COURT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let courtCache: { rows: Row[]; at: number } | null = null;

async function fetchCourts(
  jurisdiction: string | undefined,
  stopAt: number,
): Promise<{ rows: Row[]; complete: boolean }> {
  // Only a COMPLETE walk is ever cached (see the write below), so a cache hit
  // is complete by construction.
  if (!jurisdiction && courtCache && Date.now() - courtCache.at < COURT_CACHE_TTL_MS) {
    return { rows: courtCache.rows, complete: true };
  }
  const all: Row[] = [];
  let complete = false;
  for (let page = 1; page <= MAX_COURT_PAGES; page++) {
    const source = "court_list (/courts/)";
    const json = await clGet(
      "/courts/",
      { jurisdiction: jurisdiction ?? undefined, page },
      { expectResults: source },
    );
    all.push(...extractResults(json, source));
    const hasNext = str((json as Row).next) != null;
    if (!hasNext) {
      complete = true;
      break;
    }
    if (all.length >= stopAt) break;
  }
  if (!jurisdiction && complete) courtCache = { rows: all, at: Date.now() };
  return { rows: all, complete };
}

async function courtList(args: Row): Promise<unknown> {
  const jurisdiction = str(args.jurisdiction);
  const nameFilter = str(args.q)?.toLowerCase() ?? null;
  const limit = clampLimit(args.limit, 25);

  // With a name filter we must scan the whole table (server ignores page_size),
  // or common courts past the first page are silently missed. Without one, we
  // only need enough pages to satisfy `limit`.
  const { rows, complete } = await fetchCourts(jurisdiction ?? undefined, nameFilter ? Infinity : limit);

  let courts = rows.map(normalizeCourt);
  if (nameFilter) {
    courts = courts.filter((c) =>
      [c.id, c.full_name, c.short_name, c.citation_string].some(
        (x) => typeof x === "string" && x.toLowerCase().includes(nameFilter),
      ),
    );
  }
  courts = courts.slice(0, limit);
  return {
    query: { jurisdiction: jurisdiction ?? null, q: str(args.q) ?? null },
    returned: courts.length,
    // The walk can stop at MAX_COURT_PAGES on a table that only grows, and the
    // note used to claim the full table either way — so past the cap the filter
    // would run over a prefix while the payload said it had searched all of it.
    note: nameFilter
      ? complete
        ? "The q filter is applied across the full courts table, paged server-side; scope by jurisdiction to page less."
        : `The walk stopped at the ${MAX_COURT_PAGES}-page safety cap, so this filter ran over the first ${rows.length} courts only — a court past that point cannot appear here even if it matches. Scope by jurisdiction.`
      : undefined,
    courts,
  };
}

async function caseDetail(args: Row): Promise<unknown> {
  // Same positive-integer check the three sibling id-taking tools already run:
  // -5 and 1.5 were interpolated straight into the path.
  const id = num(args.id);
  if (id == null || !Number.isInteger(id) || id <= 0) {
    throw new Error("id is required (a positive numeric cluster id or opinion id).");
  }
  const kind = (str(args.type) ?? "cluster").toLowerCase();
  if (kind !== "cluster" && kind !== "opinion") {
    throw new Error('type must be "cluster" or "opinion".');
  }

  // /clusters/{id}/ and /opinions/{id}/ are authentication-only: requireAuth makes
  // clGet throw the token() setup error before any network call when unset.
  if (kind === "opinion") {
    const o = await clGet(`/opinions/${id}/`, {}, { requireAuth: true });
    return normalizeOpinionDetail(expectDetail(o, id, `case_detail (/opinions/${id}/)`));
  }
  const c = await clGet(`/clusters/${id}/`, {}, { requireAuth: true });
  return normalizeClusterDetail(expectDetail(c, id, `case_detail (/clusters/${id}/)`));
}

async function citationLookup(args: Row): Promise<unknown> {
  const text = str(args.text);
  if (!text) {
    throw new Error('text is required (free text containing citations, or a single citation string like "410 U.S. 113").');
  }
  // The endpoint validates text at 64,000 chars; enforce pre-flight.
  // Nothing is truncated: a verifier that silently drops the tail of a brief
  // would pass exactly the citations it never checked.
  if (text.length > CITATION_TEXT_CAP) {
    throw new Error(
      `text is ${text.length} characters; the CourtListener citation-lookup endpoint caps text at ${CITATION_TEXT_CAP}. ` +
        "Nothing was sent and nothing was truncated (a dropped tail would mean unchecked citations). " +
        `Split the document and call once per chunk; each call checks up to ${CITATION_MAX_PER_REQUEST} citations.`,
    );
  }

  // POST /citation-lookup/ is authentication-only (HTTP 401 without a token).
  // requireAuth throws the token() setup error pre-flight.
  const json = await clPost("/citation-lookup/", { text }, { requireAuth: true });

  // The response is a bare JSON array (no DRF envelope), one item per citation
  // recognized in the text.
  //
  // The one bare-array response in this server, and it needs the check
  // extractResults gives an envelope, for the same reason: a body that is not
  // the array reads as "no citations were recognized in the text", which is
  // exactly what a clean document produces — in the one tool whose whole
  // purpose is catching a fabricated cite.
  if (!Array.isArray(json)) {
    const got =
      json && typeof json === "object"
        ? `an object with keys: ${Object.keys(json as Row).slice(0, 12).join(", ") || "(none)"}`
        : json === null
          ? "null"
          : typeof json;
    throw new PermanentError(
      "CourtListener returned an unexpected body for citation_lookup (POST /citation-lookup/): expected " +
        `a bare array of per-citation results, got ${got}. Reporting this as "no citations were recognized" ` +
        "would be indistinguishable from a document that contains none, so it is surfaced as an error instead.",
    );
  }
  const rows = json as Row[];
  const results = rows.map(normalizeCitationResult);

  const found = results.filter((r) => r.verified === true).length;
  const notFound = results.filter((r) => r.verdict === "NOT_FOUND").length;
  const invalid = results.filter((r) => r.verdict === "UNKNOWN_REPORTER").length;
  const notChecked = results.filter((r) => r.verdict === "NOT_CHECKED_OVER_CAP").length;
  const unverified = results.length - found;

  const problems: string[] = [];
  if (notFound) problems.push(`${notFound} not found in CourtListener (likely fabricated or mis-cited)`);
  if (invalid) problems.push(`${invalid} with an unrecognized reporter`);
  if (notChecked) {
    problems.push(
      `${notChecked} not checked (past the ${CITATION_MAX_PER_REQUEST}-citations-per-call cap; split the text and re-run the rest)`,
    );
  }
  const otherUnverified = unverified - notFound - invalid - notChecked;
  if (otherUnverified > 0) problems.push(`${otherUnverified} with an unexpected per-citation status`);

  return {
    query: { text_chars: text.length },
    citations_checked: results.length,
    found,
    not_found: notFound,
    invalid,
    not_checked: notChecked,
    // True only when at least one citation was recognized AND every one resolved.
    all_verified: results.length > 0 && found === results.length,
    // The blind spot a reader must know about: the extractor can only check
    // citations whose REPORTER it recognizes. A fabricated cite with an
    // invented reporter (live example: "999 A.D.9th 999") is not recognized,
    // not counted, and not flagged — so all_verified=true means "every
    // RECOGNIZED citation resolved", never "nothing in this text is fake".
    coverage_note:
      "Only citations in recognized reporter formats are checked. A citation-like string with an " +
      "unrecognized or invented reporter is invisible to this check — it is not counted and not " +
      "flagged. all_verified covers recognized citations only.",
    warning:
      problems.length > 0
        ? `${unverified} of ${results.length} citation(s) did NOT verify: ${problems.join("; ")}. ` +
          "Do not cite unverified authorities — check them by hand before filing."
        : undefined,
    note:
      results.length === 0
        ? "No citations were recognized in the text (nothing was checked — this is not a verification pass)."
        : undefined,
    results,
  };
}

async function judgeLookup(args: Row): Promise<unknown> {
  const nameLast = str(args.name_last);
  const nameFirst = str(args.name_first);
  if (!nameLast && !nameFirst) {
    throw new Error("Provide at least one of name_last or name_first.");
  }
  const limit = clampLimit(args.limit, 10, PEOPLE_PAGE_SIZE);

  const source = "judge_lookup (/people/)";
  const json = await clGet(
    "/people/",
    {
      name_last: nameLast ?? undefined,
      name_first: nameFirst ?? undefined,
    },
    { expectResults: source },
  );
  const results = extractResults(json, source).slice(0, limit).map(normalizeJudge);
  // This tool exposes no cursor and `count` arrives as the deferred ?count=on
  // URL, so without this flag a caller asking for 50 got `returned: 20` with
  // nothing saying more people match.
  const moreAvailable = extractCursor((json as Row).next) != null;
  return {
    query: { name_last: nameLast ?? null, name_first: nameFirst ?? null },
    returned: results.length,
    more_available: moreAvailable,
    note: moreAvailable
      ? `More people match this name than one /people/ page holds (${PEOPLE_PAGE_SIZE} rows, page_size is ignored upstream). returned is this page, never the total — narrow with name_first.`
      : undefined,
    results,
  };
}

async function citedBy(args: Row): Promise<unknown> {
  const opinionId = num(args.opinion_id);
  if (opinionId == null || !Number.isInteger(opinionId) || opinionId <= 0) {
    throw new Error("opinion_id is required (a positive numeric OPINION id; a cluster's case_detail lists its sub_opinion_ids).");
  }
  const orderKey = str(args.order_by) ?? "newest";
  const order_by = pickOption(ORDER_BY, orderKey, "order_by");
  const limit = clampLimit(args.limit, SEARCH_PAGE_SIZE, SEARCH_PAGE_SIZE);
  const cursor = str(args.cursor);

  // The cites:() fielded operator (verified live 2026-08-23; keyless).
  const source = "cited_by (/search/?type=o)";
  const json = await clGet(
    "/search/",
    {
      q: `cites:(${opinionId})`,
      type: SEARCH_TYPE_OPINION,
      order_by,
      cursor: cursor ?? undefined,
    },
    { expectResults: source },
  );
  const page = extractResults(json, source);
  const results = page.slice(0, limit).map(normalizeOpinionHit);
  const dropped = droppedNote(page.length, results.length);
  return {
    query: { opinion_id: opinionId, order_by: orderKey, cursor: cursor ?? null },
    total_citing: num((json as Row).count),
    returned: results.length,
    dropped_from_this_page: page.length - results.length,
    next_cursor: extractCursor((json as Row).next),
    note:
      "Citing opinions only — no treatment classification (followed / distinguished / overruled). " +
      "A case with many recent citations is being engaged with; read the citing opinions to learn how." +
      (dropped ? ` ${dropped}` : ""),
    results,
  };
}

async function caseAuthorities(args: Row): Promise<unknown> {
  const opinionId = num(args.opinion_id);
  if (opinionId == null || !Number.isInteger(opinionId) || opinionId <= 0) {
    throw new Error("opinion_id is required (a positive numeric OPINION id).");
  }
  const limit = clampLimit(args.limit, MAX_RESULTS);

  // /opinions-cited/ answers 401 without a token (verified live 2026-08-23).
  const source = "case_authorities (/opinions-cited/)";
  const json = await clGet(
    "/opinions-cited/",
    { citing_opinion: opinionId, page_size: limit },
    { requireAuth: true, expectResults: source },
  );
  const results = extractResults(json, source).slice(0, limit).map(normalizeCitedPair);
  const totalAuthorities = num((json as Row).count);
  return {
    query: { opinion_id: opinionId },
    // v4 cursor-paginated list endpoints do not OMIT `count` — they DEFER it:
    // the field arrives as a URL string pointing at the same query with
    // ?count=on, so num() of it is null. Verified live 2026-09-14 on
    // /audio/?stt_status=3, whose `count` was the literal string
    // "https://www.courtlistener.com/api/rest/v4/audio/?count=on&stt_status=3",
    // and the same query with ?count=on returned {"count": 708}. null means
    // "not reported here — ask again with ?count=on", never zero. That second
    // request is deliberately not issued automatically: it is an extra and
    // more expensive round trip on a free endpoint.
    total_authorities: totalAuthorities,
    total_reported: totalAuthorities != null,
    returned: results.length,
    next_cursor: extractCursor((json as Row).next),
    note: "depth = how many times the opinion cites that authority. Fetch any authority with case_detail (type opinion).",
    results,
  };
}

async function docketEntries(args: Row): Promise<unknown> {
  const docketId = num(args.docket_id);
  if (docketId == null || !Number.isInteger(docketId) || docketId <= 0) {
    throw new Error("docket_id is required (a positive numeric docket id from docket_lookup).");
  }
  const limit = clampLimit(args.limit, MAX_RESULTS);
  const cursor = str(args.cursor);

  // /docket-entries/ answers 401 without a token (verified live 2026-08-23).
  // The filter parameter is `docket`, not `docket_id` — the API 400s with
  // unknown_params otherwise (found by the live rung 2026-08-23; an unauth
  // probe could not see it, since auth is checked before params).
  const source = "docket_entries (/docket-entries/)";
  const json = await clGet(
    "/docket-entries/",
    { docket: docketId, page_size: limit, cursor: cursor ?? undefined },
    { requireAuth: true, expectResults: source },
  );
  const results = extractResults(json, source).slice(0, limit).map(normalizeDocketEntry);
  const totalEntries = num((json as Row).count);
  return {
    query: { docket_id: docketId, cursor: cursor ?? null },
    // Same deferred-count mechanism as case_authorities above: `count` arrives
    // as a ?count=on URL string, so null means "not reported here — ask again
    // with ?count=on", never zero. returned + next_cursor are the real signals.
    total_entries: totalEntries,
    total_reported: totalEntries != null,
    returned: results.length,
    next_cursor: extractCursor((json as Row).next),
    note:
      "RECAP holds what its users have purchased from PACER; a missing entry or document may still " +
      "exist on PACER. Docket entries record what was FILED, not what was decided.",
    results,
  };
}

const OA_ORDER_BY: Record<string, string | undefined> = {
  relevance: undefined, // the search default
  newest: "dateArgued desc",
  oldest: "dateArgued asc",
};

async function oralArguments(args: Row): Promise<unknown> {
  const q = str(args.q);
  if (!q) throw new Error("q is required (case name, party, or topic).");
  const court = str(args.court);
  const orderKey = str(args.order_by) ?? "relevance";
  // undefined is the value of `relevance` here, so this is a lookup, not a
  // truthiness check — and an own-property lookup, so "constructor" is not one.
  const orderValue = pickOption(OA_ORDER_BY, orderKey, "order_by");
  const arguedAfter = normDate(args.argued_after, "argued_after");
  const arguedBefore = normDate(args.argued_before, "argued_before");
  const limit = clampLimit(args.limit, SEARCH_PAGE_SIZE, SEARCH_PAGE_SIZE);
  const cursor = str(args.cursor);

  const source = "oral_arguments (/search/?type=oa)";
  const json = await clGet(
    "/search/",
    {
      q: cleanQuery(q, "q"),
      type: SEARCH_TYPE_ORAL_ARGUMENT,
      court: court ?? undefined,
      order_by: orderValue,
      argued_after: arguedAfter,
      argued_before: arguedBefore,
      cursor: cursor ?? undefined,
    },
    { expectResults: source },
  );
  const page = extractResults(json, source);
  const results = page.slice(0, limit).map(normalizeOralArgumentHit);

  // Transcript availability is NOT in the search index, and /audio/ has no
  // batch id filter — id__in is rejected ("Unknown filter parameters are not
  // allowed", verified live 2026-09-14; the vendor's AudioFilter gives `id` the
  // INTEGER_LOOKUPS set, which has no `in`). So the real status costs one
  // request per row, which is why it is opt-in: a 20-row page would be 20 extra
  // requests, and a new CourtListener account is limited to 5 per minute.
  const includeStatus = args.include_transcript_status === true;
  let checkFailures = 0;
  if (includeStatus) {
    for (const row of results) {
      const audioId = row.audio_id;
      if (typeof audioId !== "number") {
        row.transcript_status = "UNKNOWN_AUDIO_ID";
        continue;
      }
      try {
        // The narrowest possible read; `fields` is honoured on this endpoint.
        const a = await clGet(`/audio/${audioId}/`, { fields: "id,stt_status" });
        row.transcript_status = sttVerdict(num((a as Row).stt_status)).verdict;
      } catch {
        // Never turn a failed check into an assertion of absence.
        row.transcript_status = "CHECK_FAILED";
        checkFailures++;
      }
    }
  }

  const notes = [
    "snippet is an excerpt of a MACHINE-generated Whisper transcript, not a certified transcript. " +
      "For the transcript text, pass a row's audio_id to oral_argument_transcript.",
  ];
  if (!includeStatus) {
    notes.push(
      'transcript_status reads "NOT_CHECKED" on every row: the search index does not carry it. ' +
        "Pass include_transcript_status to look it up (one extra request per row).",
    );
  } else if (checkFailures > 0) {
    notes.push(
      `${checkFailures} transcript status check(s) failed and read "CHECK_FAILED" — that means not ` +
        "looked up, never that no transcript exists.",
    );
  }
  const dropped = droppedNote(page.length, results.length);
  if (dropped) notes.push(dropped);

  return {
    query: {
      q,
      court: court ?? null,
      argued_after: arguedAfter ?? null,
      argued_before: arguedBefore ?? null,
      include_transcript_status: includeStatus,
      cursor: cursor ?? null,
    },
    total_matches: num((json as Row).count),
    returned: results.length,
    dropped_from_this_page: page.length - results.length,
    next_cursor: extractCursor((json as Row).next),
    note: notes.join(" "),
    results,
  };
}

async function oralArgumentTranscript(args: Row): Promise<unknown> {
  const audioId = num(args.audio_id);
  if (audioId == null || !Number.isInteger(audioId) || audioId <= 0) {
    throw new Error("audio_id is required (a positive numeric audio id from an oral_arguments hit).");
  }
  const rawOffset = args.offset === undefined || args.offset === null ? 0 : num(args.offset);
  if (rawOffset == null || !Number.isInteger(rawOffset) || rawOffset < 0) {
    throw new Error(`offset must be a non-negative integer; got: ${JSON.stringify(args.offset)}`);
  }
  const maxChars = clampLimit(args.max_chars, TRANSCRIPT_DEFAULT_CHARS, TRANSCRIPT_MAX_CHARS);

  // /audio/{id}/ answers unauthenticated (verified live 2026-09-14); the token
  // is attached opportunistically, for the higher rate limit only.
  const a = expectDetail(
    await clGet(`/audio/${audioId}/`),
    audioId,
    `oral_argument_transcript (/audio/${audioId}/)`,
  );

  const full = typeof a.stt_transcript === "string" ? a.stt_transcript : "";
  if (rawOffset > full.length) {
    throw new Error(
      `offset ${rawOffset} is past the end of this transcript (${full.length} characters). ` +
        "Page with the next_offset a previous call returned; a null next_offset means there is no more.",
    );
  }

  return normalizeTranscript(a, audioId, rawOffset, maxChars);
}

const HANDLERS: Record<string, (args: Row) => Promise<unknown>> = {
  opinion_search: opinionSearch,
  docket_lookup: docketLookup,
  court_list: courtList,
  case_detail: caseDetail,
  citation_lookup: citationLookup,
  judge_lookup: judgeLookup,
  cited_by: citedBy,
  case_authorities: caseAuthorities,
  docket_entries: docketEntries,
  oral_arguments: oralArguments,
  oral_argument_transcript: oralArgumentTranscript,
};

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * SPEC records-not-advice.
 *
 * The consumer of this server is a model, and the reader downstream of that
 * model is often a pro-se litigant or an overworked legal-aid worker. Court
 * records are exactly the kind of raw material a reader converts into a
 * decision. Every successful result therefore carries its own framing, in the
 * payload rather than in the tool description — the model sees the payload
 * when it composes an answer; it may not still be holding the description.
 *
 * Docket entries in particular record what was FILED, not what was decided.
 */
const DISCLAIMER =
  "Raw public court records from CourtListener, reproduced as published. " +
  "This is not legal advice and is not a substitute for a lawyer. Docket " +
  "entries record filings, not rulings; the absence of a record is not " +
  "evidence that nothing happened.";

function withDisclaimer(result: unknown): unknown {
  // Only object results can carry the key. Nothing here returns a bare scalar
  // today, but a future tool that does must not silently drop the framing.
  if (result === null || typeof result !== "object") {
    return { result, disclaimer: DISCLAIMER };
  }
  if (Array.isArray(result)) return { results: result, disclaimer: DISCLAIMER };
  return { ...(result as Record<string, unknown>), disclaimer: DISCLAIMER };
}

/** Render a caught value for display, without letting the rendering itself throw. */
function describeThrown(err: unknown): string {
  if (err === undefined) return "undefined";
  if (err === null) return "null";
  try {
    const rendered = typeof err === "object" ? JSON.stringify(err) : String(err);
    return (rendered ?? `a ${typeof err}`).slice(0, 200);
  } catch {
    return `a ${typeof err}`;
  }
}

/**
 * Turn whatever a handler threw into a message a caller can act on.
 *
 * `String(err)` on a non-Error throw rendered the literal text "Error: undefined",
 * which names no tool, no stage, and no cause. The shape is not hypothetical: a
 * NaN CL_HTTP_ATTEMPTS made withRetry skip its loop body and rethrow the
 * still-unassigned `last`, so every tool answered "Error: undefined" having made
 * no network call at all.
 */
function toolErrorMessage(tool: string, err: unknown): string {
  if (err instanceof Error && err.message.trim() !== "") return err.message;
  return (
    `${tool} failed while handling the call and threw a non-Error value ` +
    `(${describeThrown(err)}) instead of an error message. That is a bug in ` +
    "mcp-courtwatch, not a CourtListener response; please report it with the " +
    "tool name and arguments."
  );
}

export function createServer(): Server {
  const server = new Server(
    { name: "mcp-courtwatch", version: "1.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = HANDLERS[name];
    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    try {
      const result = await handler((args ?? {}) as Row);
      return { content: [{ type: "text", text: JSON.stringify(withDisclaimer(result), null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${toolErrorMessage(name, err)}` }],
        isError: true,
      };
    }
  });

  return server;
}

// Exported for tests only (not part of the MCP surface).
export const __test = {
  resetCourtCache(): void {
    courtCache = null;
  },
};
