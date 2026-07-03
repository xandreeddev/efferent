/**
 * The static asset manifest the cli driver serves. Contents are Bun
 * text-imports, so they inline into the CLI bundle — no runtime file paths.
 * `hash` (djb2 of content) doubles as the ETag and the `?v=` cache-buster the
 * shell links carry, so `Cache-Control: immutable` is safe.
 */
// @ts-ignore Bun resolves the import attribute; tsc sees the sibling .d.ts shims.
import htmxSrc from "./vendor/htmx.min.js" with { type: "text" }
// @ts-ignore
import wsExtSrc from "./vendor/htmx-ext-ws.js" with { type: "text" }
// @ts-ignore ~2.75MB — inlined; served lazily (diagrams.js injects it on the first diagram).
import mermaidSrc from "./vendor/mermaid.min.js" with { type: "text" }
// @ts-ignore
import appJsSrc from "./app.js" with { type: "text" }
// @ts-ignore
import diagramsJsSrc from "./diagrams.js" with { type: "text" }
// @ts-ignore
import appCssSrc from "./app.css" with { type: "text" }
// @ts-ignore
import kitCssSrc from "./kit.css" with { type: "text" }
import { renderTokensCss } from "../theme/css.js"
import { ASSET_PREFIX } from "../protocol/contract.js"

export interface StaticAsset {
  /** Absolute serve path (`/assets/…`). */
  readonly path: string
  readonly content: string
  readonly contentType: string
  /** djb2 content hash — ETag + `?v=` buster. */
  readonly hash: string
}

const djb2 = (s: string): string => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

const asset = (name: string, content: string, contentType: string): StaticAsset => ({
  path: `${ASSET_PREFIX}/${name}`,
  content,
  contentType,
  hash: djb2(content),
})

export const staticAssets: ReadonlyArray<StaticAsset> = [
  asset("htmx.min.js", htmxSrc, "text/javascript; charset=utf-8"),
  asset("htmx-ext-ws.js", wsExtSrc, "text/javascript; charset=utf-8"),
  asset("mermaid.min.js", mermaidSrc, "text/javascript; charset=utf-8"),
  asset("app.js", appJsSrc, "text/javascript; charset=utf-8"),
  asset("diagrams.js", diagramsJsSrc, "text/javascript; charset=utf-8"),
  asset("app.css", appCssSrc, "text/css; charset=utf-8"),
  asset("kit.css", kitCssSrc, "text/css; charset=utf-8"),
  asset("tokens.css", renderTokensCss(), "text/css; charset=utf-8"),
]

/** Look up an asset's versioned href for the shell's <link>/<script> tags. */
export const assetHref = (name: string): string => {
  const a = staticAssets.find((x) => x.path.endsWith(`/${name}`))
  return a === undefined ? `${ASSET_PREFIX}/${name}` : `${a.path}?v=${a.hash}`
}
