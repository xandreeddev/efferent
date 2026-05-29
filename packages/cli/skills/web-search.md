---
name: web-search
description: Search the web via the Brave Search API. Use when you need to find documentation, current facts, library/API references, or any page whose URL you don't already have. Pairs with the web_fetch tool to read the results.
---

# Web search

A bundled script that queries the Brave Search API and prints ranked results.
Run it through the `bash` tool, then use the built-in `web_fetch` tool to read
whichever results look relevant.

## Requirements

- `BRAVE_API_KEY` must be set in the environment (free tier:
  https://brave.com/search/api/ — ~1 query/sec, 2k queries/month). If it's
  missing the script exits with a clear message; tell the user to add the key
  to their `.env` rather than retrying.
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
