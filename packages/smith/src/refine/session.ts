import type { LanguageModel } from "@effect/ai"
import { Effect, Option, Ref } from "effect"
import { ConfigError } from "@xandreed/foundry"
import { ConversationStore, runAgent, SpecSlug } from "@xandreed/engine"
import { loadForgeLessons, loadWorkspaceRules } from "../forge/session.js"
import type { AgentMessage, ConversationId, FileSystem, Shell, SpecDoc } from "@xandreed/engine"
import { expandFileRefs } from "./fileRefs.js"
import {
  makeSpecRefinerHandlers,
  specRefinerAgentConfig,
  specRefinerToolkit,
} from "./refiner.js"
import type { SmithEvent } from "../domain/SmithEvent.js"
import { discoverSkills, renderSkillsBlock } from "../skills/skills.js"
import { loadSpecDoc, lockSpecDoc } from "../spec/store.js"

/** What a refine session needs from the environment — the coder's
 *  `ImplementorServices` minus the fast tier (only the implementor's
 *  attempt-boundary compaction rides `UtilityLlm`). */
export type RefineServices =
  | FileSystem
  | Shell
  | ConversationStore
  | LanguageModel.LanguageModel

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
  /** Continue an EXISTING conversation instead of creating one (`:resume`) —
   *  the model keeps its full history; the UI replays it separately. */
  readonly resume?: ConversationId
  /** Test seam; absent ⇒ the real refiner agent over `runAgent`. */
  readonly agent?: RefineAgent
  /** MID-TURN steering (the engine's `pendingInput` seam): text typed while
   *  a turn runs lands at the next step instead of after the whole turn. */
  readonly pendingInput?: () => Effect.Effect<Option.Option<string>>
}

/** The LAST successful propose_spec result in a persisted trail — the draft
 *  linkage a resumed session must recover (the tool's success carries
 *  {slug, path}). Pure over the message list; exported for tests. */
export const lastProposedDraft = (
  messages: ReadonlyArray<AgentMessage>,
): Option.Option<{ slug: SpecSlug; path: string }> =>
  Option.fromNullable(
    messages.reduce<{ slug: SpecSlug; path: string } | undefined>((latest, message) => {
      if (message.role !== "tool" || !Array.isArray(message.content)) return latest
      return message.content.reduce((acc, part) => {
        const p = part as {
          readonly type?: string
          readonly toolName?: string
          readonly isError?: boolean
          readonly output?: { readonly slug?: unknown; readonly path?: unknown }
        }
        return p.type === "tool-result" &&
          p.toolName === "propose_spec" &&
          p.isError !== true &&
          typeof p.output?.slug === "string" &&
          typeof p.output?.path === "string"
          ? { slug: SpecSlug.make(p.output.slug), path: p.output.path }
          : acc
      }, latest)
    }, undefined),
  )

export const makeRefineSession = (
  cwd: string,
  publish: (event: SmithEvent) => Effect.Effect<void>,
  options: RefineSessionOptions,
): Effect.Effect<RefineSession, never, RefineServices> =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const context = yield* Effect.context<RefineServices>()
    const conversationId =
      options.resume ?? (yield* store.create(cwd).pipe(Effect.orDie))
    // RESUME recovers the draft linkage from the TRAIL: draftRef is
    // in-memory, so without this a resumed session says "nothing to lock"
    // while the spec sits on disk and the model — which remembers proposing
    // — refuses to re-propose. A live DEADLOCK.
    const recovered = yield* Option.match(Option.fromNullable(options.resume), {
      onNone: () => Effect.succeed(Option.none<{ slug: SpecSlug; path: string }>()),
      onSome: (cid) =>
        store.list(cid).pipe(
          Effect.map(lastProposedDraft),
          Effect.orElseSucceed(() => Option.none<{ slug: SpecSlug; path: string }>()),
        ),
    })
    const draftRef = yield* Ref.make(recovered)

    // ONE handler record for the whole session — the layer (real agent) and
    // the scripted seam share the same slug identity + draft tracking. A
    // recovered slug keeps re-proposes updating the SAME spec file.
    const sessionSlug = options.slug ?? Option.getOrUndefined(Option.map(recovered, (r) => r.slug))
    const handlers = yield* makeSpecRefinerHandlers(cwd, {
      ...(sessionSlug !== undefined ? { slug: sessionSlug } : {}),
      onProposed: (slug, path) => Ref.set(draftRef, Option.some({ slug, path })),
    })
    const refinerLayer = specRefinerToolkit.toLayer(handlers)
    const tools: RefineTools = { propose: handlers.propose_spec }
    const lessons = yield* loadForgeLessons(cwd)
    const rules = yield* loadWorkspaceRules(cwd)
    const skillsBlock = renderSkillsBlock(yield* discoverSkills(cwd))
    const config = specRefinerAgentConfig(cwd, {
      unattended: options.unattended,
      lessons,
      rules,
      skills: skillsBlock.length > 0 ? Option.some(skillsBlock) : Option.none(),
    })

    const realAgent: RefineAgent = (cid, prompt) =>
      runAgent(config, cid, prompt, {
        onEvent: (event) => publish({ type: "agent", event }),
        ...(options.pendingInput !== undefined ? { pendingInput: options.pendingInput } : {}),
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
          // @path refs expand into inline file blocks (bounded; notes ride
          // the notice line via refine_error? no — they are advisory only).
          const expanded = yield* expandFileRefs(cwd, text).pipe(Effect.provide(context))
          yield* expanded.notes.length > 0
            ? publish({ type: "file_refs", notes: expanded.notes })
            : Effect.void
          yield* agent(conversationId, expanded.text, tools)
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
