import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
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

  test("a log written again is replaced whole, through a temporary file that does not stay", async () => {
    await keep(root, "8/run/review.json", "{\"complete\": false}\n")
    await keep(root, "8/run/review.json", "{\"complete\": true}\n")
    expect([readFileSync(join(root, "8", "run", "review.json"), "utf8"), readdirSync(join(root, "8", "run"))]).toEqual(["{\"complete\": true}\n", ["review.json"]])
  })

  test("a fresh folder is made only when nothing is there: a second run of the name is refused", async () => {
    const fresh = (name: string) => Effect.runPromiseExit(Effect.gen(function* () {
      return yield* (yield* ReviewLogs).fresh(name)
    }).pipe(Effect.provide(directoryLogs(root))))
    const first = await fresh("9/sha/run-a")
    const again = await fresh("9/sha/run-a")
    expect([first, Exit.isFailure(again)]).toEqual([Exit.succeed(join(root, "9", "sha", "run-a")), true])
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
