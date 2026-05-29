#!/usr/bin/env bun
// web-search — query the Brave Search API and print ranked results.
//
// The agent invokes this through its `bash` tool (see web-search.md). It is
// the OPTIONAL Brave engine — the built-in `web_search` tool (provider-native,
// no key) is the default. This stays a plain script, not a first-party
// `Tool.make`: the Brave path lives in userland so the binary stays lean and
// the API key stays a workspace concern. Pair it with `web_fetch` to read the
// pages it surfaces.
//
//   bun web-search.js "<query>"            # ranked list: title / url / snippet
//   bun web-search.js "<query>" --count 5  # cap results (default 8, max 20)
//   bun web-search.js "<query>" --json     # raw result objects, one per line
//
// Requires BRAVE_API_KEY (usage-priced, card required: https://brave.com/search/api/).

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search"
const TIMEOUT_MS = 15_000

function parseArgs(argv) {
  const out = { query: "", count: 8, json: false }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--json") out.json = true
    else if (a === "--count") {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n < 1) fail(`--count needs a positive number, got ${argv[i]}`)
      out.count = Math.min(Math.trunc(n), 20)
    } else if (a.startsWith("--")) fail(`unknown flag: ${a}`)
    else rest.push(a)
  }
  out.query = rest.join(" ").trim()
  return out
}

function fail(msg, code = 1) {
  process.stderr.write(`web-search: ${msg}\n`)
  process.exit(code)
}

async function main() {
  const { query, count, json } = parseArgs(process.argv.slice(2))
  if (!query) {
    fail('usage: bun web-search.js "<query>" [--count N] [--json]')
  }
  const key = process.env.BRAVE_API_KEY
  if (!key) {
    fail("BRAVE_API_KEY is not set. Add a key from https://brave.com/search/api/ to .env — or use the built-in web_search tool (no key needed).", 3)
  }

  const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let res
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": key,
      },
      signal: ctrl.signal,
    })
  } catch (e) {
    fail(e.name === "AbortError" ? `request timed out after ${TIMEOUT_MS}ms` : `network error: ${e.message}`, 2)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    const hint =
      res.status === 401 || res.status === 403
        ? " (check BRAVE_API_KEY)"
        : res.status === 429
          ? " (rate limited — slow down; check your Brave plan's request budget)"
          : ""
    fail(`Brave API returned ${res.status} ${res.statusText}${hint}\n${detail.slice(0, 500)}`, 2)
  }

  const body = await res.json()
  const results = body?.web?.results ?? []

  if (json) {
    for (const r of results) {
      process.stdout.write(
        JSON.stringify({ title: r.title, url: r.url, description: stripTags(r.description) }) + "\n",
      )
    }
    if (results.length === 0) process.stderr.write("web-search: no results\n")
    return
  }

  if (results.length === 0) {
    process.stdout.write(`No results for: ${query}\n`)
    return
  }

  const lines = []
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`)
    lines.push(`   ${r.url}`)
    const desc = stripTags(r.description)
    if (desc) lines.push(`   ${desc}`)
    lines.push("")
  })
  process.stdout.write(lines.join("\n"))
}

// Brave wraps matched query terms in <strong> tags; drop them for plain output.
function stripTags(s) {
  return (s ?? "").replace(/<\/?[^>]+>/g, "").trim()
}

main().catch((e) => fail(`unexpected: ${e?.stack ?? e}`, 2))
