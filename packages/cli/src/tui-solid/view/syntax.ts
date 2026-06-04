import { SyntaxStyle, getTreeSitterClient, type TreeSitterClient } from "@opentui/core"
import { theme } from "../theme.js"

/**
 * The one style table shared by `<markdown>`, `<diff>` and `<code>`. It carries
 * two scope families:
 *
 *  - **markdown `markup.*`** — `marked` parses prose and colours each token by
 *    looking these up (headings / bold / italic / strikethrough / inline-or-block
 *    code / quotes / lists / links).
 *  - **tree-sitter code scopes** (`keyword`, `string`, `function`, …, Neovim
 *    capture-name convention) — used to colour fenced code blocks inside markdown
 *    and the hunk contents of a `<diff>`, when a `treeSitterClient` is supplied.
 *    The shipped grammars cover **JS / TS / markdown / zig** (see
 *    `@opentui/core/assets`); other languages render un-highlighted. Palette is a
 *    One-Dark-ish set, consistent with `theme.ts`.
 *
 * Built lazily and once. `SyntaxStyle.fromStyles` calls into OpenTUI's native lib
 * (`resolveRenderLib`), only loaded by `createCliRenderer`, so it can't be
 * constructed at module load or ctx-build time (tests build the ctx before the
 * renderer). It's an immutable, process-wide render resource — like a font.
 */
let cachedStyle: SyntaxStyle | undefined

export const syntaxStyle = (): SyntaxStyle => {
  if (cachedStyle === undefined) {
    cachedStyle = SyntaxStyle.fromStyles({
      // --- markdown prose (marked → markup.* lookups) ---
      "markup.heading": { fg: theme.turnHeader, bold: true },
      "markup.strong": { bold: true },
      "markup.italic": { italic: true },
      "markup.strikethrough": { dim: true },
      "markup.raw": { fg: theme.green }, // inline `code` + un-highlighted fences
      "markup.quote": { fg: theme.gray, italic: true },
      "markup.list": { fg: theme.gray },
      "markup.link": { fg: theme.accent.conversation, underline: true },
      "markup.link.label": { fg: theme.accent.conversation, underline: true },
      "markup.link.url": { fg: theme.dim, underline: true },
      // --- code (tree-sitter capture scopes) ---
      keyword: { fg: "#c678dd" },
      "keyword.return": { fg: "#c678dd" },
      "keyword.function": { fg: "#c678dd" },
      "keyword.import": { fg: "#c678dd" },
      "keyword.operator": { fg: "#c678dd" },
      "keyword.conditional": { fg: "#c678dd" },
      "keyword.repeat": { fg: "#c678dd" },
      "keyword.exception": { fg: "#c678dd" },
      "keyword.modifier": { fg: "#c678dd" },
      string: { fg: "#98c379" },
      "string.escape": { fg: "#56b6c2" },
      "string.regexp": { fg: "#98c379" },
      "string.special": { fg: "#56b6c2" },
      "string.special.url": { fg: theme.accent.conversation, underline: true },
      number: { fg: "#d19a66" },
      boolean: { fg: "#d19a66" },
      constant: { fg: "#d19a66" },
      "constant.builtin": { fg: "#d19a66" },
      function: { fg: "#61afef" },
      "function.call": { fg: "#61afef" },
      "function.method": { fg: "#61afef" },
      "function.method.call": { fg: "#61afef" },
      "function.builtin": { fg: "#61afef" },
      constructor: { fg: "#e5c07b" },
      type: { fg: "#e5c07b" },
      "type.builtin": { fg: "#e5c07b" },
      comment: { fg: "#7f848e", italic: true },
      "comment.documentation": { fg: "#7f848e", italic: true },
      variable: { fg: "#e06c75" },
      "variable.parameter": { fg: "#d19a66" },
      "variable.member": { fg: "#e06c75" },
      "variable.builtin": { fg: "#e5c07b" },
      property: { fg: "#e06c75" },
      operator: { fg: "#56b6c2" },
      "punctuation.delimiter": { fg: "#abb2bf" },
      "punctuation.bracket": { fg: "#abb2bf" },
      "punctuation.special": { fg: "#56b6c2" },
      module: { fg: "#e5c07b" },
      label: { fg: "#61afef" },
      attribute: { fg: "#d19a66" },
    })
  }
  return cachedStyle
}

/**
 * The shared tree-sitter highlight client (a `singleton` inside `@opentui/core`;
 * its `parser.worker.js` + grammar WASM both resolve from that package's install
 * dir, so nothing is bundled here). **Best-effort**: returns `undefined` if the
 * runtime can't spawn the worker, so highlighting silently degrades to plain code
 * rather than breaking the TUI.
 *
 * IMPORTANT: the worker keeps the Bun process alive — `runtime.ts` registers a
 * finalizer that calls `.destroy()` so `:exit` actually exits.
 */
let triedClient = false
let cachedClient: TreeSitterClient | undefined

export const treeSitterClient = (): TreeSitterClient | undefined => {
  if (!triedClient) {
    triedClient = true
    try {
      cachedClient = getTreeSitterClient()
    } catch {
      cachedClient = undefined
    }
  }
  return cachedClient
}
