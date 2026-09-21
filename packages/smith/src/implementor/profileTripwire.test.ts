import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { LocalFileSystemLive } from "@xandreed/plugin-tools-local"
import { armProfileTripwire, profileDrift } from "./profileTripwire.js"

describe("the armed-profile tripwire", () => {
  test("edit, deletion, and creation each count as drift; unchanged never does", () => {
    const paths = ["a/foundry.config.ts", "a/custom.ts"]
    const armed = [Option.some("typecheck: true"), Option.none<string>()]
    expect(profileDrift(paths, armed, [Option.some("typecheck: true"), Option.none()])).toEqual([])
    expect(profileDrift(paths, armed, [Option.some("typecheck: false"), Option.none()])).toEqual(["a/foundry.config.ts"])
    expect(profileDrift(paths, armed, [Option.none(), Option.none()])).toEqual(["a/foundry.config.ts"])
    expect(profileDrift(paths, armed, [Option.some("typecheck: true"), Option.some("new")])).toEqual(["a/custom.ts"])
  })

  test("armed against the real workspace: a Bash-style overwrite trips it, an untouched profile does not", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smith-tripwire-"))
    writeFileSync(join(cwd, "foundry.config.ts"), "export default { typecheck: true }\n")
    const custom = join(cwd, "custom-gates.ts")
    writeFileSync(custom, "export default { tests: true }\n")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const tripwire = yield* armProfileTripwire(cwd, [custom])
        const clean = yield* tripwire.check
        // The 2026-07-12 shape: not a tool write, a shell command rewriting the file.
        writeFileSync(join(cwd, "foundry.config.ts"), "export default { typecheck: false }\n")
        const edited = yield* tripwire.check
        rmSync(custom)
        const deleted = yield* tripwire.check
        return { clean, edited, deleted, paths: tripwire.paths }
      }).pipe(Effect.provide(LocalFileSystemLive)),
    )
    rmSync(cwd, { recursive: true, force: true })
    expect(result.paths).toEqual([join(cwd, "foundry.config.ts"), custom])
    expect(result.clean).toEqual([])
    expect(result.edited).toEqual([join(cwd, "foundry.config.ts")])
    expect(result.deleted).toEqual([join(cwd, "foundry.config.ts"), custom])
  })
})
