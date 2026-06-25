/**
 * Turn `:::note` / `:::tip` / `:::caution` / `:::danger` / `:::important` container
 * directives (parsed by remark-directive) into styled `<aside class="callout …">`
 * blocks, with an optional title: `:::tip[Run it]`.
 *
 * Zero deps — a tiny manual mdast walk instead of unist-util-visit.
 */
const KINDS = new Set(["note", "tip", "caution", "danger", "important"])
const DEFAULT_TITLE = {
  note: "Note",
  tip: "Tip",
  caution: "Caution",
  danger: "Danger",
  important: "Important",
}

function walk(node, fn) {
  fn(node)
  if (node.children) for (const child of node.children) walk(child, fn)
}

export default function remarkCallouts() {
  return (tree) => {
    walk(tree, (node) => {
      if (node.type !== "containerDirective" || !KINDS.has(node.name)) return

      const kind = node.name
      node.data = node.data || {}
      node.data.hName = "aside"
      node.data.hProperties = { className: ["callout", `callout-${kind}`] }

      // The label (`:::tip[Title]`) arrives as a leading paragraph flagged
      // directiveLabel. Promote it to a titled header; otherwise synthesize one.
      const first = node.children[0]
      if (first && first.data && first.data.directiveLabel) {
        first.data.hName = "p"
        first.data.hProperties = { className: ["callout-title"] }
        delete first.data.directiveLabel
      } else {
        node.children.unshift({
          type: "paragraph",
          data: { hProperties: { className: ["callout-title"] } },
          children: [{ type: "text", value: DEFAULT_TITLE[kind] }],
        })
      }
    })
  }
}
