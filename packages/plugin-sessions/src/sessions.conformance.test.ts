import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { SessionLog, SessionLogMemoryLive, Sessions, sessionsConformance, TurnActivity, TurnAdmission } from "@xandreed/core"
import type { ConformanceCheck, SessionsInstance, SessionsSubject } from "@xandreed/core"
import { SessionsLive } from "./sessions.adapter.js"
import { sessionsDefaults } from "./sessions-state.entity.js"
import type { ProcessLiveness, SessionsConfig } from "./sessions-state.entity.js"

type Log = Context.Service.Shape<typeof SessionLog>

/** A run of a check under a TestClock of its own, which `advance` moves. */
const run = (check: ConformanceCheck) => Effect.runPromise(Effect.result(check.run).pipe(Effect.provide(TestClock.layer())))

const failedChecks = (checks: ReadonlyArray<ConformanceCheck>) => Promise.all(checks.map(async (check) => {
  const exit = await run(check)
  return exit._tag === "Failure" ? [exit.failure.check] : []
})).then((failed) => failed.flat().toSorted())

/**
 * SessionsLive instances over `log`: leased (renewed by commits only, or by
 * `renew`) or held by a process the kit names.
 */
const subjectOver = (log: Log, change: (instance: SessionsInstance) => SessionsInstance = (instance) => instance, renew: "none" | "on-commit" = "on-commit"): SessionsSubject => {
  const instance = (config: SessionsConfig, admission: Context.Service.Shape<typeof TurnAdmission>, liveness?: ProcessLiveness) =>
    Layer.build(SessionsLive(config, liveness === undefined ? undefined : { liveness }).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), Layer.succeed(TurnAdmission, admission))))).pipe(
      Effect.map((context) => change({ sessions: Context.get(context, Sessions), activity: Context.getOption(context, TurnActivity) })))
  return {
    leased: ({ ttlMs, admission }) => instance({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs, renew } }, admission),
    processOwned: ({ self, running, admission }) => instance({ ...sessionsDefaults, ownership: { mode: "process" } }, admission, {
      current: Effect.succeed(Option.some(self)),
      alive: (pid) => Effect.succeed(running.includes(pid)),
    }),
    advance: (millis) => TestClock.adjust(millis),
  }
}

/** One in-memory log for every check (the kit uses fresh owners and sessions), driven by each check's TestClock. */
const memoryLog = Effect.runSync(Effect.service(SessionLog).pipe(Effect.provide(SessionLogMemoryLive)))

describe("SessionsLive over the in-memory log conforms to the Sessions contract", () => {
  sessionsConformance(subjectOver(memoryLog)).map((check) => test(check.name, async () => {
    const exit = await run(check)
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
})

describe("the Sessions kit catches careless backends", () => {
  test("one whose begin cancels the open turn instead of refusing it fails the checks that hold a turn open against a begin", async () => {
    const lastWins = (instance: SessionsInstance): SessionsInstance => ({
      ...instance,
      sessions: Sessions.of({
        ...instance.sessions,
        begin: (address, input) => instance.sessions.get(address).pipe(
          Effect.tap((view) => Option.match(view.open, { onNone: () => Effect.void, onSome: (open) => instance.sessions.cancel(address, open.turn) })),
          Effect.andThen(instance.sessions.begin(address, input)),
        ),
      }),
    })
    expect(await failedChecks(sessionsConformance(subjectOver(memoryLog, lastWins)))).toEqual(["busy", "duplicate", "lease", "lease-renewal", "process", "race", "resume"])
  })

  test("one whose TurnActivity always reads idle fails only the activity check", async () => {
    const blind = (instance: SessionsInstance): SessionsInstance => ({
      ...instance,
      activity: Option.some(TurnActivity.of({ current: Effect.succeed({ open: [], beginning: 0 }), idle: Effect.void })),
    })
    expect(await failedChecks(sessionsConformance(subjectOver(memoryLog, blind)))).toEqual(["activity"])
  })

  test("one that drops the turn's meta fails only the meta check", async () => {
    const forgetful = (instance: SessionsInstance): SessionsInstance => ({
      ...instance,
      sessions: Sessions.of({
        ...instance.sessions,
        begin: (address, input) => instance.sessions.begin(address, input._tag === "User"
          ? { _tag: "User", userMessage: input.userMessage, runId: input.runId, key: input.key, command: input.command, ...(input.resumes === undefined ? {} : { resumes: input.resumes }) }
          : { _tag: "Inbox", runId: input.runId }),
      }),
    })
    expect(await failedChecks(sessionsConformance(subjectOver(memoryLog, forgetful)))).toEqual(["meta"])
  })

  test("one whose writes do not renew the lease fails only the lease-renewal check", async () => {
    expect(await failedChecks(sessionsConformance(subjectOver(memoryLog, undefined, "none")))).toEqual(["lease-renewal"])
  })

  test("an instance without a TurnActivity passes, its activity unchecked", async () => {
    const unprobed = (instance: SessionsInstance): SessionsInstance => ({ ...instance, activity: Option.none() })
    expect(await failedChecks(sessionsConformance(subjectOver(memoryLog, unprobed)))).toEqual([])
  })

  test("the dead-holder check runs only for a backend with process ownership", () => {
    const { processOwned: _, ...leaseOnly } = subjectOver(memoryLog)
    const ids = (subject: SessionsSubject) => sessionsConformance(subject).map((check) => check.name)
    expect(ids(subjectOver(memoryLog)).length - ids(leaseOnly).length).toBe(1)
  })
})
