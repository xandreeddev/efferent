import { Match, Option } from "effect"
import {
  loginAdvance,
  loginAppend,
  loginBack,
  loginBackspace,
  loginMove,
} from "./presentation/loginFlow.js"
import type { LoginFlow } from "./presentation/loginFlow.js"
import {
  filterAppend,
  filterBackspace,
  moveSelect,
  selectedValue,
} from "./presentation/selectBox.js"
import { customRow } from "./presentation/modelCatalog.js"
import { openSelect } from "./presentation/selectBox.js"
import { advanceLogin, stopOAuthSession } from "./actions/login.js"
import { submitModel } from "./actions/model.js"
import { logout } from "./actions/login.js"
import type { Overlay, SmithTuiContext } from "./state/store.js"

/** The structural slice of OpenTUI's ParsedKey smith cares about. */
export interface Key {
  readonly name: string
  readonly ctrl?: boolean
  /** The literal characters typed (printables ride here). */
  readonly sequence?: string
}

const isPrintable = (key: Key): boolean =>
  key.ctrl !== true &&
  typeof key.sequence === "string" &&
  key.sequence.length === 1 &&
  key.sequence >= " " &&
  key.sequence !== "\x7f"

/** Re-open the model select with the free-text escape row appended when the
 *  filter looks like `provider:modelId`. */
const withCustomRow = (overlay: Overlay): Overlay => {
  if (overlay.kind !== "select" || overlay.purpose.tag !== "model") return overlay
  const extra = customRow(overlay.sel.filter)
  if (extra.length === 0) return overlay
  const already = overlay.sel.all.some((o) => o.desc === "not in the list")
  if (already) {
    // Rebuild: drop the stale custom row, append the fresh one.
    const base = overlay.sel.all.filter((o) => o.desc !== "not in the list")
    const rebuilt = openSelect(overlay.sel.title, [...base, ...extra])
    const refiltered = [...overlay.sel.filter].reduce((s, ch) => filterAppend(s, ch), rebuilt)
    return { ...overlay, sel: { ...refiltered, selected: overlay.sel.selected } }
  }
  return { ...overlay, sel: { ...overlay.sel, all: [...overlay.sel.all, ...extra] } }
}

const routeSelectKey = (ctx: SmithTuiContext, overlay: Overlay & { kind: "select" }, key: Key): void => {
  Match.value(key.name).pipe(
    Match.when("up", () => ctx.store.setOverlay({ ...overlay, sel: moveSelect(overlay.sel, "up") })),
    Match.when("down", () => ctx.store.setOverlay({ ...overlay, sel: moveSelect(overlay.sel, "down") })),
    Match.when("escape", () => ctx.store.closeOverlay()),
    Match.when("backspace", () =>
      ctx.store.setOverlay(withCustomRow({ ...overlay, sel: filterBackspace(overlay.sel) })),
    ),
    Match.when("return", () => {
      Option.match(selectedValue(overlay.sel), {
        onNone: () => ctx.store.setNotice("no match selected"),
        onSome: (value) => {
          if (overlay.purpose.tag === "model") {
            submitModel(ctx, overlay.purpose.role, value)
            return
          }
          // logout picker: the value IS the provider id.
          ctx.store.closeOverlay()
          logout(ctx, value)
        },
      })
    }),
    Match.orElse(() => {
      if (isPrintable(key)) {
        ctx.store.setOverlay(
          withCustomRow({ ...overlay, sel: filterAppend(overlay.sel, key.sequence ?? "") }),
        )
      }
    }),
  )
}

const routeLoginKey = (ctx: SmithTuiContext, overlay: Overlay & { kind: "login" }, key: Key): void => {
  Match.value(key.name).pipe(
    Match.when("up", () => ctx.store.setOverlay({ ...overlay, flow: loginMove(overlay.flow, "up") })),
    Match.when("down", () =>
      ctx.store.setOverlay({ ...overlay, flow: loginMove(overlay.flow, "down") }),
    ),
    Match.when("escape", () => {
      if (overlay.flow.step === "oauth") stopOAuthSession(ctx)
      // Cancel the most specific thing FIRST: an active filter clears
      // before the step retreats.
      if (overlay.flow.step === "home" && overlay.flow.sel.filter.length > 0) {
        const cleared = [...overlay.flow.sel.filter].reduce<LoginFlow>(
          (f) => loginBackspace(f),
          overlay.flow,
        )
        ctx.store.setOverlay({ ...overlay, flow: cleared })
        return
      }
      Option.match(loginBack(overlay.flow), {
        onNone: () => ctx.store.closeOverlay(),
        onSome: (flow) => ctx.store.setOverlay({ ...overlay, flow }),
      })
    }),
    Match.when("backspace", () =>
      ctx.store.setOverlay({ ...overlay, flow: loginBackspace(overlay.flow) }),
    ),
    Match.when("return", () => advanceLogin(ctx, loginAdvance(overlay.flow))),
    Match.orElse(() => {
      if (isPrintable(key)) {
        ctx.store.setOverlay({ ...overlay, flow: loginAppend(overlay.flow, key.sequence ?? "") })
      }
    }),
  )
}

/**
 * Global key routing, ONE precedence chain:
 *   1. Ctrl-C quits (always; finalizers restore the terminal).
 *   2. An open overlay owns every key (the composer is unmounted meanwhile).
 *   3. Esc cancels the most specific thing: a running forge, else the composer.
 */
export const dispatch = (ctx: SmithTuiContext, key: Key): void => {
  if (key.ctrl === true && key.name === "c") {
    ctx.exit(ctx.store.exitCode() ?? 130)
    return
  }
  const overlay = ctx.store.overlay()
  if (overlay.kind === "select") {
    routeSelectKey(ctx, overlay, key)
    return
  }
  if (overlay.kind === "login") {
    routeLoginKey(ctx, overlay, key)
    return
  }
  if (key.name === "escape") {
    const phase = ctx.store.floor().phase
    if (phase === "implementing" || phase === "gating" || phase === "boot") {
      ctx.store.setNotice("interrupting the run… (:quit to leave)")
      ctx.interrupt()
      return
    }
    ctx.store.clearComposer()
  }
}
