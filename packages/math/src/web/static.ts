/**
 * The math shell's static asset manifest — Bun text-imports (bundle-safe),
 * djb2 content hash as ETag + `?v=` cache-buster. The design tokens are a
 * FROZEN snapshot (assets/tokens.css) of the math theme — the single-theme
 * product doesn't carry the old line's theme machinery.
 */
// @ts-ignore Bun resolves the import attribute; tsc sees the sibling .d.ts shims.
import htmxSrc from "../../assets/vendor/htmx.min.js" with { type: "text" }
// @ts-ignore
import wsExtSrc from "../../assets/vendor/htmx-ext-ws.js" with { type: "text" }
// @ts-ignore
import mathCssSrc from "../../assets/math.css" with { type: "text" }
// @ts-ignore
import mathJsSrc from "../../assets/math.js" with { type: "text" }
// @ts-ignore
import tokensCssSrc from "../../assets/tokens.css" with { type: "text" }
import { ASSET_PREFIX } from "./contract.js"

export interface StaticAsset {
  /** Absolute serve path (`/assets/…`). */
  readonly path: string
  readonly content: string
  readonly contentType: string
  /** djb2 content hash — ETag + `?v=` buster. */
  readonly hash: string
}

const djb2 = (s: string): string =>
  [...s]
    .reduce((h, c) => ((h * 33) ^ c.charCodeAt(0)) >>> 0, 5381)
    .toString(36)

const asset = (name: string, content: string, contentType: string): StaticAsset => ({
  path: `${ASSET_PREFIX}/${name}`,
  content,
  contentType,
  hash: djb2(content),
})

export const staticAssets: ReadonlyArray<StaticAsset> = [
  asset("htmx.min.js", htmxSrc, "text/javascript; charset=utf-8"),
  asset("htmx-ext-ws.js", wsExtSrc, "text/javascript; charset=utf-8"),
  asset("math.css", mathCssSrc, "text/css; charset=utf-8"),
  asset("math.js", mathJsSrc, "text/javascript; charset=utf-8"),
  asset("tokens.css", tokensCssSrc, "text/css; charset=utf-8"),
]

/** Look up an asset's versioned href for the shell's <link>/<script> tags. */
export const assetHref = (name: string): string => {
  const found = staticAssets.find((entry) => entry.path.endsWith(`/${name}`))
  return found === undefined ? `${ASSET_PREFIX}/${name}` : `${found.path}?v=${found.hash}`
}
