import { Result, Match, Option } from "effect"
import { ContextSet } from "./context-set.entity.js"
import type { ContextPin, StandingSource } from "./context-set.entity.js"

export const DEFAULT_BUDGET_CHARS = 24_000
const MIN_BUDGET_CHARS = 1_000
const MAX_BUDGET_CHARS = 200_000

export const emptyContextSet = new ContextSet({
  version: 1,
  off: [],
  pins: [],
  budgetChars: DEFAULT_BUDGET_CHARS,
})

export const isStandingOn = (set: ContextSet, name: StandingSource): boolean =>
  !set.off.includes(name)

export const toggleStanding = (set: ContextSet, name: StandingSource): ContextSet =>
  new ContextSet({
    ...set,
    off: set.off.includes(name) ? set.off.filter((n) => n !== name) : [...set.off, name],
  })

/** The pin as the human typed it — its identity (two pins with the same
 *  ref are the same pin) and its label. */
export const renderPinRef = (pin: ContextPin): string =>
  Match.value(pin).pipe(
    Match.tag("file", (p) => p.path),
    Match.tag("dir", (p) => `${p.path}/`),
    Match.tag("glob", (p) => p.pattern),
    Match.tag("note", (p) => `note: ${p.text}`),
    Match.tag("spec", (p) => `spec:${p.slug}`),
    Match.tag("run", (p) => `run:${p.id}`),
    Match.tag("diff", (p) =>
      Option.match(p.ref, { onNone: () => "diff", onSome: (ref) => `diff:${ref}` }),
    ),
    Match.tag("cmd", (p) => `cmd: ${p.command}`),
    Match.exhaustive,
  )

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

export const pinLabel = (pin: ContextPin): string => clip(renderPinRef(pin), 48)

/** Add (or replace) a pin — the same ref pins once. */
export const withPin = (set: ContextSet, pin: ContextPin): ContextSet =>
  new ContextSet({
    ...set,
    pins: [...set.pins.filter((p) => renderPinRef(p) !== renderPinRef(pin)), pin],
  })

export const withoutPin = (set: ContextSet, index: number): ContextSet =>
  new ContextSet({ ...set, pins: set.pins.filter((_, i) => i !== index) })

export const togglePin = (set: ContextSet, index: number): ContextSet =>
  new ContextSet({
    ...set,
    pins: set.pins.map((p, i) => (i === index ? { ...p, on: !p.on } : p)),
  })

export const clearPins = (set: ContextSet): ContextSet => new ContextSet({ ...set, pins: [] })

export const withBudget = (set: ContextSet, chars: number): ContextSet =>
  new ContextSet({
    ...set,
    budgetChars: Math.min(MAX_BUDGET_CHARS, Math.max(MIN_BUDGET_CHARS, Math.round(chars))),
  })

/** A pin index or a ref, as typed after `:context drop|on|off`. */
export const findPinIndex = (set: ContextSet, token: string): Option.Option<number> => {
  const asNumber = Number(token)
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= set.pins.length) {
    return Option.some(asNumber - 1)
  }
  const byRef = set.pins.findIndex((p) => renderPinRef(p) === token.trim())
  return byRef >= 0 ? Option.some(byRef) : Option.none()
}

export const PIN_GRAMMAR =
  "a path, a dir/, a glob, note: <text>, spec:<slug>, run:<id>, diff[:<ref>], or cmd: <command>"

/** The `:context add <ref>` grammar → a pin, or what was wrong with it. */
export const parsePinRef = (raw: string): Result.Result<ContextPin, string> => {
  const text = raw.trim()
  if (text.length === 0) return Result.fail(`nothing to add — ${PIN_GRAMMAR}`)
  const lower = text.toLowerCase()
  const after = (prefix: string): string => text.slice(prefix.length).trim()
  if (lower.startsWith("note:")) {
    const body = after("note:")
    return body.length > 0
      ? Result.succeed({ _tag: "note", text: body, on: true })
      : Result.fail("note: needs the text after it")
  }
  if (lower.startsWith("cmd:")) {
    const command = after("cmd:")
    return command.length > 0
      ? Result.succeed({ _tag: "cmd", command, on: true })
      : Result.fail("cmd: needs a command after it")
  }
  if (lower === "diff") return Result.succeed({ _tag: "diff", ref: Option.none(), on: true })
  if (lower.startsWith("diff:")) {
    const ref = after("diff:")
    return Result.succeed({
      _tag: "diff",
      ref: ref.length > 0 ? Option.some(ref) : Option.none(),
      on: true,
    })
  }
  if (lower.startsWith("spec:")) {
    const slug = after("spec:")
    return slug.length > 0
      ? Result.succeed({ _tag: "spec", slug, on: true })
      : Result.fail("spec: needs a slug after it")
  }
  if (lower.startsWith("run:")) {
    const id = after("run:")
    return id.length > 0
      ? Result.succeed({ _tag: "run", id, on: true })
      : Result.fail("run: needs a run id after it")
  }
  const path = text.startsWith("@") ? text.slice(1) : text
  if (path.length === 0) return Result.fail(`nothing to add — ${PIN_GRAMMAR}`)
  if (/[*?[\]{}]/.test(path)) return Result.succeed({ _tag: "glob", pattern: path, on: true })
  if (path.endsWith("/")) {
    const dir = path.replace(/\/+$/, "")
    return Result.succeed({ _tag: "dir", path: dir.length > 0 ? dir : ".", on: true })
  }
  return Result.succeed({ _tag: "file", path, on: true })
}

export const setPinOn = (set: ContextSet, index: number, on: boolean): ContextSet =>
  new ContextSet({ ...set, pins: set.pins.map((p, i) => (i === index ? { ...p, on } : p)) })
