import { describe, expect, it } from "bun:test"
import { Effect, Exit } from "effect"
import { LanguageModel, type Toolkit } from "@effect/ai"
import { recoverMalformedToolCalls, runAgentLoop, safeArgsSummary } from "./agentLoop.js"
import { generateHandoffBrief } from "./handoff.js"
import type { AgentMessage, AgentResult } from "../entities/Conversation.js"

/**
 * A stub `LanguageModel` service whose `generateText` returns scripted
 * outcomes turn-by-turn. A `"malformed"` entry fails with a response-decode
 * `MalformedOutput` (an unknown tool name fails *here*, inside generateText,
 * before any handler runs); a `"done"` entry is a plain text response that
 * ends the loop.
 */
const scriptedModel = (script: ReadonlyArray<"malformed" | "done">) => {
  let calls = 0
  const service = {
    generateText: () => {
      const step = script[Math.min(calls, script.length - 1)]
      calls++
      if (step === "malformed") {
        return Effect.fail({
          _tag: "MalformedOutput",
          description: 'is missing ... actual "google:search"',
        })
      }
      return Effect.succeed({
        content: [],
        text: "done",
        finishReason: "stop",
        usage: undefined,
      })
    },
    generateObject: () => Effect.die("unused"),
    streamText: () => Effect.die("unused"),
  }
  return { layer: LanguageModel.LanguageModel.of(service as never), calls: () => calls }
}

// A pre-resolved toolkit (one tool) the loop can `yield*` without a handler layer.
const oneToolToolkit = Effect.succeed({
  tools: { read_file: {} },
  handle: () => Effect.succeed({ isFailure: false, result: {}, encodedResult: {} }),
}) as unknown as Toolkit.Toolkit<Record<string, never>>

const seed: ReadonlyArray<AgentMessage> = [{ role: "user", content: "hi" }]

/**
 * Build a fake resolved toolkit whose `handle` yields whatever Effect we pass.
 * Only the `handle` channel matters for `recoverMalformedToolCalls`.
 */
const fakeToolkit = (
  handle: (name: unknown, params: unknown) => Effect.Effect<unknown, unknown, never>,
): Toolkit.WithHandler<Record<string, never>> =>
  ({ tools: {}, handle }) as unknown as Toolkit.WithHandler<Record<string, never>>

const callHandle = (tk: Toolkit.WithHandler<Record<string, never>>) =>
  (tk.handle as unknown as (n: unknown, p: unknown) => Effect.Effect<unknown, unknown, never>)(
    "edit_file",
    {},
  )

describe("recoverMalformedToolCalls", () => {
  it("turns a MalformedOutput decode failure into a returned tool failure", () => {
    const base = fakeToolkit(() =>
      Effect.fail({
        _tag: "MalformedOutput",
        description: "Failed to decode tool call parameters for tool 'edit_file'",
      }),
    )
    const out = Effect.runSync(callHandle(recoverMalformedToolCalls(base))) as {
      isFailure: boolean
      result: { error: string; message: string }
      encodedResult: unknown
    }
    expect(out.isFailure).toBe(true)
    expect(out.result.error).toBe("InvalidToolCall")
    expect(out.result.message).toContain("edit_file")
    // The model-facing result and the wire-encoded result are the same object.
    expect(out.encodedResult).toEqual(out.result)
  })

  it("lets MalformedInput (a result encode/validate bug) propagate", () => {
    const base = fakeToolkit(() =>
      Effect.fail({ _tag: "MalformedInput", description: "Failed to validate tool call result" }),
    )
    const exit = Effect.runSyncExit(callHandle(recoverMalformedToolCalls(base)))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("passes a successful handler result through unchanged", () => {
    const ok = { isFailure: false, result: { path: "a.ts" }, encodedResult: { path: "a.ts" } }
    const base = fakeToolkit(() => Effect.succeed(ok))
    const out = Effect.runSync(callHandle(recoverMalformedToolCalls(base)))
    expect(out).toBe(ok)
  })
})

describe("runAgentLoop malformed-response recovery", () => {
  it("feeds a response-decode MalformedOutput back and keeps looping", async () => {
    const model = scriptedModel(["malformed", "done"])
    const program = runAgentLoop({
      system: "s",
      messages: seed,
      toolkit: oneToolToolkit,
      maxSteps: 5,
    }).pipe(
      Effect.provideService(LanguageModel.LanguageModel, model.layer),
    ) as Effect.Effect<AgentResult, unknown, never>
    const res = await Effect.runPromise(program)

    // Failed once, retried, succeeded — the turn was NOT aborted.
    expect(model.calls()).toBe(2)
    expect(res.finalText).toBe("done")
    // A corrective message naming the real toolkit was injected before retry.
    const lastUser = res.messages.filter((m) => m.role === "user").at(-1)
    expect(String(lastUser?.content)).toContain("read_file")
    expect(String(lastUser?.content)).toContain("could not be parsed")
  })

  it("gives up after MAX_MALFORMED consecutive failures (surfaces the error)", async () => {
    const model = scriptedModel(["malformed"]) // always malformed
    const program = runAgentLoop({
      system: "s",
      messages: seed,
      toolkit: oneToolToolkit,
      maxSteps: 20,
    }).pipe(
      Effect.provideService(LanguageModel.LanguageModel, model.layer),
    ) as Effect.Effect<AgentResult, unknown, never>
    const exit = await Effect.runPromiseExit(program)

    // 3 retries are tolerated; the 4th consecutive failure surfaces, not hangs.
    expect(Exit.isFailure(exit)).toBe(true)
    expect(model.calls()).toBe(4)
  })
})

describe("runAgentLoop newTail (the persist boundary)", () => {
  it("a clean run reports exactly what was appended — empty here, not an index slice", async () => {
    const model = scriptedModel(["done"])
    const res = await Effect.runPromise(
      runAgentLoop({ system: "s", messages: seed, toolkit: oneToolToolkit, maxSteps: 5 }).pipe(
        Effect.provideService(LanguageModel.LanguageModel, model.layer),
      ) as Effect.Effect<AgentResult, unknown, never>,
    )
    // scripted "done" carries no content parts → nothing was appended.
    expect(res.newTail).toEqual([])
    expect(res.messages).toEqual([...seed])
  })

  it("the synthetic corrective from malformed recovery is IN newTail — it must persist", async () => {
    const model = scriptedModel(["malformed", "done"])
    const res = await Effect.runPromise(
      runAgentLoop({ system: "s", messages: seed, toolkit: oneToolToolkit, maxSteps: 5 }).pipe(
        Effect.provideService(LanguageModel.LanguageModel, model.layer),
      ) as Effect.Effect<AgentResult, unknown, never>,
    )
    expect(res.newTail.length).toBe(1)
    expect(res.newTail[0]!.role).toBe("user")
    expect(String(res.newTail[0]!.content)).toContain("could not be parsed")
    // The full buffer is exactly input + tail — callers never do arithmetic.
    expect(res.messages).toEqual([...seed, ...res.newTail])
  })
})

describe("generateHandoffBrief", () => {
  it("summarizes the loaded view through the model and trims the reply", async () => {
    // scriptedModel's "done" responses carry text "done"; that IS the brief here.
    const model = scriptedModel(["done"])
    const brief = await Effect.runPromise(
      generateHandoffBrief([
        { role: "user", content: "we did things" },
        { role: "assistant", content: "indeed" },
      ] as ReadonlyArray<AgentMessage>).pipe(
        Effect.provideService(LanguageModel.LanguageModel, model.layer),
      ) as Effect.Effect<string, unknown, never>,
    )
    expect(brief).toBe("done")
    expect(model.calls()).toBe(1)
  })
})

describe("safeArgsSummary", () => {
  it("projects short scalar fields as a k=v label (tool-agnostic, no schema)", () => {
    expect(safeArgsSummary({ command: "bun test", timeout: 60 })).toBe("command=bun test timeout=60")
    expect(safeArgsSummary({ pattern: "TODO", dir: "." })).toBe("pattern=TODO dir=.")
    expect(safeArgsSummary({ flag: true })).toBe("flag=true")
  })

  it("drops arrays/objects and long strings — a file's contents never leak", () => {
    // `content` is a whole file; `edits` is a nested array — both omitted, only
    // the short scalar `path` survives.
    const out = safeArgsSummary({ path: "src/a.ts", content: "a".repeat(500), edits: [{ a: 1 }] })
    expect(out).toBe("path=src/a.ts")
  })

  it("is total over non-objects and clips the whole label", () => {
    expect(safeArgsSummary(undefined)).toBe("")
    expect(safeArgsSummary("nope")).toBe("")
    const out = safeArgsSummary({ a: "x".repeat(100), b: "y".repeat(100) })
    expect(out.length).toBeLessThanOrEqual(201)
  })
})
