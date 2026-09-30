import { afterAll, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { SessionLog, sessionLogConformance } from "@xandreed/core"
import { SessionLogSqliteLive } from "./session-log.adapter.js"

const directory = join(tmpdir(), `efferent-session-log-${crypto.randomUUID()}`)
const scope = Effect.runSync(Scope.make())
const log = Context.get(await Effect.runPromise(Layer.buildWithScope(SessionLogSqliteLive(join(directory, "sessions.db")), scope)), SessionLog)
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)).then(() => rmSync(directory, { recursive: true, force: true })))

describe("the SQLite session log conforms to the SessionLog contract", () => {
  sessionLogConformance(log).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
})
