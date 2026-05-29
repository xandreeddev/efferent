---
name: web-search
description: Web search via the Brave Search API — an OPTIONAL alternative to the built-in web_search tool, for when you specifically want Brave (a key-controlled, ranked-result engine). Prefer the native web_search tool unless asked otherwise; this needs a BRAVE_API_KEY.
---

# Web search (Brave) — optional engine

There is already a built-in **`web_search` tool** (provider-native, no extra
key) — prefer it. This skill is the *alternative*: a bundled script that
queries the **Brave Search API** and prints ranked results. Use it only when
the user wants Brave specifically (e.g. a key-controlled engine, or to compare
results). Run it through the `bash` tool, then read promising results with the
built-in `web_fetch` tool.

## Requirements

- `BRAVE_API_KEY` must be set in the environment. Brave's API is usage-priced
  (~$5 per 1,000 requests with ~$5 of free monthly credits) and **requires a
  credit card** even for the free credits — see https://brave.com/search/api/.
  If the key is missing the script exits with a clear message; tell the user to
  add it to `.env` (or just use the native `web_search` tool) rather than
  retrying.
- `bash` must be permitted. In the TUI it is; in non-interactive modes the
  agent must be launched with `--allow-bash`.

## Search

```bash
bun {{SKILL_DIR}}/web-search.js "<query>"            # ranked list: title / url / snippet
bun {{SKILL_DIR}}/web-search.js "<query>" --count 5  # cap results (default 8, max 20)
bun {{SKILL_DIR}}/web-search.js "<query>" --json     # one JSON object per line, for parsing
```

`{{SKILL_DIR}}` is substituted with this skill's absolute directory, so the
command works regardless of the current working directory.

## Workflow

1. Run a focused query — prefer specific terms over a long natural-language
   question. Add the year or "latest" when currency matters.
2. Scan the titles/snippets and pick the 1–3 most relevant URLs.
3. Read them with the `web_fetch` tool (`web_fetch({ url })`) — don't guess at
   page contents from the snippet alone.
4. If the first query misses, refine the terms and search again rather than
   fetching low-relevance results.

## Notes

- This finds pages; `web_fetch` reads them. Keep the two steps distinct.
- The free tier is rate-limited — a 429 means slow down, not that the key is
  bad. Space out queries; don't fire many in parallel.
- Results are general web search. For code-specific lookups, a targeted query
  (e.g. `effect-ts Layer.provideMerge docs`) beats a broad one.
