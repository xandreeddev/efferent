import { describe, expect, test } from "bun:test"
import { Effect, Option, Stream } from "effect"
import type { BashEvent } from "./bash.entity.js"
import { collectBashResult, resolveBashEnv } from "./bash.entity.functions.js"

const parent = { PATH: "/usr/bin", HOME: "/home/kit", LC_ALL: "C", LC_TIME: "C", OPENAI_API_KEY: "sk-secret", SECRET_TOKEN: "t", UNSET: undefined }

describe("resolveBashEnv", () => {
  test("by default only the allowlist passes, LC_* by prefix, and no host secret", () => {
    expect(resolveBashEnv(parent, {})).toEqual({ PATH: "/usr/bin", HOME: "/home/kit", LC_ALL: "C", LC_TIME: "C" })
  })

  test("true inherits everything set, false nothing, a list its names and prefixes; env always wins", () => {
    expect(Object.keys(resolveBashEnv(parent, { inheritEnv: true })).toSorted()).toEqual(["HOME", "LC_ALL", "LC_TIME", "OPENAI_API_KEY", "PATH", "SECRET_TOKEN"])
    expect(resolveBashEnv(parent, { inheritEnv: false, env: { ONLY: "this" } })).toEqual({ ONLY: "this" })
    expect(resolveBashEnv(parent, { inheritEnv: ["PATH", "SECRET_*"], env: { PATH: "/opt/bin" } })).toEqual({ PATH: "/opt/bin", SECRET_TOKEN: "t" })
  })
})

const chunk = (stream: "stdout" | "stderr", text: string): BashEvent => ({ _tag: "BashChunk", stream, text })

describe("collectBashResult", () => {
  test("joins each stream's chunks and takes the end from the exit", async () => {
    const events: ReadonlyArray<BashEvent> = [
      chunk("stdout", "a"), chunk("stderr", "warn"), chunk("stdout", "b"),
      { _tag: "BashExit", termination: "exit", exitCode: Option.some(2), signal: Option.none(), durationMs: 12 },
    ]
    const result = await Effect.runPromise(collectBashResult(Stream.fromIterable(events)))
    expect(result).toEqual({ stdout: "ab", stderr: "warn", exitCode: Option.some(2), signal: Option.none(), termination: "exit", durationMs: 12 })
  })

  test("a stream cut short before its exit is interrupted, with the output so far", async () => {
    const result = await Effect.runPromise(collectBashResult(Stream.fromIterable([chunk("stdout", "partial")])))
    expect([result.stdout, result.termination, Option.isNone(result.exitCode), Option.isNone(result.signal)]).toEqual(["partial", "interrupted", true, true])
  })
})
