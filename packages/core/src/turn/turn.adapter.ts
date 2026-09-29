import { Context, Effect, Layer, Option, Ref, Scope } from "effect"
import { HarnessError } from "../harness/plugin.entity.js"
import { fingerprintOf } from "../memory/memory-log.entity.functions.js"
import type { LogEntry } from "../memory/memory-log.entity.js"
import { readerOf } from "../memory/memory-session.js"
import { Capabilities } from "../ports/capability.port.js"
import type { Capability, PromptContext, PromptSection } from "../ports/capability.port.js"
import { ConversationMemory } from "../ports/memory.port.js"
import { RunContext } from "../ports/run-context.port.js"
import { ToolRegistry } from "../ports/tool-registry.port.js"
import type { RunTools } from "../ports/tool-registry.port.js"
import { TurnEvents, TurnTasks } from "../ports/turn-events.port.js"
import { TurnMemory, TurnPrompt, TurnToolbox } from "../ports/turn-scope.port.js"
import type { TurnLiveInput } from "../ports/turn-scope.port.js"
import { makeJournalWriter } from "./journal-writer.js"
import { renderSections } from "./prompt-sections.js"
import { makeTurnEvents, makeTurnTasks } from "./turn-bus.js"
import { journalBodyOf } from "./turn-event.entity.functions.js"

const failure = (code: string, message: string) => new HarnessError({ code, message })

/** Contributed sections' requirements are erased: they render with the services of their caller. */
const inCaller = <A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> =>
  Effect.flatMap(Effect.context<never>(), (context) => effect.pipe(Effect.provide(context)) as Effect.Effect<A, E>)

/**
 * One admitted turn's services, built in this order: the event bus, the
 * tasks and the write-behind journal, with the journal as the bus's FIRST
 * subscriber (every durable event is queued before any reaction runs);
 * then the memory session, opened where this layer is built (a digester or
 * summarizer there is used), and RunContext. It also holds the tools slot
 * (`TurnToolbox`) and the prompt state (`TurnPrompt`). Nothing is recorded
 * until `TurnMemory.persistMessage`. Tasks run in the layer's scope: they
 * are interrupted, and the journal flushed, when it closes.
 */
export const TurnLive = (input: TurnLiveInput): Layer.Layer<
  RunContext | TurnEvents | TurnTasks | TurnMemory | TurnToolbox | TurnPrompt,
  HarnessError,
  ConversationMemory | ToolRegistry
> => Layer.effectContext(Effect.gen(function* () {
  const scope = yield* Effect.scope
  const memory = yield* ConversationMemory
  const registry = yield* ToolRegistry
  const capabilities = Option.getOrElse(yield* Effect.serviceOption(Capabilities), (): ReadonlyArray<Capability> => [])
  const sections = capabilities.flatMap((capability) => capability.promptSections)

  const events = yield* makeTurnEvents({ maxDepth: input.maxEventDepth ?? 8 })
  const tasks = yield* makeTurnTasks(scope)
  // One ordered write-behind journal for events and memory: producers queue and go on; the
  // turn waits only at flushes. Memory builds every request from its in-process log.
  const writer = yield* makeJournalWriter(input.journal, scope, {
    capacity: input.writer?.capacity ?? 1_024,
    batch: input.writer?.batch ?? 64,
  })
  // The journal is the first subscriber: every durable event is queued before any reaction runs.
  yield* events.subscribe((event) => journalBodyOf(input.runId, event), writer.io.append)
  const session = yield* memory.open({ conversation: input.conversation, runId: input.runId, io: writer.io })
  const reader = readerOf(session)

  const slot = yield* Ref.make(Option.none<RunTools>())
  const openTools = Ref.get(slot).pipe(Effect.flatMap(Option.match({
    onNone: () => Effect.fail(failure("tools.unavailable", "Tools are not open yet")),
    onSome: (tools) => Effect.succeed(tools),
  })))
  const run = RunContext.of({
    conversation: input.conversation,
    runId: input.runId,
    userMessage: input.userMessage,
    memory: reader,
    events,
    tasks,
    activate: (skills) => openTools.pipe(Effect.flatMap((tools) => tools.activate(skills, "host"))),
    flush: writer.flush,
    write: writer.write,
  })

  const claimed = yield* Ref.make(false)
  const started = yield* Ref.make(Option.none<number>())
  const replied = yield* Ref.make(false)
  const turnMemory = TurnMemory.of({
    ...reader,
    strategy: session.strategy,
    session,
    number: Ref.get(started).pipe(Effect.flatMap(Option.match({
      onNone: () => Effect.fail(failure("turn.unstarted", "The user's message is not persisted yet")),
      onSome: (number) => Effect.succeed(number),
    }))),
    persistMessage: Effect.gen(function* () {
      if (yield* Ref.getAndSet(claimed, true)) return yield* Effect.fail(failure("turn.persisted", "The user's message is already persisted"))
      const number = (yield* session.turn) + 1
      yield* session.record([{ _tag: "TurnStarted", userMessage: input.userMessage }], 0)
      yield* Ref.set(started, Option.some(number))
      yield* events.publish({ _tag: "turn.started", runId: input.runId, turn: number, userMessage: input.userMessage })
      return number
    }),
    context: (entry) => session.record([{ _tag: "TurnContext", sectionId: entry.id, version: entry.version, text: entry.text }], 0).pipe(Effect.asVoid),
    persistReply: (outcome) => Effect.gen(function* () {
      const number = yield* Ref.get(started)
      if (Option.isNone(number) || (yield* Ref.getAndSet(replied, true))) return
      yield* session.record([{ _tag: "TurnEnded", outcome: outcome.outcome, reply: outcome.reply }], 0)
      yield* events.publish({ _tag: "turn.ended", runId: input.runId, turn: number.value, outcome: outcome.outcome, reply: outcome.reply })
    }),
  })

  const opened = yield* Ref.make(false)
  const toolbox = TurnToolbox.of({
    open: Effect.gen(function* () {
      if (yield* Ref.getAndSet(opened, true)) return yield* Effect.fail(failure("tools.opened", "The turn's tools are already open"))
      const tools = yield* registry.open(session).pipe(Effect.provideService(RunContext, run), Scope.provide(scope))
      yield* Ref.set(slot, Option.some(tools))
      return tools
    }),
    tools: openTools,
  })

  const promptContext = (tools: RunTools, variant: Option.Option<string>) =>
    tools.active.pipe(Effect.map((active): PromptContext => ({ variant, active, skills: tools.skills })))
  const rendered = (tools: RunTools, variant: Option.Option<string>, tiers: (section: PromptSection) => boolean) =>
    inCaller(promptContext(tools, variant).pipe(Effect.flatMap((context) => renderSections(sections.filter(tiers), context))))
  const lastSystem = yield* Ref.make(Option.fromNullishOr((yield* session.entries).flatMap((entry: LogEntry) =>
    entry.body._tag === "SystemPrepared" ? [entry.body.fingerprint] : []).at(-1)))
  const systems = yield* Ref.make(new Map<string, string>())
  const turnSections = yield* Ref.make(false)
  const prompt = TurnPrompt.of({
    system: (variant) => Effect.gen(function* () {
      const key = Option.getOrElse(variant, () => "")
      const known = (yield* Ref.get(systems)).get(key)
      if (known !== undefined) return known
      const parts = yield* rendered(yield* openTools, variant, (section) => section.tier !== "turn")
      const text = [input.system ?? "", ...parts.map((part) => part.text)].filter((part) => part.trim().length > 0).join("\n\n")
      const fingerprint = fingerprintOf(text)
      if (!Option.contains(yield* Ref.get(lastSystem), fingerprint)) {
        yield* session.record([{
          _tag: "SystemPrepared", fingerprint, text,
          sections: parts.map((part) => ({ id: part.section.id, version: part.section.version, fingerprint: fingerprintOf(part.text) })),
        }], 0)
        yield* Ref.set(lastSystem, Option.some(fingerprint))
      }
      yield* Ref.update(systems, (all) => new Map([...all, [key, text]]))
      return text
    }),
    turnSections: Effect.gen(function* () {
      if (yield* Ref.getAndSet(turnSections, true)) return
      const parts = yield* rendered(yield* openTools, Option.none(), (section) => section.tier === "turn")
      yield* parts.length === 0 ? Effect.void : session.record(parts.map(({ section, text }) => ({
        _tag: "TurnContext" as const, sectionId: section.id, version: section.version, text,
      })), 0)
    }),
  })

  return Context.make(RunContext, run).pipe(
    Context.add(TurnEvents, events),
    Context.add(TurnTasks, tasks),
    Context.add(TurnMemory, turnMemory),
    Context.add(TurnToolbox, toolbox),
    Context.add(TurnPrompt, prompt),
  )
}))
