import type { LanguageModel } from "@effect/ai"
import { Effect, Fiber, Option, PubSub, Ref, Stream } from "effect"
import type { AgentEvent, ConversationId } from "@xandreed/sdk-core"
import {
  ConversationStore,
  makeAgentEventHooks,
  runAgent,
  SettingsStore,
  UtilityLlm,
} from "@xandreed/sdk-core"
import type { MathItem } from "./domain/MathContent.js"
import { mathAgentBundle } from "./toolkit.js"

/**
 * The math session's event vocabulary: the loop's own `AgentEvent`s plus the
 * ONE product event — `math_render`, published by the `render_math` handler
 * the moment a batch is accepted (the UI never parses tool-call args).
 */
export type MathSessionEvent =
  | AgentEvent
  | { readonly type: "math_render"; readonly items: ReadonlyArray<MathItem> }

/** One ledger entry: a session event with its absolute position. */
export interface MathSeqEvent {
  readonly seq: number
  readonly event: MathSessionEvent
}

/** Everything one math turn runs on (the smith pattern: adapters at the edge). */
export type MathRunServices =
  | LanguageModel.LanguageModel
  | ConversationStore
  | SettingsStore
  | UtilityLlm

/**
 * The math session chassis — the four ops the driver needs, over ONE persisted
 * conversation and an append-only in-memory event ledger (the smith pattern:
 * queue + pump, no Workspace daemon). `send` runs a whole agent turn and
 * serializes: a second send while a turn runs WAITS (the server's `busy` guard
 * coalesces user actions before it ever gets here). `interrupt` stops the
 * in-flight turn's fiber; the ledger survives for replay.
 */
export interface MathSession {
  readonly conversationId: ConversationId
  /** Run one agent turn over the session's conversation (serialized). */
  readonly send: (text: string) => Effect.Effect<void>
  /** Interrupt the in-flight turn, if any. */
  readonly interrupt: Effect.Effect<void>
  /** The full ledger + the next cursor (subscribe from here for live-only). */
  readonly state: Effect.Effect<{
    readonly log: ReadonlyArray<MathSeqEvent>
    readonly cursor: number
  }>
  /** Every event with `seq >= since`: the replay prefix, then live. */
  readonly subscribe: (since: number) => Stream.Stream<MathSeqEvent>
  /** Interrupt the in-flight turn (idempotent) — the process exit finalizer. */
  readonly shutdown: Effect.Effect<void>
}

export const makeMathSession = (args: {
  readonly conversationId: ConversationId
  readonly cwd: string
}): Effect.Effect<MathSession, never, MathRunServices> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<MathRunServices>()
    const log = yield* Ref.make<ReadonlyArray<MathSeqEvent>>([])
    const hub = yield* PubSub.sliding<MathSeqEvent>(512)
    const running = yield* Ref.make(Option.none<Fiber.RuntimeFiber<void>>())
    // One turn at a time: the loop's persistence + the UI's generating flag
    // both assume serial turns.
    const gate = yield* Effect.makeSemaphore(1)

    const publish = (event: MathSessionEvent): Effect.Effect<void> =>
      Ref.modify(log, (entries) => {
        const entry: MathSeqEvent = { seq: entries.length, event }
        return [entry, [...entries, entry]] as const
      }).pipe(
        Effect.flatMap((entry) => PubSub.publish(hub, entry)),
        Effect.asVoid,
      )

    // The toolkit's handler publishes math_render through this sink.
    const bundle = mathAgentBundle((items) => publish({ type: "math_render", items }))
    const hooks = makeAgentEventHooks(publish)

    const runTurn = (text: string): Effect.Effect<void> =>
      runAgent(
        bundle.agentConfig,
        args.conversationId,
        text,
        hooks,
        args.cwd,
        undefined,
        "interactive",
      ).pipe(
        Effect.provide(bundle.handlerLayer),
        Effect.provide(context),
        Effect.asVoid,
        Effect.catchAll((error) => publish({ type: "error", message: String(error) })),
        Effect.catchAllDefect((defect) =>
          publish({ type: "error", message: `turn crashed: ${String(defect)}` }),
        ),
      )

    const send = (text: string): Effect.Effect<void> =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(runTurn(text))
          yield* Ref.set(running, Option.some(fiber))
          yield* Fiber.join(fiber).pipe(Effect.ignore)
          yield* Ref.set(running, Option.none())
        }),
      )

    const interrupt = Ref.get(running).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
        }),
      ),
    )

    return {
      conversationId: args.conversationId,
      send,
      interrupt,
      state: Ref.get(log).pipe(
        Effect.map((entries) => ({ log: entries, cursor: entries.length })),
      ),
      subscribe: (since) =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
            // Subscribe FIRST, then snapshot — anything landing between the
            // snapshot and the live tail is deduped by seq (the identity).
            const sub = yield* PubSub.subscribe(hub)
            const entries = yield* Ref.get(log)
            const replay = Stream.fromIterable(entries.filter((e) => e.seq >= since))
            const seen = entries.length
            const live = Stream.fromQueue(sub).pipe(
              Stream.filter((e) => e.seq >= Math.max(since, seen)),
            )
            return Stream.concat(replay, live)
          }),
        ),
      shutdown: interrupt,
    } satisfies MathSession
  })
