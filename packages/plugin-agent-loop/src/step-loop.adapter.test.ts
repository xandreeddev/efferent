import { describe, expect, test } from "bun:test"
import { LanguageModel, Prompt } from "effect/ai"
import type { Tool } from "effect/ai"
import { Context, Effect, Option, Stream } from "effect"
import { CurrentAgentStep, HarnessError, responseText, responseToAgentMessages, responseToolCalls, StepLoop, stepLoopConformance, toPromptMessages } from "@xandreed/core"
import type { CompletionVerdict, RunResult, StepInfo, StepRequest } from "@xandreed/core"
import { runSteps, STEP_LOOP } from "./step-loop.adapter.js"

/**
 * The smallest loop that honours the StepLoop contract, written directly on
 * @effect/ai: proof that the kit checks the contract, not runLoop's shape.
 */
const minimalLoop = StepLoop.of({
  id: "minimal", version: "1",
  run: (request: StepRequest) => Effect.gen(function* () {
    const handlers = request.handlers as Context.Context<Tool.HandlersFor<Record<string, Tool.Any>>>
    const model = yield* Effect.orDie(Effect.fromOption(Context.getOption(request.handlers, LanguageModel.LanguageModel)))
    const toolkit = yield* request.tools.toolkit.pipe(Effect.provide(handlers))
    const evaluate = (info: StepInfo): Effect.Effect<CompletionVerdict, HarnessError> => request.completion(info).pipe(
      Effect.tap((verdict) => request.events.publish({ _tag: "completion.evaluated", step: info.stepIndex, verdict })))
    const step = (index: number, text: string): Effect.Effect<RunResult, HarnessError> => Effect.gen(function* () {
      if (index >= request.limits.maxSteps) return { outcome: "partial", reason: "step-cap", text, steps: index } satisfies RunResult
      const activeTools = yield* request.tools.active
      const info: StepInfo = { stepIndex: index, activeTools, lastUsage: Option.none() }
      const planned = index === 0 ? request.initial : Option.none()
      yield* request.events.publish({ _tag: "step.started", step: index, planned: Option.isSome(planned), activeTools })
      const plan = Option.isSome(planned) ? Option.none() : Option.some(yield* request.plan(info))
      const provider = Option.isSome(planned)
        ? yield* LanguageModel.make({
          generateText: () => Effect.succeed([
            ...planned.value.calls.map((call, position) => ({ type: "tool-call" as const, id: `planned:${position}`, name: call.name, params: call.params, providerExecuted: false })),
            { type: "finish" as const, reason: "tool-calls" as const, usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } } },
          ]),
          streamText: () => Stream.empty,
        })
        : Option.getOrElse(Option.flatMap(plan, (value) => value.model), () => model)
      const prompt = Option.match(plan, {
        onNone: () => Prompt.empty,
        onSome: (value) => Prompt.concat(Prompt.make([{ role: "system", content: value.system }]), Prompt.make(toPromptMessages(value.messages) as Prompt.RawInput)),
      })
      const toolChoice = Option.flatMap(plan, (value) => value.toolChoice)
      if (Option.isSome(plan)) yield* request.dispatch(index, {
        prompt, tools: Object.values(toolkit.tools), toolChoice: Option.getOrElse(toolChoice, () => "auto"), model: provider,
      })
      // The tools declare no dependencies: the call needs no services (`Tool.Any` widens them to `any`).
      const generated: Effect.Effect<{ readonly content: ReadonlyArray<unknown> }, unknown> = provider.generateText({ prompt, toolkit, ...Option.match(toolChoice, { onNone: () => ({}), onSome: (choice) => ({ toolChoice: choice }) }) }) as never
      const response = yield* generated.pipe(
        Effect.provide(handlers),
        Effect.provideService(CurrentAgentStep, Option.some(index)),
        Effect.mapError((error) => new HarnessError({ code: "loop.failed", message: String(error) })),
      )
      const content: ReadonlyArray<unknown> = response.content
      const entries = yield* request.record(index, responseToAgentMessages(content))
      yield* request.events.publish({ _tag: "step.ended", step: index, status: "completed", results: entries.flatMap((entry) =>
        entry.body._tag === "ToolResult" ? [{ entry: entry.id, toolCallId: entry.body.toolCallId, tool: entry.body.toolName, ok: !entry.body.isError }] : []) })
      const first = yield* evaluate(info)
      const verdict = first.complete || first.awaiting.length === 0 ? first : yield* request.tasks.await(first.awaiting).pipe(Effect.andThen(evaluate(info)))
      const reply = responseText(content).length > 0 ? responseText(content) : text
      if (verdict.complete || responseToolCalls(content).length === 0) return { outcome: "completed", reason: "completed", text: reply, steps: index + 1 } satisfies RunResult
      return yield* step(index + 1, reply)
    })
    return yield* step(0, "")
  }),
})

const conform = (name: string, loop: Context.Service.Shape<typeof StepLoop>) => describe(`${name} conforms to StepLoop`, () => {
  stepLoopConformance(loop).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
})

conform("StepLoopLive", StepLoop.of({ ...STEP_LOOP, run: runSteps }))
conform("a minimal loop", minimalLoop)
