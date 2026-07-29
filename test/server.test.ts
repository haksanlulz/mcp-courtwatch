import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";

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

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  process.env.COURTLISTENER_API_TOKEN = "test-token";

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
  it("lists exactly the six documented tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "case_detail",
      "citation_lookup",
      "court_list",
      "docket_lookup",
      "judge_lookup",
      "opinion_search",
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

  it("surfaces an HTTP 500 and a non-JSON page as isError", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("upstream boom", { ok: false, status: 500 }));
    const res500: any = await call("opinion_search", { q: "x" });
    expect(res500.isError).toBe(true);
    expect(res500.content[0].text).toContain("500");

    fetchMock.mockResolvedValueOnce(textResponse("<html>maintenance</html>"));
    const resHtml: any = await call("opinion_search", { q: "x" });
    expect(resHtml.isError).toBe(true);
    expect(resHtml.content[0].text).toContain("non-JSON");
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
});
