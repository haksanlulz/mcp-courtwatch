# Changelog

## 2.0.0 — prepared locally, 2026-11-26

**Breaking: every tool result now opens with a fixed label block.** `content[0]` is the text `[UNTRUSTED THIRD-PARTY CONTENT] ...`, saying the next block came from the upstream source and is data, never instructions; the data that used to be `content[0]` is now `content[1]`, unchanged. A program that parses results should skip the block whose text starts with `[UNTRUSTED THIRD-PARTY CONTENT]`. Every tool also declares MCP tool annotations (read-only, non-destructive, idempotent, open world).

`court_list` with `q` reads at most `COURTWATCH_COURT_WALK_PAGES` pages of the courts table (default 20, at most 200) instead of up to 200, and adds `complete`. A rate limit partway through the walk returns the courts already read, marked incomplete, instead of failing. Before this, one name search could spend the whole hourly ceiling (50/hour) and return nothing.

`COURTLISTENER_API_TOKEN` holding a space, line break or control character is refused with a message that names the variable and never quotes it. Before this, Node's fetch rejected the header and its error, which quotes the whole value, was returned to the model.

## 1.3.0 — prepared locally, 2026-11-04

Add opinion text paging, literal phrase search and stable normalized-text offsets. The separate local Civic Workbench adds highlighted contexts, saved passages, notes and reading-list exports.

Includes the preceding local correctness fixes and regression coverage. This version has not been published or deployed. See GAUNTLET.md for verification requirements.

Recognize upstream human-verification HTML, including HTTP 200/403/405/503, without retrying it. Errors distinguish anonymous access from requests that already sent a token and provide API-setup/manual-search alternatives. Five regression cases were written failing first.
