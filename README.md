# mcp-courtwatch

MCP server for free U.S. case-law and court-docket search, over [CourtListener](https://www.courtlistener.com/) (the [Free Law Project](https://free.law/)'s open legal database). Built for legal-aid orgs, tenant-defense and pro-se litigants, and public-interest lawyers who cannot afford Westlaw or PACER.

It wraps CourtListener's REST API v4, normalizing the raw JSON (`caseName`, `dateFiled`, `cluster_id`, `docket_absolute_url`, and so on) into clean, documented tool outputs.

## Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `opinion_search` | `q` (required), `court`, `filed_after`, `filed_before`, `order_by`, `limit` | Full-text case-law search (`/search/?type=o`). Per hit: case name, court, date filed, citations, docket number, snippet, citation count, cluster id, link. |
| `docket_lookup` | `q` and/or `docket_number` (at least one), `court`, `limit` | Docket search (`/search/?type=r`). Per hit: case name, court, docket number, filed/terminated dates, nature of suit, docket id, link. |
| `court_list` | `jurisdiction`, `q`, `limit` | Courts and their ids (`/courts/`), the values used as the `court` filter above. Optional jurisdiction filter and client-side name substring filter. |
| `case_detail` | `id` (required), `type` (`cluster` or `opinion`) | Full case by id. A cluster (`/clusters/{id}/`) gives case name, citations, date, judges, and its opinion ids. An opinion (`/opinions/{id}/`) gives the full opinion text. Requires a token. |
| `judge_lookup` | `name_last` and/or `name_first` (at least one), `limit` | Judges / people (`/people/`). Per person: id, assembled name, birth and death dates and place, gender, count of positions on file. |

`order_by` for `opinion_search` is one of `relevance` (default), `newest`, `oldest`, `most_cited`. Court `jurisdiction` codes include `F` (federal appellate and other), `FD` (federal district), `FB` (bankruptcy), `S` (state), `SA` (state appellate), `SS` (state supreme).

## Data source

- Base URL: `https://www.courtlistener.com/api/rest/v4`
- Auth: a free API token, sent as the header `Authorization: Token <token>`.
- Envelope: search and list endpoints return the DRF shape `{ count, next, previous, results: [...] }` with cursor pagination. Detail endpoints return a bare object.
- Access: `/search/`, `/courts/`, and `/people/` answer without a token at a low rate limit, so those tools attach the token only when it is set (a token raises the limit). `/clusters/{id}/` and `/opinions/{id}/` return HTTP 401 without a token, so `case_detail` requires one.

Sources:

- REST API v4 overview and auth: https://www.courtlistener.com/help/api/rest/ (redirects to https://wiki.free.law/c/courtlistener/help/api/rest/v4/overview)
- Search API (params, `type` enum, response fields): https://www.courtlistener.com/help/api/rest/search/ (redirects to https://wiki.free.law/c/courtlistener/help/api/rest/v4/search)
- Case Law API (clusters, opinions): https://www.courtlistener.com/help/api/rest/case-law/ (redirects to https://wiki.free.law/c/courtlistener/help/api/rest/v4/case-law)
- The live API itself, for the search / courts / people field names: `/search/?type=o`, `/search/?type=r`, `/courts/`, `/people/` (all answer unauthenticated GETs).

### Field map (CourtListener to normalized output)

| CourtListener field | Normalized field | Where |
|---------------------|------------------|-------|
| `caseName` (fallback `caseNameFull`) | `case_name` | opinion_search, docket_lookup |
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

## Install

No build step. Runs directly on [tsx](https://github.com/privatenumber/tsx).

```
git clone https://github.com/haksanlulz/mcp-courtwatch.git
cd mcp-courtwatch
npm install
```

## API token

`case_detail` needs a free CourtListener token, and the other tools run faster (higher rate limit) with one. Create a free account, open Profile then the API page, and copy the token. Docs: https://www.courtlistener.com/help/api/rest/

Expose it as `COURTLISTENER_API_TOKEN`:

```
export COURTLISTENER_API_TOKEN=your-token-here   # macOS / Linux
setx COURTLISTENER_API_TOKEN your-token-here      # Windows (new shells)
```

Without the token, `opinion_search`, `docket_lookup`, `court_list`, and `judge_lookup` still work at CourtListener's unauthenticated rate limit. `case_detail` returns a clear error telling you to set the token. The token is never logged.

## MCP client config

Point your MCP client at `index.ts` via tsx. Use an absolute path.

```json
{
  "mcpServers": {
    "courtwatch": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-courtwatch/index.ts"],
      "env": { "COURTLISTENER_API_TOKEN": "your-token-here" }
    }
  }
}
```

## Example

Call `opinion_search` with `{ "q": "warrantless search", "court": "scotus", "order_by": "most_cited", "limit": 1 }`:

```json
{
  "query": { "q": "warrantless search", "court": "scotus", "filed_after": null, "filed_before": null, "order_by": "most_cited" },
  "total_matches": 630,
  "returned": 1,
  "results": [
    {
      "case_name": "Miranda v. Selig",
      "court": "Supreme Court of the United States",
      "court_id": "scotus",
      "date_filed": "2017-12-04",
      "citations": ["138 S. Ct. 507", "199 L. Ed. 2d 386"],
      "docket_number": "17-453",
      "cite_count": 3,
      "status": "Published",
      "snippet": "The Fifth Amendment privilege ...",
      "cluster_id": 9335501,
      "docket_id": 66645415,
      "absolute_url": "https://www.courtlistener.com/opinion/9335501/miranda-v-selig/"
    }
  ]
}
```

Then pass the `cluster_id` to `case_detail` (`{ "id": 9335501 }`) for the citations, judges, and opinion ids, or `case_detail` with `{ "id": <opinion id>, "type": "opinion" }` for the full opinion text.

## Caveats

Built without a token, so:

- The `case_detail` field names (cluster and opinion objects) come from the Case Law API docs plus the search-result shape, not from a live authenticated GET (the `/clusters/` and `/opinions/` endpoints return HTTP 401 without a token). The normalizer is defensive: unknown or missing values coerce to `null` (or empty arrays) rather than throwing, and citations accept either string or object form. Run `npm run smoke` with a real token to confirm these end to end.
- `docket_number` is folded into the free-text `q` term rather than sent as a dedicated field, so matching is best-effort. If a known docket number under-returns, also pass the case name in `q`.
- `court_list` applies its `q` name filter client-side to the fetched page. Narrow by `jurisdiction` if an expected court is missing from the page.
- `opinion_search` and `docket_lookup` return the first page of results (up to `limit`); deep pagination via the cursor is not exposed. Refine the query to narrow instead.
- The `order_by` values, the `court` / `filed_after` / `filed_before` filters, and the search / courts / people field names match the live API. The token-gated behavior of `case_detail` is the main thing the keyed smoke should confirm.

## Develop

```
npm test         # vitest, fetch mocked with the documented response shapes (no token needed)
npm run smoke    # one live call per tool (needs COURTLISTENER_API_TOKEN; skips cleanly without)
npm run typecheck
```

## License

MIT. See [LICENSE](LICENSE). Data from CourtListener / the Free Law Project (public court records and openly licensed legal data). Unofficial, not affiliated with CourtListener or the Free Law Project.
