import { LanguageModel } from "@effect/ai"
import { Context, Duration, Effect, Layer, Ref, Stream } from "effect"
import { ConversationStore } from "@xandreed/engine"
import type { AgentMessage } from "@xandreed/engine"
import { LocalAuthStoreLive, SqliteConversationStoreLive } from "@xandreed/providers"
import { DefaultUiHostLive, SqliteUiPageStoreLive, UiAgentRuntimeLive, makeCanvasSession } from "@xandreed/canvas"
import type { CanvasEvent, CanvasSession } from "@xandreed/canvas"
import {
  UiAgentExecutionProfile,
  UiAgentModels,
  UiHost,
  UiPageStore,
  applicationReference,
  architectureReference,
  foldPageEvents,
  landingReference,
  validatePageCompleteness,
} from "@xandreed/ui-agent"
import type { UiPageEvent } from "@xandreed/ui-agent"
import { mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { Check, Pack } from "../framework/model.js"
import { scenario } from "../framework/run.js"
import { eventWhere, toolSequence, turnAlternationValid } from "../framework/evidence.js"
import { generalTierCall } from "../live/llm.js"
import { UI_PAGE_QUALITY_RUBRIC_VERSION, makeUiPageQualityJudge } from "../judges/uiPageQuality.js"

const finish = (reason: string) => ({ type: "finish", reason, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })
const toolCall = (id: string, name: string, params: unknown) => ({ type: "tool-call", id, name, params })

const violatingHero = {
  ...landingReference.blocks[0]!,
  actions: [{ capability: "raw.escape", label: "Unsafe" }],
}

const SCRIPTED_PROMPT = "Build a landing page for an operations product"
const SCRIPTED_PAGE_ID = landingReference.page.id
const SCRIPTED_HOST = {
  tokens: {
    schemaVersion: 1 as const, id: "efferent-canvas", version: "1.0.0",
    colors: { page: "#000000", surface: "#111111", raised: "#222222", line: "#333333", text: "#ffffff", muted: "#aaaaaa", accent: "#ff7700", success: "#00aa66", warning: "#ddaa00", danger: "#dd3344" },
    typography: { display: "geometric", body: "system", mono: "mono", scale: "standard" as const }, density: "standard" as const, radius: "soft" as const, shadow: "subtle" as const, motion: "standard" as const,
  },
  recipes: new Set(["landing.hero-grid", "app.workspace", "doc.architecture"]), assets: new Map(),
  actions: new Map([
    ["canvas.acknowledge", { decode: Effect.succeed, authorize: () => Effect.void, run: () => Effect.succeed({ blocks: [], notice: undefined }) }],
    ["canvas.request-demo", { decode: Effect.succeed, authorize: () => Effect.void, run: () => Effect.succeed({ blocks: [], notice: undefined }) }],
  ]), queries: new Map(),
}
const SCRIPTED_PROFILE = {
  profile: "streaming-ui-v1", version: "4.0.0", schemaVersion: "1.0.0", recipeSetVersion: "1.0.0",
  prompts: { planner: "4.0.0", composer: "5.0.0", repair: "2.0.0" },
  planner: { model: "test:planner", effort: "low" as const, timeoutMs: 15000, maxOutputTokens: 2400, maxSteps: 3 },
  composer: { model: "test:composer", effort: "low" as const, timeoutMs: 20000, maxOutputTokens: 5000, maxSteps: 3 },
  repair: { model: "test:repair", effort: "low" as const, timeoutMs: 8000, maxOutputTokens: 1800, maxSteps: 2, maxAttempts: 1 },
  fallback: { policy: "none" as const },
}

const scripted = (turns: ReadonlyArray<ReadonlyArray<unknown>>) => {
  const calls = Effect.runSync(Ref.make(0))
  return LanguageModel.make({
    generateText: () => Ref.getAndUpdate(calls, (value) => value + 1).pipe(Effect.map((index) => (turns[index] ?? [{ type: "text", text: "Done." }, finish("stop")]) as never)),
    streamText: () => Stream.die("scripted settled fallback") as never,
  })
}

interface CanvasWorld {
  readonly events: () => ReadonlyArray<CanvasEvent>
  readonly persistedUi: () => ReadonlyArray<UiPageEvent>
  readonly session: CanvasSession
  readonly messages: Effect.Effect<ReadonlyArray<AgentMessage>>
}

interface LiveCanvasWorld extends CanvasWorld {
  readonly startedAt: () => number
  readonly start: Effect.Effect<void>
}

interface FollowupWorld extends CanvasWorld {
  readonly runLatestWins: Effect.Effect<void>
  readonly sendLatency: () => { readonly initial: number; readonly followup: number }
  readonly uiBeforeFollowup: () => number
}

const bootCanvasWorld = Effect.gen(function* () {
  const dir = mkdtempSync(join(tmpdir(), "scenario-canvas-v2-"))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
  const uiEvents: Array<UiPageEvent> = []
  const pageStore = {
    append: (_conversationId: unknown, event: UiPageEvent) => Effect.sync(() => { uiEvents.push(event) }),
    list: () => Effect.succeed(uiEvents),
  }
  const planner = yield* scripted([
    [toolCall("bad", "start_ui", { page: landingReference.page, criticalBlocks: [violatingHero] }), finish("tool-calls")],
    [toolCall("fixed", "start_ui", { page: landingReference.page, criticalBlocks: [landingReference.blocks[0]] }), finish("tool-calls")],
    [{ type: "text", text: "Plan ready." }, finish("stop")],
  ])
  const composer = yield* scripted([
    [toolCall("bad", "patch_ui", { pageId: SCRIPTED_PAGE_ID, blocks: [violatingHero] }), finish("tool-calls")],
    [toolCall("complete", "patch_ui", { pageId: SCRIPTED_PAGE_ID, blocks: landingReference.blocks.slice(1), complete: true }), finish("tool-calls")],
    [{ type: "text", text: "Built the governed landing page." }, finish("stop")],
  ])
  const services = yield* Layer.build(Layer.mergeAll(
    SqliteConversationStoreLive(join(dir, "canvas.db")),
    Layer.succeed(UiPageStore, pageStore),
    Layer.succeed(UiHost, SCRIPTED_HOST),
    Layer.succeed(UiAgentExecutionProfile, SCRIPTED_PROFILE),
    Layer.succeed(UiAgentModels, { planner, composer, repair: planner }),
  ))
  const store = Context.get(services, ConversationStore)
  const conversationId = yield* store.create(dir).pipe(Effect.orDie)
  const session = yield* makeCanvasSession({ conversationId }).pipe(Effect.provide(services))
  return {
    events: () => Effect.runSync(session.state).log.map((entry) => entry.event),
    persistedUi: () => uiEvents,
    session,
    messages: store.listByWorkspace(`ui-attempt:${conversationId}`).pipe(
      Effect.orDie,
      Effect.flatMap((summaries) => summaries[0] === undefined ? Effect.succeed([]) : store.list(summaries[0].id).pipe(Effect.orDie)),
    ),
  } satisfies CanvasWorld
})

const bootFollowupWorld = Effect.gen(function* () {
  const dir = mkdtempSync(join(tmpdir(), "scenario-canvas-followup-"))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
  const uiEvents: Array<UiPageEvent> = []
  const pageStore = {
    append: (_conversationId: unknown, event: UiPageEvent) => Effect.sync(() => { uiEvents.push(event) }),
    list: () => Effect.succeed(uiEvents),
  }
  const calls = yield* Ref.make(0)
  const latestHero = { kind: "hero" as const, id: "hero", eyebrow: "Latest request", title: "The follow-up wins immediately.", lede: "The previous slow generation was cancelled before this model-generated replacement was applied." }
  const composer = yield* LanguageModel.make({
    generateText: () => Ref.getAndUpdate(calls, (value) => value + 1).pipe(
      Effect.flatMap((index) => index === 0
        ? Effect.never
        : Effect.succeed((index === 1
          ? [toolCall("latest-open", "start_ui", { page: landingReference.page, criticalBlocks: [latestHero] }), finish("tool-calls")]
          : index === 2
            ? [{ type: "text", text: "Plan accepted." }, finish("stop")]
            : index === 3
              ? [toolCall("latest-complete", "patch_ui", { pageId: SCRIPTED_PAGE_ID, blocks: landingReference.blocks.slice(1), complete: true }), finish("tool-calls")]
              : [{ type: "text", text: "Latest request applied." }, finish("stop")]) as never)),
    ),
    streamText: () => Stream.die("scripted settled fallback") as never,
  })
  const services = yield* Layer.build(Layer.mergeAll(
    SqliteConversationStoreLive(join(dir, "canvas.db")),
    Layer.succeed(UiPageStore, pageStore),
    Layer.succeed(UiHost, SCRIPTED_HOST),
    Layer.succeed(UiAgentExecutionProfile, SCRIPTED_PROFILE),
    Layer.succeed(UiAgentModels, { planner: composer, composer, repair: composer }),
  ))
  const store = Context.get(services, ConversationStore)
  const conversationId = yield* store.create(dir).pipe(Effect.orDie)
  const session = yield* makeCanvasSession({ conversationId }).pipe(Effect.provide(services))
  const latency = yield* Ref.make({ initial: Number.POSITIVE_INFINITY, followup: Number.POSITIVE_INFINITY })
  const beforeFollowup = yield* Ref.make(-1)
  const followup = `[viewing:${SCRIPTED_PAGE_ID}] Replace the generic hero with the latest request.`
  return {
    events: () => Effect.runSync(session.state).log.map((entry) => entry.event),
    persistedUi: () => uiEvents,
    session,
    messages: store.listByWorkspace(`ui-attempt:${conversationId}`).pipe(
      Effect.orDie,
      Effect.flatMap((summaries) => summaries[0] === undefined ? Effect.succeed([]) : store.list(summaries[0].id).pipe(Effect.orDie)),
    ),
    sendLatency: () => Effect.runSync(Ref.get(latency)),
    uiBeforeFollowup: () => Effect.runSync(Ref.get(beforeFollowup)),
    runLatestWins: Effect.gen(function* () {
      const initialAt = Date.now()
      yield* session.send(SCRIPTED_PROMPT)
      const initialDone = Date.now()
      yield* Effect.sleep("10 millis")
      yield* Ref.set(beforeFollowup, uiEvents.length)
      const followupAt = Date.now()
      yield* session.send(followup)
      const followupDone = Date.now()
      yield* Ref.set(latency, { initial: initialDone - initialAt, followup: followupDone - followupAt })
      yield* Effect.sleep("75 millis")
    }),
  } satisfies FollowupWorld
})

const uiEvents = (events: ReadonlyArray<CanvasEvent>): ReadonlyArray<UiPageEvent> => events.flatMap((event) =>
  event.type === "page_opened" || event.type === "blocks_upserted" || event.type === "page_completed" ? [event] : [],
)

const liveWorld = (prompt: string) => Effect.gen(function* () {
  const dir = mkdtempSync(join(tmpdir(), "scenario-canvas-live-"))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
  const dbPath = join(dir, "canvas.db")
  const base = Layer.mergeAll(
    SqliteConversationStoreLive(dbPath),
    SqliteUiPageStoreLive(dbPath),
    DefaultUiHostLive,
    LocalAuthStoreLive(process.cwd(), homedir()),
  )
  const services = yield* Layer.build(UiAgentRuntimeLive.pipe(Layer.provideMerge(base)))
  const conversationStore = Context.get(services, ConversationStore)
  const pageStore = Context.get(services, UiPageStore)
  const conversationId = yield* conversationStore.create(dir).pipe(Effect.orDie)
  const session = yield* makeCanvasSession({ conversationId }).pipe(Effect.provide(services))
  const started = yield* Ref.make(0)
  const waitForEnrichment = session.subscribe(0).pipe(
    Stream.filter((entry) => entry.event.type === "agent_end"),
    Stream.runHead,
    Effect.timeout(Duration.seconds(70)),
    Effect.asVoid,
    Effect.orDie,
  )
  return {
    events: () => Effect.runSync(session.state).log.map((entry) => entry.event),
    persistedUi: () => Effect.runSync(pageStore.list(conversationId).pipe(Effect.orDie)),
    session,
    messages: conversationStore.list(conversationId).pipe(Effect.orDie),
    startedAt: () => Effect.runSync(Ref.get(started)),
    start: Ref.set(started, Date.now()).pipe(Effect.zipRight(session.send(prompt)), Effect.zipRight(waitForEnrichment)),
  } satisfies LiveCanvasWorld
})

const liveCheck = (
  name: string,
  predicate: (world: LiveCanvasWorld) => boolean,
  detail: string,
): Check<LiveCanvasWorld> => ({
  name,
  severity: "hard",
  run: (world) => Effect.sync(() => {
    const pass = predicate(world)
    return { pass, ...(pass ? {} : { detail }) }
  }),
})

const liveScenario = (
  name: string,
  prompt: string,
  archetype: "landing" | "application" | "document",
) => scenario<LiveCanvasWorld>({
  name,
  modes: ["live"],
  boot: liveWorld(prompt),
  steps: [{
    name: "the pinned profile streams and completes one governed page",
    act: (world) => world.start,
    checks: [
      liveCheck("page-complete", (world) => {
        const pages = foldPageEvents(world.persistedUi())
        const page = pages[pages.length - 1]
        return page !== undefined && page.manifest.archetype === archetype && page.complete && validatePageCompleteness(page).length === 0
      }, `expected one complete ${archetype} page`),
      liveCheck("first-block-under-2s", (world) => {
        const opened = world.persistedUi().find((event) => event.type === "page_opened")
        return opened !== undefined && opened.at - world.startedAt() < 2_000
      }, "first accepted block missed the 2s SLA"),
      liveCheck("complete-under-5s", (world) => {
        const completed = world.persistedUi().find((event) => event.type === "page_completed")
        return completed !== undefined && completed.at - world.startedAt() < 5_000
      }, "initial page completion missed the 5s SLA"),
      liveCheck("no-raw-authoring", (world) => !JSON.stringify(world.persistedUi()).includes('"html"'), "structured event trail contained raw HTML"),
    ],
  }],
  judges: [makeUiPageQualityJudge<LiveCanvasWorld>({
    page: (world) => {
      const pages = foldPageEvents(world.persistedUi())
      const page = pages[pages.length - 1]
      return page === undefined ? Effect.fail("no completed page to judge") : Effect.succeed(page)
    },
    request: () => Effect.succeed(prompt),
    call: generalTierCall(process.cwd()),
  })],
})

export const canvasPack: Pack = {
  name: "canvas",
  // With deterministic checks at 1.0 and judgeWeight .35, this requires the
  // live page-quality judge to score at least .85.
  threshold: 0.9475,
  judgeWeight: 0.35,
  meta: { "ui-agent-profile": "streaming-ui-v1@4.0.0", "ui-schema": "1.0.0", "recipe-set": "1.0.0", "ui-quality-rubric": UI_PAGE_QUALITY_RUBRIC_VERSION },
  scenarios: [
    scenario<CanvasWorld>({
      name: "model-generated plan → rejected content bounce → durable completion",
      modes: ["scripted"], boot: bootCanvasWorld,
      steps: [
        { name: "one ask is planned and composed through model tool calls", act: (world) => world.session.send(SCRIPTED_PROMPT).pipe(Effect.zipRight(Effect.sleep("50 millis"))), checks: [
          eventWhere<CanvasEvent>("only model-tool governed UI events reach the canvas", (events) => {
            const accepted = uiEvents(events)
            return accepted.map((event) => event.type).join(",") === "page_opened,blocks_upserted,page_completed" && !JSON.stringify(accepted).includes('"html"')
          }),
          eventWhere<CanvasEvent>("the unregistered capability bounced before publication", (events) => events.some((event) => event.type === "tool_end" && JSON.stringify(event.result).includes("raw.escape") && JSON.stringify(event.result).includes("UiRejected"))),
        ] },
        { name: "conversation and page events are durable audit trails", act: () => Effect.void, checks: [
          turnAlternationValid<CanvasWorld>((world) => world.messages),
          toolSequence<CanvasWorld>((world) => world.messages, ["start_ui", "start_ui", "patch_ui", "patch_ui"], "exact"),
          { name: "structured-page-store", severity: "hard", run: (world) => {
            const persisted = world.persistedUi()
            const pass = persisted.map((event) => event.type).join(",") === "page_opened,blocks_upserted,page_completed"
            return Effect.succeed({ pass, ...(pass ? {} : { detail: "durable UI event sequence was incomplete" }) })
          } },
        ] },
      ],
    }),
    scenario({
      name: "application and architecture reference recipes are complete",
      modes: ["scripted"], boot: Effect.succeed(undefined),
      steps: [{ name: "both non-landing archetypes meet the deterministic contract", act: () => Effect.void, checks: [{ name: "reference-completeness", severity: "hard", run: () => {
        const pass = [applicationReference, architectureReference].every((reference) => validatePageCompleteness({ manifest: reference.page, blocks: reference.blocks, complete: true }).length === 0)
        return Effect.succeed({ pass, ...(pass ? {} : { detail: "a reference archetype was incomplete" }) })
      } }] }],
    }),
    scenario<FollowupWorld>({
      name: "follow-up replaces an in-flight enrichment without queueing",
      modes: ["scripted"], boot: bootFollowupWorld,
      steps: [{ name: "latest request cancels the hung model call and applies its patch", act: (world) => world.runLatestWins, checks: [
        { name: "send-is-nonblocking", severity: "hard", run: (world) => Effect.sync(() => {
          const latency = world.sendLatency()
          const pass = latency.initial < 500 && latency.followup < 500
          return { pass, ...(pass ? {} : { detail: `send latencies were ${latency.initial}ms / ${latency.followup}ms` }) }
        }) },
        { name: "no-ui-before-model-tool", severity: "hard", run: (world) => Effect.succeed({ pass: world.uiBeforeFollowup() === 0, ...(world.uiBeforeFollowup() === 0 ? {} : { detail: "UI events existed before a model tool call" }) }) },
        eventWhere<CanvasEvent>("both turn lifecycles terminate", (events) => events.filter((event) => event.type === "agent_end").length === 2 && events.at(-1)?.type === "agent_end"),
        eventWhere<CanvasEvent>("only the latest enrichment patch is published", (events) => JSON.stringify(uiEvents(events)).includes("The follow-up wins immediately")),
        turnAlternationValid<FollowupWorld>((world) => world.messages),
        toolSequence<FollowupWorld>((world) => world.messages, ["start_ui", "patch_ui"], "exact"),
      ] }],
    }),
    liveScenario("landing page quality and latency on the pinned UI profile", "Build a high-quality landing page for an observability product that helps small teams understand production incidents.", "landing"),
    liveScenario("application workspace quality and latency on the pinned UI profile", "Build an issue-tracker application workspace with backlog health, a create form, and a useful active-issues table.", "application"),
    liveScenario("architecture document quality and latency on the pinned UI profile", "Build an architecture document explaining an Effect-native ports-and-adapters service, including a clear dependency diagram and decisions.", "document"),
  ],
}
