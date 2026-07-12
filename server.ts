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
/** Minimum spacing between outbound API calls (polite throttle). */
const THROTTLE_MS = 200;
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
 * Safety cap on pages walked when scanning the full /courts/ table for a name
 * filter. /courts/ paginates by ?page=N and also ignores page_size (~20/page),
 * so the ~3,359 courts span ~168 pages; cap well
 * above that so every court is reachable without an unbounded loop.
 */
const MAX_COURT_PAGES = 200;
/** Cap on opinion full-text length returned by case_detail (chars). */
const TEXT_CAP = 50000;
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
 * Read the CourtListener API token from the environment, or throw a clear setup
 * error. Called by tools that hit auth-required endpoints (case_detail).
 */
function token(): string {
  const t = process.env.COURTLISTENER_API_TOKEN?.trim();
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
  return process.env.COURTLISTENER_API_TOKEN?.trim() || null;
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

type Row = Record<string, unknown>;

type QueryValue = string | number | undefined | null;

/**
 * Read a CourtListener response: surface DRF errors ({"detail":"..."}) on
 * non-2xx, parse JSON on success, and reject non-JSON bodies (HTML error pages
 * / proxy interstitials arrive as non-JSON with a 200). Shared by clGet/clPost.
 */
async function readClResponse(res: { ok: boolean; status: number; text: () => Promise<string> }): Promise<unknown> {
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
    throw new Error(`CourtListener API request failed (HTTP ${res.status}): ${detail}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`CourtListener API returned a non-JSON response: ${text.slice(0, 300).trim()}`);
  }
}

/**
 * Execute one GET against the CourtListener API and return the parsed JSON.
 * Undefined/null/empty params are omitted. Set opts.requireAuth for endpoints
 * that 401 without a token (case_detail); it throws the token error pre-flight.
 */
async function clGet(
  path: string,
  params: Record<string, QueryValue> = {},
  opts: { requireAuth?: boolean } = {},
): Promise<unknown> {
  const headers = buildHeaders(opts.requireAuth === true); // may throw before fetch
  const url = new URL(`${CL_API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await throttled(() => fetch(url, { headers, signal: AbortSignal.timeout(15_000) }));
  return readClResponse(res);
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

  const res = await throttled(() =>
    fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }),
  );
  return readClResponse(res);
}

/** Pull the DRF `results` array out of a list/search envelope, defensively. */
function extractResults(json: unknown): Row[] {
  if (json && typeof json === "object" && Array.isArray((json as Row).results)) {
    return (json as Row).results as Row[];
  }
  return [];
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

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: "opinion_search",
    description:
      "Full-text search of U.S. case law / court opinions (CourtListener type=o). " +
      "Returns the top matching page (up to `limit`) with case name, court, date filed, " +
      "citations, docket number, a snippet, citation count, and a link. Works without a " +
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
        limit: { type: "integer", description: `Max people to return (1-${MAX_RESULTS}, default 10).` },
      },
      // Requires at least one of name_last / name_first (enforced in the handler).
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
  const order_by = ORDER_BY[orderKey];
  if (!order_by) {
    throw new Error(`order_by must be one of: ${Object.keys(ORDER_BY).join(", ")}.`);
  }
  const cursor = str(args.cursor);

  const json = await clGet("/search/", {
    q,
    type: SEARCH_TYPE_OPINION,
    court: court ?? undefined,
    filed_after: filedAfter,
    filed_before: filedBefore,
    order_by,
    cursor: cursor ?? undefined,
  });
  const results = extractResults(json).slice(0, limit).map(normalizeOpinionHit);
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
    next_cursor: extractCursor((json as Row).next),
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
  const effectiveQ = [q, docketNumber].filter(Boolean).join(" ").trim();

  const json = await clGet("/search/", {
    q: effectiveQ || undefined,
    type: SEARCH_TYPE_DOCKET,
    court: court ?? undefined,
    cursor: cursor ?? undefined,
  });
  const results = extractResults(json).slice(0, limit).map(normalizeDocketHit);
  return {
    query: { q: q ?? null, docket_number: docketNumber ?? null, court: court ?? null, cursor: cursor ?? null },
    total_matches: num((json as Row).count),
    returned: results.length,
    next_cursor: extractCursor((json as Row).next),
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
async function fetchCourts(jurisdiction: string | undefined, stopAt: number): Promise<Row[]> {
  const all: Row[] = [];
  for (let page = 1; page <= MAX_COURT_PAGES; page++) {
    const json = await clGet("/courts/", { jurisdiction: jurisdiction ?? undefined, page });
    all.push(...extractResults(json));
    const hasNext = str((json as Row).next) != null;
    if (!hasNext || all.length >= stopAt) break;
  }
  return all;
}

async function courtList(args: Row): Promise<unknown> {
  const jurisdiction = str(args.jurisdiction);
  const nameFilter = str(args.q)?.toLowerCase() ?? null;
  const limit = clampLimit(args.limit, 25);

  // With a name filter we must scan the whole table (server ignores page_size),
  // or common courts past the first page are silently missed. Without one, we
  // only need enough pages to satisfy `limit`.
  const rows = await fetchCourts(jurisdiction ?? undefined, nameFilter ? Infinity : limit);

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
    note: nameFilter
      ? "The q filter is applied across the full courts table, paged server-side; scope by jurisdiction to page less."
      : undefined,
    courts,
  };
}

async function caseDetail(args: Row): Promise<unknown> {
  const id = num(args.id);
  if (id == null) throw new Error("id is required (a numeric cluster id or opinion id).");
  const kind = (str(args.type) ?? "cluster").toLowerCase();
  if (kind !== "cluster" && kind !== "opinion") {
    throw new Error('type must be "cluster" or "opinion".');
  }

  // /clusters/{id}/ and /opinions/{id}/ are authentication-only: requireAuth makes
  // clGet throw the token() setup error before any network call when unset.
  if (kind === "opinion") {
    const o = await clGet(`/opinions/${id}/`, {}, { requireAuth: true });
    return normalizeOpinionDetail(o as Row);
  }
  const c = await clGet(`/clusters/${id}/`, {}, { requireAuth: true });
  return normalizeClusterDetail(c as Row);
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
  const rows = Array.isArray(json) ? (json as Row[]) : [];
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
  const limit = clampLimit(args.limit, 10);

  const json = await clGet("/people/", {
    name_last: nameLast ?? undefined,
    name_first: nameFirst ?? undefined,
  });
  const results = extractResults(json).slice(0, limit).map(normalizeJudge);
  return {
    query: { name_last: nameLast ?? null, name_first: nameFirst ?? null },
    returned: results.length,
    results,
  };
}

const HANDLERS: Record<string, (args: Row) => Promise<unknown>> = {
  opinion_search: opinionSearch,
  docket_lookup: docketLookup,
  court_list: courtList,
  case_detail: caseDetail,
  citation_lookup: citationLookup,
  judge_lookup: judgeLookup,
};

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(): Server {
  const server = new Server(
    { name: "mcp-courtwatch", version: "1.0.0" },
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
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}
