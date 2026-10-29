import { describe, expect, test } from "bun:test"
import { Effect, Option, Stream } from "effect"
import { BashError } from "../domain/bash.entity.js"
import type { BashEvent } from "../domain/bash.entity.js"
import { collectBashResult } from "../domain/bash.entity.functions.js"
import { Bash } from "../ports/bash.port.js"
import { bashConformance } from "./bash.conformance.js"
import type { BashSubject } from "./bash.conformance.js"

/*
 * Core has no Bash adapter (plugin-workspace runs this kit over a real
 * shell on Bun and Node). Here the kit runs against careless fakes, to show
 * that none of its checks passes without a shell behind the port.
 */

const subjectOf = (stream: (command: string) => Stream.Stream<BashEvent, BashError>): BashSubject => ({
  open: () => Effect.succeed({
    bash: Bash.of({ stream, exec: (command) => collectBashResult(stream(command)) }),
    root: "/kit",
  }),
})

const failedChecks = (subject: BashSubject) => Effect.runPromise(Effect.forEach(bashConformance(subject), (check) =>
  Effect.result(check.run).pipe(Effect.map((exit) => exit._tag === "Failure" ? [exit.failure.check] : [])))).then((failed) => failed.flat().toSorted())

const everyCheck = ["backpressure", "cwd", "env", "exit-code", "inherit-env", "interrupt", "signal", "stdin", "stdin-ignored", "streaming", "streams", "timeout", "utf8"]

describe("the Bash kit catches backends that run nothing", () => {
  test("its checks have the ids the docs list", () => {
    expect(bashConformance(subjectOf(() => Stream.empty)).length).toBe(everyCheck.length)
  })

  test("a backend that runs nothing and exits 0 at once fails every check", async () => {
    const exitAtOnce = subjectOf(() => Stream.make<ReadonlyArray<BashEvent>>({ _tag: "BashExit", termination: "exit", exitCode: Option.some(0), signal: Option.none(), durationMs: 0 }))
    expect(await failedChecks(exitAtOnce)).toEqual(everyCheck)
  })

  test("a backend that cannot spawn fails every check", async () => {
    const cannotSpawn = subjectOf(() => Stream.fail(new BashError({ reason: "SpawnFailed", message: "no shell here" })))
    expect(await failedChecks(cannotSpawn)).toEqual(everyCheck)
  })
})
