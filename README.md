# mcp-courtwatch

MCP server for free U.S. case-law and court-docket search, over [CourtListener](https://www.courtlistener.com/) (the [Free Law Project](https://free.law/)'s open legal database). Built for legal-aid orgs, tenant-defense and pro-se litigants, and public-interest lawyers who cannot afford Westlaw or PACER.

It wraps CourtListener's REST API v4, normalizing the raw JSON (`caseName`, `dateFiled`, `cluster_id`, `docket_absolute_url`, and so on) rather than passing the envelope through — see the field map below.

## Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `opinion_search` | `q` (required), `court`, `filed_after`, `filed_before`, `order_by`, `limit`, `cursor` | Full-text case-law search (`/search/?type=o`). Per hit: case name, court, date filed, citations, docket number, snippet, citation count, cluster id, link, and `opinions` — the `{id, type}` of each opinion in the case, which is the keyless input to `cited_by`. Also returns `next_cursor` (pass it back as `cursor` for the next page). |
| `docket_lookup` | `q` and/or `docket_number` (at least one), `court`, `limit`, `cursor` | Docket search (`/search/?type=r`). Per hit: case name, court, docket number, filed/terminated dates, nature of suit, docket id, link. Also returns `next_cursor` (pass it back as `cursor` for the next page). |
| `court_list` | `jurisdiction`, `q`, `limit` | Courts and their ids (`/courts/`), the values used as the `court` filter above. Optional jurisdiction filter and a name substring filter applied across the full courts table (paged server-side). |
| `case_detail` | `id` (required), `type` (`cluster` or `opinion`) | Full case by id. A cluster (`/clusters/{id}/`) gives case name, citations, date, judges, and its opinion ids. An opinion (`/opinions/{id}/`) gives the full opinion text. Requires a token. |
| `citation_lookup` | `text` (required) | Verify citations (`POST /citation-lookup/`). Pass free text (a brief, a draft) or a single citation string; every citation recognized is checked against the database of real cases. Per citation: `FOUND` (with matched case name, date, link) or an explicit `NOT_FOUND` / `UNKNOWN_REPORTER` flag. Requires a token. |
| `judge_lookup` | `name_last` and/or `name_first` (at least one), `limit` | Judges / people (`/people/`). Per person: id, assembled name, birth and death dates and place, gender, count of positions on file. |
| `cited_by` | `opinion_id` (required), `order_by`, `limit`, `cursor` | Every opinion citing a given opinion, via the `cites:()` search operator — a free citator check (who still relies on this case). Newest-first by default. No treatment classification. Keyless, and the id comes from `opinion_search`'s `opinions[].id` so the whole chain works without a token (`case_detail`'s `sub_opinion_ids` is the token-gated alternative). |
| `case_authorities` | `opinion_id` (required), `limit` | The authorities an opinion relies on (its table of authorities) with a per-authority citation depth, via `/opinions-cited/`. Token required. |
| `docket_entries` | `docket_id` (required), `limit`, `cursor` | A federal docket's filing history from the RECAP archive: numbered entries, dates, descriptions, archived PACER documents with page counts and availability. Token required. RECAP holds what its users bought from PACER. |
| `oral_arguments` | `q` (required), `court`, `order_by` (relevance/newest/oldest), `argued_after`, `argued_before`, `include_transcript_status`, `limit`, `cursor` | Oral-argument audio search (`type=oa`): case, court, argue date, panel judges, duration, audio id, MP3 link, and `snippet` — an excerpt of the recording's **machine-generated Whisper transcript**, not a certified transcript, and 708 of CourtListener's audio records are flagged as transcripts that do not match their audio. Each row also carries `transcript_status`, which reads `NOT_CHECKED` unless `include_transcript_status` is set (that costs one extra request per row; see the caveats). Keyless. |
| `oral_argument_transcript` | `audio_id` (required), `offset`, `max_chars` | The recording's Whisper transcript text (`/audio/{id}/`), paged. Returns `stt_verdict` (CourtListener's own transcription status, mapped), `transcript_usable`, `transcript_chars`, `truncated`, `next_offset`, and `provenance`. Only a `COMPLETE` transcription returns text: one flagged `TRANSCRIPTION_DOES_NOT_MATCH_AUDIO` has text on the record and it is withheld here. Keyless. |

`order_by` for `opinion_search` is one of `relevance` (default), `newest`, `oldest`, `most_cited`. Court `jurisdiction` codes include `F` (federal appellate and other), `FD` (federal district), `FB` (bankruptcy), `S` (state), `SA` (state appellate), `SS` (state supreme).

## Data source

- Base URL: `https://www.courtlistener.com/api/rest/v4`
- Auth: a free API token, sent as the header `Authorization: Token <token>`.
- Envelope: search and list endpoints return the DRF shape `{ count, next, previous, results: [...] }`. `/search/` and `/people/` paginate by opaque `cursor`; `/courts/` paginates by page number (`?page=N`). Detail endpoints return a bare object. `POST /citation-lookup/` returns a bare JSON array (one item per citation recognized in the text).
- Access: `/search/`, `/courts/`, `/people/`, and `/audio/{id}/` answer without a token at a low rate limit, so those tools attach the token only when it is set (a token raises the limit). `/clusters/{id}/`, `/opinions/{id}/`, `/opinions-cited/`, `/docket-entries/`, and `POST /citation-lookup/` return HTTP 401 without a token, so `case_detail`, `citation_lookup`, `case_authorities`, and `docket_entries` require one. The `/docket-entries/` filter parameter is `docket` (not `docket_id` — the API answers 400 `unknown_params` otherwise; found live).
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
| `opinions[]` (`id`, `type`) | `opinions` (array of `{id, type}`) | opinion_search, cited_by |
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
| `count` on a `cites:()` search | `total_citing` (hits normalized exactly as opinion_search hits) | cited_by |
| `cited_opinion` / `citing_opinion` (resource URLs), `depth` | `cited_opinion_id`, `citing_opinion_id`, `depth` | case_authorities |
| `entry_number`, `date_filed`, `description`, `recap_documents[]` (`document_number`, `page_count`, `is_available`, `filepath_local`) | same names; `description_short` falls back to `short_description` | docket_entries |
| `dateArgued`, `dateReargued`, `judge`, `duration`, `id`, `download_url` | `date_argued`, `date_reargued`, `judges`, `duration_seconds`, `audio_id`, `download_url` | oral_arguments |
| `snippet` (the indexed text for `type=oa` IS the Whisper transcript, so this is machine speech-to-text, not a certified transcript — live 2026-09-14, audio 102928's 497-character snippet is byte-identical to the opening of its `stt_transcript`) | `snippet` | oral_arguments |
| `stt_status` (0-5) | `stt_verdict` (`TRANSCRIPTION_NEEDED`, `COMPLETE`, `TRANSCRIPTION_FAILED`, `TRANSCRIPTION_DOES_NOT_MATCH_AUDIO`, `AUDIO_FILE_TOO_BIG`, `AUDIO_FILE_MISSING`) + `transcript_usable`; on a search row, `transcript_status` | oral_argument_transcript, oral_arguments |
| `stt_source` (1 / 2) | `stt_source` (`OpenAI API whisper-1` / `self-hosted Whisper`) | oral_argument_transcript |
| `stt_transcript` | `text` (+ `transcript_chars`, `offset`, `returned_chars`, `truncated`, `next_offset`) | oral_argument_transcript |

## Install

**Bundle (.mcpb).** For a client that installs MCP bundles, build one and open it — no JSON to edit, and the API token is an optional field in the install dialog:

```bash
npm ci && npm run mcpb:pack     # writes build/mcp-courtwatch-<version>.mcpb
```

The bundle is self-contained (manifest, `dist/`, and the one runtime dependency) and runs `node dist/index.js`. `npm run verify:mcpb` packs it, unpacks it, launches it through the manifest's own `mcp_config` with no token in the environment, and checks that the tools it serves match the ones the manifest declares. CI runs that on every push.

**npm.** Nothing to clone. Point your MCP client at it and npm fetches it on first run:

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

`case_detail`, `citation_lookup`, `case_authorities`, and `docket_entries` need a free CourtListener token, and the other tools run faster (higher rate limit) with one. Create a free account, open Profile then the API page, and copy the token. Docs: https://www.courtlistener.com/help/api/rest/

Expose it as `COURTLISTENER_API_TOKEN`:

```
export COURTLISTENER_API_TOKEN=your-token-here   # macOS / Linux
setx COURTLISTENER_API_TOKEN your-token-here      # Windows (new shells)
```

Without the token, `opinion_search`, `docket_lookup`, `court_list`, `judge_lookup`, `cited_by`, `oral_arguments`, and `oral_argument_transcript` still work at CourtListener's unauthenticated rate limit. The token-gated tools return a clear error telling you to set the token. The token is never logged.

**New-account rate limit:** fresh CourtListener accounts are throttled at 5 requests/minute (it rises as the account ages). Until then, set `COURTWATCH_THROTTLE_MS=15000` in the server's env to pace requests under that limit — the default spacing is 200ms.

## Example

Call `opinion_search` with `{ "q": "warrantless search", "court": "scotus", "order_by": "most_cited", "limit": 1 }` (output captured live, 2026-09-14; counts drift as CourtListener grows):

```json
{
  "query": { "q": "warrantless search", "court": "scotus", "filed_after": null, "filed_before": null, "order_by": "most_cited", "cursor": null },
  "total_matches": 282,
  "returned": 1,
  "next_cursor": "cz01MTM2JnM9MTA4NTcxJnQ9byZkPTIwMjYtMDktMTQmcD0y",
  "results": [
    {
      "case_name": "Monell v. New York City Dept. of Social Servs.",
      "court": "Supreme Court of the United States",
      "court_id": "scotus",
      "date_filed": "1978-06-06",
      "citations": ["56 L. Ed. 2d 611", "98 S. Ct. 2018", "436 U.S. 658", "1978 U.S. LEXIS 100", "16 Empl. Prac. Dec. (CCH) 8345", "17 Fair Empl. Prac. Cas. (BNA) 873"],
      "docket_number": "75-1914",
      "cite_count": 42979,
      "status": "Published",
      "snippet": "\n436 U.S. 658 (1978)\nMONELL ET AL.\nv.\nDEPARTMENT OF SOCIAL SERVICES OF THE CITY OF NEW YORK ET AL.\nNo. 75-1914.\nSupreme Court of the United States. ...",
      "opinions": [{ "id": 109881, "type": "combined-opinion" }],
      "cluster_id": 109881,
      "docket_id": 266243,
      "absolute_url": "https://www.courtlistener.com/opinion/109881/monell-v-new-york-city-dept-of-social-servs/"
    }
  ],
  "disclaimer": "Raw public court records from CourtListener, reproduced as published. This is not legal advice and is not a substitute for a lawyer. Docket entries record filings, not rulings; the absence of a record is not evidence that nothing happened."
}
```

The `disclaimer` is attached to every response, in the payload rather than only in the tool description — a model composing an answer has the payload in hand and may no longer be holding the description.

Then pass the `cluster_id` to `case_detail` (`{ "id": 109881 }`) for the citations, judges, and opinion ids, or `case_detail` with `{ "id": <opinion id>, "type": "opinion" }` for the full opinion text. Both need a token. Without one, `opinions[0].id` from the hit above goes straight to `cited_by`. For the next page, pass `next_cursor` back as `cursor`.

## Example: verifying citations before filing

Courts have sanctioned filings built on citations that do not exist. Run a draft's citations through `citation_lookup` before filing.

Call `citation_lookup` with `{ "text": "Tenants are protected here. See Roe v. Wade, 410 U.S. 113 (1973); Smith v. Imaginary, 999 U.S. 9999 (2099)." }`. The output below is illustrative of the response shape (the live smoke runs this exact real-plus-fabricated check and fails unless the real one resolves and the fake flags `NOT_FOUND`):

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
  ],
  "disclaimer": "Raw public court records from CourtListener, reproduced as published. This is not legal advice and is not a substitute for a lawyer. Docket entries record filings, not rulings; the absence of a record is not evidence that nothing happened."
}
```

The fabricated citation comes back `NOT_FOUND` with a top-level `warning`. Per-citation `status` mirrors the API's own codes: `200` found, `300` found with multiple matching clusters (`FOUND_MULTIPLE` — a real citation, ambiguous mapping), `400` unknown reporter, `404` not found, `429` past the 250-citations-per-call cap (`NOT_CHECKED_OVER_CAP` — split the text and re-run the rest). A lookup that recognizes zero citations says so in a `note` instead of pretending to have verified anything.

**The blind spot to know about:** the extractor can only flag what it can recognize. `999 U.S. 9999` is caught (real reporter, fake volume: `NOT_FOUND`), but a cite with an *invented reporter* — live example `999 A.D.9th 999` — is not recognized as a citation at all, so it is neither counted nor flagged. Every response carries a `coverage_note` stating this; treat `all_verified` as covering recognized citations only.

## Worked example: is this tenant case still good law?

A caseworker is writing an intake note on a habitability defense in New York and needs the leading case plus some sign it is still being relied on. No token, no account, three tool calls. Every figure below was captured live on 2026-09-14 and will drift as CourtListener grows.

**1. Find the leading case.** `opinion_search` with `{ "q": "warranty of habitability eviction", "court": "ny", "order_by": "most_cited" }` → 8 results. The fields that matter from the first one:

| Field | Value |
|---|---|
| `case_name` | Park West Management Corp. v. Mitchell |
| `date_filed` | 1979-06-07 |
| `cite_count` | 393 |
| `cluster_id` | 5683523 |
| `opinions[0].id` | 5532217 (`lead-opinion`) |

`cite_count` is how many opinions cite it — the reason it sorts first under `most_cited`.

**2. Take the opinion id, not the cluster id.** `cited_by` wants an *opinion* id, and `opinions[0].id` above is it. `case_detail` would also give you one, in `sub_opinion_ids`, but that endpoint needs a token; the search hit does not.

**3. Ask who cites it.** `cited_by` with `{ "opinion_id": 5532217 }` → `total_citing` **174**, newest first:

| Field | Value |
|---|---|
| `total_citing` | 174 |
| `results[0].case_name` | Fiondella v. 345 W. 70th Tenants Corp. |
| `results[0].date_filed` | 2023-06-13 |
| `results[0].court_id` | nyappdiv |

What a caseworker can paste into an intake note:

> The leading New York case on the warranty of habitability is Park West Management Corp. v. Mitchell, decided 1979-06-07. As of 2026-09-14, CourtListener records 174 opinions citing it, the most recent being Fiondella v. 345 W. 70th Tenants Corp. (App. Div., 2023-06-13). That means the case is still being engaged with by New York courts. It does **not** mean those 174 opinions agreed with it: `cited_by` reports who cites a case, never whether they followed, distinguished, or criticized it. Read the citing opinions before relying on any of them, and confirm current law with a lawyer.

That last caveat is not decoration. It rides every `cited_by` response as a `note`, because the difference between "cited 174 times" and "good law 174 times" is the whole of a citator's value.

## Caveats and verification state

Every tool has been run live against the real API with a real token. `npm run smoke` makes one real call per tool, all eleven of them since 2026-09-14 — that is the day `oral_argument_transcript` got its own live check, which passed on audio 102928 (`COMPLETE`, 98,073 characters on the record); until then it was verified only by hand, against audio 106247 and 106047, byte-compared with a direct read of `/audio/<id>/`. Eleven checks in one run needs an account past CourtListener's hourly ceiling: the runs on this machine split across it, and the tools that did not answer read FAIL with the 429, never green (see the rate-limit note in the token section). Two contract facts were only discoverable live and are baked in: the `/docket-entries/` filter parameter is `docket` (an unauthenticated probe cannot see this, since auth is checked before params), and new-account rate limiting is 5 requests/minute (see the token section). Standing caveats that are properties of the API, not gaps in verification:

- **The citation checker has a structural blind spot, named in every payload.** It can only check citations whose reporter it recognizes. A fabricated cite with an invented reporter (live example: `999 A.D.9th 999`) is not recognized, not counted, and not flagged, so `all_verified: true` means "every recognized citation resolved" — never "nothing in this text is fake." Every `citation_lookup` response carries a `coverage_note` saying exactly this.
- The clusters returned by `citation_lookup` do not include the court (in CourtListener's model the court hangs off the docket, not the cluster). For the court, follow the match's `absolute_url` or pass its `cluster_id` to `case_detail`. Deliberately not auto-fetched: a 250-citation brief would fan out into hundreds of extra docket calls.
- A `docket_number` argument is sent through the fielded `docketNumber:"..."` search operator (live: 6 matches where the free-text form matched thousands). Combine with `q` for case-name context when a docket number alone under-returns.
- `court_list` with a name filter walks the full courts table one page at a time (the `/courts/` endpoint ignores `page_size`; ~3,400 courts over ~170 pages). A complete walk is cached in-process for 24 hours, so it happens at most once per day per server process; scope by `jurisdiction` to avoid it entirely. On a 5-req/min account, a full walk cannot finish inside one client timeout — filter by jurisdiction until the account limit rises.
- `opinion_search`, `docket_lookup`, `cited_by`, and `oral_arguments` return one fixed `/search/` page of ~20 results; for more, pass `next_cursor` back as `cursor`. The endpoint ignores `page_size`, so `limit` caps at 20 rather than advertising an unreachable number.
- `/docket-entries/` and `/opinions-cited/` use v4 cursor pagination, which DEFERS the total count rather than omitting it: `count` arrives as a URL string pointing at the same query with `?count=on`, so `total_entries` / `total_authorities` come back `null` with `total_reported: false` — that means "not reported here", never zero. Re-request the endpoint with `?count=on` for a real total. (Verified live 2026-09-14 on `/audio/?stt_status=3`: `count` was the literal `?count=on` URL, and that URL returned `{"count": 708}`.)
- **Oral-argument transcripts are machine speech-to-text, and CourtListener says so per record.** `stt_status` is an enum, not a flag, and its failure values are not rare: of 103,278 audio records on 2026-09-14, 708 were status 3 (`TRANSCRIPTION_DOES_NOT_MATCH_AUDIO` — a Whisper hallucination), 154 status 4 (file over the 25 MB limit), 77 status 5 (no audio file), 46 status 2 (failed) and 16 status 0 (not yet transcribed). `oral_argument_transcript` maps the enum to a named `stt_verdict` and returns text only for a completed transcription; a status-3 record still carries text and it is withheld rather than presented as a transcript (audio 106047 holds 9,450 characters that are the case caption repeated over and over). Every response carries `provenance` saying the text is Whisper output, not a court reporter's certified transcript. Enum names and numbers from the vendor source, `cl/audio/models.py`.
- Transcripts are too long to ride a search result, so they are paged: a 6,385-second SCOTUS argument (audio 104586) is 101,707 characters, a 1,051-second circuit argument (audio 106247) is 13,974 (both measured live 2026-09-14). `max_chars` defaults to 15,000 and caps at 50,000; a truncated page reports `truncated: true` and a `next_offset` to resume from.
- `oral_arguments`' `transcript_status` is `NOT_CHECKED` unless you pass `include_transcript_status`, which costs **one extra API request per result row**. The search index does not carry `stt_status`, and `/audio/` has no batch id filter — `?id__in=` is rejected as an unknown parameter (the vendor's `AudioFilter` gives `id` the `INTEGER_LOOKUPS` set, which has no `in`). On a 5-request/minute account, lower `limit` before turning it on. A check that fails reads `CHECK_FAILED`, which means not looked up, never that no transcript exists.

## Testing

```
npm test           # offline: vitest, fetch mocked with the documented response shapes (no token needed)
npm run smoke      # live: one real call per tool (needs COURTLISTENER_API_TOKEN; skips cleanly without)
npm run typecheck
npm run verify:pack  # packs, installs into a temp project, spawns the bin shim over real stdio
npm run verify:mcpb  # packs the .mcpb, unpacks it, launches it through the manifest's own mcp_config
```

Two tiers, split by script rather than by marker. `npm test` is the offline suite; CI runs it plus `npm run typecheck`, `npm run build`, `npm run verify:pack` and `npm run verify:mcpb` (ci.yml jobs test, package, consume). `npm run smoke` is the live upstream contract, token-gated, and not run in CI.

Counts as of 2026-09-14: 106 tests in 4 files (`npm test`), 2313 lines of app source and packaging scripts, 1890 lines of test source.

```
find . -path ./node_modules -prune -o -path ./dist -prune -o -path ./build -prune -o -path ./test -prune -o \( -name '*.ts' -o -name '*.mjs' \) -print | grep -v smoke.ts | xargs wc -l
find test -name '*.test.ts' | xargs wc -l
```

What the tests cover, by layer. `test/server.test.ts` drives every tool through a real MCP client over an in-memory transport with `fetch` stubbed, and asserts the outgoing request (path, query params, Authorization header, POST body) and the normalized response shape, plus the retry policy (5xx and 429 retried three times, 4xx and non-JSON not retried), the response cache, the argument validators that must fail before any network call, and the two shapes that must never be confused with each other — an empty `results` array (a real answer) versus a body with no `results` array (an error). `test/throttle.test.ts` measures the outbound throttle against a fake clock, asserting call-START timestamps. `test/env-validation.test.ts` re-imports the server with a garbage `CL_HTTP_ATTEMPTS` / `CL_CACHE_TTL_MS` / `CL_CACHE_MAX` and asserts each falls back rather than poisoning arithmetic. `test/no-http-stack.test.ts` pins the dependency surface. The live smoke checks each tool once against the real API.

The offline suite runs with `COURTWATCH_THROTTLE_MS=0` (`vitest.config.ts`): `fetch` is stubbed, so paying the real 200ms outbound gap bought nothing but 14 seconds of sleeping.

Mutation probes (2026-09-14), each run and then reverted: restoring the bare `Number(process.env.CL_HTTP_ATTEMPTS ?? 3)` read turns 4 env-validation tests red; restoring `String(err)` in the CallTool catch turns the non-Error test red with *expected 'Error: undefined' not to be 'Error: undefined'*; restoring the permissive `extractResults` turns 6 of the 8 envelope tests red while leaving the legitimate-empty test green; neutering `throttled()` to a pass-through turns both throttle tests red; removing the transcript usability gate turns 8 transcript tests red; and pointing the manifest's `entry_point` at a file that exists but is not an entry point turns `verify:mcpb` red with *no initialize response*. The live smoke's verdict path was probed the same way: with every tool stubbed and `opinion_search` returning an empty page, it exits 1 reporting 8 passed / 1 failed / 1 skipped, where the earlier version printed two green lines.

The 35 `toHaveBeenCalled*` assertions each pin a named contract (no request leaves on a validation or missing-token error, retry count, cache hit, two-page walk, one status check per row). Policy: assert behavior and payloads, never merely that a function was called.

## AI assistance

This project was built with AI assistance (Claude). Correctness was established by the test suite and typecheck (`npm test`, `npm run typecheck`): every tool is driven through a real MCP client over an in-memory transport with `fetch` stubbed to the documented CourtListener response shapes, and the unauthenticated search / courts / people surfaces were additionally checked against the live API. As of 2026-08-23 every tool, including the token-gated four, has additionally been verified live with a real token (`npm run smoke`, plus persona-driven scenario probes that surfaced and fixed the `docket` filter-param and fake-reporter-coverage findings). The author is accountable for what ships here.

## License

MIT. See [LICENSE](LICENSE). Data from CourtListener / the Free Law Project (public court records and openly licensed legal data). Unofficial, not affiliated with CourtListener or the Free Law Project.
