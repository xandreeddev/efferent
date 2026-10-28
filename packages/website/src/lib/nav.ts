/**
 * Single source of truth for navigation.
 * Every internal link in .astro components goes through `href()` so it gets the
 * project-page base (`/efferent`) — markdown links are handled by a rehype plugin.
 */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "")

export const href = (path: string): string => {
  if (/^(https?:|mailto:|#|\/\/)/.test(path)) return path
  return BASE + (path.startsWith("/") ? path : "/" + path)
}

export const GITHUB = "https://github.com/xandreeddev/efferent"
export const NPM = "https://www.npmjs.com/package/@xandreed/sdk"

export const topNav = [
  { label: "Docs", href: "/docs/getting-started" },
  { label: "Ecosystem", href: "/#ecosystem" },
  { label: "Plugins", href: "/docs/concepts/plugin-reference" },
]

export interface DocItem {
  slug: string
  label: string
}
export interface DocGroup {
  group: string
  items: DocItem[]
}

export const docsNav: DocGroup[] = [
  {
    group: "Start here",
    items: [{ slug: "getting-started", label: "Getting started" }],
  },
  {
    group: "Concepts",
    items: [
      { slug: "concepts/architecture", label: "Architecture" },
      { slug: "concepts/harness", label: "SDK & sessions" },
      { slug: "concepts/foundry", label: "Foundry — the factory" },
      { slug: "concepts/engine", label: "Core contracts" },
      { slug: "concepts/providers", label: "Plugin configuration" },
      { slug: "concepts/plugin-reference", label: "Plugin reference" },
      { slug: "concepts/evals", label: "Evals — calibrations and journeys" },
    ],
  },
]

/** Flat, ordered list of doc slugs — drives prev/next. */
export const docsOrder: DocItem[] = docsNav.flatMap((g) => g.items)
