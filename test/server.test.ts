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

const COURTS = {
  count: 3359,
  next: "https://www.courtlistener.com/api/rest/v4/courts/?cursor=ghi",
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

/** The request init (headers, etc.) passed to the most recent fetch call. */
function lastInit(): { headers: Record<string, string> } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return call[1] as { headers: Record<string, string> };
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
  it("lists exactly the five documented tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "case_detail",
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

  it("applies the q substring filter client-side to the page", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(COURTS));
    const body = payload(await call("court_list", { q: "ninth circuit" }));
    expect(body.returned).toBe(1);
    expect(body.courts[0].id).toBe("ca9");
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

describe("unknown tool", () => {
  it("rejects with a protocol error", async () => {
    await expect(call("does_not_exist", {})).rejects.toThrow();
  });
});
