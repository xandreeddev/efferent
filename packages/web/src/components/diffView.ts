import { html, join, type Html } from "../html.js"

/**
 * Unified-diff text → classed lines. Shared by the rail tool pill and the
 * workspace diff card. Pure line classification — no parsing beyond prefixes.
 */
export const renderDiff = (diff: string): Html => {
  const lines = diff.replace(/\n$/, "").split("\n")
  const rendered = lines.map((line) => {
    const cls = line.startsWith("+++") || line.startsWith("---")
      ? "ef-diff-line--meta"
      : line.startsWith("@@")
        ? "ef-diff-line--hunk"
        : line.startsWith("+")
          ? "ef-diff-line--add"
          : line.startsWith("-")
            ? "ef-diff-line--del"
            : ""
    return html`<div class="ef-diff-line${cls === "" ? "" : ` ${cls}`}">${line === "" ? " " : line}</div>`
  })
  return html`<div class="ef-diff">${join(rendered)}</div>`
}
