import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Match, Option, PubSub, Stream } from "effect"
import { TestClock } from "effect/testing"
import { frameworkDraft, harnessCodeOf, HarnessError, isHarnessError, isTurnError, RunId, SessionLog, SessionLogMemoryLive, Sessions, TurnActivity, TurnAdmission } from "@xandreed/core"
import { sessionsConformance } from "@xandreed/core/conformance"
import type { BeginTurn, TurnError, TurnWriter } from "@xandreed/core"
import type { ConformanceCheck, SessionsInstance, SessionsSubject } from "@xandreed/core/conformance"
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
    expect(await failedChecks(sessionsConformance(subjectOver(memoryLog, lastWins)))).toEqual(["busy", "duplicate", "lease", "lease-renewal", "process", "race", "resume", "tenure"])
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
        begin: (address, input) => instance.sessions.begin(address, Match.valueTags(input, {
          User: (user): BeginTurn => ({ _tag: "User", userMessage: user.userMessage, runId: user.runId, key: user.key, command: user.command, ...(user.resumes === undefined ? {} : { resumes: user.resumes }) }),
          Inbox: (inbox): BeginTurn => ({ _tag: "Inbox", runId: inbox.runId }),
          Task: (task): BeginTurn => ({ _tag: "Task", task: task.task, userMessage: task.userMessage, runId: task.runId, key: task.key }),
        })),
      }),
    })
    expect(await failedChecks(sessionsConformance(subjectOver(memoryLog, forgetful)))).toEqual(["meta"])
  })

  test("one that begins a task's turn as a user's, its task in the command, fails only the task check", async () => {
    const asUser = (instance: SessionsInstance): SessionsInstance => ({
      ...instance,
      sessions: Sessions.of({
        ...instance.sessions,
        begin: (address, input) => instance.sessions.begin(address, input._tag === "Task"
          ? { _tag: "User", userMessage: input.userMessage, runId: input.runId, key: input.key, command: { task: input.task.taskId }, ...(input.meta === undefined ? {} : { meta: input.meta }) }
          : input),
      }),
    })
    expect(await failedChecks(sessionsConformance(subjectOver(memoryLog, asUser)))).toEqual(["task"])
  })

  test("one whose turn writers take the framework's kinds from anyone fails only the transact check", async () => {
    const trusting = (instance: SessionsInstance): SessionsInstance => ({
      ...instance,
      sessions: Sessions.of({
        ...instance.sessions,
        begin: (address, input) => instance.sessions.begin(address, input).pipe(Effect.map((writer) => ({
          ...writer,
          append: (drafts) => writer.append(drafts.map((draft) => frameworkDraft(draft.kind, draft.data))),
          transact: (decide) => writer.transact((foreign) => decide(foreign).pipe(Effect.map((decision) => ({
            ...decision, drafts: decision.drafts.map((draft) => frameworkDraft(draft.kind, draft.data)),
          })))),
        }))),
      }),
    })
    expect(await failedChecks(sessionsConformance(subjectOver(memoryLog, trusting)))).toEqual(["transact"])
  })

  test("one whose turn writers raise their refusals as HarnessError codes fails the checks that read them", async () => {
    const asCode = (error: TurnError): TurnError => isHarnessError(error) ? error
      : new HarnessError({ code: Option.getOrElse(harnessCodeOf(error), () => error._tag), message: error._tag })
    const flattened = <E>(error: E | TurnError) => isTurnError(error) ? asCode(error) : error
    const coded = (instance: SessionsInstance): SessionsInstance => ({
      ...instance,
      sessions: Sessions.of({
        ...instance.sessions,
        begin: (address, input) => instance.sessions.begin(address, input).pipe(Effect.map((writer): TurnWriter => ({
          ...writer,
          append: (drafts) => writer.append(drafts).pipe(Effect.mapError(asCode)),
          flush: writer.flush.pipe(Effect.mapError(asCode)),
          transact: (decide) => writer.transact(decide).pipe(Effect.mapError(flattened)),
        }))),
      }),
    })
    expect(await failedChecks(sessionsConformance(subjectOver(memoryLog, coded)))).toEqual(["cancel", "lease", "process", "transact", "writer"])
  })

  test("one whose turn writers store the closing drafts at once, as a write before the end, fails only the closing check", async () => {
    const eager = (instance: SessionsInstance): SessionsInstance => ({
      ...instance,
      sessions: Sessions.of({
        ...instance.sessions,
        begin: (address, input) => instance.sessions.begin(address, input).pipe(Effect.map((writer): TurnWriter => ({
          ...writer,
          closing: (drafts) => writer.append(drafts),
        }))),
      }),
    })
    expect(await failedChecks(sessionsConformance(subjectOver(memoryLog, eager)))).toEqual(["closing"])
  })

  test("one that begins a reused run id's turn under a new one fails only the run-id check", async () => {
    const renaming = (instance: SessionsInstance): SessionsInstance => ({
      ...instance,
      sessions: Sessions.of({
        ...instance.sessions,
        begin: (address, input) => instance.sessions.begin(address, input).pipe(
          Effect.catchTag("RunIdReused", () => instance.sessions.begin(address, { ...input, runId: RunId.make(`${input.runId}:again`) }))),
      }),
    })
    expect(await failedChecks(sessionsConformance(subjectOver(memoryLog, renaming)))).toEqual(["run-id"])
  })

  /**
   * An instance whose `changes` come from a hub of its own, fed by `transact`
   * with the session's id: `perSession` follows only that session's commits.
   */
  const signalledBy = (hub: PubSub.PubSub<string>, perSession: boolean) => (instance: SessionsInstance): SessionsInstance => ({
    ...instance,
    sessions: Sessions.of({
      ...instance.sessions,
      transact: (address, decide) => instance.sessions.transact(address, decide).pipe(Effect.tap(() => PubSub.publish(hub, address.id))),
      changes: (address) => Stream.fromPubSub(hub).pipe(Stream.filter((id) => !perSession || id === address.id), Stream.map(() => undefined)),
    }),
  })

  test("one that keeps a signal per commit for a follower that does not pull fails only the changes check", async () => {
    const hub = Effect.runSync(PubSub.unbounded<string>())
    expect(await failedChecks(sessionsConformance(subjectOver(memoryLog, signalledBy(hub, true))))).toEqual(["changes"])
  })

  test("one whose commits wake the followers of every session fails only the changes check", async () => {
    const hub = Effect.runSync(PubSub.sliding<string>(1))
    expect(await failedChecks(sessionsConformance(subjectOver(memoryLog, signalledBy(hub, false))))).toEqual(["changes"])
  })

  test("one whose writes do not renew the lease fails only the lease-renewal check", async () => {
    expect(await failedChecks(sessionsConformance(subjectOver(memoryLog, undefined, "none")))).toEqual(["lease-renewal"])
  })

  test("an instance without a TurnActivity passes, its activity unchecked", async () => {
    const unprobed = (instance: SessionsInstance): SessionsInstance => ({ ...instance, activity: Option.none() })
    expect(await failedChecks(sessionsConformance(subjectOver(memoryLog, unprobed)))).toEqual([])
  })

  test("the dead-holder and tenure checks run only for a backend with process ownership", () => {
    const { processOwned: _, ...leaseOnly } = subjectOver(memoryLog)
    const ids = (subject: SessionsSubject) => sessionsConformance(subject).map((check) => check.name)
    expect(ids(subjectOver(memoryLog)).length - ids(leaseOnly).length).toBe(2)
  })
})
