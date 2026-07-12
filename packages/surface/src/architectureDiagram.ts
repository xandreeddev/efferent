import dagre from "@dagrejs/dagre"
import type { ArchitectureGraphType } from "@xandreed/ui-agent"
import { html, join, raw } from "./html.js"
import type { Html } from "./html.js"

const WIDTH = 176
const HEIGHT = 64

interface PositionedNode {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly detail: string | undefined
  readonly group: string | undefined
  readonly x: number
  readonly y: number
}

interface PositionedGroup {
  readonly id: string
  readonly label: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface PositionedEdge {
  readonly from: PositionedNode
  readonly to: PositionedNode
  readonly label: string | undefined
  readonly kind: string
}

const layout = (spec: ArchitectureGraphType): { readonly nodes: ReadonlyArray<PositionedNode>; readonly edges: ReadonlyArray<PositionedEdge>; readonly groups: ReadonlyArray<PositionedGroup>; readonly width: number; readonly height: number } => {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: spec.direction, nodesep: 46, ranksep: 84, marginx: 28, marginy: 28 })
  spec.nodes.forEach((node) => graph.setNode(node.id, { width: WIDTH, height: HEIGHT }))
  spec.edges.forEach((edge) => graph.setEdge(edge.from, edge.to))
  dagre.layout(graph)
  const nodes = spec.nodes.map((node) => {
    const point = graph.node(node.id) as { readonly x: number; readonly y: number }
    return { ...node, detail: node.detail, group: node.group, x: point.x, y: point.y }
  })
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const edges = spec.edges.flatMap((edge) => {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    return from === undefined || to === undefined ? [] : [{ from, to, label: edge.label, kind: edge.kind ?? "dependency" }]
  })
  const groups = (spec.groups ?? []).flatMap((group) => {
    const members = nodes.filter((node) => node.group === group.id)
    if (members.length === 0) return []
    const left = Math.min(...members.map((node) => node.x - WIDTH / 2)) - 18
    const top = Math.min(...members.map((node) => node.y - HEIGHT / 2)) - 34
    const right = Math.max(...members.map((node) => node.x + WIDTH / 2)) + 18
    const bottom = Math.max(...members.map((node) => node.y + HEIGHT / 2)) + 18
    return [{ id: group.id, label: group.label, x: left, y: top, width: right - left, height: bottom - top }]
  })
  const meta = graph.graph() as { readonly width?: number; readonly height?: number }
  return { nodes, edges, groups, width: meta.width ?? 800, height: meta.height ?? 420 }
}

const groupShape = (group: PositionedGroup): Html => html`<g class="ui-diagram-group"><rect x="${group.x}" y="${group.y}" width="${group.width}" height="${group.height}" rx="14"></rect><text x="${group.x + 12}" y="${group.y + 20}">${group.label}</text></g>`

const nodeShape = (node: PositionedNode): Html => html`<g class="ui-diagram-node ui-diagram-node--${node.kind}" transform="translate(${node.x - WIDTH / 2} ${node.y - HEIGHT / 2})">
  <rect width="${WIDTH}" height="${HEIGHT}" rx="10"></rect>
  <text x="14" y="27">${node.label}</text>
  ${node.detail === undefined ? raw("") : html`<text class="ui-diagram-detail" x="14" y="47">${node.detail.slice(0, 38)}</text>`}
</g>`

const edgeShape = (edge: PositionedEdge, index: number): Html => {
  const horizontal = Math.abs(edge.to.x - edge.from.x) >= Math.abs(edge.to.y - edge.from.y)
  const x1 = edge.from.x + (horizontal ? Math.sign(edge.to.x - edge.from.x) * WIDTH / 2 : 0)
  const y1 = edge.from.y + (horizontal ? 0 : Math.sign(edge.to.y - edge.from.y) * HEIGHT / 2)
  const x2 = edge.to.x - (horizontal ? Math.sign(edge.to.x - edge.from.x) * WIDTH / 2 : 0)
  const y2 = edge.to.y - (horizontal ? 0 : Math.sign(edge.to.y - edge.from.y) * HEIGHT / 2)
  return html`<g class="ui-diagram-edge ui-diagram-edge--${edge.kind}">
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#ui-arrow-${index})"></line>
    <marker id="ui-arrow-${index}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z"></path></marker>
    ${edge.label === undefined ? raw("") : html`<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 7}">${edge.label}</text>`}
  </g>`
}

export const renderArchitectureDiagram = (spec: ArchitectureGraphType): Html => {
  const positioned = layout(spec)
  const diagramId = spec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "architecture"
  return html`<figure class="ui-diagram"><svg role="img" aria-labelledby="diagram-title-${diagramId}" viewBox="0 0 ${positioned.width} ${positioned.height}" preserveAspectRatio="xMidYMid meet">
    <title id="diagram-title-${diagramId}">${spec.title}</title><desc>${spec.description}</desc>
    ${join(positioned.groups.map(groupShape))}${join(positioned.edges.map(edgeShape))}${join(positioned.nodes.map(nodeShape))}
  </svg><figcaption>${spec.description}</figcaption>
  <details class="ui-diagram-fallback"><summary>Diagram as a list</summary><ul>${join(spec.edges.map((edge) => html`<li>${edge.from} → ${edge.to}${edge.label === undefined ? raw("") : html`: ${edge.label}`}</li>`))}</ul></details></figure>`
}
