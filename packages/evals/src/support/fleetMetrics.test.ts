import { expect, test } from "bun:test"
import { coordinationMetrics, coordinationScore, trajectoryMatch } from "./fleetMetrics.js"
import type { Spawn } from "./scenarioRun.js"

const spawn = (name: string, files: string[], ok = true): Spawn => ({
  name,
  role: "code",
  ok,
  filesChanged: files.length,
  files,
  tokens: 0,
})

test("coordinationMetrics flags writer overlap + over-spawn + failures", () => {
  const m = coordinationMetrics(
    [spawn("a", ["x.ts", "y.ts"]), spawn("b", ["y.ts"]), spawn("c", ["z.ts"], false)],
    1, // expected one area
  )
  expect(m.spawnCount).toBe(3)
  expect(m.failedSpawns).toBe(1)
  expect(m.overSpawn).toBe(2) // 3 spawns, expected 1
  // distinct files x,y,z; y written by 2 ⇒ 1/3 overlapped
  expect(m.writerOverlap).toBeCloseTo(1 / 3, 5)
})

test("a tidy single-writer fleet scores near 1; a messy one decays", () => {
  const tidy = coordinationScore(coordinationMetrics([spawn("a", ["x.ts"])], 1))
  expect(tidy).toBe(1)
  const messy = coordinationScore(
    coordinationMetrics([spawn("a", ["x.ts"]), spawn("b", ["x.ts"]), spawn("c", ["x.ts"], false)], 1),
  )
  expect(messy).toBeLessThan(1)
})

test("trajectoryMatch — strict / unordered / superset / subset", () => {
  const actual = ["read", "edit", "Bash"]
  expect(trajectoryMatch(actual, ["read", "edit", "Bash"], "strict")).toBe(true)
  expect(trajectoryMatch(actual, ["read", "Bash", "edit"], "strict")).toBe(false)
  expect(trajectoryMatch(actual, ["Bash", "edit", "read"], "unordered")).toBe(true)
  expect(trajectoryMatch(actual, ["edit", "Bash"], "superset")).toBe(true) // required ran
  expect(trajectoryMatch(actual, ["read", "edit"], "superset")).toBe(true)
  expect(trajectoryMatch(actual, ["read", "edit"], "subset")).toBe(false) // Bash is extra
  expect(trajectoryMatch(["read", "edit"], ["read", "edit", "Bash"], "subset")).toBe(true)
})
