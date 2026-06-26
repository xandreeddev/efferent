import type { Fiber } from "effect"

/**
 * One live fired-agent run. `id` is a small client-side fleet index (shown to
 * the human for `:stop <id>`); `fiber` is the detached daemon running the
 * agent, so `Fiber.interrupt` cancels it. The persistent record (status,
 * summary, files) lives in the context tree — this registry only tracks what's
 * RUNNING right now, so a fired agent can be stopped and counted.
 */
export interface FleetEntry {
  readonly id: number
  readonly title: string
  readonly folder: string
  readonly agent: string
  readonly fiber: Fiber.RuntimeFiber<void, never>
}

/**
 * The minimal in-memory fleet supervisor (Phase 1.5): a registry of currently
 * running fired agents. Grows in Phase 3 to carry each agent's mailbox + event
 * channel. Plain mutable state in the driver — the persistent tree (`:tree`) is
 * the durable view; this is just the live handle set for `:stop` and counts.
 */
export interface FleetSupervisor {
  /** Reserve the next fleet index (before the fiber exists, so `ensuring` can
   *  reference it). */
  readonly nextId: () => number
  readonly register: (id: number, entry: Omit<FleetEntry, "id">) => void
  readonly remove: (id: number) => void
  readonly get: (id: number) => FleetEntry | undefined
  readonly list: () => ReadonlyArray<FleetEntry>
}

export const makeFleetSupervisor = (): FleetSupervisor => {
  const entries = new Map<number, FleetEntry>()
  let counter = 0
  return {
    nextId: () => (counter += 1),
    register: (id, entry) => {
      entries.set(id, { id, ...entry })
    },
    remove: (id) => {
      entries.delete(id)
    },
    get: (id) => entries.get(id),
    list: () => [...entries.values()],
  }
}
