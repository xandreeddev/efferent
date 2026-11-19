import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { directoryLogs } from "./review-logs.adapter.js"
import { ReviewLogs } from "./review-logs.port.js"

const root = mkdtempSync(join(tmpdir(), "review-logs-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const keep = (folder: string, name: string, text: string) => Effect.runPromiseExit(Effect.gen(function* () {
  return yield* (yield* ReviewLogs).keep(name, text)
}).pipe(Effect.provide(directoryLogs(folder))))

describe("directoryLogs", () => {
  test("keeps a log under its name, its folders made, and answers its path", async () => {
    const exit = await keep(root, "7-abc/ci-11.log", "error: boom\n")
    expect(exit).toEqual(Exit.succeed(join(root, "7-abc", "ci-11.log")))
    expect(readFileSync(join(root, "7-abc", "ci-11.log"), "utf8")).toBe("error: boom\n")
  })

  test("a name that leads out of the folder, an absolute name or a folder that is not absolute is refused, nothing written", async () => {
    for (const [folder, name] of [[root, "../escaped.log"], [root, "/tmp/absolute.log"], ["relative", "a.log"]] as const) {
      const exit = await keep(folder, name, "x")
      const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
      expect(reason?._tag === "Fail" && reason.error._tag).toBe("LogsUnavailable")
    }
    expect(existsSync(join(root, "..", "escaped.log"))).toBe(false)
  })
})
