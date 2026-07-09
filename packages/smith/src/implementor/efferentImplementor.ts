import type { LanguageModel } from "@effect/ai"
import { Effect, Layer, Option, Ref } from "effect"
import { Implementor, ImplementorError } from "@xandreed/foundry"
import type { WorkspacePath } from "@xandreed/foundry"
import { ConversationStore, FileSystem, runAgent, Shell } from "@xandreed/engine"
import type { ConversationId, LoopEvent, SpecDoc } from "@xandreed/engine"
import type { SmithEvent } from "../domain/SmithEvent.js"
import { capturePath } from "./filesTouched.js"
import { makeSmithCodingHandlers, smithCodingToolkit } from "./codingToolkit.js"
import { renderBrief, renderRetryBrief, smithCoderSystemPrompt } from "./prompt.js"

/**
 * The coder at the forge, RE-FOUNDED on the new line: a capable DIRECT agent
 * (the engine's loop + the smith coding toolkit) doing agentic engineering,
 * with foundry's gates entirely OUTSIDE it — no fleet, no sub-agent tree, no
 * gates-inside-gates. Refine happened upstream (the locked SpecDoc IS the
 * refined prompt); the forge loop drives attempts and the gate pipeline
 * judges the workspace.
 *
 * Each forge run gets ONE persisted conversation: attempt 1 opens it with
 * the brief; every retry continues the SAME conversation with the gate
 * feedback as the next user prompt — cache-warm, full context. The receipt's
 * `ref` ("conversation:<id>") links the FactoryRun artifact back to it.
 *
 * Error mapping: only INFRA failures (a provider error that survived the
 * retry ladder, a defect) become `ImplementorError` — forge retries those
 * twice. A finished-but-weak turn returns a normal receipt: the gates judge.
 */

export type ImplementorServices =
  | FileSystem
  | Shell
  | ConversationStore
  | LanguageModel.LanguageModel

// 100 (raised from 40 on user call): real ports kept handing off mid-slice.
// The runaway bounds are the degenerate-loop breaker + the empty-write guard
// + the wall-clock budget — the ceiling only sets the gate-feedback cadence.
const MAX_ATTEMPT_STEPS = 100

export interface EfferentImplementorOptions {
  /** The workspace the coder works in — the same dir the gates snapshot. */
  readonly cwd: string
  /** The smith event sink; the coder's LoopEvents ride it as `{type:"agent"}`. */
  readonly publish: (event: SmithEvent) => Effect.Effect<void>
  /** The locked SpecDoc driving this run — its constraints/non-goals reach the
   *  brief here (foundry's `Spec` never carries them). `None` = shorthand path. */
  readonly doc: Option.Option<SpecDoc>
  /** Rendered forge-history lessons (foundry's deterministic memory) — folded
   *  into the attempt-1 brief; retries already carry the gate feedback. */
  readonly lessons?: Option.Option<string>
}

export const makeEfferentImplementorLive = (
  options: EfferentImplementorOptions,
): Layer.Layer<Implementor, never, ImplementorServices> =>
  Layer.scoped(
    Implementor,
    Effect.gen(function* () {
      const context = yield* Effect.context<ImplementorServices>()
      const store = yield* ConversationStore
      const handlers = yield* Layer.build(
        smithCodingToolkit.toLayer(makeSmithCodingHandlers(options.cwd)),
      )

      const conversationRef = yield* Ref.make(Option.none<ConversationId>())
      const conversation = Effect.gen(function* () {
        const existing = yield* Ref.get(conversationRef)
        if (Option.isSome(existing)) return existing.value
        const fresh = yield* store.create(options.cwd)
        yield* Ref.set(conversationRef, Option.some(fresh))
        return fresh
      })

      return Implementor.of({
        implement: (input) =>
          Effect.gen(function* () {
            const filesRef = yield* Ref.make<ReadonlyArray<WorkspacePath>>([])
            const cid = yield* conversation.pipe(
              Effect.mapError(
                (cause) =>
                  new ImplementorError({
                    attempt: input.attempt,
                    message: `conversation store: ${String(cause)}`,
                  }),
              ),
            )
            const onEvent = (event: LoopEvent) =>
              (event.type === "tool_end"
                ? Ref.update(filesRef, (all) =>
                    Option.match(capturePath(event, options.cwd), {
                      onNone: () => all,
                      onSome: (path) => (all.includes(path) ? all : [...all, path]),
                    }),
                  )
                : Effect.void
              ).pipe(Effect.zipRight(options.publish({ type: "agent", event })))

            const brief = Option.match(input.feedback, {
              onNone: () =>
                renderBrief(input.spec, options.doc, options.lessons ?? Option.none()),
              onSome: renderRetryBrief,
            })

            // The turn's prose is not the deliverable — the workspace state the
            // gates snapshot is; the run is driven for its side effects. Loop
            // failures AND defects map to ImplementorError (infra), never a
            // silent success.
            yield* runAgent(
              {
                system: smithCoderSystemPrompt(options.cwd),
                toolkit: smithCodingToolkit,
                maxSteps: MAX_ATTEMPT_STEPS,
              },
              cid,
              brief,
              { onEvent },
            ).pipe(
              Effect.provide(handlers),
              Effect.provide(context),
              Effect.mapError(
                (cause) =>
                  new ImplementorError({
                    attempt: input.attempt,
                    message: String(cause),
                  }),
              ),
              Effect.catchAllDefect((defect) =>
                Effect.fail(
                  new ImplementorError({
                    attempt: input.attempt,
                    message: `implementor crashed: ${String(defect)}`,
                  }),
                ),
              ),
            )

            return {
              filesTouched: [...(yield* Ref.get(filesRef))].sort(),
              ref: Option.some(`conversation:${cid}`),
            }
          }).pipe(
            Effect.withSpan("smith.implement", {
              attributes: { "attempt.n": input.attempt },
            }),
          ),
      })
    }),
  )
