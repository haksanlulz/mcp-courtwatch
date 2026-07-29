# mcp-courtwatch

MCP server for free U.S. case-law and court-docket search, over [CourtListener](https://www.courtlistener.com/) (the [Free Law Project](https://free.law/)'s open legal database). Built for legal-aid orgs, tenant-defense and pro-se litigants, and public-interest lawyers who cannot afford Westlaw or PACER.

It wraps CourtListener's REST API v4, normalizing the raw JSON (`caseName`, `dateFiled`, `cluster_id`, `docket_absolute_url`, and so on) rather than passing the envelope through — see the field map below.

## Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `opinion_search` | `q` (required), `court`, `filed_after`, `filed_before`, `order_by`, `limit`, `cursor` | Full-text case-law search (`/search/?type=o`). Per hit: case name, court, date filed, citations, docket number, snippet, citation count, cluster id, link. Also returns `next_cursor` (pass it back as `cursor` for the next page). |
| `docket_lookup` | `q` and/or `docket_number` (at least one), `court`, `limit`, `cursor` | Docket search (`/search/?type=r`). Per hit: case name, court, docket number, filed/terminated dates, nature of suit, docket id, link. Also returns `next_cursor` (pass it back as `cursor` for the next page). |
| `court_list` | `jurisdiction`, `q`, `limit` | Courts and their ids (`/courts/`), the values used as the `court` filter above. Optional jurisdiction filter and a name substring filter applied across the full courts table (paged server-side). |
| `case_detail` | `id` (required), `type` (`cluster` or `opinion`) | Full case by id. A cluster (`/clusters/{id}/`) gives case name, citations, date, judges, and its opinion ids. An opinion (`/opinions/{id}/`) gives the full opinion text. Requires a token. |
| `citation_lookup` | `text` (required) | Verify citations (`POST /citation-lookup/`). Pass free text (a brief, a draft) or a single citation string; every citation recognized is checked against the database of real cases. Per citation: `FOUND` (with matched case name, date, link) or an explicit `NOT_FOUND` / `UNKNOWN_REPORTER` flag. Requires a token. |
| `judge_lookup` | `name_last` and/or `name_first` (at least one), `limit` | Judges / people (`/people/`). Per person: id, assembled name, birth and death dates and place, gender, count of positions on file. |

`order_by` for `opinion_search` is one of `relevance` (default), `newest`, `oldest`, `most_cited`. Court `jurisdiction` codes include `F` (federal appellate and other), `FD` (federal district), `FB` (bankruptcy), `S` (state), `SA` (state appellate), `SS` (state supreme).

## Data source

- Base URL: `https://www.courtlistener.com/api/rest/v4`
- Auth: a free API token, sent as the header `Authorization: Token <token>`.
- Envelope: search and list endpoints return the DRF shape `{ count, next, previous, results: [...] }`. `/search/` and `/people/` paginate by opaque `cursor`; `/courts/` paginates by page number (`?page=N`). Detail endpoints return a bare object. `POST /citation-lookup/` returns a bare JSON array (one item per citation recognized in the text).
- Access: `/search/`, `/courts/`, and `/people/` answer without a token at a low rate limit, so those tools attach the token only when it is set (a token raises the limit). `/clusters/{id}/`, `/opinions/{id}/`, and `POST /citation-lookup/` return HTTP 401 without a token, so `case_detail` and `citation_lookup` require one.
- Citation-lookup limits (server-side): `text` max 64,000 characters (enforced pre-flight here with a clear error; the tool never truncates, since a dropped tail would mean unchecked citations); the first 250 citations per call are looked up and any beyond that come back flagged per-item as not checked; rate limit 60 citations/min.

Sources:

- REST API v4 overview and auth: https://www.courtlistener.com/help/api/rest/ (redirects to https://wiki.free.law/c/courtlistener/help/api/rest/v4/overview)
- Search API (params, `type` enum, response fields): https://www.courtlistener.com/help/api/rest/search/ (redirects to https://wiki.free.law/c/courtlistener/help/api/rest/v4/search)
- Case Law API (clusters, opinions): https://www.courtlistener.com/help/api/rest/case-law/ (redirects to https://wiki.free.law/c/courtlistener/help/api/rest/v4/case-law)
- Citation Lookup API: https://www.courtlistener.com/help/api/rest/citation-lookup/ (redirects to https://wiki.free.law/c/courtlistener/help/api/rest/v4/citation-lookup), plus the endpoint's source in the CourtListener repo: `cl/citations/api_views.py` and `api_serializers.py` (request/response fields, per-citation status codes) and `cl/settings/project/citations.py` (the 250-citations-per-request cap). The endpoint returns HTTP 401 without a token.
- The live API itself, for the search / courts / people field names: `/search/?type=o`, `/search/?type=r`, `/courts/`, `/people/` (all answer unauthenticated GETs).

### Field map (CourtListener to normalized output)

| CourtListener field | Normalized field | Where |
|---------------------|------------------|-------|
| `caseName` (fallback: `caseNameFull` on opinion hits, `case_name_full` on docket hits) | `case_name` | opinion_search, docket_lookup |
| `court_id`, `court` | `court_id`, `court` | search hits |
| `dateFiled` | `date_filed` | search hits |
| `citation` (array) | `citations` | opinion_search |
| `docketNumber` | `docket_number` | search hits |
| `opinions[].snippet` | `snippet` | opinion_search |
| `cluster_id`, `docket_id` | `cluster_id`, `docket_id` | search hits |
| `absolute_url` / `docket_absolute_url` | `absolute_url` (made a full link) | search hits |
| `dateTerminated`, `suitNature` | `date_terminated`, `nature_of_suit` | docket_lookup |
| `id`, `full_name`, `short_name`, `jurisdiction`, `citation_string`, `url` | `id`, `full_name`, `short_name`, `jurisdiction`, `citation_string`, `website` | court_list |
| `citations` (array of `{volume, reporter, page}`) | `citations` (formatted strings) | case_detail (cluster) |
| `sub_opinions` (array of URLs) | `sub_opinion_ids` | case_detail (cluster) |
| `plain_text` (fallback `html_with_citations`) | `text` (+ `text_source`, `text_truncated`) | case_detail (opinion) |
| `citation`, `normalized_citations`, `start_index`, `end_index` | same names | citation_lookup (per citation) |
| `status` (200/300/400/404/429), `error_message` | `status` + `verdict` (`FOUND`, `FOUND_MULTIPLE`, `UNKNOWN_REPORTER`, `NOT_FOUND`, `NOT_CHECKED_OVER_CAP`) + `verified`, `error_message` | citation_lookup (per citation) |
| `clusters` (array of cluster objects) | `matches` (cluster id, case name, date, citations, link) | citation_lookup (per citation) |

## Install

Nothing to clone. Point your MCP client at it and npm fetches it on first run:

```json
{
  "mcpServers": {
    "courtwatch": {
      "command": "npx",
      "args": ["-y", "@haksanlulz/mcp-courtwatch"],
      "env": { "COURTLISTENER_API_TOKEN": "your-courtlistener-token" }
    }
  }
}
```

<details>
<summary>From source (contributors)</summary>

```bash
git clone https://github.com/haksanlulz/mcp-courtwatch
cd mcp-courtwatch
npm install
npm run build     # emits dist/; the published bin is dist/index.js
```

`npm start` runs the TypeScript directly via [`tsx`](https://github.com/privatenumber/tsx) without building.
</details>

## API token

`case_detail` and `citation_lookup` need a free CourtListener token, and the other tools run faster (higher rate limit) with one. Create a free account, open Profile then the API page, and copy the token. Docs: https://www.courtlistener.com/help/api/rest/

Expose it as `COURTLISTENER_API_TOKEN`:

```
export COURTLISTENER_API_TOKEN=your-token-here   # macOS / Linux
setx COURTLISTENER_API_TOKEN your-token-here      # Windows (new shells)
```

Without the token, `opinion_search`, `docket_lookup`, `court_list`, and `judge_lookup` still work at CourtListener's unauthenticated rate limit. `case_detail` and `citation_lookup` return a clear error telling you to set the token. The token is never logged.

## Example

Call `opinion_search` with `{ "q": "warrantless search", "court": "scotus", "order_by": "most_cited", "limit": 1 }` (output captured live, 2026-07; counts drift as CourtListener grows):

```json
{
  "query": { "q": "warrantless search", "court": "scotus", "filed_after": null, "filed_before": null, "order_by": "most_cited", "cursor": null },
  "total_matches": 282,
  "returned": 1,
  "next_cursor": "cz01MTI3JnM9MTA5NjkzJnQ9byZkPTIwMjYtMDctMTcmcD0y",
  "results": [
    {
      "case_name": "Monell v. New York City Dept. of Social Servs.",
      "court": "Supreme Court of the United States",
      "court_id": "scotus",
      "date_filed": "1978-06-06",
      "citations": ["56 L. Ed. 2d 611", "98 S. Ct. 2018", "436 U.S. 658", "1978 U.S. LEXIS 100", "16 Empl. Prac. Dec. (CCH) 8345", "17 Fair Empl. Prac. Cas. (BNA) 873"],
      "docket_number": "75-1914",
      "cite_count": 42298,
      "status": "Published",
      "snippet": "436 U.S. 658 (1978)\nMONELL ET AL.\nv.\nDEPARTMENT OF SOCIAL SERVICES OF THE CITY OF NEW YORK ET AL.\nNo. 75-1914.\nSupreme Court of the United States. ...",
      "cluster_id": 109881,
      "docket_id": 266243,
      "absolute_url": "https://www.courtlistener.com/opinion/109881/monell-v-new-york-city-dept-of-social-servs/"
    }
  ]
}
```

Then pass the `cluster_id` to `case_detail` (`{ "id": 109881 }`) for the citations, judges, and opinion ids, or `case_detail` with `{ "id": <opinion id>, "type": "opinion" }` for the full opinion text. For the next page, pass `next_cursor` back as `cursor`.

## Example: verifying citations before filing

Courts have sanctioned filings built on citations that do not exist. Run a draft's citations through `citation_lookup` before filing.

Call `citation_lookup` with `{ "text": "Tenants are protected here. See Roe v. Wade, 410 U.S. 113 (1973); Smith v. Imaginary, 999 U.S. 9999 (2099)." }`. This endpoint requires a token this repo was built without, so unlike the example above the output here is constructed from the documented response shape, not captured from a live call (see Caveats):

```json
{
  "query": { "text_chars": 107 },
  "citations_checked": 2,
  "found": 1,
  "not_found": 1,
  "invalid": 0,
  "not_checked": 0,
  "all_verified": false,
  "warning": "1 of 2 citation(s) did NOT verify: 1 not found in CourtListener (likely fabricated or mis-cited). Do not cite unverified authorities — check them by hand before filing.",
  "results": [
    {
      "citation": "410 U.S. 113",
      "verified": true,
      "verdict": "FOUND",
      "status": 200,
      "error_message": null,
      "normalized_citations": ["410 U.S. 113"],
      "start_index": 45,
      "end_index": 57,
      "matches": [
        {
          "cluster_id": 108713,
          "case_name": "Roe v. Wade",
          "date_filed": "1973-01-22",
          "citations": ["410 U.S. 113", "93 S. Ct. 705", "35 L. Ed. 2d 147"],
          "precedential_status": "Published",
          "citation_count": 12030,
          "judges": "Blackmun",
          "docket_id": 4463,
          "absolute_url": "https://www.courtlistener.com/opinion/108713/roe-v-wade/"
        }
      ]
    },
    {
      "citation": "999 U.S. 9999",
      "verified": false,
      "verdict": "NOT_FOUND",
      "status": 404,
      "error_message": "Citation not found: '999 U.S. 9999'",
      "normalized_citations": ["999 U.S. 9999"],
      "start_index": 86,
      "end_index": 99,
      "matches": []
    }
  ]
}
```

The fabricated citation comes back `NOT_FOUND` with a top-level `warning`. Per-citation `status` mirrors the API's own codes: `200` found, `300` found with multiple matching clusters (`FOUND_MULTIPLE` — a real citation, ambiguous mapping), `400` unknown reporter, `404` not found, `429` past the 250-citations-per-call cap (`NOT_CHECKED_OVER_CAP` — split the text and re-run the rest). A lookup that recognizes zero citations says so in a `note` instead of pretending to have verified anything.

## Caveats

Built without a token, so:

- The `case_detail` field names (cluster and opinion objects) come from the Case Law API docs plus the search-result shape, not from a live authenticated GET (the `/clusters/` and `/opinions/` endpoints return HTTP 401 without a token). The normalizer is defensive: unknown or missing values coerce to `null` (or empty arrays) rather than throwing, and citations accept either string or object form. Run `npm run smoke` with a real token to confirm these end to end.
- The `citation_lookup` response shape (per-citation fields, the 200/300/400/404/429 status codes, the serializer-level 64,000-char text cap, the 250-citation per-request cap) comes from the CourtListener source (`cl/citations/api_views.py`, `api_serializers.py`, `cl/settings/project/citations.py`) and the Citation Lookup docs, not from a live authenticated POST (the endpoint returns HTTP 401 without a token). The normalizer is defensive like the rest. Run `npm run smoke` with a token: it checks one real citation (`410 U.S. 113`, Roe v. Wade) plus one fabricated one and fails unless the real one resolves and the fake comes back `NOT_FOUND`.
- The clusters returned by `citation_lookup` do not include the court (in CourtListener's model the court hangs off the docket, not the cluster). For the court, follow the match's `absolute_url` or pass its `cluster_id` to `case_detail` and the `docket_id` onward. Deliberately not auto-fetched here: a 250-citation brief would fan out into hundreds of extra docket calls.
- `docket_number` is folded into the free-text `q` term rather than sent as a dedicated field, so matching is best-effort. If a known docket number under-returns, also pass the case name in `q`.
- `court_list` applies its `q` name filter across the full courts table, walked one page at a time server-side (the `/courts/` endpoint ignores `page_size`, so the ~3,400 courts span ~170 pages of ~20 up to a safety cap). Scope by `jurisdiction` to page less; a token is recommended for the unfiltered full-table scan.
- `opinion_search` and `docket_lookup` return one fixed `/search/` page of ~20 results; for more, pass the response's `next_cursor` back as the `cursor` argument. The endpoint ignores `page_size`, so `limit` cannot exceed one page (it is capped at 20 rather than advertising an unreachable number).
- The `order_by` values, the `court` / `filed_after` / `filed_before` filters, and the search / courts / people field names match the live API, as does the fixed ~20-row page size of `/search/` and `/courts/` (both ignore `page_size`). The token-gated behavior of `case_detail` is the main thing the keyed smoke should confirm.

## Develop

```
npm test         # vitest, fetch mocked with the documented response shapes (no token needed)
npm run smoke    # one live call per tool (needs COURTLISTENER_API_TOKEN; skips cleanly without)
npm run typecheck
```

## AI assistance

This project was built with AI assistance (Claude). Correctness was established by the test suite and typecheck (`npm test`, `npm run typecheck`): every tool is driven through a real MCP client over an in-memory transport with `fetch` stubbed to the documented CourtListener response shapes, and the unauthenticated search / courts / people surfaces were additionally checked against the live API. The token-gated endpoints are verified only to the extent the Caveats state, with `npm run smoke` as the live confirmation path. The author is accountable for what ships here.

## License

MIT. See [LICENSE](LICENSE). Data from CourtListener / the Free Law Project (public court records and openly licensed legal data). Unofficial, not affiliated with CourtListener or the Free Law Project.
