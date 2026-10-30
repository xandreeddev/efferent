import { afterAll, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Exit, Layer, Option, Scope } from "effect"
import { TestClock } from "effect/testing"
import { SessionLog, Sessions, TurnActivity, TurnAdmission } from "@xandreed/core"
import { sessionsConformance } from "@xandreed/core/conformance"
import type { SessionsSubject } from "@xandreed/core/conformance"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import type { SessionsConfig } from "@xandreed/plugin-sessions"
import { SessionLogSqliteLive } from "./session-log.adapter.js"

/*
 * The Sessions kit over the SQLite log: every instance a check opens is a
 * SessionsLive over one database file, as several servers over one store.
 * The log stamps time with the caller's Clock, so each check's TestClock
 * moves leases.
 */

const directory = join(tmpdir(), `efferent-sessions-kit-${crypto.randomUUID()}`)
const scope = Effect.runSync(Scope.make())
const log = Context.get(await Effect.runPromise(Layer.buildWithScope(SessionLogSqliteLive(join(directory, "sessions.db")), scope)), SessionLog)
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)).then(() => rmSync(directory, { recursive: true, force: true })))

const instance = (config: SessionsConfig, admission: Context.Service.Shape<typeof TurnAdmission>, liveness?: Parameters<typeof SessionsLive>[1]) =>
  Layer.build(SessionsLive(config, liveness).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), Layer.succeed(TurnAdmission, admission))))).pipe(
    Effect.map((context) => ({ sessions: Context.get(context, Sessions), activity: Context.getOption(context, TurnActivity) })))

const subject: SessionsSubject = {
  leased: ({ ttlMs, admission }) => instance({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs, renew: "on-commit" } }, admission),
  processOwned: ({ self, running, admission }) => instance({ ...sessionsDefaults, ownership: { mode: "process" } }, admission, {
    liveness: { current: Effect.succeed(Option.some(self)), alive: (pid) => Effect.succeed(running.includes(pid)) },
  }),
  advance: (millis) => TestClock.adjust(millis),
}

describe("SessionsLive over the SQLite log conforms to the Sessions contract", () => {
  sessionsConformance(subject).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run).pipe(Effect.provide(TestClock.layer())))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
})
