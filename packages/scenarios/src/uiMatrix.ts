import { LanguageModel } from "@effect/ai"
import { Cause, Context, Duration, Effect, Layer, Option, Ref, Stream } from "effect"
import { ConversationStore, parseModelSelection, toAgentFailure, toolResultFailure } from "@xandreed/engine"
import type { AgentFailureType } from "@xandreed/engine"
import { DefaultUiHostLive, SqliteUiComponentCatalogLive, SqliteUiPageStoreLive, SqliteUiThemeStoreLive, makeCanvasSession, serveCanvas } from "@xandreed/canvas"
import type { CanvasSession } from "@xandreed/canvas"
import { LanguageModelSelectionLive, LocalAuthStoreLive, SqliteConversationStoreLive } from "@xandreed/providers"
import { UI_COMPOSER_PROMPT_VERSION, UI_PLANNER_PROMPT_VERSION, UI_REPAIR_PROMPT_VERSION, UiAgentExecutionProfile, UiAgentModels, UiComponentCatalog, UiHost, UiPageStore, foldPageEvents, validateBlocks, validateManifest, validatePageCompleteness } from "@xandreed/ui-agent"
import type { UiAgentEvent, UiAgentProfileType, UiGenerationProtocolType, UiPage } from "@xandreed/ui-agent"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { chromium } from "playwright"
import { wilsonInterval } from "./framework/stats.js"
import { makeUiPageQualityJudge } from "./judges/uiPageQuality.js"
import { generalTierCall, preflightAuth } from "./live/llm.js"

type Effort = "none" | "low" | "medium" | "high"

interface Candidate {
  readonly model: string
  readonly effort: Effort
  readonly protocol: UiGenerationProtocolType
}

interface MatrixTask {
  readonly id: string
  readonly prompt: string
  readonly archetype: UiPage["manifest"]["archetype"]
  readonly concepts: ReadonlyArray<ReadonlyArray<string>>
  readonly screening: boolean
}

interface MatrixBudgets {
  readonly plannerTimeoutMs: number
  readonly composerTimeoutMs: number
  readonly trialTimeoutMs: number
}

/** One arrival-stamped session event — the trial's attribution spine. The
 * stamp is the event's own wall-clock (`at`) when it carries one (ui_stage,
 * page events), else the in-process arrival time; both share the harness
 * clock, so stage intervals and paint stamps subtract cleanly. */
interface TimelineEvent {
  readonly tMs: number
  readonly type: string
  readonly stage?: string
  readonly phase?: string
  readonly toolName?: string
  readonly ok?: boolean
  readonly model?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
}

/** Per-stage wall-clock + token attribution, folded from the timeline.
 * Repair may open several intervals (planner-repair, composer-repair) —
 * they accumulate into the one `repair` row; order in the timeline keeps
 * them distinguishable. */
export interface StageMetric {
  readonly stage: string
  readonly wallMs: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly turns: number
}

interface Trial {
  readonly candidate: Candidate
  readonly task: string
  readonly request: string
  readonly sample: number
  readonly serverReceiveMs: number | null
  readonly stageMetrics: ReadonlyArray<StageMetric>
  readonly timeline: ReadonlyArray<TimelineEvent>
  readonly firstVisibleMs: number
  readonly browserFirstVisibleMs: number
  readonly firstContentDeltaMs: number
  readonly initialCompleteMs: number
  readonly firstRefinementMs: number | null
  readonly enrichmentMs: number
  readonly acceptedRefinements: number
  readonly componentCount: number
  readonly pendingComponents: number
  readonly desktopOverflow: number
  readonly mobileOverflow: number
  readonly desktopScreenshot: string | null
  readonly mobileScreenshot: string | null
  readonly errors: ReadonlyArray<string>
  readonly failures: ReadonlyArray<AgentFailureType>
  readonly complete: boolean
  readonly designSystemScore: number
  readonly informationArchitectureScore: number
  readonly relevance: number
  readonly page: UiPage | null
}

interface RankedCandidate {
  readonly candidate: Candidate
  readonly trials: ReadonlyArray<Trial>
  readonly refinementSuccesses: number
  readonly withinFiveSeconds: number
  readonly reliabilityLcb90: number
  readonly latencyLcb90: number
  readonly p50EnrichmentMs: number
  readonly p95EnrichmentMs: number
  readonly p50FirstVisibleMs: number
  readonly p95FirstVisibleMs: number
  readonly meanDesignSystemScore: number
  readonly meanInformationArchitectureScore: number
  readonly meanRelevance: number
  readonly repeatConsistency: number
  readonly stageP50WallMs: Record<string, number>
  readonly stageMeanOutputTokens: Record<string, number>
  readonly deterministicScore: number
  readonly judgeScore?: number
  readonly selectionScore: number
}

// General-purpose models only: this matrix evaluates information architecture,
// copy, and governed composition—not code generation.
const DEFAULT_MODELS = [
  "opencode:deepseek-v4-flash",
  "opencode:kimi-k2.6",
  "opencode:glm-5.2",
  "openai-codex:gpt-5.6-luna",
]
const DEFAULT_EFFORTS: ReadonlyArray<Effort> = ["low", "medium", "high"]
const DEFAULT_PROTOCOLS: ReadonlyArray<UiGenerationProtocolType> = ["compact-lines", "a2ui-jsonl", "native-tools"]
const TASKS: ReadonlyArray<MatrixTask> = [
  { id: "recipe-app", archetype: "application", screening: true, prompt: "Build an Italian recipe application with regional discovery, saved recipes, and ingredient search.", concepts: [["italian", "italia"], ["recipe", "ricett"], ["regional", "region"], ["ingredient"], ["saved", "salvat", "preferit"]] },
  { id: "observability-landing", archetype: "landing", screening: true, prompt: "Build a high-quality landing page for an observability product helping small teams understand production incidents.", concepts: [["observability", "telemetry"], ["small team"], ["production"], ["incident"], ["trace", "metric", "log"]] },
  { id: "architecture-doc", archetype: "document", screening: true, prompt: "Build an architecture document for an Effect-native ports-and-adapters service with a dependency diagram and decisions.", concepts: [["effect"], ["port"], ["adapter"], ["depend"], ["decision"]] },
  { id: "mini-pc-catalog", archetype: "application", screening: false, prompt: "Build a mini PC shopping application with workload filters, comparable specifications, prices, and a useful shortlist.", concepts: [["mini pc"], ["workload", "filter"], ["specification", "memory", "processor"], ["price"], ["shortlist", "saved"]] },
  { id: "issue-tracker", archetype: "application", screening: false, prompt: "Build an issue-tracker workspace with backlog health, filters, an issue table, assignees, priorities, and a create-issue form.", concepts: [["issue"], ["backlog"], ["assignee"], ["priorit"], ["create"]] },
  { id: "travel-planner", archetype: "application", screening: false, prompt: "Build a collaborative city-trip planner with a day-by-day itinerary, saved places, a budget summary, and scheduling conflicts.", concepts: [["itinerary", "day"], ["place"], ["budget"], ["schedule"], ["conflict"]] },
  { id: "developer-api-landing", archetype: "landing", screening: false, prompt: "Build a landing page for a developer API that turns documents into structured data, with concrete examples, reliability proof, pricing, and a strong first-call CTA.", concepts: [["api"], ["document"], ["structured data"], ["reliab"], ["pricing"]] },
  { id: "architecture-studio", archetype: "landing", screening: false, prompt: "Build an editorial landing page for a sustainable architecture studio, featuring selected projects, materials philosophy, measurable outcomes, and a consultation CTA.", concepts: [["architecture"], ["sustainab"], ["project"], ["material"], ["consult"]] },
  { id: "product-conference", archetype: "landing", screening: false, prompt: "Build a conference landing page with a clear theme, speaker proof, schedule highlights, venue information, ticket tiers, and registration CTA.", concepts: [["conference"], ["speaker"], ["schedule"], ["venue"], ["ticket"]] },
  { id: "incident-runbook", archetype: "document", screening: false, prompt: "Build an operational incident runbook for elevated API latency, including detection, triage flow, ownership, rollback criteria, commands, and post-incident decisions.", concepts: [["latency"], ["triage"], ["owner"], ["rollback"], ["post-incident", "decision"]] },
  { id: "integration-guide", archetype: "document", screening: false, prompt: "Build an API integration guide covering authentication, the first request, typed responses, error handling, rate limits, and production readiness.", concepts: [["authentication", "auth"], ["request"], ["response"], ["error"], ["rate limit"]] },
  { id: "migration-adr", archetype: "document", screening: false, prompt: "Build an architecture decision document for migrating a promise-based service to Effect with ports and adapters, Layers, concurrency, rollout stages, and trade-offs.", concepts: [["effect"], ["port"], ["layer"], ["concurr"], ["rollout", "trade-off"]] },
]

const argValue = (name: string): Option.Option<string> => {
  const at = process.argv.indexOf(name)
  return Option.fromNullable(at < 0 ? undefined : process.argv[at + 1])
}

const csv = (name: string, fallback: ReadonlyArray<string>): ReadonlyArray<string> => Option.match(argValue(name), {
  onNone: () => fallback,
  onSome: (value) => value.split(",").map((entry) => entry.trim()).filter(Boolean),
})

const positiveInt = (name: string, fallback: number): number => Option.match(argValue(name), {
  onNone: () => fallback,
  onSome: (value) => {
    const parsed = Math.floor(Number(value))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  },
})

const percentile = (values: ReadonlyArray<number>, q: number): number => {
  if (values.length === 0) return Number.POSITIVE_INFINITY
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(q * ordered.length) - 1))]!
}

const mean = (values: ReadonlyArray<number>): number => values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

const standardDeviation = (values: ReadonlyArray<number>): number => {
  const average = mean(values)
  return values.length < 2 ? 0 : Math.sqrt(mean(values.map((value) => (value - average) ** 2)))
}

const normalizedText = (value: string): string => value.normalize("NFKD").replaceAll(/[\u0300-\u036f]/g, "").toLowerCase()

export const scoreRequestRelevance = (page: UiPage, concepts: ReadonlyArray<ReadonlyArray<string>>): number => {
  const content = normalizedText(JSON.stringify(page))
  return concepts.filter((aliases) => aliases.some((alias) => content.includes(normalizedText(alias)))).length / concepts.length
}

export const scoreInformationArchitecture = (page: UiPage, expectedArchetype: UiPage["manifest"]["archetype"]): number => {
  const ids = new Set(page.blocks.map((block) => block.id))
  const slotOrder = new Map(page.manifest.slots.map((slot, index) => [slot.id, index]))
  const roots = page.blocks.filter((block) => slotOrder.has(block.id))
  const positions = roots.map((block) => slotOrder.get(block.id) ?? Number.POSITIVE_INFINITY)
  const ordered = positions.every((position, index) => index === 0 || position >= positions[index - 1]!)
  const navigationTargets = page.blocks.flatMap((block) => {
    if (block.kind === "navigation") return block.links.map((link) => link.target)
    if (block.kind !== "component" || !block.component.startsWith("navigation.")) return []
    return Array.isArray(block.props.items) ? block.props.items.flatMap((item) => typeof item === "object" && item !== null && "target" in item && typeof item.target === "string" ? [item.target] : []) : []
  })
  const targetsResolve = navigationTargets.every((target) => ids.has(target))
  const expectedFirst = page.manifest.archetype === "application" ? "navigation" : "hero"
  const first = roots[0]
  const firstMatches = first?.kind === expectedFirst || (first?.kind === "component" && (page.manifest.archetype === "application" ? first.component.startsWith("navigation.") : first.component === "marketing.hero" || first.component === "primitive.heading"))
  const checks = [page.manifest.archetype === expectedArchetype, ordered, targetsResolve, firstMatches, validatePageCompleteness(page).length === 0]
  return checks.filter(Boolean).length / checks.length
}

const repeatConsistency = (trials: ReadonlyArray<Trial>): number => {
  const byTask = [...new Set(trials.map((trial) => trial.task))].map((task) => trials.filter((trial) => trial.task === task))
  if (byTask.every((group) => group.length < 2)) return 0
  return mean(byTask.map((group) => {
    if (group.length < 2) return 0
    const relevanceSpread = Math.min(1, standardDeviation(group.map((trial) => trial.relevance)) * 2)
    const successSpread = Math.min(1, standardDeviation(group.map((trial) => trial.acceptedRefinements > 0 ? 1 : 0)) * 2)
    return Math.max(0, 1 - (relevanceSpread + successSpread) / 2)
  }))
}

const profileFor = (candidate: Candidate, budgets: MatrixBudgets): UiAgentProfileType => ({
  profile: "streaming-ui-v1", version: "matrix-v2", schemaVersion: "2.0.0", recipeSetVersion: "2.0.0",
  protocol: candidate.protocol,
  prompts: { planner: UI_PLANNER_PROMPT_VERSION, composer: UI_COMPOSER_PROMPT_VERSION, repair: UI_REPAIR_PROMPT_VERSION },
  planner: { model: candidate.model, effort: candidate.effort, timeoutMs: budgets.plannerTimeoutMs, maxOutputTokens: 1800, maxSteps: 2 },
  composer: { model: candidate.model, effort: candidate.effort, timeoutMs: budgets.composerTimeoutMs, maxOutputTokens: 6000, maxSteps: 5 },
  repair: { model: candidate.model, effort: candidate.effort, timeoutMs: 8_000, maxOutputTokens: 1800, maxSteps: 2, maxAttempts: 1 },
  fallback: { policy: "none" },
})

interface DriveEvidence {
  readonly startedAt: number
  readonly finishedAt: number
  readonly timeline: ReadonlyArray<TimelineEvent>
  readonly browserFirstVisibleMs: number
  readonly firstContentDeltaMs: number
  readonly componentCount: number
  readonly pendingComponents: number
  readonly desktopOverflow: number
  readonly mobileOverflow: number
  readonly desktopScreenshot: string | null
  readonly mobileScreenshot: string | null
}

const waitForAgentEnd = (session: CanvasSession, timeoutMs: number) => session.subscribe(0).pipe(
  Stream.filter((entry) => entry.event.type === "agent_end"),
  Stream.runHead,
  Effect.timeout(Duration.millis(timeoutMs)),
)

const recordFirstDelta = (session: CanvasSession, startedAt: number, target: Ref.Ref<number | null>) => session.transient.pipe(
  Stream.filter((event) => event.type === "assistant_delta" && event.channel === "text" && event.delta.length > 0),
  Stream.runForEach(() => Ref.update(target, (current) => current ?? Date.now() - startedAt)),
)

const timelineRow = (event: UiAgentEvent, arrivalMs: number, startedAt: number): ReadonlyArray<TimelineEvent> => {
  const stamped = (at: number): number => at - startedAt
  if (event.type === "ui_stage") return [{ tMs: stamped(event.at), type: event.type, stage: event.stage, phase: event.phase }]
  if (event.type === "tool_start") return [{ tMs: arrivalMs, type: event.type, toolName: event.toolName }]
  if (event.type === "tool_end") return [{ tMs: arrivalMs, type: event.type, toolName: event.toolName, ok: event.ok }]
  if (event.type === "assistant_message") {
    return [{
      tMs: arrivalMs,
      type: event.type,
      ...(event.model === undefined ? {} : { model: event.model }),
      inputTokens: event.usage.inputTokens,
      outputTokens: event.usage.outputTokens,
    }]
  }
  if (event.type === "page_opened" || event.type === "blocks_upserted" || event.type === "theme_patched" || event.type === "page_completed") return [{ tMs: stamped(event.at), type: event.type }]
  if (event.type === "error" || event.type === "agent_end") return [{ tMs: arrivalMs, type: event.type }]
  return []
}

const recordTimeline = (session: CanvasSession, startedAt: number, target: Ref.Ref<ReadonlyArray<TimelineEvent>>) => session.subscribe(0).pipe(
  Stream.runForEach((entry) => Effect.suspend(() => {
    const rows = timelineRow(entry.event, Date.now() - startedAt, startedAt)
    return rows.length === 0 ? Effect.void : Ref.update(target, (current) => [...current, ...rows])
  })),
)

export const deriveStageMetrics = (timeline: ReadonlyArray<TimelineEvent>): ReadonlyArray<StageMetric> => {
  const emptyMetric = (stage: string): StageMetric => ({ stage, wallMs: 0, inputTokens: 0, outputTokens: 0, turns: 0 })
  const folded = timeline.reduce<{
    readonly open: { readonly stage: string; readonly sinceMs: number } | null
    readonly rows: ReadonlyMap<string, StageMetric>
  }>(
    (state, event) => {
      if (event.type === "ui_stage" && event.stage !== undefined && event.stage !== "turn") {
        if (event.phase === "started") return { ...state, open: { stage: event.stage, sinceMs: event.tMs } }
        if (event.phase === "settled" && state.open !== null && state.open.stage === event.stage) {
          const current = state.rows.get(event.stage) ?? emptyMetric(event.stage)
          return {
            open: null,
            rows: new Map(state.rows).set(event.stage, { ...current, wallMs: current.wallMs + Math.max(0, event.tMs - state.open.sinceMs) }),
          }
        }
        return state
      }
      if (event.type === "assistant_message" && state.open !== null) {
        const current = state.rows.get(state.open.stage) ?? emptyMetric(state.open.stage)
        return {
          ...state,
          rows: new Map(state.rows).set(state.open.stage, {
            ...current,
            inputTokens: current.inputTokens + (event.inputTokens ?? 0),
            outputTokens: current.outputTokens + (event.outputTokens ?? 0),
            turns: current.turns + 1,
          }),
        }
      }
      return state
    },
    { open: null, rows: new Map<string, StageMetric>() },
  )
  return [...folded.rows.values()]
}

export const serverReceiveMs = (timeline: ReadonlyArray<TimelineEvent>): Option.Option<number> =>
  Option.fromNullable(timeline.find((event) => event.type === "ui_stage" && event.stage === "turn" && event.phase === "started")?.tMs)

const evidenceName = (candidate: Candidate, task: MatrixTask, sample: number): string => `${candidate.model}-${candidate.effort}-${candidate.protocol}-${task.id}-${sample}`.replaceAll(/[^a-z0-9.-]+/gi, "-").toLowerCase()

const driveSession = (
  session: CanvasSession,
  request: string,
  timeoutMs: number,
): Effect.Effect<DriveEvidence, unknown> => Effect.scoped(Effect.gen(function* () {
  const firstDelta = yield* Ref.make<number | null>(null)
  const timeline = yield* Ref.make<ReadonlyArray<TimelineEvent>>([])
  const startedAt = Date.now()
  yield* Effect.forkScoped(recordFirstDelta(session, startedAt, firstDelta))
  yield* Effect.forkScoped(recordTimeline(session, startedAt, timeline))
  yield* session.send(request)
  yield* waitForAgentEnd(session, timeoutMs)
  const firstContentDeltaMs = yield* Ref.get(firstDelta)
  return {
    startedAt,
    finishedAt: Date.now(),
    timeline: yield* Ref.get(timeline),
    browserFirstVisibleMs: Number.POSITIVE_INFINITY,
    firstContentDeltaMs: firstContentDeltaMs ?? Number.POSITIVE_INFINITY,
    componentCount: 0,
    pendingComponents: 0,
    desktopOverflow: 0,
    mobileOverflow: 0,
    desktopScreenshot: null,
    mobileScreenshot: null,
  }
}))

const driveBrowser = (
  session: CanvasSession,
  url: string,
  request: string,
  timeoutMs: number,
  evidenceDir: string,
  name: string,
): Effect.Effect<DriveEvidence, unknown> => Effect.scoped(Effect.gen(function* () {
  const browser = yield* Effect.acquireRelease(
    Effect.tryPromise({ try: () => chromium.launch({ headless: true }), catch: (error) => error }),
    // Closing a crashed Chromium can hang forever; an unbounded release
    // freezes interruption (and with it every stage/trial timeout above it).
    (active) => Effect.tryPromise({ try: () => active.close(), catch: () => undefined }).pipe(
      Effect.timeout(Duration.seconds(10)),
      Effect.ignore,
    ),
  )
  const page = yield* Effect.tryPromise({
    try: async () => {
      const opened = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
      await opened.goto(url, { waitUntil: "domcontentloaded" })
      await opened.evaluate(() => {
        const state = globalThis as typeof globalThis & { __efferentFirstVisibleAt?: number }
        state.__efferentFirstVisibleAt = 0
        const mark = () => {
          if (state.__efferentFirstVisibleAt === 0 && document.querySelector(".ef-page-host:not([hidden]) .ui-component, .ef-page-host:not([hidden]) .ui-hero, .ef-page-host:not([hidden]) .ui-navigation") !== null) state.__efferentFirstVisibleAt = Date.now()
        }
        new MutationObserver(mark).observe(document.documentElement, { childList: true, subtree: true, attributes: true })
        mark()
      })
      return opened
    },
    catch: (error) => error,
  })
  const firstDelta = yield* Ref.make<number | null>(null)
  const timeline = yield* Ref.make<ReadonlyArray<TimelineEvent>>([])
  const startedAt = Date.now()
  yield* Effect.forkScoped(recordFirstDelta(session, startedAt, firstDelta))
  yield* Effect.forkScoped(recordTimeline(session, startedAt, timeline))
  yield* Effect.tryPromise({
    try: async () => {
      await page.locator(".ef-ask-input").fill(request)
      await page.locator(".ef-ask-send").click()
    },
    catch: (error) => error,
  })
  yield* waitForAgentEnd(session, timeoutMs)
  const finishedAt = Date.now()
  const firstContentDeltaMs = yield* Ref.get(firstDelta)
  yield* Effect.sync(() => mkdirSync(evidenceDir, { recursive: true }))
  const desktopScreenshot = join(evidenceDir, `${name}-desktop.png`)
  const mobileScreenshot = join(evidenceDir, `${name}-mobile.png`)
  const desktop = yield* Effect.tryPromise({
    try: async () => {
      await page.screenshot({ path: desktopScreenshot, fullPage: true })
      return page.evaluate(() => {
        const state = globalThis as typeof globalThis & { __efferentFirstVisibleAt?: number }
        return {
          firstVisibleAt: state.__efferentFirstVisibleAt ?? 0,
          componentCount: document.querySelectorAll("[data-component]").length,
          pendingComponents: document.querySelectorAll("[data-pending-node]").length,
          overflow: Array.from(document.querySelectorAll<HTMLElement>(".ui-page *")).filter((element) => element.scrollWidth > element.clientWidth + 2).length,
        }
      })
    },
    catch: (error) => error,
  })
  const mobileOverflow = yield* Effect.tryPromise({
    try: async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.screenshot({ path: mobileScreenshot, fullPage: true })
      return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".ui-page *")).filter((element) => element.scrollWidth > element.clientWidth + 2).length)
    },
    catch: (error) => error,
  })
  return {
    startedAt,
    finishedAt,
    timeline: yield* Ref.get(timeline),
    browserFirstVisibleMs: desktop.firstVisibleAt === 0 ? Number.POSITIVE_INFINITY : desktop.firstVisibleAt - startedAt,
    firstContentDeltaMs: firstContentDeltaMs ?? Number.POSITIVE_INFINITY,
    componentCount: desktop.componentCount,
    pendingComponents: desktop.pendingComponents,
    desktopOverflow: desktop.overflow,
    mobileOverflow,
    desktopScreenshot,
    mobileScreenshot,
  }
}))

const selectedModel = (candidate: Candidate) => Effect.gen(function* () {
  const selection = Option.getOrThrow(parseModelSelection(candidate.model))
  return yield* LanguageModel.LanguageModel.pipe(
    Effect.provide(LanguageModelSelectionLive(selection, Option.none())),
    Effect.provide(LocalAuthStoreLive(process.cwd(), homedir())),
  )
})

const cleanupTrialWorkspace = (dir: string): Effect.Effect<void> => Effect.try({
  try: () => rmSync(dir, { recursive: true, force: true }),
  catch: (error) => error,
}).pipe(
  Effect.catchAll((error) => Effect.logWarning(`ui-matrix could not remove ${dir}: ${String(error)}`)),
)

const runTrial = (candidate: Candidate, task: MatrixTask, sample: number, budgets: MatrixBudgets, evidenceDir: string): Effect.Effect<Trial, unknown> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => mkdtempSync(join(tmpdir(), "efferent-ui-matrix-")),
      catch: (error) => error,
    }),
    (dir) => Effect.scoped(Effect.gen(function* () {
    const db = join(dir, "canvas.db")
    const model = yield* selectedModel(candidate)
    const base = Layer.mergeAll(
      SqliteConversationStoreLive(db),
      SqliteUiPageStoreLive(db),
      SqliteUiComponentCatalogLive(db),
      SqliteUiThemeStoreLive(db),
      DefaultUiHostLive,
      LocalAuthStoreLive(process.cwd(), homedir()),
      Layer.succeed(UiAgentExecutionProfile, profileFor(candidate, budgets)),
      Layer.succeed(UiAgentModels, { planner: model, composer: model, repair: model }),
    )
    const services = yield* Layer.build(base)
    const conversations = Context.get(services, ConversationStore)
    const pages = Context.get(services, UiPageStore)
    const host = Context.get(services, UiHost)
    const componentCatalog = Context.get(services, UiComponentCatalog)
    const conversationId = yield* conversations.create(dir).pipe(Effect.orDie)
    const session = yield* makeCanvasSession({ conversationId }).pipe(Effect.provide(services))
    const drive = yield* (process.argv.includes("--session-only")
      ? driveSession(session, task.prompt, budgets.trialTimeoutMs)
      : Effect.gen(function* () {
        const server = yield* serveCanvas({ session, port: 0, initialEvents: [] }).pipe(Effect.provide(services))
        yield* Effect.addFinalizer(() => server.close.pipe(
          Effect.timeout(Duration.seconds(10)),
          Effect.catchAllCause((cause) => Effect.logWarning(`ui-matrix server cleanup failed: ${Cause.pretty(cause)}`)),
        ))
        return yield* driveBrowser(session, server.url, task.prompt, budgets.trialTimeoutMs, evidenceDir, evidenceName(candidate, task, sample))
      }))
    const sessionState = yield* session.state
    const events = yield* pages.list(conversationId).pipe(Effect.orDie)
    const definitions = yield* componentCatalog.list.pipe(Effect.orDie)
    const page = foldPageEvents(events).at(-1)
    const opened = events.find((event) => event.type === "page_opened")
    const completed = events.find((event) => event.type === "page_completed")
    const refinements = events.filter((event) => event.type === "blocks_upserted")
    const acceptedRefinements = refinements.length
    const designFindings = page === undefined ? ["model produced no page"] : [...validateManifest(page.manifest, host), ...validateBlocks(page.manifest, page.blocks, host, new Map(definitions.map((definition) => [definition.id, definition])))]
    const failures = sessionState.log.flatMap((entry): ReadonlyArray<AgentFailureType> => {
      if (entry.event.type === "error") {
        return [entry.event.failure ?? toAgentFailure(entry.event.message, "session")]
      }
      if (entry.event.type === "tool_end" && !entry.event.ok) {
        return [toolResultFailure(entry.event.result, entry.event.toolName)]
      }
      return []
    })
    return {
      candidate, task: task.id, request: task.prompt, sample,
      serverReceiveMs: Option.getOrNull(serverReceiveMs(drive.timeline)),
      stageMetrics: deriveStageMetrics(drive.timeline),
      timeline: drive.timeline,
      firstVisibleMs: opened === undefined ? Number.POSITIVE_INFINITY : opened.at - drive.startedAt,
      browserFirstVisibleMs: drive.browserFirstVisibleMs,
      firstContentDeltaMs: drive.firstContentDeltaMs,
      initialCompleteMs: completed === undefined ? Number.POSITIVE_INFINITY : completed.at - drive.startedAt,
      firstRefinementMs: refinements[0] === undefined ? null : refinements[0].at - drive.startedAt,
      enrichmentMs: drive.finishedAt - drive.startedAt,
      acceptedRefinements,
      componentCount: Math.max(drive.componentCount, page?.blocks.filter((block) => block.kind === "component").length ?? 0),
      pendingComponents: drive.pendingComponents,
      desktopOverflow: drive.desktopOverflow,
      mobileOverflow: drive.mobileOverflow,
      desktopScreenshot: drive.desktopScreenshot,
      mobileScreenshot: drive.mobileScreenshot,
      errors: failures.map((failure) => `[${failure.stage}/${failure.code}] ${failure.message}`),
      failures,
      complete: page !== undefined && page.complete && validatePageCompleteness(page).length === 0,
      designSystemScore: designFindings.length === 0 ? 1 : 0,
      informationArchitectureScore: page === undefined ? 0 : scoreInformationArchitecture(page, task.archetype),
      relevance: page === undefined ? 0 : scoreRequestRelevance(page, task.concepts),
      page: page ?? null,
    }
    })),
    cleanupTrialWorkspace,
  )

const failedTrial = (candidate: Candidate, task: MatrixTask, sample: number, error: unknown): Trial => {
  const failure = toAgentFailure(error, "ui-matrix")
  return {
    candidate,
    task: task.id,
    request: task.prompt,
    sample,
    serverReceiveMs: null,
    stageMetrics: [],
    timeline: [],
    firstVisibleMs: Number.POSITIVE_INFINITY,
    browserFirstVisibleMs: Number.POSITIVE_INFINITY,
    firstContentDeltaMs: Number.POSITIVE_INFINITY,
    initialCompleteMs: Number.POSITIVE_INFINITY,
    firstRefinementMs: null,
    enrichmentMs: Number.POSITIVE_INFINITY,
    acceptedRefinements: 0,
    componentCount: 0,
    pendingComponents: 0,
    desktopOverflow: 0,
    mobileOverflow: 0,
    desktopScreenshot: null,
    mobileScreenshot: null,
    errors: [`[${failure.stage}/${failure.code}] ${failure.message}`],
    failures: [failure],
    complete: false,
    designSystemScore: 0,
    informationArchitectureScore: 0,
    relevance: 0,
    page: null,
  }
}

/** Disconnect + hard wall-clock cap: a trial whose cleanup wedges (dead
 * Chromium, stuck server drain) is abandoned in the BACKGROUND and the wave
 * moves on — interruption blocked inside finalizers cannot stall the
 * campaign. The 2026-07-13 v8 run froze for hours on exactly this. */
export const cappedTrial = (capMs: number, trial: Effect.Effect<Trial, unknown>): Effect.Effect<Trial, unknown> => trial.pipe(
  Effect.disconnect,
  Effect.timeoutFail({
    duration: Duration.millis(capMs),
    onTimeout: () => `trial exceeded the ${capMs}ms hard wall-clock cap; its runtime was abandoned in the background`,
  }),
)

export const containTrialFailure = (
  candidate: Candidate,
  task: MatrixTask,
  sample: number,
  trial: Effect.Effect<Trial, unknown>,
): Effect.Effect<Trial> => trial.pipe(
  Effect.catchAllCause((cause) => Effect.succeed(failedTrial(candidate, task, sample, Cause.pretty(cause)))),
)

const rank = (candidate: Candidate, trials: ReadonlyArray<Trial>): RankedCandidate => {
  const refinementSuccesses = trials.filter((trial) => trial.acceptedRefinements > 0 && trial.complete && trial.designSystemScore === 1 && trial.informationArchitectureScore === 1 && trial.relevance >= 0.6).length
  const withinFiveSeconds = trials.filter((trial) => trial.browserFirstVisibleMs <= 5_000 || (trial.desktopScreenshot === null && trial.firstVisibleMs <= 5_000)).length
  const reliabilityLcb90 = wilsonInterval(refinementSuccesses, trials.length, 1.645).low
  const latencyLcb90 = wilsonInterval(withinFiveSeconds, trials.length, 1.645).low
  const p50EnrichmentMs = percentile(trials.map((trial) => trial.firstRefinementMs ?? trial.enrichmentMs), 0.5)
  const p95EnrichmentMs = percentile(trials.map((trial) => trial.enrichmentMs), 0.95)
  const visible = trials.map((trial) => trial.desktopScreenshot === null ? trial.firstVisibleMs : trial.browserFirstVisibleMs)
  const p50FirstVisibleMs = percentile(visible, 0.5)
  const p95FirstVisibleMs = percentile(visible, 0.95)
  const meanDesignSystemScore = mean(trials.map((trial) => trial.designSystemScore))
  const meanInformationArchitectureScore = mean(trials.map((trial) => trial.informationArchitectureScore))
  const meanRelevance = mean(trials.map((trial) => trial.relevance))
  const consistency = repeatConsistency(trials)
  const latencyUtility = refinementSuccesses === 0 ? 0 : Math.exp(-p50FirstVisibleMs / 3_000)
  const eligibleConsistency = refinementSuccesses === 0 ? 0 : consistency
  const stageRows = (stage: string) => trials.flatMap((trial) => trial.stageMetrics.filter((metric) => metric.stage === stage))
  const stageP50WallMs = Object.fromEntries(["planner", "composer", "repair"].map((stage) => [stage, percentile(stageRows(stage).map((metric) => metric.wallMs), 0.5)]))
  const stageMeanOutputTokens = Object.fromEntries(["planner", "composer", "repair"].map((stage) => [stage, Math.round(mean(stageRows(stage).map((metric) => metric.outputTokens)))]))
  const deterministicScore = refinementSuccesses === 0 ? 0 : 0.25 * reliabilityLcb90 + 0.20 * latencyLcb90 + 0.15 * meanDesignSystemScore + 0.15 * meanInformationArchitectureScore + 0.10 * meanRelevance + 0.10 * latencyUtility + 0.05 * eligibleConsistency
  return { candidate, trials, refinementSuccesses, withinFiveSeconds, reliabilityLcb90, latencyLcb90, p50EnrichmentMs, p95EnrichmentMs, p50FirstVisibleMs, p95FirstVisibleMs, meanDesignSystemScore, meanInformationArchitectureScore, meanRelevance, repeatConsistency: eligibleConsistency, stageP50WallMs, stageMeanOutputTokens, deterministicScore, selectionScore: deterministicScore }
}

const judgeCandidate = (
  candidate: RankedCandidate,
  call: (prompt: string) => Effect.Effect<string, unknown>,
): Effect.Effect<RankedCandidate, never> => {
  const judge = makeUiPageQualityJudge<{ readonly page: UiPage; readonly request: string }>({ page: (world) => Effect.succeed(world.page), request: (world) => Effect.succeed(world.request), call })
  return Effect.forEach(candidate.trials, (trial) => trial.page === null
    ? Effect.succeed(0)
    : judge.run({ page: trial.page, request: trial.request }).pipe(
      Effect.map((result) => result.score),
      Effect.catchAll(() => Effect.succeed(0)),
    ), { concurrency: 1 }).pipe(
    Effect.map((scores) => {
      const judgeScore = mean(scores)
      return { ...candidate, judgeScore, selectionScore: 0.7 * candidate.deterministicScore + 0.3 * judgeScore }
    }),
  )
}

const persist = (path: string, value: unknown): Effect.Effect<void, Error> => Effect.try({
  try: () => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  },
  catch: (cause) => new Error(`failed to persist UI matrix: ${String(cause)}`),
})

const persistTrial = (evidenceDir: string, candidate: Candidate, task: MatrixTask, sample: number, trial: Trial): Effect.Effect<void> =>
  persist(join(evidenceDir, "trials", `${evidenceName(candidate, task, sample)}.json`), {
    version: "ui-agent-trial-v2",
    recordedAt: new Date().toISOString(),
    trial,
  }).pipe(
    Effect.catchAll((error) => Effect.logWarning(String(error))),
  )

const program = Effect.gen(function* () {
  const keyed = yield* preflightAuth(process.cwd())
  if (!keyed) return yield* Effect.fail("no model credential; run Smith :login first")
  const efforts = csv("--efforts", DEFAULT_EFFORTS).filter((value): value is Effort => value === "none" || value === "low" || value === "medium" || value === "high")
  const protocols = csv("--protocols", DEFAULT_PROTOCOLS).filter((value): value is UiGenerationProtocolType => value === "native-tools" || value === "a2ui-jsonl" || value === "compact-lines")
  const candidates = csv("--models", DEFAULT_MODELS).flatMap((model) => efforts.flatMap((effort) => protocols.map((protocol) => ({ model, effort, protocol }))))
  const taskSet = Option.getOrElse(argValue("--task-set"), () => "screening")
  if (taskSet !== "screening" && taskSet !== "reference") return yield* Effect.fail(`unknown UI matrix task set: ${taskSet}`)
  const defaultTaskIds = TASKS.filter((task) => taskSet === "reference" || task.screening).map((task) => task.id)
  const taskIds = csv("--tasks", defaultTaskIds)
  const unknownTasks = taskIds.filter((id) => !TASKS.some((task) => task.id === id))
  if (unknownTasks.length > 0) return yield* Effect.fail(`unknown UI matrix task(s): ${unknownTasks.join(", ")}`)
  const tasks = TASKS.filter((task) => taskIds.includes(task.id))
  const samples = positiveInt("--samples", 1)
  const top = positiveInt("--top", 3)
  const concurrency = positiveInt("--concurrency", 3)
  const plannerTimeoutMs = positiveInt("--planner-timeout-ms", 120_000)
  const composerTimeoutMs = positiveInt("--composer-timeout-ms", 180_000)
  const trialTimeoutMs = positiveInt("--trial-timeout-ms", plannerTimeoutMs + composerTimeoutMs + 15_000)
  const budgets = { plannerTimeoutMs, composerTimeoutMs, trialTimeoutMs }
  const output = Option.getOrElse(argValue("--output"), () => join(process.cwd(), ".efferent", "evals", `ui-agent-matrix-${new Date().toISOString().replace(/[:.]/g, "-")}.json`))
  const evidenceDir = output.replace(/\.json$/i, "-screenshots")
  const combinations = candidates.flatMap((candidate) => tasks.flatMap((task) => Array.from({ length: samples }, (_, sample) => ({ candidate, task, sample: sample + 1 }))))
  console.log(`ui-matrix: ${candidates.length} candidates × ${tasks.length} tasks × ${samples} sample(s) = ${combinations.length} trials · concurrency=${concurrency} · profiling budgets=${plannerTimeoutMs}/${composerTimeoutMs}/${trialTimeoutMs}ms`)
  const trials = yield* Effect.forEach(combinations, ({ candidate, task, sample }) =>
    Effect.logInfo(`ui-matrix ${candidate.model} effort=${candidate.effort} protocol=${candidate.protocol} task=${task.id} sample=${sample}`).pipe(
      Effect.zipRight(containTrialFailure(candidate, task, sample, cappedTrial(budgets.trialTimeoutMs + 60_000, runTrial(candidate, task, sample, budgets, evidenceDir)))),
      Effect.tap((trial) => persistTrial(evidenceDir, candidate, task, sample, trial)),
      Effect.tap((trial) => Effect.sync(() => console.log(`  ${candidate.model} ${candidate.effort} ${candidate.protocol} ${task.id}: delta=${trial.firstContentDeltaMs}ms browser=${trial.browserFirstVisibleMs}ms accepted=${trial.firstVisibleMs}ms complete=${trial.initialCompleteMs}ms first-patch=${trial.firstRefinementMs ?? "none"} components=${trial.componentCount} overflow=${trial.desktopOverflow}/${trial.mobileOverflow} ds=${trial.designSystemScore.toFixed(2)} ia=${trial.informationArchitectureScore.toFixed(2)} relevance=${trial.relevance.toFixed(2)} stages=${trial.stageMetrics.map((metric) => `${metric.stage}:${metric.wallMs}ms/${metric.outputTokens}tok`).join(" ") || "none"}`))),
    ),
  { concurrency })
  const ranked = candidates.map((candidate) => rank(candidate, trials.filter((trial) => trial.candidate.model === candidate.model && trial.candidate.effort === candidate.effort && trial.candidate.protocol === candidate.protocol))).sort((a, b) => b.deterministicScore - a.deterministicScore)
  const judgeModel = argValue("--judge-model")
  const judgeCall = yield* Option.match(judgeModel, {
    onNone: () => Effect.succeed(generalTierCall(process.cwd())),
    onSome: (model) => selectedModel({ model, effort: "high", protocol: "native-tools" }).pipe(
      Effect.map((service) => (prompt: string): Effect.Effect<string, unknown> => LanguageModel.generateText({ prompt }).pipe(
        Effect.map((response) => response.text),
        Effect.provideService(LanguageModel.LanguageModel, service),
      )),
    ),
  })
  const finalists = ranked.filter((candidate) => candidate.refinementSuccesses > 0).slice(0, top)
  const judgedFinalists = process.argv.includes("--no-judge")
    ? finalists
    : yield* Effect.forEach(finalists, (candidate) => judgeCandidate(candidate, judgeCall), { concurrency: 1 })
  const judgedByCandidate = new Map(judgedFinalists.map((candidate) => [`${candidate.candidate.model}:${candidate.candidate.effort}:${candidate.candidate.protocol}`, candidate]))
  const judged = ranked.map((candidate) => judgedByCandidate.get(`${candidate.candidate.model}:${candidate.candidate.effort}:${candidate.candidate.protocol}`) ?? candidate)
  const final = judged.sort((a, b) => b.selectionScore - a.selectionScore)
  const report = { version: "ui-agent-matrix-v6", generatedAt: new Date().toISOString(), executionPath: process.argv.includes("--session-only") ? "internal-session" : "canvas-browser", evidenceDir, trialEvidenceDir: join(evidenceDir, "trials"), targets: { firstContentP50Ms: 750, firstContentP95Ms: 1500, meaningfulUiP50Ms: 3000, meaningfulUiP95Ms: 5000, completeP50Ms: 12000, completeP95Ms: 20000 }, judgeModel: Option.getOrElse(judgeModel, () => "configured-general"), formula: "eligibility uses accepted complete output, design-system compliance, information architecture and relevance; latency confidence is browser first meaningful UI <=5s; finalist selection = .70*deterministic + .30*fixed-judge quality", tasks, candidates: final }
  yield* persist(output, report)
  console.log("\nrank  model/protocol                                   effort  success  <=5s   first-p50 first-p95 done-p95 DS    IA    rel   cons  judge  score")
  final.forEach((entry, index) => console.log(`${String(index + 1).padStart(4)}  ${`${entry.candidate.model}/${entry.candidate.protocol}`.padEnd(48)} ${entry.candidate.effort.padEnd(6)}  ${String(entry.refinementSuccesses).padStart(2)}/${String(entry.trials.length).padEnd(2)}    ${String(entry.withinFiveSeconds).padStart(2)}/${String(entry.trials.length).padEnd(2)}  ${String(entry.p50FirstVisibleMs).padStart(9)} ${String(entry.p95FirstVisibleMs).padStart(9)} ${String(entry.p95EnrichmentMs).padStart(8)} ${entry.meanDesignSystemScore.toFixed(2)}  ${entry.meanInformationArchitectureScore.toFixed(2)}  ${entry.meanRelevance.toFixed(2)}  ${entry.repeatConsistency.toFixed(2)}  ${(entry.judgeScore?.toFixed(2) ?? "-").padStart(5)}  ${entry.selectionScore.toFixed(3)}`))
  console.log(`evidence: ${output}`)
  return process.argv.includes("--strict") && !final.some((candidate) => candidate.refinementSuccesses > 0) ? 1 : 0
})

if (process.argv[1]?.endsWith("uiMatrix.ts") === true) {
  process.exit(await Effect.runPromise(program))
}
