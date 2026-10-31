import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { InboxRunner } from "../ports/inbox-runner.port.js"
import { inboxRunnerConformance } from "./inbox-runner.conformance.js"
import type { InboxRunnerSubject } from "./inbox-runner.conformance.js"

const subject: InboxRunnerSubject = { open: ({ use }) => Effect.succeed(InboxRunner.of({ run: use })) }
const failedChecks = (backend: InboxRunnerSubject) => Effect.runPromise(Effect.forEach(inboxRunnerConformance(backend), (check) =>
  Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [result.failure.check] : [])), { concurrency: 1 })).then((all) => all.flat().toSorted())
const everyCheck = ["borrowed-writer", "failure", "outcome", "writer-lifetime"]

describe("the InboxRunner kit", () => {
  test("has the documented check ids and accepts an exact borrowed-writer delegate", async () => {
    expect(inboxRunnerConformance(subject).length).toBe(everyCheck.length)
    expect(await failedChecks(subject)).toEqual([])
  })

  test("a runner that executes nothing fails every check", async () => {
    expect(await failedChecks({ open: () => Effect.succeed(InboxRunner.of({ run: () => Effect.succeed({ outcome: "completed", reply: Option.none() }) })) })).toEqual(everyCheck)
  })

  test("a runner that copies the writer fails only exact borrowed identity", async () => {
    expect(await failedChecks({ open: ({ use }) => Effect.succeed(InboxRunner.of({ run: (writer) => use({ ...writer }) })) })).toEqual(["borrowed-writer"])
  })

  test("a runner that forces completion fails only outcome preservation", async () => {
    expect(await failedChecks({ open: ({ use }) => Effect.succeed(InboxRunner.of({ run: (writer) => use(writer).pipe(Effect.map((outcome) => ({ ...outcome, outcome: "completed" }))) })) })).toEqual(["outcome"])
  })

  test("a runner that swallows the failure fails only failure preservation", async () => {
    expect(await failedChecks({ open: ({ use }) => Effect.succeed(InboxRunner.of({ run: (writer) => use(writer).pipe(Effect.catch(() => Effect.succeed({ outcome: "failed" as const, reply: Option.none() }))) })) })).toEqual(["failure"])
  })

  test("a runner that ends its borrowed writer fails only writer lifetime", async () => {
    const ending: InboxRunnerSubject = { open: ({ use }) => Effect.succeed(InboxRunner.of({
      run: (writer) => use(writer).pipe(Effect.ensuring(writer.end({ reason: "completed", failure: Option.none() }).pipe(Effect.orDie))),
    })) }
    expect(await failedChecks(ending)).toEqual(["writer-lifetime"])
  })
})
