import { Effect, Option, Ref } from "effect"
import { ConfigError } from "@xandreed/foundry"
import { ConversationStore, runAgent } from "@xandreed/engine"
import type { ConversationId, SpecDoc, SpecSlug } from "@xandreed/engine"
import {
  makeSpecRefinerHandlers,
  specRefinerAgentConfig,
  specRefinerToolkit,
} from "./refiner.js"
import type { SmithEvent } from "../domain/SmithEvent.js"
import type { ImplementorServices } from "../implementor/efferentImplementor.js"
import { loadSpecDoc, lockSpecDoc } from "../spec/store.js"

export interface DraftRef {
  readonly doc: SpecDoc
  readonly path: string
}

/**
 * One refine session: a persisted conversation with the spec-refiner agent.
 * `send` runs one turn (the TUI composer / the headless one-shot both drive
 * it); after each turn the draft file is RE-READ — the file is the truth, the
 * conversation is just how it got there. `lock` is the human's approval and
 * the only path to `status: locked`.
 */
export interface RefineSession {
  readonly conversationId: ConversationId
  readonly send: (text: string) => Effect.Effect<Option.Option<DraftRef>, ConfigError>
  readonly currentDraft: Effect.Effect<Option.Option<DraftRef>>
  readonly lock: Effect.Effect<DraftRef, ConfigError>
}

/** What a scripted refiner may do: exactly what the real one may — propose.
 *  The session hands over ITS handler record, so both paths share the same
 *  slug identity and draft tracking. */
export interface RefineTools {
  readonly propose: Effect.Effect.Success<
    ReturnType<typeof makeSpecRefinerHandlers>
  >["propose_spec"]
}

/** The turn runner seam — tests inject a scripted refiner; production runs
 *  the real agent. Infra failures surface as `ConfigError` messages. */
export type RefineAgent = (
  conversationId: ConversationId,
  prompt: string,
  tools: RefineTools,
) => Effect.Effect<void, ConfigError>

export interface RefineSessionOptions {
  readonly unattended: boolean
  /** Refine an existing spec in place. */
  readonly slug?: SpecSlug
  /** Test seam; absent ⇒ the real refiner agent over `runAgent`. */
  readonly agent?: RefineAgent
}

export const makeRefineSession = (
  cwd: string,
  publish: (event: SmithEvent) => Effect.Effect<void>,
  options: RefineSessionOptions,
): Effect.Effect<RefineSession, never, ImplementorServices> =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const context = yield* Effect.context<ImplementorServices>()
    const conversationId = yield* store.create(cwd).pipe(Effect.orDie)
    const draftRef = yield* Ref.make(Option.none<{ slug: SpecSlug; path: string }>())

    // ONE handler record for the whole session — the layer (real agent) and
    // the scripted seam share the same slug identity + draft tracking.
    const handlers = yield* makeSpecRefinerHandlers(cwd, {
      ...(options.slug !== undefined ? { slug: options.slug } : {}),
      onProposed: (slug, path) => Ref.set(draftRef, Option.some({ slug, path })),
    })
    const refinerLayer = specRefinerToolkit.toLayer(handlers)
    const tools: RefineTools = { propose: handlers.propose_spec }
    const config = specRefinerAgentConfig(cwd, { unattended: options.unattended })

    const realAgent: RefineAgent = (cid, prompt) =>
      runAgent(config, cid, prompt, {
        onEvent: (event) => publish({ type: "agent", event }),
      }).pipe(
        Effect.provide(refinerLayer),
        Effect.provide(context),
        Effect.asVoid,
        Effect.catchAll((error) =>
          Effect.fail(new ConfigError({ path: cwd, message: `refiner: ${String(error)}` })),
        ),
        Effect.catchAllDefect((defect) =>
          Effect.fail(new ConfigError({ path: cwd, message: `refiner: ${String(defect)}` })),
        ),
      )
    const agent = options.agent ?? realAgent

    // The draft FILE is the truth. A file that no longer decodes (hand-edit
    // gone wrong, codec gap) is SURFACED as refine_error — never swallowed
    // (live-caught: a silent None left the panel saying "no draft yet" while
    // propose_spec had fired three times).
    const readDraft: Effect.Effect<Option.Option<DraftRef>> = Effect.gen(function* () {
      const current = yield* Ref.get(draftRef)
      if (Option.isNone(current)) return Option.none<DraftRef>()
      return yield* loadSpecDoc(cwd, String(current.value.slug)).pipe(
        Effect.map((doc) => Option.some({ doc, path: current.value.path })),
        Effect.catchAll((error) =>
          publish({
            type: "refine_error",
            message: `draft file no longer decodes: ${error.message}`,
          }).pipe(Effect.as(Option.none<DraftRef>())),
        ),
        Effect.provide(context),
      )
    })

    return {
      conversationId,
      currentDraft: readDraft,
      send: (text) =>
        Effect.gen(function* () {
          yield* agent(conversationId, text, tools)
          const draft = yield* readDraft
          yield* Option.match(draft, {
            onNone: () => Effect.void,
            onSome: (ref) => publish({ type: "spec_draft", doc: ref.doc, path: ref.path }),
          })
          return draft
        }).pipe(
          Effect.tapError((error) =>
            publish({ type: "refine_error", message: error.message }),
          ),
        ),
      lock: Effect.gen(function* () {
        const draft = yield* readDraft
        if (Option.isNone(draft)) {
          return yield* Effect.fail(
            new ConfigError({ path: cwd, message: "nothing to lock — no draft proposed yet" }),
          )
        }
        const locked = yield* lockSpecDoc(
          cwd,
          draft.value.doc,
          new Date().toISOString(),
        ).pipe(Effect.provide(context))
        yield* publish({ type: "spec_locked", doc: locked, path: draft.value.path })
        return { doc: locked, path: draft.value.path }
      }),
    }
  })
