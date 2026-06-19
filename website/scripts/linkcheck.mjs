/**
 * Static link checker for the built site (dist/). Crawls every .html file,
 * extracts internal links + ids, and verifies:
 *   - every internal <a href> resolves to a built page (no 404s),
 *   - root-absolute links carry the project base (/efferent),
 *   - every #anchor (cross-page and same-page) targets an id that exists.
 * Exits non-zero if anything is broken. Zero deps.
 *
 *   bun scripts/linkcheck.mjs [distDir] [base]
 */
import { readdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve, dirname, posix } from "node:path"

const DIST = resolve(process.argv[2] || "dist")
const BASE = (process.argv[3] || "/efferent").replace(/\/$/, "")

async function htmlFiles(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await htmlFiles(p)))
    else if (e.name.endsWith(".html")) out.push(p)
  }
  return out
}

// dist file path -> served URL path (base-prefixed, e.g. /efferent/docs/x/)
const urlOf = (file) => {
  let u = "/" + posix.relative(DIST, file).replace(/\\/g, "/")
  u = u.replace(/index\.html$/, "").replace(/\.html$/, "/")
  return BASE + (u === "/" ? "/" : u)
}

// served URL path -> candidate dist files
const distCandidates = (urlPath) => {
  let p = urlPath
  if (BASE && p.startsWith(BASE)) p = p.slice(BASE.length) || "/"
  p = p.replace(/\/$/, "")
  return [
    join(DIST, p, "index.html"),
    join(DIST, p + ".html"),
    p === "" ? join(DIST, "index.html") : null,
  ].filter(Boolean)
}

const files = await htmlFiles(DIST)
const ids = new Map() // url path (no trailing slash) -> Set<id>
const pages = new Set() // served url paths that exist (normalized, no trailing slash)

for (const f of files) {
  const html = await readFile(f, "utf8")
  const u = urlOf(f).replace(/\/$/, "") || BASE
  pages.add(u)
  const idset = new Set()
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) idset.add(m[1])
  ids.set(u, idset)
}

let broken = 0
const report = []

for (const f of files) {
  const html = await readFile(f, "utf8")
  const fromUrl = urlOf(f)
  for (const m of html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) {
    const raw = m[1]
    if (/^(https?:|mailto:|tel:|data:)/.test(raw) || raw.startsWith("//")) continue

    let [path, hash] = raw.split("#")
    // same-page anchor
    if (path === "" && hash) {
      const here = fromUrl.replace(/\/$/, "") || BASE
      if (!(ids.get(here) || new Set()).has(hash)) {
        report.push(`✗ ${fromUrl}  →  #${hash}  (no such id on this page)`)
        broken++
      }
      continue
    }

    // resolve relative -> absolute served path
    let target = path
    if (!target.startsWith("/")) {
      target = posix.normalize(posix.join(dirname(fromUrl), target))
    }

    // root-absolute must carry the base
    if (target.startsWith("/") && BASE && !target.startsWith(BASE + "/") && target !== BASE) {
      report.push(`✗ ${fromUrl}  →  ${raw}  (root link missing base ${BASE})`)
      broken++
      continue
    }

    const cands = distCandidates(target)
    const hit = cands.find((c) => existsSync(c))
    if (!hit) {
      report.push(`✗ ${fromUrl}  →  ${raw}  (no built page; tried ${cands.map((c) => posix.relative(DIST, c)).join(", ")})`)
      broken++
      continue
    }
    // verify cross-page anchor id exists
    if (hash) {
      const targetUrl = urlOf(hit).replace(/\/$/, "") || BASE
      if (!(ids.get(targetUrl) || new Set()).has(hash)) {
        report.push(`✗ ${fromUrl}  →  ${raw}  (page ok, but no id="${hash}")`)
        broken++
      }
    }
  }
}

console.log(`Checked ${files.length} pages.`)
if (broken === 0) {
  console.log("✓ All internal links resolve.")
} else {
  console.log(`\n${broken} broken link(s):\n` + report.join("\n"))
  process.exit(1)
}
