import type { SmithTuiContext } from "./state/store.js"

/** The structural slice of OpenTUI's key event smith cares about. */
export interface Key {
  readonly name: string
  readonly ctrl?: boolean
}

/**
 * Global keys — fire BEFORE the focused command textarea:
 *   Ctrl-C  quit immediately (finalizers restore the terminal)
 *   Esc     interrupt the running forge session (the floor keeps its state)
 * Everything else flows to the command line.
 */
export const dispatch = (ctx: SmithTuiContext, key: Key): void => {
  if (key.ctrl === true && key.name === "c") {
    ctx.exit(ctx.store.exitCode() ?? 130)
    return
  }
  if (key.name === "escape") {
    const phase = ctx.store.floor().phase
    if (phase === "implementing" || phase === "gating" || phase === "boot") {
      ctx.store.setNotice("interrupting the run… (:quit to leave)")
      ctx.interrupt()
    }
  }
}
