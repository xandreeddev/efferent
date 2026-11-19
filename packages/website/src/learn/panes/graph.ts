// The Graph tab (lesson 18): the memory the knowledge session holds, drawn
// as entities and the memories between them (thicker the more often said, an
// ended one dashed, one about a single entity listed under it), with what the
// latest curation kept and what the latest recall sent lit on top; then what
// that curation did, in words, and the recall's steps, picked by turn and
// model call (the latest by default). It draws what graph-model.ts gives;
// every name, sentence and question is a text node, never markup.
import { Option } from "effect"
import type { CurationView, EdgeView, MemoryView, RecallRow, RecallView, ThingView } from "../graph-model.ts"

/** One recall the picker offers: its value and its name. */
export interface RecallChoice {
  readonly value: string
  readonly label: string
}

/** What the tab draws: the memory, or why there is none; the latest curation; and the recall picked. */
export interface GraphPaneView {
  readonly memory: Option.Option<MemoryView>
  readonly empty: string
  readonly everything: boolean
  readonly curation: Option.Option<CurationView>
  readonly choices: ReadonlyArray<RecallChoice>
  readonly picked: string
  /** Which turn and model call the recall drawn is ("Turn 3, model call 1 of 2"), the latest one included. */
  readonly shown: string
  readonly recall: Option.Option<RecallView>
  readonly noRecall: string
}

export interface GraphPane {
  readonly render: (view: GraphPaneView) => void
}

/** The picker's value for the latest recall. */
export const LATEST = "latest"

const SVG = "http://www.w3.org/2000/svg"
/** The picture's measures: the room a column of entities takes, a row's height, and the margin around it. */
const COLUMN = 240
const ROW = 40
const PAD = 14
/** The most characters of a name, or of a memory under it, the picture writes; the whole is in its title. */
const LABEL = 26
const ALONE = 32

const el = (tag: string, attrs: Readonly<Record<string, string>> = {}, ...children: ReadonlyArray<Node | string>): HTMLElement => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  node.append(...children)
  return node
}
const svg = (tag: string, attrs: Readonly<Record<string, string>> = {}, ...children: ReadonlyArray<Node>): SVGElement => {
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
const texted = (attrs: Readonly<Record<string, string>>, text: string): SVGElement => {
  const node = svg("text", attrs)
  node.textContent = text
  return node
}
const clipped = (text: string, most: number): string => (text.length > most ? `${text.slice(0, most - 1)}…` : text)

/** How wide one character of a name is, in the picture's 11px monospace font. */
const CHAR = 6.7
/** Room on the left of the first column, for a memory between two entities of one column, drawn as a curve there. */
const LEFT = 30

/** Where an entity's dot is. */
const at = (thing: ThingView) => ({ x: PAD + LEFT + thing.column * COLUMN, y: PAD + thing.row * ROW + 6 })
/** Where an entity's name ends: a memory leaves from there, so it never crosses the name of the entity it starts at. */
const nameEnd = (thing: ThingView): number => at(thing).x + 9 + clipped(thing.label, LABEL).length * CHAR + 4

/** A light's data attribute, when there is one. */
const lit = (light: Option.Option<string>): Readonly<Record<string, string>> => Option.match(light, { onNone: () => ({}), onSome: (how) => ({ "data-light": how }) })

/** The picture of the memory: an SVG sized to the entities it draws. */
const picture = (view: MemoryView): SVGElement => {
  const columns = Math.max(0, ...view.things.map((thing) => thing.column))
  const rows = Math.max(1, ...view.things.map((thing) => thing.row + 1))
  const width = PAD * 2 + LEFT + columns * COLUMN + 220
  const height = PAD * 2 + rows * ROW
  const byKey = new Map(view.things.map((thing) => [thing.key, thing]))
  // The memories not lit first, so the lit ones are drawn over them.
  const edges = [...view.edges].sort((a, b) => Number(Option.isSome(a.light)) - Number(Option.isSome(b.light))).flatMap((edge: EdgeView) => {
    const from = byKey.get(edge.from)
    const to = byKey.get(edge.to)
    if (from === undefined || to === undefined) return []
    const a = at(from)
    const b = at(to)
    const forward = to.column > from.column
    const backward = to.column < from.column
    const attrs = { class: "grp-edge", "stroke-width": String(edge.width), ...(edge.ended ? { "stroke-dasharray": "5 4" } : {}) }
    // A memory to an entity further right leaves from the end of its subject's name; one back, from the end of the
    // other's; one between two entities of a column is a curve on the left.
    const line = forward ? svg("line", { ...attrs, x1: String(nameEnd(from)), y1: String(a.y), x2: String(b.x - 7), y2: String(b.y) }, titled(edge.title))
      : backward ? svg("line", { ...attrs, x1: String(nameEnd(to)), y1: String(b.y), x2: String(a.x - 7), y2: String(a.y) }, titled(edge.title))
        : svg("path", { ...attrs, d: `M ${a.x - 5} ${a.y} C ${a.x - LEFT} ${a.y}, ${b.x - LEFT} ${b.y}, ${b.x - 5} ${b.y}`, fill: "none" }, titled(edge.title))
    return [svg("g", { class: "grp-link", "data-memory": edge.id, ...lit(edge.light), ...(edge.ended ? { "data-ended": "" } : {}) }, line)]
  })
  const things = view.things.map((thing) => {
    const { x, y } = at(thing)
    const alone = thing.alone.length === 0 ? [] : [texted({ x: String(x + 9), y: String(y + 17), class: "grp-alone" }, clipped(thing.alone.length === 1 ? thing.alone[0]! : `${thing.alone[0]!} (+${thing.alone.length - 1})`, ALONE))]
    return svg("g", { class: "grp-thing", "data-entity": thing.key, ...lit(thing.light) },
      titled([thing.title, ...thing.alone].join("\n")),
      svg("circle", { cx: String(x), cy: String(y), r: "5", class: "grp-dot" }),
      texted({ x: String(x + 9), y: String(y + 4), class: "grp-name" }, clipped(thing.label, LABEL)), ...alone)
  })
  return svg("svg", { class: "grp-svg", viewBox: `0 0 ${width} ${height}`, width: String(width), height: String(height), role: "img", "aria-label": "The memory: each entity a dot, each memory between two entities a line" },
    ...edges, ...things)
}

/** One memory of a recall, as the panel lists it. */
const rowOf = (row: RecallRow): HTMLElement =>
  el("li", { class: "grp-row", ...(row.sent ? { "data-sent": "" } : {}) },
    el("span", { class: "grp-row-head" }, el("code", {}, row.id), ` ${row.text} `, el("span", { class: "grp-mark" }, row.sent ? "✔ sent" : "✗ not sent")),
    el("span", { class: "grp-row-detail" }, row.how.join(" · ")),
    el("span", { class: "grp-why" }, row.why),
    ...row.before.map((text) => el("span", { class: "grp-row-detail" }, `before that: ${text}`)))

/** How many memories that were not sent a list shows before the rest are folded away. */
const NOT_SENT_SHOWN = 5

/**
 * A list of a recall's memories: every one that was sent, the first few that were not (the next in line), and the
 * rest of those folded under a line that counts them, so a recall over many memories does not bury what was sent.
 */
const rowsOf = (rows: ReadonlyArray<RecallRow>): ReadonlyArray<HTMLElement> => {
  const unsent = rows.filter((row) => !row.sent)
  const folded = new Set(unsent.slice(NOT_SENT_SHOWN))
  const shown = rows.filter((row) => !folded.has(row))
  const rest = rows.filter((row) => folded.has(row))
  return [
    el("ol", { class: "grp-rows" }, ...shown.map(rowOf)),
    ...(rest.length === 0 ? [] : [el("details", { class: "grp-folded" },
      el("summary", {}, `${rest.length} more ${rest.length === 1 ? "memory" : "memories"} not sent`),
      el("ol", { class: "grp-rows" }, ...rest.map(rowOf)))]),
  ]
}

/** The recall's steps, in words. */
const stepsOf = (view: RecallView): ReadonlyArray<HTMLElement> => [
  el("li", {}, el("strong", {}, "1. The seeds: what your message named"), el("ul", { class: "grp-named" }, ...view.seeds.map((line) => el("li", {}, line)))),
  el("li", {}, el("strong", {}, `2. ${view.lists}`),
    ...Option.toArray(Option.map(view.byMeaning, (line) => el("p", { class: "grp-more", "data-grp-meaning": "" }, line))),
    ...(view.ranked.length === 0 ? [el("p", {}, "None.")] : rowsOf(view.ranked))),
  el("li", {}, el("strong", {}, "3. The walk by subject"),
    ...(view.bridges.length === 0 ? [el("p", {}, "It started from nothing: the best memories about the seeds brought in no entity your message did not name.")]
      : [el("ul", { class: "grp-named" }, ...view.bridges.map((line) => el("li", {}, line)))]),
    ...(view.walked.length === 0 ? [] : rowsOf(view.walked))),
  el("li", {}, el("strong", {}, "4. What was sent"), el("p", {}, view.sent), ...Option.toArray(Option.map(view.more, (more) => el("p", { class: "grp-more" }, more)))),
]

export const mountGraph = (host: HTMLElement, handlers: { readonly pick: (value: string) => void; readonly everything: (on: boolean) => void }): GraphPane => {
  const find = <T extends HTMLElement>(selector: string): T => {
    const found = host.querySelector<T>(selector)
    if (!found) throw new Error(`the Graph tab is missing ${selector}`)
    return found
  }
  const empty = find("[data-grp-empty]")
  const body = find("[data-grp-body]")
  const heading = find("[data-grp-heading]")
  const counts = find("[data-grp-counts]")
  const all = find<HTMLButtonElement>("[data-grp-all]")
  const drawing = find("[data-grp-picture]")
  const curationHead = find("[data-grp-curation-head]")
  const curation = find("[data-grp-curation]")
  const pick = find<HTMLSelectElement>("[data-grp-pick]")
  const options = find("[data-grp-options]")
  const question = find("[data-grp-question]")
  const steps = find("[data-grp-steps]")
  let everything = false
  pick.addEventListener("change", () => handlers.pick(pick.value))
  all.addEventListener("click", () => handlers.everything(!everything))
  /** What was drawn last: the same view is not drawn again, so a reader's scroll stays where it is. */
  let drawnMemory: MemoryView | undefined
  let drawnCuration: Option.Option<CurationView> | undefined
  let drawnRecall: RecallView | undefined
  let named = ""

  const render = (shown: GraphPaneView) => {
    everything = shown.everything
    all.textContent = everything ? "Show what the conversation named" : "Show everything"
    all.setAttribute("aria-pressed", String(everything))
    Option.match(shown.memory, {
      onNone: () => {
        empty.hidden = false
        empty.textContent = shown.empty
        body.hidden = true
        drawnMemory = undefined
      },
      onSome: (view) => {
        empty.hidden = true
        body.hidden = false
        if (view === drawnMemory) return
        drawnMemory = view
        heading.textContent = view.heading
        counts.textContent = view.counts
        drawing.replaceChildren(picture(view))
      },
    })
    if (shown.curation !== drawnCuration) {
      drawnCuration = shown.curation
      Option.match(shown.curation, {
        onNone: () => {
          curationHead.textContent = "No turn has been curated yet."
          curation.replaceChildren()
        },
        onSome: (view) => {
          curationHead.textContent = view.heading
          curation.replaceChildren(...view.lines.map((line) => el("li", {}, line)))
        },
      })
    }
    pick.replaceChildren(...[{ value: LATEST, label: "the latest request" }, ...shown.choices].map((choice) => {
      const option = el("option", { value: choice.value }, choice.label)
      if (choice.value === shown.picked) option.setAttribute("selected", "")
      return option
    }))
    pick.value = shown.picked
    Option.match(shown.recall, {
      onNone: () => {
        question.textContent = shown.noRecall
        options.textContent = ""
        steps.replaceChildren()
        drawnRecall = undefined
      },
      onSome: (view) => {
        if (view === drawnRecall && shown.shown === named) return
        drawnRecall = view
        named = shown.shown
        question.textContent = `${shown.shown}. Your message: “${view.question}”`
        options.textContent = view.options
        steps.replaceChildren(...stepsOf(view))
      },
    })
  }
  return { render }
}
