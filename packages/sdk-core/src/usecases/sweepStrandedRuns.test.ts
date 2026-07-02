import { describe, expect, test } from "bun:test"
import { shouldSweepNode, SWEEP_GRACE_MS } from "./sweepStrandedRuns.js"

// The mid-session stranded-node sweeper's DECISION is pure (status + bus
// liveness + age → should-sweep). The effectful wiring around it (recordReturn +
// bus.complete + publish subagent_end) is covered by the in-process Workspace
// integration tests; this pins the guard logic that prevents false positives.

const base = {
  status: "running" as const,
  isRunningOnBus: false,
  createdAt: 0,
  now: SWEEP_GRACE_MS + 1, // safely past the grace window
}

describe("shouldSweepNode — stranded-node sweep decision", () => {
  test("sweeps a running node with no live fiber past the grace window", () => {
    expect(shouldSweepNode(base)).toBe(true)
  })

  test("never sweeps a node still live on the bus (the primary guard)", () => {
    expect(shouldSweepNode({ ...base, isRunningOnBus: true })).toBe(false)
  })

  test("never sweeps a node that already finished (ok/error)", () => {
    expect(shouldSweepNode({ ...base, status: "ok" })).toBe(false)
    expect(shouldSweepNode({ ...base, status: "error" })).toBe(false)
  })

  test("respects the grace window — a fresh node is NOT swept", () => {
    // Created `now`, so age 0 < grace → a legitimately slow turn survives.
    expect(shouldSweepNode({ ...base, createdAt: base.now })).toBe(false)
    // Exactly one ms short of the window: still safe (age = grace - 1).
    expect(shouldSweepNode({ ...base, createdAt: 2 })).toBe(false)
  })

  test("sweeps exactly at the grace boundary", () => {
    expect(
      shouldSweepNode({ status: "running", isRunningOnBus: false, createdAt: 0, now: SWEEP_GRACE_MS }),
    ).toBe(true)
  })

  test("a custom grace window overrides the default", () => {
    expect(
      shouldSweepNode({
        status: "running",
        isRunningOnBus: false,
        createdAt: 0,
        now: 50,
        graceMs: 100,
      }),
    ).toBe(false)
    expect(
      shouldSweepNode({
        status: "running",
        isRunningOnBus: false,
        createdAt: 0,
        now: 100,
        graceMs: 100,
      }),
    ).toBe(true)
  })
})
