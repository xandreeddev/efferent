/**
 * Keeps the guides under docs/ in step with the code they quote, and
 * mirrors them to the website (`bun run docs:generate` runs it; CI fails
 * when what it writes is not committed).
 *
 * - A fence that follows `<!-- snippet: <file>#<region> -->` is replaced by
 *   that region of the file (a test that runs) with the import lines its
 *   code uses, from the file's own imports; a snippet may import only
 *   public packages. Every region of a quoted file must be in a guide.
 * - Every TypeScript or JavaScript fence is a snippet (a `ts` fence), or
 *   says why not on the line before it (`<!-- unchecked: <why> -->`); a
 *   snippet marker the sync cannot fill is a problem too.
 * - Every link must resolve: an anchor to a heading of its target, a
 *   repository file that exists. On the website, a file that has a page
 *   links to it; any other file links to GitHub.
 */
import { existsSync, statSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { importsOf, regionsOf, snippetOf } from "./guide-snippets.js"
import type { ImportDeclaration } from "./guide-snippets.js"

const root = join(import.meta.dir, "..")
const github = "https://github.com/xandreeddev/efferent"

interface Guide {
  /** The guide, from the repository root. */
  readonly source: string
  /** Its page on the website, under /docs/. */
  readonly page: string
  readonly title: string
  readonly description: string
}

const guides: ReadonlyArray<Guide> = [{
  source: "docs/events.md",
  page: "guides/events",
  title: "Events guide",
  description: "Stream a turn to a client, react to its tools, see its start and end, publish your own events, follow a session's journal from anywhere, and serve it all over HTTP.",
}]

/** Repository files with a page of their own on the website; any other file a guide links to is linked on GitHub. */
const sitePages: ReadonlyMap<string, string> = new Map([
  ["docs/event-reference.md", "/docs/concepts/event-reference/"],
  ...guides.map((guide): readonly [string, string] => [guide.source, `/docs/${guide.page}/`]),
])

const read = (file: string) => readFile(join(root, file), "utf8")

/* ── markdown: fences, links, headings ── */

/** A text's fenced code blocks at odd indices, the prose around them at even ones. */
const fenced = (text: string): ReadonlyArray<string> => text.split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/m)

/** A link (its label may hold inline code), or inline code standing alone, which is never a link. */
const linkOrCode = /(`[^`\n]*`)|(?<!!)\[((?:[^\]`]|`[^`\n]*`)*)\]\(([^)\s]+)\)/g

/** Rewrite the links of markdown prose (its fences and inline code untouched). */
const mapLinks = (text: string, link: (target: string) => string): string => fenced(text).map((part, index) => index % 2 === 1 ? part
  : part.replace(linkOrCode, (whole: string, code: string | undefined, label: string, target: string) => code !== undefined ? whole : `[${label}](${link(target)})`)).join("")

/** The link targets of markdown prose. */
const linksOf = (text: string): ReadonlyArray<string> => fenced(text).filter((_, index) => index % 2 === 0)
  .flatMap((part) => Array.from(part.matchAll(linkOrCode)).flatMap((match) => match[1] === undefined ? [match[3] ?? ""] : []))

/** The anchors of a markdown file's headings, as GitHub and the website (github-slugger) make them. */
const anchorsOf = (text: string): ReadonlySet<string> => {
  const headings = fenced(text).filter((_, index) => index % 2 === 0).flatMap((part) =>
    Array.from(part.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm), (match) => match[1] ?? ""))
  const slugs = headings.map((heading) => heading.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "").toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-"))
  return new Set(slugs.map((slug, index) => {
    const before = slugs.slice(0, index).filter((other) => other === slug).length
    return before === 0 ? slug : `${slug}-${before}`
  }))
}

/* ── snippets ── */

interface Quoted {
  readonly imports: ReadonlyArray<ImportDeclaration>
  readonly regions: ReadonlyMap<string, string>
}

const quoted = (file: string): Promise<Quoted> => read(file).then((source) => {
  const { regions, problems } = regionsOf(source)
  if (problems.length > 0) {
    console.error(problems.map((problem) => `${file}: ${problem}`).join("\n"))
    process.exit(1)
  }
  return { imports: importsOf(source), regions }
})

const snippetFence = /^<!-- snippet: ([^#\s]+)#([\w-]+) -->\n```(ts|typescript)\b[^\n]*\n[\s\S]*?^```[ \t]*$/gm

/** The guide with every snippet fence holding its region as the quoted file has it now, and the regions it quoted. */
const withSnippets = async (guide: Guide, text: string) => {
  const markers = Array.from(text.matchAll(snippetFence), (match) => ({ file: match[1] ?? "", region: match[2] ?? "" }))
  const files = new Map(await Promise.all([...new Set(markers.map((marker) => marker.file))].map(async (file) => [file, await quoted(file)] as const)))
  const snippetAt = (file: string, region: string) => {
    const source = files.get(file)
    const code = source?.regions.get(region)
    if (source === undefined || code === undefined) return { text: "", problems: [`${guide.source}: ${file} has no #region ${region}`] }
    const snippet = snippetOf(source.imports, code)
    return { text: snippet.text, problems: snippet.problems.map((problem) => `${guide.source}: snippet ${region} ${problem}`) }
  }
  const snippets = markers.map((marker) => snippetAt(marker.file, marker.region))
  const next = text.replace(snippetFence, (_, file: string, region: string, language: string) =>
    `<!-- snippet: ${file}#${region} -->\n\`\`\`${language}\n${snippetAt(file, region).text}\n\`\`\``)
  return { text: next, quoted: markers, problems: snippets.flatMap((snippet) => snippet.problems) }
}

/** Fences of code a reader would run that are neither a snippet (a `ts` fence the sync fills) nor say why not. */
const unmarkedFences = (guide: Guide, text: string): ReadonlyArray<string> => {
  const parts = fenced(text)
  return parts.flatMap((part, index) => index % 2 === 1 && /^```(ts|typescript|tsx|js|javascript|mjs)\b/.test(part)
    && !/<!-- unchecked: [^\n]+ -->\n$/.test(parts[index - 1] ?? "")
    && !(/^```(ts|typescript)\b/.test(part) && /<!-- snippet: [^\n]+ -->\n$/.test(parts[index - 1] ?? ""))
    ? [`${guide.source}:${parts.slice(0, index).join("").split("\n").length}: a code fence that is neither a snippet nor marked <!-- unchecked: why -->`]
    : [])
}

/** Snippet markers the sync did not fill: not `<!-- snippet: <file>#<region> -->` right before a `ts` fence. */
const strayMarkers = (guide: Guide, text: string): ReadonlyArray<string> => {
  const filled = new Set(Array.from(text.matchAll(snippetFence), (match) => match.index))
  return Array.from(text.matchAll(/^<!-- snippet:[^\n]*$/gm)).flatMap((match) => filled.has(match.index) ? []
    : [`${guide.source}:${text.slice(0, match.index).split("\n").length}: a snippet marker that is not <!-- snippet: <file>#<region> --> right before a ts fence`])
}

/* ── links ── */

/** Where a guide's link goes on the website, or why it cannot go anywhere. */
const siteLink = async (guide: Guide, guideText: string, target: string): Promise<{ readonly href: string; readonly problem?: string }> => {
  if (/^(https?:|mailto:)/.test(target)) return { href: target }
  const [path = "", anchor] = target.split("#")
  if (path === "") {
    return anchorsOf(guideText).has(anchor ?? "") ? { href: target } : { href: target, problem: `${guide.source}: no heading for ${target}` }
  }
  if (path.startsWith("/")) return { href: target, problem: `${guide.source}: ${target} is a site path; link the repository file instead` }
  const file = relative(root, resolve(root, dirname(guide.source), path))
  if (file.startsWith("..") || !existsSync(join(root, file))) return { href: target, problem: `${guide.source}: ${target} names no file of the repository` }
  const fragment = anchor === undefined ? "" : `#${anchor}`
  if (anchor !== undefined && file.endsWith(".md") && !anchorsOf(await read(file)).has(anchor)) {
    return { href: target, problem: `${guide.source}: ${file} has no heading for #${anchor}` }
  }
  const page = sitePages.get(file)
  return page !== undefined ? { href: `${page}${fragment}` }
    : { href: `${github}/${statSync(join(root, file)).isDirectory() ? "tree" : "blob"}/main/${file}${fragment}` }
}

/** Every link of the guide resolved for the website (the same text, its links rewritten), and what could not be. */
const forWebsite = async (guide: Guide, text: string) => {
  const resolved = new Map(await Promise.all([...new Set(linksOf(text))].map(async (target) => [target, await siteLink(guide, text, target)] as const)))
  return {
    text: mapLinks(text, (target) => resolved.get(target)?.href ?? target),
    problems: [...resolved.values()].flatMap((link) => link.problem === undefined ? [] : [link.problem]),
  }
}

/* ── each guide ── */

const results = await Promise.all(guides.map(async (guide) => {
  const original = await read(guide.source)
  const snippets = await withSnippets(guide, original)
  const body = snippets.text
    .replace(/^<!-- (snippet|unchecked): [^\n]* -->\n/gm, "")
    .replace(/^# [^\n]*\n+/, "")
  const website = await forWebsite(guide, body)
  return {
    guide, original, text: snippets.text, quoted: snippets.quoted, page: website.text,
    problems: [...snippets.problems, ...strayMarkers(guide, original), ...unmarkedFences(guide, snippets.text), ...website.problems],
  }
}))

/** A region nobody quotes is a snippet the guide lost, or code the test file need not mark. */
const unquoted = await Promise.all([...new Set(results.flatMap((result) => result.quoted.map((marker) => marker.file)))].map(async (file) => {
  const used = new Set(results.flatMap((result) => result.quoted.filter((marker) => marker.file === file).map((marker) => marker.region)))
  return [...(await quoted(file)).regions.keys()].filter((region) => !used.has(region)).map((region) => `${file}: #region ${region} is in no guide`)
}))

const problems = [...results.flatMap((result) => result.problems), ...unquoted.flat()]
if (problems.length > 0) {
  console.error(`The guides are out of step:\n${problems.join("\n")}`)
  process.exit(1)
}

await Promise.all(results.map(async (result) => {
  if (result.text !== result.original) await writeFile(join(root, result.guide.source), result.text)
  const page = join(root, "packages/website/src/content/docs", `${result.guide.page}.md`)
  await mkdir(dirname(page), { recursive: true })
  await writeFile(page, `---\ntitle: ${JSON.stringify(result.guide.title)}\ndescription: ${JSON.stringify(result.guide.description)}\n---\n\n<!-- Generated by bun run docs:generate (scripts/sync-guides.ts) from ${result.guide.source}: edit that file. -->\n\n${result.page}`)
}))
console.log(`Synced ${results.length} guide${results.length === 1 ? "" : "s"} (${results.reduce((sum, result) => sum + result.quoted.length, 0)} snippets) to the website`)
