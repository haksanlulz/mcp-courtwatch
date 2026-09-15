import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, __test, clearClCache } from "../server.js";

// ---------------------------------------------------------------------------
// Fixtures: CourtListener v4 response shapes, field names as the live API
// returns them. Search/list endpoints use the DRF envelope
// { count, next, previous, results:[...] }; detail endpoints return a bare object.
// ---------------------------------------------------------------------------

const SEARCH_OPINION = {
  count: 630,
  next: "https://www.courtlistener.com/api/rest/v4/search/?cursor=abc&q=miranda",
  previous: null,
  results: [
    {
      absolute_url: "/opinion/9335501/miranda-v-selig/",
      caseName: "Miranda v. Selig",
      caseNameFull: "Sergio MIRANDA v. Allan Huber SELIG, Bud",
      court: "Supreme Court of the United States",
      court_id: "scotus",
      dateFiled: "2017-12-04",
      dateArgued: null,
      docketNumber: "17-453",
      docket_id: 66645415,
      citation: ["138 S. Ct. 507", "199 L. Ed. 2d 386"],
      citeCount: 3,
      cluster_id: 9335501,
      status: "Published",
      // For type=o, the highlighted snippet lives inside opinions[].snippet.
      opinions: [{ id: 9200000, type: "010combined", snippet: "The Fifth Amendment privilege ..." }],
    },
  ],
};

const SEARCH_DOCKET = {
  count: 219769,
  document_count: 5,
  next: "https://www.courtlistener.com/api/rest/v4/search/?cursor=def&q=eviction",
  previous: null,
  results: [
    {
      caseName: "Eviction Rights, Inc.",
      case_name_full: "In re Eviction Rights, Incorporated",
      court: "United States Bankruptcy Court, N.D. Texas",
      court_id: "txnb",
      docketNumber: "11-35405",
      dateFiled: "2011-08-29",
      dateTerminated: "2012-03-01",
      suitNature: "Bankruptcy",
      docket_id: 6654071,
      docket_absolute_url: "/docket/6654071/eviction-rights-inc/",
    },
  ],
};

// A single complete /courts/ page (next: null). Note the live /courts/ endpoint
// paginates by ?page=N (offset), not cursor, and ignores page_size (~20/page).
const COURTS = {
  count: 3359,
  next: null,
  previous: null,
  results: [
    {
      id: "scotus",
      full_name: "Supreme Court of the United States",
      short_name: "Supreme Court",
      jurisdiction: "F",
      citation_string: "U.S.",
      in_use: true,
      url: "http://supremecourt.gov/",
      start_date: null,
      end_date: null,
    },
    {
      id: "ca9",
      full_name: "Court of Appeals for the Ninth Circuit",
      short_name: "Ninth Circuit",
      jurisdiction: "F",
      citation_string: "9th Cir.",
      in_use: true,
      url: "http://www.ca9.uscourts.gov/",
      start_date: "1891-06-16",
      end_date: null,
    },
  ],
};

// Two-page /courts/ fixture: the sought court (nysd) lives on page 2, so a filter
// that only reads page 1 would silently miss it. `next` uses the real ?page= form.
const COURTS_PAGE_1 = {
  count: 3359,
  next: "https://www.courtlistener.com/api/rest/v4/courts/?page=2",
  previous: null,
  results: COURTS.results,
};
const COURTS_PAGE_2 = {
  count: 3359,
  next: null,
  previous: "https://www.courtlistener.com/api/rest/v4/courts/?page=1",
  results: [
    {
      id: "nysd",
      full_name: "District Court, S.D. New York",
      short_name: "S.D.N.Y.",
      jurisdiction: "FD",
      citation_string: "S.D.N.Y.",
      in_use: true,
      url: "http://www.nysd.uscourts.gov/",
      start_date: "1789-09-24",
      end_date: null,
    },
  ],
};

// /people/ returns `count` as a deferred-count URL string (not an integer).
const PEOPLE = {
  count: "https://www.courtlistener.com/api/rest/v4/people/?count=on&name_last=Ginsburg",
  next: null,
  previous: null,
  results: [
    {
      id: 1213,
      name_first: "Ruth",
      name_middle: "Bader",
      name_last: "Ginsburg",
      name_suffix: null,
      date_dob: "1933-03-15",
      date_dod: "2020-09-18",
      dob_city: "Brooklyn",
      dob_state: "NY",
      gender: "f",
      positions: [
        "https://www.courtlistener.com/api/rest/v4/positions/1/",
        "https://www.courtlistener.com/api/rest/v4/positions/2/",
      ],
      slug: "ruth-bader-ginsburg",
      resource_uri: "https://www.courtlistener.com/api/rest/v4/people/1213/",
    },
  ],
};

// /citation-lookup/ responses: a bare JSON array (no DRF envelope), one item per
// citation eyecite recognized in the submitted text. Field names and the per-
// citation `status` codes follow CourtListener's source
// (cl/citations/api_views.py + api_serializers.py): 200 found, 300 multiple
// matches, 400 unknown reporter, 404 not found, 429 past the per-request
// citation cap. `clusters` items are OpinionClusterSerializer objects (the same
// snake_case shape as /clusters/{id}/).
const CITATION_LOOKUP_MIXED = [
  {
    citation: "410 U.S. 113",
    normalized_citations: ["410 U.S. 113"],
    start_index: 26,
    end_index: 38,
    status: 200,
    error_message: "",
    clusters: [
      {
        id: 108713,
        absolute_url: "/opinion/108713/roe-v-wade/",
        case_name: "Roe v. Wade",
        case_name_full: "Jane ROE, et al., Appellants, v. Henry WADE",
        case_name_short: "Roe",
        date_filed: "1973-01-22",
        citations: [
          { volume: 410, reporter: "U.S.", page: "113", type: 1 },
          { volume: 93, reporter: "S. Ct.", page: "705", type: 2 },
        ],
        precedential_status: "Published",
        citation_count: 12030,
        judges: "Blackmun",
        docket_id: 4463,
        docket: "https://www.courtlistener.com/api/rest/v4/dockets/4463/",
        sub_opinions: ["https://www.courtlistener.com/api/rest/v4/opinions/108713/"],
      },
    ],
  },
  {
    citation: "999 U.S. 9999",
    normalized_citations: ["999 U.S. 9999"],
    start_index: 80,
    end_index: 93,
    status: 404,
    error_message: "Citation not found: '999 U.S. 9999'",
    clusters: [],
  },
];

const CITATION_LOOKUP_EDGE = [
  {
    citation: "576 U.S. 644",
    normalized_citations: ["576 U.S. 644"],
    start_index: 0,
    end_index: 12,
    status: 300,
    error_message: "",
    clusters: [
      {
        id: 2812209,
        absolute_url: "/opinion/2812209/obergefell-v-hodges/",
        case_name: "Obergefell v. Hodges",
        date_filed: "2015-06-26",
        citations: [{ volume: 576, reporter: "U.S.", page: "644", type: 1 }],
        precedential_status: "Published",
        citation_count: 2400,
        docket_id: 2965411,
      },
      {
        id: 9999999,
        absolute_url: "/opinion/9999999/obergefell-dup/",
        case_name: "Obergefell v. Hodges (duplicate cluster)",
        date_filed: "2015-06-26",
        citations: [],
        precedential_status: "Published",
        citation_count: 0,
        docket_id: 2965412,
      },
    ],
  },
  {
    citation: "12 Imaginary Rptr. 34",
    normalized_citations: [],
    start_index: 20,
    end_index: 41,
    status: 400,
    error_message: "Unable to find reporter with abbreviation of 'Imaginary Rptr.'",
    clusters: [],
  },
  {
    citation: "1 U.S. 1",
    normalized_citations: ["1 U.S. 1"],
    start_index: 60,
    end_index: 68,
    status: 429,
    error_message: "Too many citations requested.",
    clusters: [],
  },
];

const CLUSTER = {
  id: 9335501,
  case_name: "Miranda v. Selig",
  case_name_full: "Sergio MIRANDA v. Allan Huber SELIG, Bud",
  case_name_short: "Miranda",
  date_filed: "2017-12-04",
  citations: [
    { volume: 138, reporter: "S. Ct.", page: "507", type: 1 },
    { volume: 199, reporter: "L. Ed. 2d", page: "386", type: 2 },
  ],
  precedential_status: "Published",
  citation_count: 3,
  judges: "Roberts, Kennedy, Thomas",
  nature_of_suit: "",
  posture: "On writ of certiorari",
  syllabus: "",
  attorneys: "",
  docket: "https://www.courtlistener.com/api/rest/v4/dockets/66645415/",
  sub_opinions: ["https://www.courtlistener.com/api/rest/v4/opinions/9200000/"],
  absolute_url: "/opinion/9335501/miranda-v-selig/",
};

const OPINION = {
  id: 9200000,
  type: "010combined",
  author_str: "Ginsburg",
  per_curiam: false,
  page_count: 12,
  download_url: "https://www.supremecourt.gov/opinions/17pdf/17-453.pdf",
  local_path: "pdf/2017/12/04/miranda_v_selig.pdf",
  plain_text: "SUPREME COURT OF THE UNITED STATES\nMiranda v. Selig\nThe judgment is affirmed.",
  html_with_citations: "<p>SUPREME COURT OF THE UNITED STATES</p>",
  cluster: "https://www.courtlistener.com/api/rest/v4/clusters/9335501/",
  absolute_url: "/opinion/9335501/miranda-v-selig/",
};

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let client: Client;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(text: string, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => text,
  };
}

/** The URL passed to the most recent fetch call. */
function lastUrl(): URL {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return call[0] as URL;
}

/** The request init (headers, method, body, etc.) passed to the most recent fetch call. */
function lastInit(): { headers: Record<string, string>; method?: string; body?: string } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return call[1] as { headers: Record<string, string>; method?: string; body?: string };
}

async function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

function payload(result: any) {
  return JSON.parse(result.content[0].text);
}

// The response cache lives for the process; without this a value cached by one
// test is served to the next and the suite becomes order-dependent.
beforeEach(() => clearClCache());

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  process.env.COURTLISTENER_API_TOKEN = "test-token";
  __test.resetCourtCache(); // the court-table cache is a module singleton

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.COURTLISTENER_API_TOKEN;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tool registration", () => {
  it("lists exactly the eleven documented tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "case_authorities",
      "case_detail",
      "citation_lookup",
      "cited_by",
      "court_list",
      "docket_entries",
      "docket_lookup",
      "judge_lookup",
      "opinion_search",
      "oral_argument_transcript",
      "oral_arguments",
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
    }
  });
});

describe("opinion_search", () => {
  it("normalizes an opinion hit (snippet from nested opinions, full URL, citations array)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_OPINION));
    const body = payload(await call("opinion_search", { q: "miranda" }));

    expect(body.total_matches).toBe(630);
    expect(body.returned).toBe(1);
    const hit = body.results[0];
    expect(hit.case_name).toBe("Miranda v. Selig");
    expect(hit.court_id).toBe("scotus");
    expect(hit.date_filed).toBe("2017-12-04");
    expect(hit.citations).toEqual(["138 S. Ct. 507", "199 L. Ed. 2d 386"]);
    expect(hit.docket_number).toBe("17-453");
    expect(hit.cite_count).toBe(3);
    expect(hit.status).toBe("Published");
    expect(hit.snippet).toBe("The Fifth Amendment privilege ...");
    expect(hit.cluster_id).toBe(9335501);
    expect(hit.absolute_url).toBe("https://www.courtlistener.com/opinion/9335501/miranda-v-selig/");
  });

  it("forwards the cursor arg and surfaces next_cursor from the envelope's next URL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_OPINION));
    const body = payload(await call("opinion_search", { q: "miranda", cursor: "PAGE2CUR" }));
    // the cursor is passed straight through to the API for the next page
    expect(lastUrl().searchParams.get("cursor")).toBe("PAGE2CUR");
    expect(body.query.cursor).toBe("PAGE2CUR");
    // the fixture's `next` carries cursor=abc; that value is surfaced back out
    expect(body.next_cursor).toBe("abc");
  });

  it("reports next_cursor as null on the last page (no next)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 1, next: null, previous: null, results: [] }));
    const body = payload(await call("opinion_search", { q: "miranda" }));
    expect(body.next_cursor).toBeNull();
  });

  it("advertises and enforces the true search page size (1-20, not the 50 it cannot reach)", async () => {
    const { tools } = await client.listTools();
    const schema = JSON.stringify(tools.find((t) => t.name === "opinion_search")!.inputSchema);
    expect(schema).toContain("1-20");
    expect(schema).not.toContain("1-50");
    // Even asked for 50, one /search/ page tops out at 20 rows.
    const results = Array.from({ length: 25 }, (_, i) => ({ caseName: `Case ${i}`, cluster_id: i }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 999, next: null, results }));
    const body = payload(await call("opinion_search", { q: "x", limit: 50 }));
    expect(body.returned).toBe(20);
  });

  it("builds the type=o query with filters and order_by, and sends the token when set", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0, results: [] }));
    await call("opinion_search", {
      q: "eviction",
      court: "nysd",
      filed_after: "2015-01-01",
      filed_before: "2020-12-31",
      order_by: "newest",
    });

    const url = lastUrl();
    expect(url.origin + url.pathname).toBe("https://www.courtlistener.com/api/rest/v4/search/");
    expect(url.searchParams.get("type")).toBe("o");
    expect(url.searchParams.get("q")).toBe("eviction");
    expect(url.searchParams.get("court")).toBe("nysd");
    expect(url.searchParams.get("filed_after")).toBe("2015-01-01");
    expect(url.searchParams.get("filed_before")).toBe("2020-12-31");
    expect(url.searchParams.get("order_by")).toBe("dateFiled desc");
    expect(lastInit().headers.Authorization).toBe("Token test-token");
  });

  it("works without a token and omits the Authorization header", async () => {
    delete process.env.COURTLISTENER_API_TOKEN;
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_OPINION));
    const body = payload(await call("opinion_search", { q: "miranda" }));
    expect(body.returned).toBe(1);
    expect(lastInit().headers.Authorization).toBeUndefined();
  });

  it("returns an empty result set cleanly", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0, next: null, previous: null, results: [] }));
    const body = payload(await call("opinion_search", { q: "nonesuchquery" }));
    expect(body.returned).toBe(0);
    expect(body.results).toEqual([]);
  });

  it("requires q (error, no network call)", async () => {
    const res: any = await call("opinion_search", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/q is required/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid order_by and a malformed date without calling the API", async () => {
    const bad1: any = await call("opinion_search", { q: "x", order_by: "cheapest" });
    expect(bad1.isError).toBe(true);
    expect(bad1.content[0].text).toMatch(/order_by/i);

    const bad2: any = await call("opinion_search", { q: "x", filed_after: "01-01-2020" });
    expect(bad2.isError).toBe(true);
    expect(bad2.content[0].text).toMatch(/YYYY-MM-DD/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The option tables are plain object literals, so they inherit
  // Object.prototype: ORDER_BY["toString"] is a truthy function and
  // "constructor" in OA_ORDER_BY is true. The two validators were a truthiness
  // check and an `in` check, so these passed and were stringified into the
  // outgoing query. The inputSchema enum does not help — the low-level SDK
  // Server does no schema validation, so the handler is the only gate.
  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"])(
    "rejects the inherited key %s on every tool that takes order_by",
    async (orderKey) => {
      for (const [tool, args] of [
        ["opinion_search", { q: "x" }],
        ["cited_by", { opinion_id: 5 }],
        ["oral_arguments", { q: "x" }],
      ] as Array<[string, Record<string, unknown>]>) {
        const res: any = await call(tool, { ...args, order_by: orderKey });
        expect(res.isError, `${tool} accepted order_by=${orderKey}`).toBe(true);
        expect(res.content[0].text, tool).toMatch(/order_by must be one of/);
        expect(fetchMock, `${tool} sent a request for order_by=${orderKey}`).not.toHaveBeenCalled();
      }
    },
  );

  it("still accepts relevance, whose oral-argument value is legitimately undefined", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0, next: null, results: [] }));
    const res: any = await call("oral_arguments", { q: "x", order_by: "relevance" });
    expect(res.isError).toBeFalsy();
    // The search default: the parameter is omitted rather than sent empty.
    expect(lastUrl().searchParams.has("order_by")).toBe(false);
  });

  it("surfaces an HTTP 500 as isError, after exhausting retries", async () => {
    // A 5xx is retried (see withRetry), so the mock must answer every attempt.
    fetchMock.mockResolvedValue(textResponse("upstream boom", { ok: false, status: 500 }));
    const res500: any = await call("opinion_search", { q: "x" });
    expect(res500.isError).toBe(true);
    expect(res500.content[0].text).toContain("500");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("surfaces a non-JSON page as isError WITHOUT retrying it", async () => {
    // An HTML page is a rejected request or a changed API, not a wobble.
    fetchMock.mockResolvedValue(textResponse("<html>maintenance</html>"));
    const resHtml: any = await call("opinion_search", { q: "x" });
    expect(resHtml.isError).toBe(true);
    expect(resHtml.content[0].text).toContain("non-JSON");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a 4xx", async () => {
    fetchMock.mockResolvedValue(textResponse(JSON.stringify({ detail: "bad request" }), { ok: false, status: 400 }));
    const res: any = await call("opinion_search", { q: "x" });
    expect(res.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429, since that one means slow down", async () => {
    fetchMock.mockResolvedValue(textResponse(JSON.stringify({ detail: "throttled" }), { ok: false, status: 429 }));
    const res: any = await call("opinion_search", { q: "x" });
    expect(res.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("docket_lookup", () => {
  it("normalizes a docket hit and queries type=r", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_DOCKET));
    const body = payload(await call("docket_lookup", { q: "eviction" }));

    expect(lastUrl().searchParams.get("type")).toBe("r");
    expect(body.returned).toBe(1);
    const hit = body.results[0];
    expect(hit.case_name).toBe("Eviction Rights, Inc.");
    expect(hit.court_id).toBe("txnb");
    expect(hit.docket_number).toBe("11-35405");
    expect(hit.date_terminated).toBe("2012-03-01");
    expect(hit.nature_of_suit).toBe("Bankruptcy");
    expect(hit.absolute_url).toBe("https://www.courtlistener.com/docket/6654071/eviction-rights-inc/");
  });

  it("folds docket_number into the q term", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0, results: [] }));
    await call("docket_lookup", { docket_number: "11-35405" });
    expect(lastUrl().searchParams.get("q")).toContain("11-35405");
  });

  it("forwards the cursor arg and surfaces next_cursor", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_DOCKET));
    const body = payload(await call("docket_lookup", { q: "eviction", cursor: "DKT2" }));
    expect(lastUrl().searchParams.get("cursor")).toBe("DKT2");
    expect(body.query.cursor).toBe("DKT2");
    // SEARCH_DOCKET.next carries cursor=def
    expect(body.next_cursor).toBe("def");
  });

  it("requires q or docket_number (error, no network call)", async () => {
    const res: any = await call("docket_lookup", { court: "nysd" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/at least one/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("court_list", () => {
  it("passes a jurisdiction filter and normalizes courts", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(COURTS));
    const body = payload(await call("court_list", { jurisdiction: "F" }));
    expect(lastUrl().searchParams.get("jurisdiction")).toBe("F");
    expect(body.returned).toBe(2);
    expect(body.courts[0]).toMatchObject({ id: "scotus", jurisdiction: "F", in_use: true });
    expect(body.courts[0].website).toBe("http://supremecourt.gov/");
  });

  it("applies the q substring filter over the fetched courts", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(COURTS));
    const body = payload(await call("court_list", { q: "ninth circuit" }));
    expect(body.returned).toBe(1);
    expect(body.courts[0].id).toBe("ca9");
  });

  it("pages through the whole courts table so the name filter is not capped at page 1", async () => {
    // The sought court is on page 2; a single-page scan would silently miss it.
    fetchMock.mockResolvedValueOnce(jsonResponse(COURTS_PAGE_1));
    fetchMock.mockResolvedValueOnce(jsonResponse(COURTS_PAGE_2));
    const body = payload(await call("court_list", { q: "s.d. new york" }));

    // Both pages were fetched, and the second advanced via ?page=2 (offset paging).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][0] as URL).searchParams.get("page")).toBe("2");
    // The match lived on page 2 and was still found.
    expect(body.returned).toBe(1);
    expect(body.courts[0].id).toBe("nysd");
    // A completed walk is what the unconditional note used to claim always.
    expect(String(body.note)).toMatch(/full courts table/i);
  });

  // The walk stops at MAX_COURT_PAGES (200) on a table that only grows. Past
  // the cap the filter runs over a PREFIX, and the note claimed the full table
  // either way.
  it("says so when the page cap stopped the walk, instead of claiming the full table", async () => {
    // Every page reports a next, so the walk runs to the cap and never completes.
    fetchMock.mockResolvedValue(
      jsonResponse({
        count: 99999,
        next: "https://www.courtlistener.com/api/rest/v4/courts/?page=999",
        results: [{ id: "scotus", full_name: "Supreme Court of the United States", jurisdiction: "F", in_use: true }],
      }),
    );
    const body = payload(await call("court_list", { q: "no-such-court" }));
    expect(fetchMock).toHaveBeenCalledTimes(200);
    expect(String(body.note)).toMatch(/safety cap/i);
    expect(String(body.note)).not.toMatch(/full courts table/i);
    expect(String(body.note)).toMatch(/cannot appear here even if it matches/i);
  });
});

describe("judge_lookup", () => {
  it("assembles the name and counts positions", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(PEOPLE));
    const body = payload(await call("judge_lookup", { name_last: "Ginsburg" }));
    expect(lastUrl().searchParams.get("name_last")).toBe("Ginsburg");
    expect(body.returned).toBe(1);
    const p = body.results[0];
    expect(p.id).toBe(1213);
    expect(p.name).toBe("Ruth Bader Ginsburg");
    expect(p.date_of_birth).toBe("1933-03-15");
    expect(p.positions_count).toBe(2);
  });

  it("requires a name (error, no network call)", async () => {
    const res: any = await call("judge_lookup", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/name_last or name_first/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // /people/ serves one fixed page of 20 and ignores page_size: live
  // 2026-09-14, /people/?name_last=Smith and the same query with page_size=50
  // both returned 20 rows with a `next`. The tool advertised 1-50 and exposes
  // no cursor, so a caller asking for 50 got 20 with nothing saying more exist.
  it("advertises and enforces the true /people/ page size, not the 50 it cannot reach", async () => {
    // 25 rows is a deliberately over-long page: upstream serves 20, and this
    // is the only way to make the clamp observable. With limit clamped at
    // MAX_RESULTS (50) instead of PEOPLE_PAGE_SIZE, `returned` would be 25.
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: 1000 + i, name_last: `Smith${i}` }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ count: null, next: "https://www.courtlistener.com/api/rest/v4/people/?cursor=abc", results: rows }),
    );
    const body = payload(await call("judge_lookup", { name_last: "Smith", limit: 50 }));
    expect(body.returned).toBe(20);
    expect(body.more_available).toBe(true);
    expect(String(body.note)).toMatch(/never the total/i);

    const tools: any = await client.listTools();
    const schema = tools.tools.find((t: any) => t.name === "judge_lookup").inputSchema;
    expect(schema.properties.limit.description).toMatch(/1-20/);
    expect(schema.properties.limit.description).not.toMatch(/1-50/);
  });

  it("says nothing about more pages when the page is the whole answer", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(PEOPLE));
    const body = payload(await call("judge_lookup", { name_last: "Ginsburg" }));
    expect(body.more_available).toBe(false);
    expect(body.note).toBeUndefined();
  });
});

describe("case_detail", () => {
  it("fetches a cluster with the token, formatting citations and sub-opinion ids", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(CLUSTER));
    const body = payload(await call("case_detail", { id: 9335501 }));

    expect(lastUrl().pathname).toBe("/api/rest/v4/clusters/9335501/");
    expect(lastInit().headers.Authorization).toBe("Token test-token");
    expect(body.type).toBe("cluster");
    expect(body.case_name).toBe("Miranda v. Selig");
    expect(body.citations).toEqual(["138 S. Ct. 507", "199 L. Ed. 2d 386"]);
    expect(body.citation_count).toBe(3);
    expect(body.sub_opinion_ids).toEqual([9200000]);
    expect(body.absolute_url).toBe("https://www.courtlistener.com/opinion/9335501/miranda-v-selig/");
  });

  it("fetches an opinion and returns its full text", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(OPINION));
    const body = payload(await call("case_detail", { id: 9200000, type: "opinion" }));

    expect(lastUrl().pathname).toBe("/api/rest/v4/opinions/9200000/");
    expect(body.type).toBe("opinion");
    expect(body.opinion_type).toBe("010combined");
    expect(body.author).toBe("Ginsburg");
    expect(body.per_curiam).toBe(false);
    expect(body.text_source).toBe("plain_text");
    expect(body.text).toContain("The judgment is affirmed.");
    expect(body.text_truncated).toBe(false);
  });

  it("errors clearly when the token is missing, without calling the API", async () => {
    delete process.env.COURTLISTENER_API_TOKEN;
    const res: any = await call("case_detail", { id: 9335501 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("COURTLISTENER_API_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid type", async () => {
    const res: any = await call("case_detail", { id: 1, type: "docket" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/cluster.*opinion/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("citation_lookup", () => {
  it("POSTs the text as a JSON body and verifies a mixed found/not-found set, flagging the fake NOT_FOUND", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(CITATION_LOOKUP_MIXED));
    const text = "In Roe v. Wade, 410 U.S. 113 (1973), the Court held. See also Smith v. Imaginary, 999 U.S. 9999 (2099).";
    const body = payload(await call("citation_lookup", { text }));

    // POST to /citation-lookup/ with a JSON body carrying only the text.
    const url = lastUrl();
    expect(url.origin + url.pathname).toBe("https://www.courtlistener.com/api/rest/v4/citation-lookup/");
    const init = lastInit();
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    // CourtListener is a free public service run by a non-profit: identify
    // ourselves on every call, POST included. A missing UA is invisible to
    // every other assertion here — that is how the sibling wagewatch server
    // shipped without one until 2026-07-29.
    expect(init.headers["User-Agent"]).toMatch(/^mcp-courtwatch\/\d/);
    expect(JSON.parse(init.body!)).toEqual({ text });

    // Summary counts: one real, one fake, verified never claimed overall.
    expect(body.citations_checked).toBe(2);
    expect(body.found).toBe(1);
    expect(body.not_found).toBe(1);
    expect(body.all_verified).toBe(false);
    expect(body.warning).toMatch(/did NOT verify/);
    expect(body.warning).toMatch(/not found/i);
    expect(body.warning).toMatch(/check them by hand/i);

    // The real citation resolves with normalized cluster matches.
    const hit = body.results[0];
    expect(hit.citation).toBe("410 U.S. 113");
    expect(hit.verified).toBe(true);
    expect(hit.verdict).toBe("FOUND");
    expect(hit.status).toBe(200);
    expect(hit.normalized_citations).toEqual(["410 U.S. 113"]);
    expect(hit.start_index).toBe(26);
    expect(hit.end_index).toBe(38);
    const match = hit.matches[0];
    expect(match.cluster_id).toBe(108713);
    expect(match.case_name).toBe("Roe v. Wade");
    expect(match.date_filed).toBe("1973-01-22");
    expect(match.citations).toEqual(["410 U.S. 113", "93 S. Ct. 705"]);
    expect(match.precedential_status).toBe("Published");
    expect(match.citation_count).toBe(12030);
    expect(match.absolute_url).toBe("https://www.courtlistener.com/opinion/108713/roe-v-wade/");

    // The fake citation gets an explicit NOT_FOUND flag.
    const fake = body.results[1];
    expect(fake.citation).toBe("999 U.S. 9999");
    expect(fake.verified).toBe(false);
    expect(fake.verdict).toBe("NOT_FOUND");
    expect(fake.status).toBe(404);
    expect(fake.error_message).toBe("Citation not found: '999 U.S. 9999'");
    expect(fake.matches).toEqual([]);
  });

  it("maps multiple-match, unknown-reporter, and over-cap statuses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(CITATION_LOOKUP_EDGE));
    const body = payload(await call("citation_lookup", { text: "576 U.S. 644 et al." }));

    expect(body.citations_checked).toBe(3);
    expect(body.found).toBe(1);
    expect(body.not_found).toBe(0);
    expect(body.invalid).toBe(1);
    expect(body.not_checked).toBe(1);
    expect(body.all_verified).toBe(false);

    // 300 = the citation is real but matches multiple clusters; both surfaced.
    const multi = body.results[0];
    expect(multi.verified).toBe(true);
    expect(multi.verdict).toBe("FOUND_MULTIPLE");
    expect(multi.matches).toHaveLength(2);
    expect(multi.matches[0].case_name).toBe("Obergefell v. Hodges");

    // 400 = the reporter abbreviation is not a known reporter.
    const bad = body.results[1];
    expect(bad.verified).toBe(false);
    expect(bad.verdict).toBe("UNKNOWN_REPORTER");
    expect(bad.error_message).toMatch(/Unable to find reporter/);

    // 429 = past the per-request citation cap; returned flagged, not checked.
    const over = body.results[2];
    expect(over.verified).toBe(false);
    expect(over.verdict).toBe("NOT_CHECKED_OVER_CAP");
    expect(body.warning).toMatch(/split the text/i);
  });

  it("reports all_verified (and no warning) only when every citation resolves", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([CITATION_LOOKUP_MIXED[0]]));
    const body = payload(await call("citation_lookup", { text: "410 U.S. 113" }));
    expect(body.citations_checked).toBe(1);
    expect(body.found).toBe(1);
    expect(body.all_verified).toBe(true);
    expect(body.warning).toBeUndefined();
  });

  it("handles a response with no recognized citations without claiming verification", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const body = payload(await call("citation_lookup", { text: "no citations in this text at all" }));
    expect(body.citations_checked).toBe(0);
    expect(body.all_verified).toBe(false);
    expect(body.note).toMatch(/no citations were recognized/i);
  });

  it("rejects oversized text before any network call instead of truncating", async () => {
    const res: any = await call("citation_lookup", { text: "x".repeat(64_001) });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("64000");
    expect(res.content[0].text).toMatch(/split/i);
    expect(res.content[0].text).toMatch(/nothing was sent/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires text (error, no network call)", async () => {
    const res: any = await call("citation_lookup", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/text is required/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("errors clearly when the token is missing, without calling the API", async () => {
    delete process.env.COURTLISTENER_API_TOKEN;
    const res: any = await call("citation_lookup", { text: "410 U.S. 113" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("COURTLISTENER_API_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the token as an Authorization header, never in the URL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await call("citation_lookup", { text: "410 U.S. 113" });
    expect(lastInit().headers.Authorization).toBe("Token test-token");
    expect(lastUrl().search).toBe("");
  });
});

describe("unknown tool", () => {
  it("rejects with a protocol error", async () => {
    await expect(call("does_not_exist", {})).rejects.toThrow();
  });

  // The dispatch table is a plain object literal, so every Object.prototype
  // member used to resolve as a "tool". "constructor" answered isError:false
  // with the caller's own arguments plus the records-only disclaimer attached —
  // a fabricated court record, labelled as a real one, one typo away.
  // "does_not_exist" alone could not catch it: it is the one name that has no
  // inherited answer.
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"])(
    "does not dispatch the inherited property %s as a tool",
    async (name) => {
      await expect(call(name, { q: "x" })).rejects.toThrow(/Unknown tool/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// SPEC records-not-advice — operator-authored 2026-07-29
// ---------------------------------------------------------------------------

describe("SPEC records-not-advice", () => {
  // spec: records-not-advice
  // Given any successful tool call
  // When the result is returned to a model
  // Then it carries an explicit records-only framing, so an overworked legal-aid
  //      worker or pro-se litigant cannot read the output as guidance.
  // Operator's stated worst failure for this server: "it's treated as legal advice."
  it("every successful tool result carries the records-only framing", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ count: 0, results: [] }));
    for (const [tool, args] of [
      ["opinion_search", { q: "test" }],
      ["court_list", {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const body = payload(await call(tool, args));
      expect(body, `${tool} must carry the disclaimer`).toHaveProperty("disclaimer");
      expect(String(body.disclaimer).toLowerCase()).toContain("not legal advice");
    }
  });
});

// ---------------------------------------------------------------------------
// 1.1.0 tools: cited_by, case_authorities, docket_entries, oral_arguments
// ---------------------------------------------------------------------------

describe("cited_by", () => {
  it("searches with the cites:() fielded operator, type=o", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        count: 470,
        next: "https://www.courtlistener.com/api/rest/v4/search/?cursor=abc&q=cites%3A(2812209)",
        results: [
          {
            caseName: "Mirabelli v. Bonta",
            court: "S.D. California",
            court_id: "casd",
            dateFiled: "2025-01-01",
            citation: [],
            cluster_id: 999,
            absolute_url: "/opinion/999/mirabelli/",
          },
        ],
      }),
    );
    const body = payload(await call("cited_by", { opinion_id: 2812209 }));
    expect(lastUrl().searchParams.get("q")).toBe("cites:(2812209)");
    expect(lastUrl().searchParams.get("type")).toBe("o");
    expect(lastUrl().searchParams.get("order_by")).toBe("dateFiled desc"); // default newest
    expect(body.total_citing).toBe(470);
    expect(body.next_cursor).toBe("abc");
    expect(body.results[0].case_name).toBe("Mirabelli v. Bonta");
    expect(String(body.note)).toContain("treatment");
  });

  // Bad opinion_id values are covered for every id-taking tool at once, in
  // "positive-integer id validation" below.
});

describe("case_authorities", () => {
  it("hits /opinions-cited/ with citing_opinion and normalizes URL pairs", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        count: 2,
        next: null,
        results: [
          {
            citing_opinion: "https://www.courtlistener.com/api/rest/v4/opinions/2812209/",
            cited_opinion: "https://www.courtlistener.com/api/rest/v4/opinions/108713/",
            depth: 7,
          },
          {
            citing_opinion: "https://www.courtlistener.com/api/rest/v4/opinions/2812209/",
            cited_opinion: "https://www.courtlistener.com/api/rest/v4/opinions/96405/",
            depth: 1,
          },
        ],
      }),
    );
    const body = payload(await call("case_authorities", { opinion_id: 2812209 }));
    expect(lastUrl().pathname).toContain("/opinions-cited/");
    expect(lastUrl().searchParams.get("citing_opinion")).toBe("2812209");
    expect(body.results[0].cited_opinion_id).toBe(108713);
    expect(body.results[0].depth).toBe(7);
    expect(body.total_authorities).toBe(2);
  });

  it("throws the token setup error pre-flight when unset", async () => {
    delete process.env.COURTLISTENER_API_TOKEN;
    const res = await call("case_authorities", { opinion_id: 5 });
    expect((res as any).isError).toBe(true);
    expect((res as any).content[0].text).toContain("COURTLISTENER_API_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("docket_entries", () => {
  it("lists entries with nested RECAP documents and the coverage note", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        count: 42,
        next: "https://www.courtlistener.com/api/rest/v4/docket-entries/?cursor=xyz",
        results: [
          {
            id: 1,
            entry_number: 12,
            date_filed: "2024-05-01",
            description: "MOTION to Dismiss",
            recap_documents: [
              {
                id: 900,
                document_number: "12",
                description: "Memorandum of Law",
                page_count: 25,
                is_available: true,
                absolute_url: "/docket/65745614/12/",
              },
            ],
          },
        ],
      }),
    );
    const body = payload(await call("docket_entries", { docket_id: 65745614 }));
    expect(lastUrl().pathname).toContain("/docket-entries/");
    expect(lastUrl().searchParams.get("docket")).toBe("65745614"); // the real filter param; docket_id 400s
    expect(body.total_entries).toBe(42);
    expect(body.next_cursor).toBe("xyz");
    expect(body.results[0].entry_number).toBe(12);
    expect(body.results[0].recap_documents[0].page_count).toBe(25);
    expect(String(body.note)).toContain("PACER");
    expect(String(body.note)).toContain("FILED");
  });

  it("requires a token pre-flight", async () => {
    delete process.env.COURTLISTENER_API_TOKEN;
    const res = await call("docket_entries", { docket_id: 5 });
    expect((res as any).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("oral_arguments", () => {
  it("searches type=oa and normalizes the audio fields", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        count: 2175,
        next: null,
        results: [
          {
            caseName: "Miranda v. Arizona",
            court: "Supreme Court of the United States",
            court_id: "scotus",
            docketNumber: "759",
            dateArgued: "1966-02-28",
            judge: "Warren",
            duration: 3600,
            id: 555,
            docket_id: 777,
            download_url: "https://example.com/audio.mp3",
            absolute_url: "/audio/555/miranda/",
          },
        ],
      }),
    );
    const body = payload(await call("oral_arguments", { q: "miranda", court: "scotus" }));
    expect(lastUrl().searchParams.get("type")).toBe("oa");
    expect(lastUrl().searchParams.get("court")).toBe("scotus");
    expect(body.total_matches).toBe(2175);
    expect(body.results[0].date_argued).toBe("1966-02-28");
    expect(body.results[0].duration_seconds).toBe(3600);
    expect(body.results[0].download_url).toBe("https://example.com/audio.mp3");
  });
});

// A type=o hit exactly as the live API serves it (unauthenticated,
// /search/?type=o&q=obergefell&court=scotus, 2026-09-14): opinions[] entries
// carry many keys, and the two that matter downstream are id and type.
const SEARCH_OPINION_LIVE_SHAPE = {
  count: 46,
  next: null,
  previous: null,
  results: [
    {
      absolute_url: "/opinion/8174675/obergefell-v-hodges/",
      caseName: "Obergefell v. Hodges",
      caseNameFull: "James OBERGEFELL v. Richard HODGES, Director, Ohio Department of Health",
      court: "Supreme Court of the United States",
      court_id: "scotus",
      dateFiled: "2015-06-26",
      citation: [],
      citeCount: 0,
      cluster_id: 8174675,
      status: "Published",
      opinions: [
        {
          author_id: null,
          cites: [],
          download_url: null,
          id: 8136452,
          joined_by_ids: [],
          local_path: null,
          meta: { timestamp: "2024-06-25T03:02:12.978753Z", date_created: "2022-09-09T17:53:37.932738Z" },
          ordering_key: null,
          per_curiam: false,
          sha1: "",
          snippet: "\nMotion of Theodore Coates for leave to file a brief as amicus curiaedenied.\n",
          type: "lead-opinion",
        },
      ],
    },
  ],
};

describe("opinion_search carries the opinion ids", () => {
  // cited_by is billed as the free, keyless citator and it takes an OPINION id.
  // The only other documented route to one was case_detail's sub_opinion_ids,
  // which reads a 401-gated endpoint — so without this field a token-less
  // caller could not reach the keyless feature at all.
  it("surfaces opinions[].id and .type from a live-shaped hit", async () => {
    delete process.env.COURTLISTENER_API_TOKEN; // the point is that this works keyless
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_OPINION_LIVE_SHAPE));
    const body = payload(await call("opinion_search", { q: "obergefell", court: "scotus" }));

    expect(lastInit().headers.Authorization).toBeUndefined();
    expect(body.results[0].cluster_id).toBe(8174675);
    expect(body.results[0].opinions).toEqual([{ id: 8136452, type: "lead-opinion" }]);
    // The snippet still comes out of the same array; both readers coexist.
    expect(body.results[0].snippet).toContain("amicus curiae");
  });

  it("feeds cited_by directly: the id from a search hit is the id it queries on", async () => {
    delete process.env.COURTLISTENER_API_TOKEN;
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_OPINION_LIVE_SHAPE));
    const search = payload(await call("opinion_search", { q: "obergefell" }));
    const opinionId = search.results[0].opinions[0].id;

    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 174, next: null, results: [] }));
    const citing = payload(await call("cited_by", { opinion_id: opinionId }));

    expect(lastUrl().searchParams.get("q")).toBe(`cites:(${opinionId})`);
    expect(lastInit().headers.Authorization).toBeUndefined(); // still keyless
    expect(citing.total_citing).toBe(174);
  });

  it("drops opinions[] entries with no id, and survives a missing array", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        count: 2,
        next: null,
        results: [
          { caseName: "No opinions key", cluster_id: 1 },
          { caseName: "Junk entries", cluster_id: 2, opinions: [null, "x", { type: "lead-opinion" }, { id: 7 }] },
        ],
      }),
    );
    const body = payload(await call("opinion_search", { q: "x" }));
    expect(body.results[0].opinions).toEqual([]);
    expect(body.results[1].opinions).toEqual([{ id: 7, type: null }]);
  });

  it("names opinion_search as the keyless source in cited_by's description", async () => {
    const { tools } = await client.listTools();
    const citedBy = tools.find((t) => t.name === "cited_by")!;
    expect(citedBy.description).toContain("opinion_search");
    expect(JSON.stringify(citedBy.inputSchema)).toContain("opinion_search");
  });
});

describe("docket_lookup fielded docket number", () => {
  it("routes docket_number through the docketNumber:() operator with quotes stripped", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 6, next: null, results: [] }));
    await call("docket_lookup", { docket_number: '1:20-cv-"03590"' });
    expect(lastUrl().searchParams.get("q")).toBe('docketNumber:"1:20-cv-03590"');
  });

  // A trailing backslash escapes the closing quote rather than ending the
  // value, and CourtListener answers 500 — which isRetryable() reads as a
  // "come back", so one bad argument drew three 500s from a nonprofit's search
  // cluster. Live 2026-09-14: docketNumber:"1:20-cv-03590\" -> HTTP 500;
  // the same query without the backslash -> HTTP 200, count 6.
  it("strips a TRAILING backslash, which would otherwise escape the closing quote", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 6, next: null, results: [] }));
    await call("docket_lookup", { docket_number: "1:20-cv-03590\\" });
    const q = lastUrl().searchParams.get("q")!;
    expect(q).toBe('docketNumber:"1:20-cv-03590"');
    expect(q).not.toContain("\\");
  });

  it("strips a mid-string backslash too", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0, next: null, results: [] }));
    await call("docket_lookup", { docket_number: "1:20\\cv\\03590" });
    const q = lastUrl().searchParams.get("q")!;
    expect(q).toBe('docketNumber:"1:20cv03590"');
    expect(q).not.toContain("\\");
  });

  // The mix that sanitizes away entirely is not a balanced operator, it is an
  // empty one — and docketNumber:"" is a query CourtListener answers: HTTP 200,
  // count 0, verified live 2026-09-14. The balanced-operator test below used to
  // feed exactly this input and assert only the shape of the string, so the
  // real negative it produced had nothing looking at it.
  it.each(['"', "\\", '"\\', '\\"\\"', '  "  '])(
    "refuses docket_number %j, which would leave an empty operator reading as no such docket",
    async (raw) => {
      const res: any = await call("docket_lookup", { docket_number: raw });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/nothing is left to match/i);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("refuses it even when a free-text q would have carried the search", async () => {
    const res: any = await call("docket_lookup", { q: "eviction", docket_number: '"' });
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the operator balanced for every quote/backslash mix", async () => {
    for (const raw of ['1:20-cv-03590\\', '1:20\\"-cv', 'a\\\\b', '"1:20"']) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0, next: null, results: [] }));
      await call("docket_lookup", { docket_number: raw });
      const q = lastUrl().searchParams.get("q")!;
      // Exactly the two delimiting quotes, and no backslash to escape either.
      expect(q.match(/"/g), `q for ${JSON.stringify(raw)}`).toHaveLength(2);
      expect(q, `q for ${JSON.stringify(raw)}`).not.toContain("\\");
      expect(q.startsWith('docketNumber:"') && q.endsWith('"')).toBe(true);
    }
  });
});

// The same HTTP 500, one argument over. Sanitizing only docket_number left the
// free-text q of the three search tools passing a dangling backslash straight
// through, and 500 is retryable here. Live 2026-09-14:
//   /search/?type=o&q=eviction\   -> HTTP 500   (three times, with the retries)
//   /search/?type=o&q=eviction    -> HTTP 200
//   /search/?type=o&q=eviction\\  -> HTTP 200
describe("free-text q never leaves with a dangling escape", () => {
  it.each([
    ["opinion_search", { q: "eviction\\" }],
    ["docket_lookup", { q: "eviction\\" }],
    ["oral_arguments", { q: "eviction\\" }],
  ])("drops the trailing backslash %s would otherwise send", async (tool, args) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0, next: null, results: [] }));
    await call(tool, args);
    const q = lastUrl().searchParams.get("q")!;
    expect(q.endsWith("\\")).toBe(false);
    expect(q).toBe("eviction");
  });

  it("keeps a balanced pair, which is a real escaped backslash (live: HTTP 200)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0, next: null, results: [] }));
    await call("opinion_search", { q: "eviction\\\\" });
    expect(lastUrl().searchParams.get("q")).toBe("eviction\\\\");
  });

  it("leaves an interior escape alone — it has something to escape", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0, next: null, results: [] }));
    await call("opinion_search", { q: 'caseName:\\"Roe\\" eviction' });
    expect(lastUrl().searchParams.get("q")).toBe('caseName:\\"Roe\\" eviction');
  });

  it("cleans the free-text half before it is joined to the fielded operator", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0, next: null, results: [] }));
    await call("docket_lookup", { q: "eviction\\", docket_number: "1:20-cv-03590" });
    // Without the clean, the backslash escapes the separating space instead.
    expect(lastUrl().searchParams.get("q")).toBe('eviction docketNumber:"1:20-cv-03590"');
  });

  // The clean's own edge: a q made only of dangling escapes empties, clGet
  // omits an empty param, and /search/?type=o with no q is HTTP 200 count
  // 8,310,312 — every opinion in the database, reported as matches for the
  // caller's query (verified live 2026-09-14).
  it.each([
    ["opinion_search", { q: "\\" }],
    ["docket_lookup", { q: "\\" }],
    ["oral_arguments", { q: "\\" }],
  ])("refuses a %s query that cleans away to nothing, which would search everything", async (tool, args) => {
    const res: any = await call(tool, args);
    expect(res.isError, `${tool} sent an empty q`).toBe(true);
    expect(res.content[0].text).toMatch(/nothing is left to search for/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a docket_lookup free-text q that empties even when a docket_number would carry it", async () => {
    const res: any = await call("docket_lookup", { q: "\\", docket_number: "1:20-cv-03590" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/nothing is left to search for/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// An /audio/{id}/ record, field names as the live API serves them
// (unauthenticated, 2026-09-14). Audio 106247 is a 1,051-second circuit
// argument whose real transcript is 13,974 characters; the text is abbreviated
// here, the shape is not.
function audioRecord(over: Record<string, unknown> = {}) {
  return {
    id: 106247,
    absolute_url: "/audio/106247/mikes-auto-body-of-glenwood-city-v-st-croix-county/",
    case_name: "Mike's Auto Body of Glenwood City v. St. Croix County",
    case_name_full: "Mike's Auto Body of Glenwood City v. St. Croix County",
    docket: "https://www.courtlistener.com/api/rest/v4/dockets/70000000/",
    download_url: "https://storage.courtlistener.com/mp3/2026/09/02/argument.mp3",
    duration: 1051,
    judges: "Kirk, Hruz, Gill",
    local_path_mp3: "mp3/2026/09/02/argument.mp3",
    processing_complete: true,
    sha1: "abc",
    source: "C",
    stt_source: 1,
    stt_status: 1,
    stt_transcript: "ABCDEFGHIJ",
    ...over,
  };
}

describe("oral_argument_transcript", () => {
  it("returns the Whisper transcript, keyless, with the machine-generated provenance", async () => {
    delete process.env.COURTLISTENER_API_TOKEN;
    fetchMock.mockResolvedValueOnce(jsonResponse(audioRecord()));
    const body = payload(await call("oral_argument_transcript", { audio_id: 106247 }));

    expect(lastUrl().pathname).toBe("/api/rest/v4/audio/106247/");
    expect(lastInit().headers.Authorization).toBeUndefined(); // the endpoint is keyless
    expect(body.stt_status).toBe(1);
    expect(body.stt_verdict).toBe("COMPLETE");
    expect(body.transcript_usable).toBe(true);
    expect(body.text).toBe("ABCDEFGHIJ");
    expect(body.transcript_chars).toBe(10);
    expect(body.returned_chars).toBe(10);
    expect(body.truncated).toBe(false);
    expect(body.next_offset).toBeNull();
    expect(body.stt_source).toBe("OpenAI API whisper-1");
    expect(body.machine_generated).toBe(true);
    expect(String(body.provenance)).toMatch(/not a court reporter/i);
    expect(body.case_name).toBe("Mike's Auto Body of Glenwood City v. St. Croix County");
    expect(body.duration_seconds).toBe(1051);
  });

  it("truncates at max_chars and hands back a next_offset that actually resumes", async () => {
    fetchMock.mockResolvedValue(jsonResponse(audioRecord()));
    const first = payload(await call("oral_argument_transcript", { audio_id: 106247, max_chars: 4 }));
    expect(first.text).toBe("ABCD");
    expect(first.returned_chars).toBe(4);
    expect(first.truncated).toBe(true);
    expect(first.next_offset).toBe(4);

    const second = payload(
      await call("oral_argument_transcript", { audio_id: 106247, offset: first.next_offset, max_chars: 4 }),
    );
    expect(second.text).toBe("EFGH");
    expect(second.offset).toBe(4);
    expect(second.next_offset).toBe(8);

    const last = payload(
      await call("oral_argument_transcript", { audio_id: 106247, offset: second.next_offset, max_chars: 4 }),
    );
    expect(last.text).toBe("IJ");
    expect(last.truncated).toBe(false);
    expect(last.next_offset).toBeNull();

    // The pages reassemble into the whole transcript, in order, with no gap.
    expect(first.text + second.text + last.text).toBe("ABCDEFGHIJ");
  });

  it("caps max_chars at the documented maximum", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(audioRecord({ stt_transcript: "x".repeat(120_000) })));
    const body = payload(await call("oral_argument_transcript", { audio_id: 106247, max_chars: 999_999 }));
    expect(body.max_chars).toBe(50_000);
    expect(body.returned_chars).toBe(50_000);
    expect(body.truncated).toBe(true);
    expect(body.transcript_chars).toBe(120_000);
  });

  // stt_status is an enum, not a flag, and its failure values are not rare: of
  // 103,278 audio records on 2026-09-14, 708 are status 3, 154 are 4, 77 are 5,
  // 46 are 2 and 16 are 0. Numbers and names from cl/audio/models.py.
  it.each([
    [0, "TRANSCRIPTION_NEEDED"],
    [2, "TRANSCRIPTION_FAILED"],
    [3, "TRANSCRIPTION_DOES_NOT_MATCH_AUDIO"],
    [4, "AUDIO_FILE_TOO_BIG"],
    [5, "AUDIO_FILE_MISSING"],
  ])("stt_status %i maps to %s and returns no text", async (status, verdict) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(audioRecord({ stt_status: status })));
    const body = payload(await call("oral_argument_transcript", { audio_id: 106247 }));
    expect(body.stt_status).toBe(status);
    expect(body.stt_verdict).toBe(verdict);
    expect(body.transcript_usable).toBe(false);
    expect(body.text).toBeNull();
    expect(String(body.warning)).toContain("No usable transcript");
    expect(String(body.stt_meaning).length).toBeGreaterThan(0);
  });

  it("stt_status 1 is the ONLY value that yields text", async () => {
    for (const status of [0, 1, 2, 3, 4, 5]) {
      clearClCache();
      fetchMock.mockResolvedValueOnce(jsonResponse(audioRecord({ stt_status: status })));
      const body = payload(await call("oral_argument_transcript", { audio_id: 106247 }));
      expect(typeof body.text === "string", `stt_status ${status}`).toBe(status === 1);
    }
  });

  // Audio 106047 live: stt_status 3, 9,450 characters that are the case caption
  // repeated over and over. It must not be handed back as a record.
  it("withholds a status-3 transcript while still saying the text exists", async () => {
    // A sentinel that exists ONLY in the transcript. The first version of this
    // test asserted the payload did not contain "Beaverdam" — a word from the
    // real record's transcript — and it passed for the wrong reason: live,
    // audio 106047's case_name is "Beaverdam Creek Holdings, LLC v.
    // Commissioner of Internal Revenue", so the word is legitimately in the
    // metadata and the assertion was measuring the fixture, not the behavior.
    const SENTINEL = "ZZ-TRANSCRIPT-ONLY-MARKER-ZZ";
    const caption = `25-12624 ${SENTINEL} v. Commissioner of Internal Revenue `.repeat(20);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(audioRecord({ id: 106047, stt_status: 3, stt_transcript: caption })),
    );
    const body = payload(await call("oral_argument_transcript", { audio_id: 106047 }));

    expect(body.stt_verdict).toBe("TRANSCRIPTION_DOES_NOT_MATCH_AUDIO");
    expect(body.text).toBeNull();
    // The length is still reported, so "nothing was transcribed" and "there is
    // text and CourtListener disowns it" do not read the same.
    expect(body.transcript_chars).toBe(caption.length);
    expect(String(body.warning)).toContain("withheld");
    expect(String(body.warning)).toContain(".mp3"); // pointed at the audio instead
    expect(JSON.stringify(body)).not.toContain(SENTINEL);
  });

  it("never guesses on an stt_status the enum does not carry", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(audioRecord({ stt_status: 9 })));
    const unknown = payload(await call("oral_argument_transcript", { audio_id: 106247 }));
    expect(unknown.stt_verdict).toBe("STATUS_9");
    expect(unknown.transcript_usable).toBe(false);
    expect(unknown.text).toBeNull();

    clearClCache();
    fetchMock.mockResolvedValueOnce(jsonResponse(audioRecord({ stt_status: null })));
    const missing = payload(await call("oral_argument_transcript", { audio_id: 106247 }));
    expect(missing.stt_verdict).toBe("STATUS_UNKNOWN");
    expect(missing.text).toBeNull();
  });

  it.each([0, -5, 1.5, "abc"])("rejects audio_id %s before any network call", async (audio_id) => {
    const res: any = await call("oral_argument_transcript", { audio_id });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/audio_id/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a negative or fractional offset before any network call", async () => {
    for (const offset of [-1, 2.5]) {
      const res: any = await call("oral_argument_transcript", { audio_id: 5, offset });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/offset/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says so when an offset runs past the end instead of returning a silent empty page", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(audioRecord()));
    const res: any = await call("oral_argument_transcript", { audio_id: 106247, offset: 500 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("past the end");
    expect(res.content[0].text).toContain("10 characters");
  });
});

describe("oral_arguments transcript availability", () => {
  const OA_PAGE = {
    count: 18,
    next: null,
    results: [
      { caseName: "A", court_id: "scotus", id: 111, duration: 100, snippet: "we will hear argument" },
      { caseName: "B", court_id: "scotus", id: 222, duration: 200, snippet: "" },
    ],
  };

  it("reads NOT_CHECKED by default, and costs no extra request", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(OA_PAGE));
    const body = payload(await call("oral_arguments", { q: "miranda" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body.results.map((r: any) => r.transcript_status)).toEqual(["NOT_CHECKED", "NOT_CHECKED"]);
    expect(String(body.note)).toContain("NOT_CHECKED");
    expect(String(body.note)).toContain("oral_argument_transcript");
    expect(body.query.include_transcript_status).toBe(false);
  });

  it("names the snippet's provenance in the payload, not only in the README", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(OA_PAGE));
    const body = payload(await call("oral_arguments", { q: "miranda" }));
    expect(String(body.note)).toMatch(/machine-generated whisper/i);
    expect(String(body.note)).toMatch(/not a certified transcript/i);
  });

  it("looks the real status up per row when asked, with the narrow fields read", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(OA_PAGE));
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 111, stt_status: 1 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 222, stt_status: 3 }));

    const body = payload(await call("oral_arguments", { q: "miranda", include_transcript_status: true }));

    expect(fetchMock).toHaveBeenCalledTimes(3); // one per row, as documented
    const audioCall = fetchMock.mock.calls[1][0] as URL;
    expect(audioCall.pathname).toBe("/api/rest/v4/audio/111/");
    expect(audioCall.searchParams.get("fields")).toBe("id,stt_status");
    expect(body.results.map((r: any) => r.transcript_status)).toEqual([
      "COMPLETE",
      "TRANSCRIPTION_DOES_NOT_MATCH_AUDIO",
    ]);
  });

  it("a failed status check reads CHECK_FAILED, never an assertion that no transcript exists", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(OA_PAGE));
    fetchMock.mockResolvedValue(textResponse(JSON.stringify({ detail: "Not found." }), { ok: false, status: 404 }));

    const body = payload(await call("oral_arguments", { q: "miranda", include_transcript_status: true }));

    // The search itself still answers; a status check is an extra, not a gate.
    expect(body.returned).toBe(2);
    expect(body.results.map((r: any) => r.transcript_status)).toEqual(["CHECK_FAILED", "CHECK_FAILED"]);
    expect(String(body.note)).toContain("CHECK_FAILED");
    expect(String(body.note)).toContain("never that no transcript exists");
  });
});

describe("an unexpected response envelope", () => {
  // The contrast with "returns an empty result set cleanly" (opinion_search,
  // above) is the whole point: an empty `results` array is a real answer, a
  // body with no `results` array is not an answer at all, and a caseworker
  // reading "returned: 0" cannot tell them apart.
  it.each([
    ['{"detail":"ok"}', { detail: "ok" }],
    ["a bare array", [{ caseName: "x" }]],
    ["a JSON string", "results"],
    ["null", null],
  ])("surfaces %s as an error rather than zero matches", async (_label, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body));
    const res: any = await call("opinion_search", { q: "eviction" });

    expect(res.isError).toBe(true);
    const text = res.content[0].text as string;
    expect(text).toMatch(/unexpected (envelope|body)/i);
    expect(text).toContain("opinion_search");
    expect(text).not.toMatch(/returned.*0/);
  });

  it("names the keys it actually received, so the change is diagnosable", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ count: 3, items: [], cursor: null }));
    const res: any = await call("docket_lookup", { q: "eviction" });
    const text = res.content[0].text as string;
    expect(text).toContain("count, items, cursor");
    expect(text).toContain("docket_lookup");
  });

  it("is not retried — a changed shape answers the same however often it is asked", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "ok" }));
    await call("opinion_search", { q: "x" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("every list and search tool refuses the same body", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["opinion_search", { q: "x" }],
      ["docket_lookup", { q: "x" }],
      ["court_list", { jurisdiction: "F" }],
      ["judge_lookup", { name_last: "Ginsburg" }],
      ["cited_by", { opinion_id: 5 }],
      ["case_authorities", { opinion_id: 5 }],
      ["docket_entries", { docket_id: 5 }],
      ["oral_arguments", { q: "x" }],
    ];
    for (const [tool, args] of calls) {
      clearClCache();
      __test.resetCourtCache();
      fetchMock.mockResolvedValue(jsonResponse({ detail: "ok" }));
      const res: any = await call(tool, args);
      expect(res.isError, `${tool} must refuse a body with no results array`).toBe(true);
      expect(res.content[0].text, tool).toContain(tool);
    }
  });

  // The response cache sat above the validation: clGet wrote every HTTP success
  // to it before any caller looked at the body, so the round that turned an
  // unexpected envelope into a thrown error also gave the cache something to
  // pin. One bad body then answered every identical query for CL_CACHE_TTL_MS
  // — 24 hours by default — with no network call, long after CourtListener had
  // gone back to normal.
  it("is never cached, so recovery upstream is visible immediately", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "ok" }));
    const first: any = await call("opinion_search", { q: "eviction" });
    expect(first.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Same arguments, so a cached entry would be served here instead.
    fetchMock.mockResolvedValue(jsonResponse(SEARCH_OPINION));
    const second: any = await call("opinion_search", { q: "eviction" });
    expect(second.isError, "the bad body was pinned in the cache").toBeFalsy();
    expect(fetchMock, "the repeat query never reached the network").toHaveBeenCalledTimes(2);
    expect(payload(second).returned).toBe(1);
  });

  it("a good body is still cached — the fix must not disable the cache", async () => {
    fetchMock.mockResolvedValue(jsonResponse(SEARCH_OPINION));
    await call("opinion_search", { q: "cacheable" });
    await call("opinion_search", { q: "cacheable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("citation_lookup still accepts its bare-array response, which is its real shape", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(CITATION_LOOKUP_MIXED));
    const body = payload(await call("citation_lookup", { text: "410 U.S. 113 and 999 U.S. 9999" }));
    expect(body.citations_checked).toBe(2);
  });

  // The contrast with the test above is the point: an enveloped body used to
  // coerce to [] and render byte-identically to a document containing no
  // citations at all — in the one tool built to catch a fabricated cite.
  it("citation_lookup refuses an enveloped response instead of reading it as no citations", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ count: 2, results: [{ citation: "410 U.S. 113", status: 200 }] }),
    );
    const res: any = await call("citation_lookup", { text: "See Roe v. Wade, 410 U.S. 113 (1973)." });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/unexpected body for citation_lookup/i);
    // The property that matters is that no success payload is produced: the
    // old coercion answered with citations_checked 0 / found 0 / results [],
    // byte-identical to a document that cites nothing.
    expect(res.content[0].text).not.toMatch(/citations_checked/);
  });

  it("citation_lookup refuses a null body rather than reporting a clean document", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(null));
    const res: any = await call("citation_lookup", { text: "See Roe v. Wade, 410 U.S. 113 (1973)." });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/got null/i);
  });
});

describe("a rejected token", () => {
  // token() writes careful setup guidance when COURTLISTENER_API_TOKEN is
  // UNSET. optionalToken() checks truthiness only, so a wrong, expired, or
  // quote/newline-mangled value passes, goes out on the wire, and the user who
  // completed the setup step is handed DRF's bare "Invalid token."
  it("a 401 WITH a token attached names the variable and the regeneration step", async () => {
    process.env.COURTLISTENER_API_TOKEN = "stale-token-value";
    fetchMock.mockResolvedValue(
      textResponse(JSON.stringify({ detail: "Invalid token." }), { ok: false, status: 401 }),
    );

    const res: any = await call("opinion_search", { q: "miranda" });
    const text = res.content[0].text as string;

    expect(res.isError).toBe(true);
    expect(text).toContain("401");
    expect(text).toContain("Invalid token.");
    expect(text).toContain("COURTLISTENER_API_TOKEN");
    expect(text).toMatch(/regenerate/i);
    // The token is never echoed, whole or in part.
    expect(text).not.toContain("stale-token-value");
    expect(text).not.toContain("stale-token");
    // A 401 is not a wobble: it is not retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 401 with NO token attached is left as the plain upstream error", async () => {
    delete process.env.COURTLISTENER_API_TOKEN;
    fetchMock.mockResolvedValue(
      textResponse(JSON.stringify({ detail: "Authentication credentials were not provided." }), {
        ok: false,
        status: 401,
      }),
    );

    const res: any = await call("opinion_search", { q: "miranda" });
    const text = res.content[0].text as string;

    expect(res.isError).toBe(true);
    expect(text).not.toMatch(/regenerate/i);
    expect(text).not.toMatch(/token WAS sent/i);
  });

  it("the POST path carries the same guidance", async () => {
    process.env.COURTLISTENER_API_TOKEN = "stale-token-value";
    fetchMock.mockResolvedValue(
      textResponse(JSON.stringify({ detail: "Invalid token." }), { ok: false, status: 401 }),
    );

    const res: any = await call("citation_lookup", { text: "410 U.S. 113" });
    const text = res.content[0].text as string;

    expect(lastInit().method).toBe("POST");
    expect(text).toContain("COURTLISTENER_API_TOKEN");
    expect(text).toMatch(/regenerate/i);
    expect(text).not.toContain("stale-token-value");
  });
});

// The .mcpb manifest declares ${user_config.courtlistener_api_token} for an
// OPTIONAL field. The bundle probe models a host that drops the entry when the
// user leaves it blank; nothing in the mcpb package documents that a host must.
// A host that substitutes nothing sends the placeholder verbatim.
describe("an unsubstituted user_config placeholder is not a token", () => {
  const PLACEHOLDER = "${user_config.courtlistener_api_token}";

  it("is not sent as an Authorization header", async () => {
    process.env.COURTLISTENER_API_TOKEN = PLACEHOLDER;
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_OPINION));

    const res: any = await call("opinion_search", { q: "miranda" });

    expect(res.isError).toBeFalsy();
    // Sending it 401s every keyless tool — and the 401 branch would then tell
    // the user their token is stale when they never set one.
    expect(lastInit().headers.Authorization).toBeUndefined();
  });

  it("makes a token-gated tool report the setup step, not a 401", async () => {
    process.env.COURTLISTENER_API_TOKEN = PLACEHOLDER;

    const res: any = await call("case_detail", { id: 109881 });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("COURTLISTENER_API_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a real token is still attached — the guard matches only a bare placeholder", async () => {
    for (const value of ["abc123", "${partial", "x${user_config.courtlistener_api_token}"]) {
      clearClCache();
      process.env.COURTLISTENER_API_TOKEN = value;
      fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_OPINION));
      await call("opinion_search", { q: `token-${value}` });
      expect(lastInit().headers.Authorization, value).toBe(`Token ${value}`);
    }
  });
});

describe("positive-integer id validation", () => {
  // Four tools interpolate a caller-supplied id into the request path or a
  // fielded operator, and all four run the same guard (== null ||
  // !Number.isInteger(x) || x <= 0). Only two of them were tested, and
  // cited_by's one case passed a STRING, which num() rejects before the
  // integer branch is ever reached — so dropping `<= 0` or the isInteger check
  // from cited_by, case_authorities or docket_entries would have shipped with
  // the suite green. The table is the population: every id-taking tool, every
  // way the guard can be wrong.
  const ID_TOOLS: Array<[string, string]> = [
    ["case_detail", "id"],
    ["cited_by", "opinion_id"],
    ["case_authorities", "opinion_id"],
    ["docket_entries", "docket_id"],
  ];

  it.each(ID_TOOLS)("%s rejects a bad %s before any network call", async (tool, field) => {
    for (const bad of [-5, 1.5, 0, "not-a-number", null, undefined]) {
      fetchMock.mockClear();
      const res: any = await call(tool, { [field]: bad });
      expect(res.isError, `${tool} accepted ${field}=${JSON.stringify(bad)}`).toBe(true);
      expect(res.content[0].text, `${tool} ${field}=${JSON.stringify(bad)}`).toMatch(/positive/i);
      expect(fetchMock, `${tool} sent a request for ${field}=${JSON.stringify(bad)}`).not.toHaveBeenCalled();
    }
  });

  it.each(ID_TOOLS)("%s accepts a valid %s", async (tool, field) => {
    // `id: 5` is here because case_detail reads a DETAIL endpoint: the body
    // must be the record that was asked for, not a list envelope. This mock
    // used to be the bare envelope and the comment called the all-null result
    // "a thin but valid record" — which is what expectDetail now refuses.
    fetchMock.mockResolvedValue(jsonResponse({ id: 5, count: 0, next: null, results: [] }));
    const res: any = await call(tool, { [field]: 5 });
    expect(res.isError, `${tool} rejected a valid ${field}`).toBeFalsy();
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("a detail endpoint must answer with the record that was asked for", () => {
  // The list/search envelope has extractResults; the detail endpoints had
  // nothing, so a body carrying no matching id normalized to a record whose
  // every field is null and went back as a success. A case with no name, no
  // date and no citations is a missing record, not a thin one.
  const BAD_BODIES: Array<[string, unknown]> = [
    ["a list envelope", { count: 0, next: null, results: [] }],
    ["a 200-served error object", { detail: "Not found." }],
    ["an array", [{ id: 5 }]],
    ["null", null],
    ["another record's id", { id: 99, case_name: "Some Other Case" }],
  ];

  it.each(BAD_BODIES)("case_detail (cluster) refuses %s", async (_label, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    const res: any = await call("case_detail", { id: 5 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/expected the record with id 5/i);
  });

  it.each(BAD_BODIES)("case_detail (opinion) refuses %s", async (_label, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    const res: any = await call("case_detail", { id: 5, type: "opinion" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/expected the record with id 5/i);
  });

  it.each(BAD_BODIES)("oral_argument_transcript refuses %s", async (_label, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    const res: any = await call("oral_argument_transcript", { audio_id: 5 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/expected the record with id 5/i);
  });

  it("a null body is named as null, not as a raw property-access crash", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(null));
    const res: any = await call("oral_argument_transcript", { audio_id: 5 });
    expect(res.content[0].text).toMatch(/got null/i);
    expect(res.content[0].text).not.toMatch(/Cannot read properties/i);
  });

  it("the real records still pass — the check must not refuse a good body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(CLUSTER));
    const body = payload(await call("case_detail", { id: 9335501 }));
    expect(body.case_name).toBe("Miranda v. Selig");
  });

  // The cases above all run under beforeEach(clearClCache), so they could not
  // see the other half: expectDetail ran at the CALL SITE, after clGet had
  // already written the bad body to a 24h cache, and the repeat call answered
  // the pinned error with no request at all. These do not clear the cache
  // mid-test, which is the whole point.
  it.each([
    ["case_detail", { id: 9335501 }, jsonResponse(CLUSTER), (b: any) => expect(b.case_name).toBe("Miranda v. Selig")],
    [
      "oral_argument_transcript",
      { audio_id: 106247 },
      jsonResponse(audioRecord()),
      (b: any) => expect(b.stt_verdict).toBe("COMPLETE"),
    ],
  ] as Array<[string, Record<string, unknown>, unknown, (b: any) => void]>)(
    "%s does not cache a bad detail body — the repeat call still asks upstream",
    async (tool, args, goodResponse, assertGood) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "Not found." }));
      const bad: any = await call(tool, args);
      expect(bad.isError).toBe(true);
      const afterBad = fetchMock.mock.calls.length;
      expect(afterBad).toBe(1);

      // Upstream recovers. The identical call must reach it, not the pin.
      fetchMock.mockResolvedValueOnce(goodResponse);
      const good: any = await call(tool, args);
      expect(good.isError).toBeFalsy();
      expect(fetchMock.mock.calls.length).toBeGreaterThan(afterBad);
      assertGood(payload(good));
    },
  );
});

describe("court_list cache", () => {
  it("a complete unfiltered walk is cached; the next filtered call fetches nothing", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        count: 2,
        next: null,
        results: [
          { id: "scotus", full_name: "Supreme Court of the United States", jurisdiction: "F", in_use: true },
          { id: "nysd", full_name: "Southern District of New York", jurisdiction: "FD", in_use: true },
        ],
      }),
    );
    // Name filter forces a full-table walk; the single mocked page has no `next`,
    // so the walk is complete and cacheable.
    const first = payload(await call("court_list", { q: "supreme" }));
    expect(first.returned).toBe(1);
    const callsAfterFirst = fetchMock.mock.calls.length;

    const second = payload(await call("court_list", { q: "york" }));
    expect(second.returned).toBe(1);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // served from cache
  });
});


describe("ux fixes 1.1.1", () => {
  it("citation_lookup always carries the unrecognized-reporter coverage note", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const body = payload(await call("citation_lookup", { text: "totally uncited prose" }));
    expect(String(body.coverage_note)).toContain("unrecognized or invented reporter");
    expect(body.all_verified).toBe(false); // zero recognized is never a pass
  });

  it("docket_entries with no reported count says so instead of a bare null", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ next: null, results: [{ id: 1, entry_number: 1, date_filed: "2024-01-01", description: "x", recap_documents: [] }] }));
    const body = payload(await call("docket_entries", { docket_id: 5 }));
    expect(body.total_entries).toBeNull();
    expect(body.total_reported).toBe(false);
    expect(body.returned).toBe(1);
  });

  it("oral_arguments order_by newest maps to dateArgued desc", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 1, next: null, results: [] }));
    await call("oral_arguments", { q: "miranda", order_by: "newest" });
    expect(lastUrl().searchParams.get("order_by")).toBe("dateArgued desc");
  });
});

describe("a limit below the page size loses rows the cursor then skips", () => {
  // next_cursor is taken from the full envelope, so it begins at the row after
  // the whole PAGE. With limit 3 of a 20-row page, seventeen matches are gone
  // and the `cursor` argument's own description tells the caller to page
  // exactly that way.
  const page = (n: number, row: Record<string, unknown>) =>
    jsonResponse({
      count: 999,
      next: "https://www.courtlistener.com/api/rest/v4/search/?cursor=nextpage",
      results: Array.from({ length: n }, (_, i) => ({ ...row, cluster_id: 100 + i, docket_id: 200 + i })),
    });

  const CASES: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["opinion_search", { q: "eviction", limit: 3 }, { caseName: "A", court_id: "ny", opinions: [{ id: 5 }] }],
    ["docket_lookup", { q: "eviction", limit: 3 }, { caseName: "A", court_id: "ny" }],
    ["cited_by", { opinion_id: 2812209, limit: 3 }, { caseName: "A", court_id: "ny", opinions: [{ id: 5 }] }],
    ["oral_arguments", { q: "miranda", limit: 3 }, { caseName: "A", court_id: "ny", id: 7 }],
  ];

  it.each(CASES)("%s reports the rows limit dropped", async (tool, args, row) => {
    fetchMock.mockResolvedValueOnce(page(20, row));
    const body = payload(await call(tool, args));
    expect(body.returned).toBe(3);
    expect(body.dropped_from_this_page, `${tool} did not report dropped rows`).toBe(17);
    expect(String(body.note)).toMatch(/skips the 17 dropped row/i);
    expect(body.next_cursor).toBe("nextpage");
  });

  it.each(CASES)("%s says nothing when the whole page fits", async (tool, args, row) => {
    fetchMock.mockResolvedValueOnce(page(3, row));
    const body = payload(await call(tool, args));
    expect(body.dropped_from_this_page).toBe(0);
    expect(String(body.note ?? "")).not.toMatch(/dropped row/i);
  });
});

describe("response cache", () => {
  // Case law is immutable, so a repeat lookup in one session is a settled
  // question. CourtListener runs on donated infrastructure, which makes not
  // re-asking a courtesy as well as a speedup.
  it("serves a repeated search without a second request", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ count: 0, results: [] }));
    await call("opinion_search", { q: "roe" });
    await call("opinion_search", { q: "roe" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a different query as a different key", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ count: 0, results: [] }));
    await call("opinion_search", { q: "roe" });
    await call("opinion_search", { q: "miranda" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure", async () => {
    fetchMock.mockResolvedValue(textResponse("boom", { ok: false, status: 500 }));
    const bad: any = await call("opinion_search", { q: "roe" });
    expect(bad.isError).toBe(true);
    const after = fetchMock.mock.calls.length;
    fetchMock.mockResolvedValue(jsonResponse({ count: 0, results: [] }));
    const good: any = await call("opinion_search", { q: "roe" });
    expect(good.isError).toBeFalsy();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(after);
  });
});
