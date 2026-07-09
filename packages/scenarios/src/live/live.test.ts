import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { parseLiveArgs } from "../evalsLive.js"
import { listCases, seedWorkspace } from "./fixtures.js"

describe("parseLiveArgs", () => {
  test("defaults: all packs, no override, live-entry flags", () => {
    const args = parseLiveArgs([], ["a", "b"])
    expect(args.names).toEqual(["a", "b"])
    expect(Option.isNone(args.samplesOverride)).toBe(true)
    expect(args.json).toBe(false)
    expect(args.update).toBe(false)
  })

  test("battery selection + --samples override + flags", () => {
    const args = parseLiveArgs(
      ["judge-calibration", "--samples", "1", "--json", "--update-baselines"],
      ["judge-calibration", "digest"],
    )
    expect(args.names).toEqual(["judge-calibration"])
    expect(Option.getOrThrow(args.samplesOverride)).toBe(1)
    expect(args.json).toBe(true)
    expect(args.update).toBe(true)
  })

  test("a garbage --samples value is ignored (None)", () => {
    expect(Option.isNone(parseLiveArgs(["--samples", "zero"], []).samplesOverride)).toBe(true)
    expect(Option.isNone(parseLiveArgs(["--samples", "0"], []).samplesOverride)).toBe(true)
  })
})

describe("fixture plumbing", () => {
  test("listCases: sorted case dirs only (files skipped)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fixtures-"))
    mkdirSync(join(dir, "b-case"))
    mkdirSync(join(dir, "a-case"))
    writeFileSync(join(dir, "README.md"), "not a case")
    expect(listCases(dir)).toEqual(["a-case", "b-case"])
  })

  test("seedWorkspace copies the tree into a scoped temp dir and releases it", async () => {
    const source = mkdtempSync(join(tmpdir(), "fixture-src-"))
    mkdirSync(join(source, "src"))
    writeFileSync(join(source, "src", "a.ts"), "export const a = 1\n")
    const seeded = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* seedWorkspace(source)
          return { dir, hadFile: existsSync(join(dir, "src", "a.ts")) }
        }),
      ),
    )
    expect(seeded.hadFile).toBe(true)
    // The finalizer removed the temp dir when the scope closed.
    expect(existsSync(seeded.dir)).toBe(false)
  })
})
