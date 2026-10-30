import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Exit, Layer, Option, Scope } from "effect"
import { TestClock } from "effect/testing"
import { SessionLog, Sessions, STORED_FORMAT, TurnActivity, TurnAdmission } from "@xandreed/core"
import type { JsonObject, SessionAddress } from "@xandreed/core"
import { sessionsConformance } from "@xandreed/core/conformance"
import type { SessionsSubject } from "@xandreed/core/conformance"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import type { SessionsConfig } from "@xandreed/plugin-sessions"
import { SessionLogFilesLive } from "./session-log.adapter.js"

/*
 * The Sessions kit over the file log: every instance a check opens is a
 * SessionsLive over its own handle on one directory, as several servers
 * over one mount. The log stamps time with the caller's Clock, so each
 * check's TestClock moves leases.
 */

const directory = mkdtempSync(join(tmpdir(), "efferent-sessions-files-kit-"))
const scope = Effect.runSync(Scope.make())
const handle = () => Effect.runPromise(Layer.buildWithScope(SessionLogFilesLive(directory), scope)).then((context) => Context.get(context, SessionLog))
const [first, second] = [await handle(), await handle()]
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)).then(() => rmSync(directory, { recursive: true, force: true })))

/** Instances alternate between the two handles: a check's instances share the directory, not a handle's cache. */
const handles = { next: 0 }
const nextLog = () => { handles.next += 1; return handles.next % 2 === 0 ? first : second }

const instance = (config: SessionsConfig, admission: Context.Service.Shape<typeof TurnAdmission>, liveness?: Parameters<typeof SessionsLive>[1]) =>
  Layer.build(SessionsLive(config, liveness).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, nextLog()), Layer.succeed(TurnAdmission, admission))))).pipe(
    Effect.map((context) => ({ sessions: Context.get(context, Sessions), activity: Context.getOption(context, TurnActivity) })))

/** A session's head state as the next release would leave it: its stored format one above this release's. */
const newerFormat = (address: SessionAddress) => first.head(address.id).pipe(
  Effect.flatMap((head) => first.commit(address.id, {
    expect: head.revision,
    notAfter: Option.none(),
    events: [],
    state: Option.some({ ...head.state, sessions: { ...(head.state["sessions"] as JsonObject), format: STORED_FORMAT + 1 } }),
  })),
  Effect.asVoid,
)

const subject: SessionsSubject = {
  leased: ({ ttlMs, admission }) => instance({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs, renew: "on-commit" } }, admission),
  processOwned: ({ self, running, admission }) => instance({ ...sessionsDefaults, ownership: { mode: "process" } }, admission, {
    liveness: { current: Effect.succeed(Option.some(self)), alive: (pid) => Effect.succeed(running.includes(pid)) },
  }),
  advance: (millis) => TestClock.adjust(millis),
  newerFormat,
}

describe("SessionsLive over the file log, two handles on one directory, conforms to the Sessions contract", () => {
  sessionsConformance(subject).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run).pipe(Effect.provide(TestClock.layer())))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }, 30_000))
})
