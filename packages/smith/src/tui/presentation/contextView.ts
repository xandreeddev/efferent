import { Option } from "effect"
import type { BlockStatus, ContextBundle } from "../../context/assemble.js"
import { approxTokens, fmtChars } from "../../context/assemble.js"
import type { ContextSet, StandingSource } from "../../context/context-set.entity.js"
import { isStandingOn, pinLabel } from "../../context/context-set.entity.functions.js"
import type { StandingSources } from "../../context/standing.js"

/**
 * The context PANEL's view model — what the model will be handed, source by
 * source, with sizes: the standing sources (on/off + measured chars) and the
 * pins (status + chars from the last measurement). Pure; the runtime folds a
 * fresh measurement into it after every change and every workspace refresh.
 */

export interface StandingLine {
  readonly name: StandingSource
  readonly on: boolean
  readonly chars: number
}

export interface PinLine {
  readonly index: number
  readonly label: string
  readonly kind: string
  readonly on: boolean
  readonly status: BlockStatus
  readonly chars: number
}

export interface ContextView {
  readonly standing: ReadonlyArray<StandingLine>
  readonly pins: ReadonlyArray<PinLine>
  /** Chars the pins add (measured; shell-backed pins count once assembled). */
  readonly pinChars: number
  readonly standingChars: number
  readonly budgetChars: number
}

export const emptyContextView: ContextView = {
  standing: [],
  pins: [],
  pinChars: 0,
  standingChars: 0,
  budgetChars: 0,
}

export const contextView = (
  set: ContextSet,
  standing: StandingSources,
  bundle: ContextBundle,
): ContextView => ({
  standing: standing.measured.map((m) => ({ name: m.name, on: isStandingOn(set, m.name), chars: m.chars })),
  pins: set.pins.map((pin, index) => {
    const block = Option.fromNullishOr(bundle.blocks[index])
    return {
      index,
      label: pinLabel(pin),
      kind: pin._tag,
      on: pin.on,
      status: Option.match(block, { onNone: () => "off" as const, onSome: (b) => b.status }),
      chars: Option.match(block, { onNone: () => 0, onSome: (b) => b.chars }),
    }
  }),
  pinChars: bundle.totalChars,
  standingChars: standing.measured.filter((m) => m.on).reduce((sum, m) => sum + m.chars, 0),
  budgetChars: set.budgetChars,
})

export const STANDING_LABEL: Record<StandingSource, string> = {
  rules: "rules file",
  lessons: "forge lessons",
  memory: "workspace memory",
  doctrine: "quality bar",
}

/** `8.3k chars ≈ 2.1k tokens (budget 24k)` — the panel's headline. */
export const contextHeadline = (view: ContextView): string => {
  const total = view.pinChars + view.standingChars
  return `${fmtChars(total)} chars ≈ ${fmtChars(approxTokens(total))} tokens · pins ${fmtChars(view.pinChars)} of ${fmtChars(view.budgetChars)}`
}

/** One standing line: `✓ rules file 2.1k` / `◌ forge lessons off`. */
export const standingLine = (line: StandingLine): string =>
  line.on
    ? `${STANDING_LABEL[line.name]} ${line.chars > 0 ? fmtChars(line.chars) : "(empty)"}`
    : `${STANDING_LABEL[line.name]} off`

/** One pin line: `src/x.ts 3.2k` / `diff deferred` / `missing.ts missing`. */
export const pinLine = (line: PinLine): string =>
  !line.on
    ? `${line.label} off`
    : line.status === "included" || line.status === "clipped"
      ? `${line.label} ${fmtChars(line.chars)}${line.status === "clipped" ? " (clipped)" : ""}`
      : `${line.label} ${line.status}`
