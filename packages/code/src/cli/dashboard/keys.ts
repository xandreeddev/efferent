import type { SessionSummary } from "@xandreed/sdk-core"
import type { Key } from "../keys/ParsedKey.js"
import { clampCursor } from "../presentation/paneNav.js"
import { buildFleetRows } from "./presentation/dashboardView.js"
import type { DashboardStore } from "./state/dashboardStore.js"

/** Operator actions the dashboard keys drive (wired to the Workspace + transport). */
export interface DashboardActions {
  readonly attach: (s: SessionSummary) => void
  readonly spawnFleet: () => void
  readonly stop: (s: SessionSummary) => void
  readonly interrupt: (s: SessionSummary) => void
  readonly shutdown: () => void
  readonly quit: () => void
}

export interface DashboardKeyCtx {
  readonly store: DashboardStore
  readonly actions: DashboardActions
}

/**
 * k9s-style key dispatch over the fleet tree: j/k move, gg/G ends, ⇥ folds a
 * fleet, ↵/a attaches, n spawns a fleet, s/x stops the selected agent, i
 * interrupts the selected fleet, D shuts the daemon down, q/Ctrl-C quits.
 * Pure-ish (only store/action side effects), so it's testable with plain keys.
 */
export const handleDashboardKey = (ctx: DashboardKeyCtx, key: Key): void => {
  const { store, actions } = ctx
  const rows = buildFleetRows(store.sessions(), store.collapsed())
  const cursor = clampCursor(rows.length, store.cursor())
  const current = rows[cursor]

  if (key.ctrl && key.name === "c") return actions.quit()
  switch (key.name) {
    case "q":
      return actions.quit()
    case "j":
    case "down":
      return void store.setCursor(clampCursor(rows.length, cursor + 1))
    case "k":
    case "up":
      return void store.setCursor(clampCursor(rows.length, cursor - 1))
    case "g":
      return void store.setCursor(0)
    case "G":
      return void store.setCursor(Math.max(0, rows.length - 1))
    case "tab": {
      // Fold/unfold the selected fleet (only fleet rows have a foldId).
      if (current?.foldId === undefined) return
      const fid = current.foldId
      return void store.setCollapsed((c) => {
        const next = new Set(c)
        if (next.has(fid)) next.delete(fid)
        else next.add(fid)
        return next
      })
    }
    case "return":
    case "a":
      if (current !== undefined) actions.attach(current.display.summary)
      return
    case "n":
      return actions.spawnFleet()
    case "s":
    case "x":
      if (current?.display.kind === "agent") actions.stop(current.display.summary)
      return
    case "i":
      if (current?.display.kind === "fleet") actions.interrupt(current.display.summary)
      return
    case "D":
      return actions.shutdown()
    default:
      return
  }
}
