/**
 * Prefix the site `base` onto every root-absolute internal link in rendered
 * markdown, so authors write clean `/docs/...` hrefs and nothing 404s under the
 * project-page base (`/efferent`). External links (`http`, `//`, `mailto:`,
 * `#anchors`) and already-prefixed links are left alone.
 *
 * `base` is passed from astro.config (the one place that knows it). Zero deps.
 */
function walk(node, fn) {
  fn(node)
  if (node.children) for (const child of node.children) walk(child, fn)
}

export default function rehypeBaseLinks({ base = "/" } = {}) {
  const prefix = base.replace(/\/$/, "") // "/efferent"
  return (tree) => {
    walk(tree, (node) => {
      if (node.type !== "element" || node.tagName !== "a") return
      const href = node.properties && node.properties.href
      if (typeof href !== "string") return
      if (!href.startsWith("/") || href.startsWith("//")) return
      if (prefix && (href === prefix || href.startsWith(prefix + "/"))) return
      node.properties.href = prefix + href
    })
  }
}
