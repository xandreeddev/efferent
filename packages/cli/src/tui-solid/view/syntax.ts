import { SyntaxStyle, getTreeSitterClient, type TreeSitterClient } from "@opentui/core"
import { activeThemeName, tokens } from "../state/theme.js"

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
 *    `@opentui/core/assets`); other languages render un-highlighted. Colours are
 *    the semantic `tokens.syntax` roles (one source for both families).
 *
 * Built lazily, **once per theme**. `SyntaxStyle.fromStyles` calls into OpenTUI's
 * native lib (`resolveRenderLib`), only loaded by `createCliRenderer`, so it can't
 * be constructed at module load or ctx-build time (tests build the ctx before the
 * renderer). Each style is an immutable, process-wide render resource — like a
 * font — so it's memoised by theme name: a `:theme` switch reads the active name
 * (a tracked signal), so any `<markdown>`/`<diff>` reading `syntaxStyle()` in JSX
 * re-renders with the new theme's colours; the first switch builds + caches that
 * theme's style, later switches reuse it.
 */
const styleCache = new Map<string, SyntaxStyle>()

export const syntaxStyle = (): SyntaxStyle => {
  const name = activeThemeName() // reactive dependency → follows `:theme`
  const cached = styleCache.get(name)
  if (cached === undefined) {
    const built = SyntaxStyle.fromStyles({
      // --- markdown prose (marked → markup.* lookups) ---
      "markup.heading": { fg: tokens.syntax.heading, bold: true },
      "markup.strong": { bold: true },
      "markup.italic": { italic: true },
      "markup.strikethrough": { dim: true },
      "markup.raw": { fg: tokens.syntax.raw }, // inline `code` + un-highlighted fences
      "markup.quote": { fg: tokens.syntax.quote, italic: true },
      "markup.list": { fg: tokens.syntax.list },
      "markup.link": { fg: tokens.syntax.link, underline: true },
      "markup.link.label": { fg: tokens.syntax.link, underline: true },
      "markup.link.url": { fg: tokens.syntax.linkUrl, underline: true },
      // --- code (tree-sitter capture scopes) ---
      keyword: { fg: tokens.syntax.keyword },
      "keyword.return": { fg: tokens.syntax.keyword },
      "keyword.function": { fg: tokens.syntax.keyword },
      "keyword.import": { fg: tokens.syntax.keyword },
      "keyword.operator": { fg: tokens.syntax.keyword },
      "keyword.conditional": { fg: tokens.syntax.keyword },
      "keyword.repeat": { fg: tokens.syntax.keyword },
      "keyword.exception": { fg: tokens.syntax.keyword },
      "keyword.modifier": { fg: tokens.syntax.keyword },
      string: { fg: tokens.syntax.string },
      "string.escape": { fg: tokens.syntax.escape },
      "string.regexp": { fg: tokens.syntax.string },
      "string.special": { fg: tokens.syntax.escape },
      "string.special.url": { fg: tokens.syntax.link, underline: true },
      number: { fg: tokens.syntax.number },
      boolean: { fg: tokens.syntax.number },
      constant: { fg: tokens.syntax.number },
      "constant.builtin": { fg: tokens.syntax.number },
      function: { fg: tokens.syntax.function },
      "function.call": { fg: tokens.syntax.function },
      "function.method": { fg: tokens.syntax.function },
      "function.method.call": { fg: tokens.syntax.function },
      "function.builtin": { fg: tokens.syntax.function },
      constructor: { fg: tokens.syntax.type },
      type: { fg: tokens.syntax.type },
      "type.builtin": { fg: tokens.syntax.type },
      comment: { fg: tokens.syntax.comment, italic: true },
      "comment.documentation": { fg: tokens.syntax.comment, italic: true },
      variable: { fg: tokens.syntax.variable },
      "variable.parameter": { fg: tokens.syntax.param },
      "variable.member": { fg: tokens.syntax.variable },
      "variable.builtin": { fg: tokens.syntax.type },
      property: { fg: tokens.syntax.variable },
      operator: { fg: tokens.syntax.escape },
      "punctuation.delimiter": { fg: tokens.syntax.punctuation },
      "punctuation.bracket": { fg: tokens.syntax.punctuation },
      "punctuation.special": { fg: tokens.syntax.escape },
      module: { fg: tokens.syntax.type },
      label: { fg: tokens.syntax.function },
      attribute: { fg: tokens.syntax.param },
    })
    styleCache.set(name, built)
    return built
  }
  return cached
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
