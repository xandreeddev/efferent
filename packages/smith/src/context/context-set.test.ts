import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Option } from "effect"
import { LocalFileSystemLive } from "@xandreed/plugin-tools-local"
import {
  clearPins,
  emptyContextSet,
  findPinIndex,
  isStandingOn,
  parsePinRef,
  renderPinRef,
  togglePin,
  toggleStanding,
  withBudget,
  withPin,
  withoutPin,
} from "./context-set.entity.functions.js"
import { contextSetPath, loadContextSet, saveContextSet } from "./store.js"

const pin = (raw: string) => Either.getOrThrow(parsePinRef(raw))

describe("the context set — selection is the human's", () => {
  test("the :context add grammar covers every pin kind and round-trips through its ref", () => {
    const refs = [
      "src/x.ts",
      "@src/x.ts",
      "src/",
      "**/*.test.ts",
      "note: never touch the schema",
      "spec:stats-module",
      "run:22222222",
      "diff",
      "diff:main",
      "cmd: bun test",
    ]
    const tags = refs.map((r) => pin(r)._tag)
    expect(tags).toEqual(["file", "file", "dir", "glob", "note", "spec", "run", "diff", "diff", "cmd"])
    // `@` is only the composer's habit — the ref drops it.
    expect(renderPinRef(pin("@src/x.ts"))).toBe("src/x.ts")
    expect(refs.filter((r) => !r.startsWith("@")).map((r) => renderPinRef(pin(r)))).toEqual(
      refs.filter((r) => !r.startsWith("@")),
    )
    expect(Either.isLeft(parsePinRef(""))).toBe(true)
    expect(Either.isLeft(parsePinRef("note:"))).toBe(true)
    expect(Either.isLeft(parsePinRef("cmd:   "))).toBe(true)
    expect(Either.isLeft(parsePinRef("spec:"))).toBe(true)
  })

  test("pins dedupe by ref, toggle in place, drop by index or ref; standing sources toggle; budget clamps", () => {
    const a = withPin(withPin(emptyContextSet, pin("src/x.ts")), pin("@src/x.ts"))
    expect(a.pins).toHaveLength(1)
    const b = withPin(a, pin("note: keep it small"))
    expect(b.pins.map(renderPinRef)).toEqual(["src/x.ts", "note: keep it small"])
    expect(togglePin(b, 0).pins[0]?.on).toBe(false)
    expect(togglePin(togglePin(b, 0), 0).pins[0]?.on).toBe(true)
    expect(findPinIndex(b, "2")).toEqual(Option.some(1))
    expect(findPinIndex(b, "note: keep it small")).toEqual(Option.some(1))
    expect(findPinIndex(b, "9")).toEqual(Option.none())
    expect(withoutPin(b, 0).pins.map(renderPinRef)).toEqual(["note: keep it small"])
    expect(clearPins(b).pins).toEqual([])
    expect(isStandingOn(b, "lessons")).toBe(true)
    const off = toggleStanding(b, "lessons")
    expect(isStandingOn(off, "lessons")).toBe(false)
    expect(isStandingOn(toggleStanding(off, "lessons"), "lessons")).toBe(true)
    expect(withBudget(b, 10).budgetChars).toBe(1_000)
    expect(withBudget(b, 1e9).budgetChars).toBe(200_000)
    expect(withBudget(b, 30_000).budgetChars).toBe(30_000)
  })

  test("the store round-trips .efferent/context.json; absent reads empty; a broken file reads empty, never bricks", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-context-"))
    const set = withBudget(
      toggleStanding(withPin(withPin(emptyContextSet, pin("src/x.ts")), pin("diff:main")), "memory"),
      12_000,
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const absent = yield* loadContextSet(cwd)
        yield* saveContextSet(cwd, set)
        const loaded = yield* loadContextSet(cwd)
        yield* Effect.sync(() => writeFileSync(contextSetPath(cwd), "{ not json"))
        const broken = yield* loadContextSet(cwd)
        return { absent, loaded, broken }
      }).pipe(Effect.provide(LocalFileSystemLive)),
    )
    const onDisk = readFileSync(contextSetPath(cwd), "utf8")
    rmSync(cwd, { recursive: true, force: true })
    expect(result.absent).toEqual(emptyContextSet)
    expect(result.loaded.pins.map(renderPinRef)).toEqual(["src/x.ts", "diff:main"])
    expect(result.loaded.off).toEqual(["memory"])
    expect(result.loaded.budgetChars).toBe(12_000)
    expect(result.broken).toEqual(emptyContextSet)
    expect(onDisk).toBe("{ not json")
  })
})
