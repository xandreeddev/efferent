// The Graph tab (lesson 18): what the walk of one model call did. A picker
// of the walks heard (the latest by default), the question, a picture of
// the links the walk reached (the things named on the left, then one column
// for each link further away; the links sent lit, the rest dimmed, each
// drawn from the thing the walk reached it from, thicker the more often it
// was said), and the walk's steps in words. It draws what graph-model.ts
// gives; every name and question is a text node, never markup.
import { Option } from "effect"
import type { EdgeView, GraphView, RankedRow, ThingView } from "../graph-model.ts"

/** One walk the picker offers: its value and its name. */
export interface RecallChoice {
  readonly value: string
  readonly label: string
}

/** What the tab draws: the walks to pick from, the one picked, and its view, or why there is none. */
export interface GraphPaneView {
  readonly choices: ReadonlyArray<RecallChoice>
  readonly picked: string
  /** Which turn and model call the walk drawn is ("Turn 3, model call 1 of 2"), the latest one included. */
  readonly shown: string
  readonly view: Option.Option<GraphView>
  readonly empty: string
}

export interface GraphPane {
  readonly render: (view: GraphPaneView) => void
}

/** The picker's value for the latest walk. */
export const LATEST = "latest"

const SVG = "http://www.w3.org/2000/svg"
/** The picture's measures: the room a column of things takes, a row's height, and the margin around it. */
const COLUMN = 230
const ROW = 34
const PAD = 14
/** The most characters of a thing's name the picture writes; the whole name is in its title. */
const LABEL = 26

const el = (tag: string, attrs: Record<string, string> = {}, ...children: ReadonlyArray<Node | string>): HTMLElement => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  node.append(...children)
  return node
}
const svg = (tag: string, attrs: Record<string, string> = {}, ...children: ReadonlyArray<Node>): SVGElement => {
  const node = document.createElementNS(SVG, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  node.append(...children)
  return node
}
const titled = (text: string): SVGElement => {
  const title = document.createElementNS(SVG, "title")
  title.textContent = text
  return title
}
const clipped = (text: string): string => (text.length > LABEL ? `${text.slice(0, LABEL - 1)}…` : text)

/** How wide one character of a name is, in the picture's 11px monospace font. */
const CHAR = 6.7

/** Where a thing's name ends: a link leaves from there, so it never crosses the name of the thing it starts at. */
const nameEnd = (thing: ThingView): number => at(thing).x + 9 + clipped(thing.label).length * CHAR + 4

/** Where a thing's dot is. */
const at = (thing: ThingView) => ({ x: PAD + LEFT + thing.column * COLUMN, y: PAD + thing.row * ROW + 6 })

/** Room on the left of the first column, for a link that goes back or stays in its column, drawn as a curve there. */
const LEFT = 30

/** The picture of one walk: an SVG sized to the things it draws. */
const picture = (view: GraphView): SVGElement => {
  const columns = Math.max(0, ...view.things.map((thing) => thing.column))
  const rows = Math.max(1, ...view.things.map((thing) => thing.row + 1))
  const width = PAD * 2 + LEFT + columns * COLUMN + 190
  const height = PAD * 2 + rows * ROW
  const byKey = new Map(view.things.map((thing) => [thing.key, thing]))
  // Arrowheads sized in the picture's own units, not by the line's width, so a link said often keeps a small head;
  // a sent link's head takes its colour.
  const marker = (id: string, head: string) => svg("marker", { id, viewBox: "0 0 10 10", refX: "10", refY: "5", markerUnits: "userSpaceOnUse", markerWidth: "8", markerHeight: "8", orient: "auto-start-reverse" },
    svg("path", { d: "M 0 0 L 10 5 L 0 10 z", class: head }))
  // The links not sent first, so the ones sent are drawn over them.
  const edges = [...view.edges].sort((a, b) => Number(a.sent) - Number(b.sent) || b.rank - a.rank).flatMap((edge: EdgeView) => {
    const from = byKey.get(edge.from)
    const to = byKey.get(edge.to)
    if (from === undefined || to === undefined) return []
    const a = at(from)
    const b = at(to)
    const sent = edge.sent ? { "data-sent": "" } : {}
    const head = edge.sent ? "url(#grp-arrow-sent)" : "url(#grp-arrow)"
    // A link to a thing further right leaves from the end of its thing's name, so it never crosses that name; one that
    // stays in its column or goes back (to a thing the walk reached sooner by another link) is a curve on the left.
    const forward = to.column > from.column
    const start = nameEnd(from)
    const line = forward
      ? svg("line", { x1: String(start), y1: String(a.y), x2: String(b.x - 7), y2: String(b.y), class: "grp-edge", "stroke-width": String(edge.width), "marker-end": head, ...sent }, titled(edge.title))
      : svg("path", { d: `M ${a.x - 5} ${a.y} C ${a.x - LEFT} ${a.y}, ${b.x - LEFT} ${b.y}, ${b.x - 7} ${b.y}`, fill: "none", class: "grp-edge", "stroke-width": String(edge.width), "marker-end": head, ...sent }, titled(edge.title))
    // The label sits past the middle of the line it names, where lines from one thing to things a row apart are apart
    // too, so labels do not lie on each other; a curve on the left is labelled with its rank alone, beside it.
    const along = 0.55
    const label = !edge.sent ? [] : forward
      ? [svg("text", { x: String(start + (b.x - start) * along - 30), y: String(a.y + (b.y - a.y) * along - 4), class: "grp-relation" })]
      : [svg("text", { x: String(Math.min(a.x, b.x) - LEFT + 2), y: String((a.y + b.y) / 2 + 4), class: "grp-relation" })]
    label.forEach((text) => { text.textContent = forward ? `${edge.rank}. ${edge.relation}` : `${edge.rank}.` })
    return [svg("g", { class: "grp-link", "data-rank": String(edge.rank), ...sent }, line, ...label)]
  })
  const things = view.things.map((thing) => {
    const { x, y } = at(thing)
    const name = svg("text", { x: String(x + 9), y: String(y + 4), class: "grp-name" })
    name.textContent = clipped(thing.label)
    return svg("g", { class: "grp-thing", ...Option.match(thing.named, { onNone: () => ({}), onSome: (how) => ({ "data-named": how }) }) },
      titled(Option.match(thing.named, { onNone: () => thing.label, onSome: (how) => `${thing.label}: named by the question (${how})` })),
      svg("circle", { cx: String(x), cy: String(y), r: "5", class: "grp-dot" }), name)
  })
  return svg("svg", { class: "grp-svg", viewBox: `0 0 ${width} ${height}`, width: String(width), height: String(height), role: "img", "aria-label": "The links the walk reached: the things named on the left, each link from the thing the walk reached it from" },
    svg("defs", {}, marker("grp-arrow", "grp-head"), marker("grp-arrow-sent", "grp-head-sent")), ...edges, ...things)
}

/** One link of the walk, as the panel lists it. */
const rowOf = (row: RankedRow): HTMLElement =>
  el("li", { class: "grp-row", ...(row.sent ? { "data-sent": "" } : {}) },
    el("span", { class: "grp-row-head" },
      el("span", { class: "grp-rank" }, `${row.rank}.`),
      el("code", {}, row.id),
      ` ${row.sentence} `,
      el("span", { class: "grp-mark" }, row.sent ? "✔ sent" : "✗ not sent")),
    el("span", { class: "grp-row-detail" },
      [row.reached, row.met.length === 0 ? "met no word" : `met: ${row.met.join(", ")}`, row.said, ...Option.toArray(row.weight)].join(" · ")),
    ...Option.toArray(Option.map(row.why, (why) => el("span", { class: "grp-why" }, `Not sent: ${why}.`))))

/** The walk's steps, in words. */
const stepsOf = (view: GraphView): ReadonlyArray<HTMLElement> => [
  el("li", {}, el("strong", {}, "1. What the question named"),
    ...Option.match(view.nothing, {
      onSome: (nothing) => [el("p", {}, nothing)],
      onNone: () => [el("ul", { class: "grp-named" }, ...view.named.map((line) => el("li", {}, line)))],
    })),
  el("li", {}, el("strong", {}, "2. The walk"), el("p", {}, view.walk),
    ...(view.rows.length === 0 ? [] : [el("ol", { class: "grp-rows" }, ...view.rows.map(rowOf))]),
    ...Option.toArray(Option.map(view.more, (more) => el("p", { class: "grp-more" }, more)))),
  el("li", {}, el("strong", {}, "3. What was sent"), el("p", {}, view.sent)),
]

export const mountGraph = (host: HTMLElement, handlers: { readonly pick: (value: string) => void }): GraphPane => {
  const find = <T extends HTMLElement>(selector: string): T => {
    const found = host.querySelector<T>(selector)
    if (!found) throw new Error(`the Graph tab is missing ${selector}`)
    return found
  }
  const pick = find<HTMLSelectElement>("[data-grp-pick]")
  const empty = find("[data-grp-empty]")
  const body = find("[data-grp-body]")
  const question = find("[data-grp-question]")
  const options = find("[data-grp-options]")
  const drawing = find("[data-grp-picture]")
  const steps = find("[data-grp-steps]")
  pick.addEventListener("change", () => handlers.pick(pick.value))
  /** The walk drawn last: the same walk is not drawn again, so a reader's scroll stays where it is. */
  let drawn: GraphView | undefined
  /** The name of the walk drawn last: a walk of the same turn gains a call, and its name changes. */
  let named = ""

  const render = (shown: GraphPaneView) => {
    pick.replaceChildren(...[{ value: LATEST, label: "The latest" }, ...shown.choices].map((choice) => {
      const option = el("option", { value: choice.value }, choice.label)
      if (choice.value === shown.picked) option.setAttribute("selected", "")
      return option
    }))
    pick.value = shown.picked
    Option.match(shown.view, {
      onNone: () => {
        empty.hidden = false
        empty.textContent = shown.empty
        body.hidden = true
        drawn = undefined
      },
      onSome: (view) => {
        empty.hidden = true
        body.hidden = false
        if (view === drawn && shown.shown === named) return
        drawn = view
        named = shown.shown
        question.textContent = `${shown.shown}. The question: “${view.question}”`
        options.textContent = view.options
        drawing.replaceChildren(picture(view))
        steps.replaceChildren(...stepsOf(view))
      },
    })
  }
  return { render }
}
