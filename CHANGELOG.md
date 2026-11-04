# Changelog

## 1.3.0 — prepared locally, 2026-11-04

Add opinion text paging, literal phrase search and stable normalized-text offsets. The separate local Civic Workbench adds highlighted contexts, saved passages, notes and reading-list exports.

Includes the preceding local correctness fixes and regression coverage. This version has not been published or deployed. See GAUNTLET.md for verification requirements.

Recognize upstream human-verification HTML, including HTTP 200/403/405/503, without retrying it. Errors distinguish anonymous access from requests that already sent a token and provide API-setup/manual-search alternatives. Five regression cases were written failing first.
