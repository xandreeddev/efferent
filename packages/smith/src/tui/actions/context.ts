import { Option } from "effect"
import { STANDING_SOURCES } from "../../context/context-set.entity.js"
import type { StandingSource } from "../../context/context-set.entity.js"
import { fmtChars } from "../../context/assemble.js"
import { openSelect } from "../presentation/selectBox.js"
import type { SelectOption } from "../presentation/selectBox.js"
import { pinLine, standingLine } from "../presentation/contextView.js"
import type { SmithTuiContext } from "../state/store.js"

/**
 * The `:context` drivers — the ONE select overlay again: the menu lists the
 * standing sources (⏎ toggles), the pins (⏎ opens the pin's verbs), and the
 * actions (preview · clear · budget). Everything the menu does, the command
 * forms do too (`:context add|drop|on|off|show|clear|budget`), so a
 * scripted session and a human reach the same capability.
 */

export const CONTEXT_USAGE =
  "usage: :context [add <ref> | drop <n|ref> | on|off <n|ref|rules|lessons|memory|doctrine> | show | clear | budget <chars>]"

export const BUDGET_PRESETS: ReadonlyArray<number> = [8_000, 16_000, 24_000, 48_000, 96_000]

const isStanding = (token: string): token is StandingSource =>
  (STANDING_SOURCES as ReadonlyArray<string>).includes(token)

export const openContextMenu = (ctx: SmithTuiContext): void => {
  const view = ctx.store.context()
  const standing: ReadonlyArray<SelectOption<Option.Option<string>>> = view.standing.map((line) => ({
    value: Option.some(`standing:${line.name}`),
    label: standingLine(line),
    tag: line.on ? "on" : "off",
    desc: "⏎ toggles",
  }))
  const pins: ReadonlyArray<SelectOption<Option.Option<string>>> = view.pins.map((line) => ({
    value: Option.some(`pin:${line.index}`),
    label: pinLine(line),
    tag: line.kind,
    desc: "⏎ for its verbs",
  }))
  const actions: ReadonlyArray<SelectOption<Option.Option<string>>> = [
    { value: Option.some("action:show"), label: "preview", desc: "assemble now and show what the next turn carries", action: true },
    { value: Option.some("action:add"), label: "add…", desc: "type :context add <path | dir/ | glob | note: … | spec:… | run:… | diff[:ref] | cmd: …>", action: true },
    { value: Option.some("action:budget"), label: "budget", desc: `the pins' cap — now ${fmtChars(view.budgetChars)} chars`, action: true },
    { value: Option.some("action:clear"), label: "clear pins", desc: "drop every pin (standing sources stay)", action: true },
  ]
  ctx.store.setDashboardFocus(Option.none())
  ctx.store.setOverlay({
    kind: "select",
    purpose: { tag: "context" },
    sel: openSelect("context — what the model sees", [...standing, ...pins, ...actions]),
  })
}

const openPinVerbs = (ctx: SmithTuiContext, index: number): void => {
  const line = ctx.store.context().pins[index]
  if (line === undefined) return
  ctx.store.setOverlay({
    kind: "select",
    purpose: { tag: "context-pin", index },
    sel: openSelect(`pin ${line.label}`, [
      { value: Option.some("toggle"), label: line.on ? "switch off" : "switch on", desc: "keep it, but out of the next turn" },
      { value: Option.some("remove"), label: "remove", desc: "drop the pin" },
    ]),
  })
}

const openBudgetPicker = (ctx: SmithTuiContext): void => {
  const current = ctx.store.context().budgetChars
  ctx.store.setOverlay({
    kind: "select",
    purpose: { tag: "context-budget" },
    sel: openSelect(
      "pins budget (chars)",
      BUDGET_PRESETS.map((chars) => ({
        value: Option.some(String(chars)),
        label: fmtChars(chars),
        active: chars === current,
        desc: `≈ ${fmtChars(Math.ceil(chars / 4))} tokens`,
      })),
    ),
  })
}

/** ⏎ on the context menu. */
export const submitContextMenu = (ctx: SmithTuiContext, value: Option.Option<string>): void => {
  ctx.store.closeOverlay()
  const actions = ctx.context
  if (actions === undefined) {
    ctx.store.setNotice("the context set only applies in the workspace session")
    return
  }
  const picked = Option.getOrElse(value, () => "")
  if (picked.startsWith("standing:")) {
    const name = picked.slice("standing:".length)
    return isStanding(name) ? actions.toggle(name) : ctx.store.setNotice(CONTEXT_USAGE)
  }
  if (picked.startsWith("pin:")) return openPinVerbs(ctx, Number(picked.slice("pin:".length)))
  if (picked === "action:show") return actions.preview()
  if (picked === "action:add") return ctx.store.setNotice("type :context add <ref> — " + CONTEXT_USAGE.slice("usage: ".length))
  if (picked === "action:budget") return openBudgetPicker(ctx)
  if (picked === "action:clear") return actions.clear()
  ctx.store.setNotice("nothing selected")
}

/** ⏎ on a pin's verbs. */
export const submitContextPin = (ctx: SmithTuiContext, index: number, value: Option.Option<string>): void => {
  ctx.store.closeOverlay()
  const actions = ctx.context
  if (actions === undefined) return
  const verb = Option.getOrElse(value, () => "")
  const line = ctx.store.context().pins[index]
  if (verb === "toggle") return actions.setPin(String(index + 1), !(line?.on ?? true))
  if (verb === "remove") return actions.drop(String(index + 1))
  ctx.store.setNotice("nothing selected")
}

/** ⏎ on the budget picker. */
export const submitContextBudget = (ctx: SmithTuiContext, value: Option.Option<string>): void => {
  ctx.store.closeOverlay()
  Option.match(Option.fromNullishOr(ctx.context), {
    onNone: () => ctx.store.setNotice("the context set only applies in the workspace session"),
    onSome: (actions) =>
      Option.match(Option.map(value, Number), {
        onNone: () => ctx.store.setNotice("nothing selected"),
        onSome: (chars) => actions.budget(chars),
      }),
  })
}

/** `Nk` or a plain number of chars. */
export const parseBudget = (token: string): Option.Option<number> => {
  const m = /^(\d+(?:\.\d+)?)(k)?$/i.exec(token.trim())
  if (m === null) return Option.none()
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? Option.some(m[2] !== undefined ? n * 1_000 : n) : Option.none()
}

/** The `:context …` command family. */
export const runContextCommand = (ctx: SmithTuiContext, words: ReadonlyArray<string>): void => {
  const actions = ctx.context
  if (actions === undefined) {
    ctx.store.setNotice("the context set only applies in the workspace session")
    return
  }
  const [verb, ...rest] = words
  const arg = rest.join(" ").trim()
  if (verb === undefined || verb.length === 0) return openContextMenu(ctx)
  if (verb === "add") return arg.length > 0 ? actions.add(arg) : ctx.store.setNotice(CONTEXT_USAGE)
  if (verb === "drop" || verb === "rm") return arg.length > 0 ? actions.drop(arg) : ctx.store.setNotice(CONTEXT_USAGE)
  if (verb === "on" || verb === "off") {
    if (arg.length === 0) return ctx.store.setNotice(CONTEXT_USAGE)
    return isStanding(arg) ? actions.set(arg, verb === "on") : actions.setPin(arg, verb === "on")
  }
  if (verb === "show" || verb === "preview") return actions.preview()
  if (verb === "clear") return actions.clear()
  if (verb === "budget") {
    if (arg.length === 0) return openBudgetPicker(ctx)
    return Option.match(parseBudget(arg), {
      onNone: () => ctx.store.setNotice("budget: a number of chars, e.g. 24000 or 24k"),
      onSome: (chars) => actions.budget(chars),
    })
  }
  ctx.store.setNotice(CONTEXT_USAGE)
}
