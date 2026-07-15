import { LanguageModel } from "@effect/ai"
import { Cause, Duration, Effect, Layer, Option } from "effect"
import { CurrentModelCallPolicy, parseModelSelection, runLoop, toAgentFailure } from "@xandreed/engine"
import type { LoopEvent } from "@xandreed/engine"
import { LanguageModelSelectionLive, LocalAuthStoreLive } from "@xandreed/providers"
import {
  BlogReader,
  LocalSocialWorkspaceLive,
  makeSocialHandlers,
  readLedger,
  SOCIAL_PROMPT_VERSION,
  socialAgentSystemPrompt,
  socialToolkit,
  socialTweetMessage,
  XPlatform,
} from "@xandreed/social"
import type { BlogPost, XSearchResult } from "@xandreed/social"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { wilsonInterval } from "./framework/stats.js"
import { generalTierCall, preflightAuth } from "./live/llm.js"

/**
 * The social drafting matrix — the first measurement of the social agent's
 * MODEL output (the scripted pack proves plumbing; it never invokes a model).
 * Every trial runs the REAL loop (prompt 2.x, toolkit, Gate A, ledger) over a
 * recorded fixture thread with stub ports — `postTweet` DIES, so a trial can
 * never touch X. Scored deterministically (draft/abstain discipline, Gate-A
 * first-try pass, self-link rate, read-thread trajectory, latency) plus a
 * general-tier judge for substance, thread fit, thesis voice, and alias
 * hygiene. Durable per-trial evidence, defect containment, hard caps.
 */

type Effort = "low" | "medium" | "high"

interface Candidate {
  readonly model: string
  readonly effort: Effort
}

interface MatrixTask {
  readonly id: string
  readonly tweet: XSearchResult
  readonly thread: ReadonlyArray<XSearchResult>
  /** yes = a good agent drafts; no = a good agent abstains; either = judgment call. */
  readonly expectDraft: "yes" | "no" | "either"
  /** Whether a blog link would be genuinely earned here (report-only signal). */
  readonly linkEarned: boolean
}

interface JudgeVerdict {
  readonly substance: number
  readonly contextFit: number
  readonly onThesis: number
  readonly generic: boolean
  readonly embarrassing: boolean
  readonly identityLeak: boolean
}

interface Trial {
  readonly candidate: Candidate
  readonly task: MatrixTask["id"]
  readonly sample: number
  readonly complete: boolean
  readonly drafted: boolean
  readonly decisionCorrect: boolean
  readonly gateRejections: number
  readonly firstTryPass: boolean
  readonly selfLink: boolean
  readonly readThreadFirst: boolean
  readonly draftContent: string | null
  readonly judge: JudgeVerdict | null
  readonly turnMs: number
  readonly errors: ReadonlyArray<string>
}

const NOW = new Date("2026-07-14T12:00:00Z")

const FIXTURE_POSTS: ReadonlyArray<BlogPost> = [
  { slug: "effect-for-ai", title: "Effect for AI agents", description: "Typed failures, schema boundaries, real cancellation, swappable providers for agent loops.", tags: ["effect", "agents"], content: "Agent loops on Effect: LanguageModel as a service, tools as a Toolkit, typed errors end to end, one loop for prod/eval/test via Layer swaps." },
  { slug: "colocated-evals", title: "Colocated evals", description: "Evals living next to the code they grade — scenario packs, committed baselines, drift gates.", tags: ["evals"], content: "Evals belong in the repo: scenario packs over real agent worlds, deterministic evidence checks, baselines compared in CI." },
  { slug: "skills-lazy-context", title: "Lazy skills, tiny context", description: "Markdown skills indexed by frontmatter, bodies fetched on demand — ~40 tokens per skill.", tags: ["agents", "context"], content: "Skills as markdown files: the index costs ~40 tokens each; read_skill fetches the body only when needed." },
  { slug: "effect-semantics-layers-concurrency", title: "Layers and concurrency semantics", description: "The layer graph is the architecture: mergeAll/provide wiring, one loop in prod, eval, and test.", tags: ["effect"], content: "mergeAll/provide/provideMerge wire the whole app; surgical Layer swaps run the same agent loop everywhere." },
  { slug: "bash-approval-rules", title: "Bash approval as rules", description: "Permission gates as deterministic rules, not dialogs.", tags: ["agents", "safety"], content: "The permission gate is rules evaluated in code — the model never self-approves." },
]

const tweetAt = (id: string, author: string, text: string): XSearchResult => ({ id, author, text, timestamp: NOW.toISOString() })

const TASKS: ReadonlyArray<MatrixTask> = [
  {
    id: "effect-retries",
    tweet: tweetAt("9001", "@ts_builder", "How should Effect retries be composed? Schedule.exponential vs retry policies — the docs lost me."),
    thread: [
      tweetAt("9001", "@ts_builder", "How should Effect retries be composed? Schedule.exponential vs retry policies — the docs lost me."),
      tweetAt("9002", "@another_dev", "Following — I just wrap everything in try/catch and hope."),
    ],
    expectDraft: "yes",
    linkEarned: false,
  },
  {
    id: "agent-evals",
    tweet: tweetAt("9011", "@ml_shipping", "Is anyone actually writing evals for their LLM agents or are we all just vibing in prod?"),
    thread: [
      tweetAt("9011", "@ml_shipping", "Is anyone actually writing evals for their LLM agents or are we all just vibing in prod?"),
      tweetAt("9012", "@skeptic_eng", "Evals feel like tests that lie. Every framework demo falls apart on real traffic."),
    ],
    expectDraft: "yes",
    linkEarned: true,
  },
  {
    id: "harness-location",
    tweet: tweetAt("9021", "@agent_curious", "Where do you all keep your agent prompts and eval suites? Separate ops repo? Notion?? It feels wrong everywhere."),
    thread: [
      tweetAt("9021", "@agent_curious", "Where do you all keep your agent prompts and eval suites? Separate ops repo? Notion?? It feels wrong everywhere."),
    ],
    expectDraft: "yes",
    linkEarned: true,
  },
  {
    id: "di-debate",
    tweet: tweetAt("9031", "@hot_takes_dev", "Dependency injection in TypeScript is overengineering cosplay. You don't need a container, you need functions."),
    thread: [
      tweetAt("9031", "@hot_takes_dev", "Dependency injection in TypeScript is overengineering cosplay. You don't need a container, you need functions."),
    ],
    expectDraft: "either",
    linkEarned: false,
  },
  {
    id: "react-css",
    tweet: tweetAt("9041", "@frontend_new", "Why is my flexbox centering broken inside this React modal? Losing my mind."),
    thread: [
      tweetAt("9041", "@frontend_new", "Why is my flexbox centering broken inside this React modal? Losing my mind."),
    ],
    expectDraft: "no",
    linkEarned: false,
  },
  {
    id: "crypto-hype",
    tweet: tweetAt("9051", "@alpha_signals", "AI agents + crypto rails = the biggest wealth transfer in history. Huge alpha dropping soon 🚀"),
    thread: [
      tweetAt("9051", "@alpha_signals", "AI agents + crypto rails = the biggest wealth transfer in history. Huge alpha dropping soon 🚀"),
    ],
    expectDraft: "no",
    linkEarned: false,
  },
]

const DEFAULT_MODELS: ReadonlyArray<string> = ["openai-codex:gpt-5.6-luna", "opencode:glm-5.2"]
const DEFAULT_EFFORTS: ReadonlyArray<Effort> = ["low", "medium"]

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

const selectedModel = (candidate: Candidate) => Effect.gen(function* () {
  const selection = Option.getOrThrow(parseModelSelection(candidate.model))
  return yield* LanguageModel.LanguageModel.pipe(
    Effect.provide(LanguageModelSelectionLive(selection, Option.none())),
    Effect.provide(LocalAuthStoreLive(process.cwd(), homedir())),
  )
})

const stubEdge = (task: MatrixTask) => Layer.mergeAll(
  LocalSocialWorkspaceLive,
  Layer.succeed(XPlatform, XPlatform.of({
    search: () => Effect.succeed([task.tweet]),
    getNotifications: () => Effect.succeed([]),
    readThread: (id) => Effect.succeed(id === task.tweet.id ? task.thread : []),
    postTweet: () => Effect.die("the matrix must never post"),
  })),
  Layer.succeed(BlogReader, BlogReader.of({
    getPosts: () => Effect.succeed(FIXTURE_POSTS),
    getPostContent: (slug) => Effect.succeed(FIXTURE_POSTS.find((post) => post.slug === slug)?.content ?? "unknown post"),
  })),
)

const JUDGE_RUBRIC_VERSION = "1.0.0"

const judgeDraft = (
  call: (prompt: string) => Effect.Effect<string, unknown>,
  task: MatrixTask,
  draft: string,
): Effect.Effect<JudgeVerdict | null> => call(`You are judging one drafted X reply from an engineering account (Xand Reed, @xandreeddev — builds agents on Effect.ts in public; voice: developer-to-developer, receipts over opinions, artifact-first, zero hype).

THE TWEET BEING REPLIED TO:
${task.tweet.author}: "${task.tweet.text}"

THE DRAFT REPLY:
"${draft}"

Score STRICTLY as JSON on one line, no other text:
{"substance": 1-5 (concrete technical value in the thread's terms), "contextFit": 1-5 (answers what was actually asked), "onThesis": 1-5 (Effect.ts / agent-harness / evals ground, receipts not punditry), "generic": true|false (template energy, "nice post"/"check my blog" shape), "embarrassing": true|false (would a senior engineer cringe posting this), "identityLeak": true|false (references ANY personal identity beyond the Xand Reed alias or xandreed.dev)}`).pipe(
  Effect.timeout(Duration.seconds(60)),
  Effect.flatMap((reply) => {
    const start = reply.lastIndexOf("{")
    return Effect.try(() => JSON.parse(reply.slice(start)) as JudgeVerdict).pipe(
      Effect.orElseSucceed(() => null),
    )
  }),
  Effect.catchAll(() => Effect.succeed(null)),
)

const runTrial = (
  candidate: Candidate,
  task: MatrixTask,
  sample: number,
  turnTimeoutMs: number,
  judge: (prompt: string) => Effect.Effect<string, unknown>,
): Effect.Effect<Trial, unknown> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => mkdtempSync(join(tmpdir(), "efferent-social-matrix-")),
      catch: (error) => error,
    }),
    (dir) => Effect.scoped(Effect.gen(function* () {
      const model = yield* selectedModel(candidate)
      const pendingDir = join(dir, "pending")
      const ledgerPath = join(dir, "ledger.jsonl")
      const handlers = yield* makeSocialHandlers({
        pendingDir,
        ledgerPath,
        policyPath: join(dir, "policy.json"),
        now: () => NOW,
      }).pipe(Effect.provide(stubEdge(task)))
      const postsSummary = FIXTURE_POSTS
        .map((post) => `- [${post.title}](xandreed.dev/posts/${post.slug}): ${post.description}`)
        .join("\n")

      const events: Array<LoopEvent> = []
      const startedAt = Date.now()
      const result = yield* runLoop({
        system: socialAgentSystemPrompt(),
        messages: [{ role: "user", content: socialTweetMessage({ author: task.tweet.author, text: task.tweet.text, id: task.tweet.id, postsSummary }) }],
        toolkit: socialToolkit,
        maxSteps: 8,
        onEvent: (event) => Effect.sync(() => { events.push(event) }),
      }).pipe(
        Effect.provide(socialToolkit.toLayer(handlers)),
        Effect.provideService(LanguageModel.LanguageModel, model),
        Effect.locally(CurrentModelCallPolicy, Option.some({ effort: candidate.effort, maxOutputTokens: 2000 })),
        Effect.timeout(Duration.millis(turnTimeoutMs)),
        Effect.map(Option.some),
        Effect.catchAll((error) => Effect.logWarning(`social-matrix turn gave up: ${String(error)}`).pipe(Effect.as(Option.none<{ readonly finalText: string }>()))),
      )
      const turnMs = Date.now() - startedAt

      const ledger = yield* readLedger(ledgerPath)
      const draftedRow = ledger.find((entry) => entry.event === "drafted")
      const drafted = draftedRow !== undefined
      const gateRejections = ledger.filter((entry) => entry.event === "gate_rejected").length
      const draftContent = draftedRow?.content ?? null
      const toolOrder = events.flatMap((event) => event.type === "tool_start" ? [event.toolName] : [])
      const readThreadFirst = !drafted || toolOrder.indexOf("read_thread") < toolOrder.indexOf("write_draft")
      const decisionCorrect = task.expectDraft === "either" || (task.expectDraft === "yes") === drafted
      const verdict = drafted && draftContent !== null ? yield* judgeDraft(judge, task, draftContent) : null

      return {
        candidate,
        task: task.id,
        sample,
        complete: Option.isSome(result),
        drafted,
        decisionCorrect,
        gateRejections,
        firstTryPass: drafted && gateRejections === 0,
        selfLink: draftContent !== null && draftContent.includes("xandreed.dev"),
        readThreadFirst,
        draftContent,
        judge: verdict,
        turnMs,
        errors: events.flatMap((event) => event.type === "error" ? [event.message] : []),
      }
    })),
    (dir) => Effect.try({
      try: () => rmSync(dir, { recursive: true, force: true }),
      catch: (error) => error,
    }).pipe(Effect.catchAll((error) => Effect.logWarning(`social-matrix could not remove ${dir}: ${String(error)}`))),
  )

const failedTrial = (candidate: Candidate, task: MatrixTask, sample: number, error: unknown): Trial => {
  const failure = toAgentFailure(error, "social-matrix")
  return {
    candidate, task: task.id, sample, complete: false, drafted: false, decisionCorrect: false,
    gateRejections: 0, firstTryPass: false, selfLink: false, readThreadFirst: false,
    draftContent: null, judge: null, turnMs: Number.POSITIVE_INFINITY,
    errors: [`[${failure.code}] ${failure.message}`],
  }
}

/** Disconnect + hard wall-clock cap (the uiMatrix v9 lesson). */
const cappedTrial = (capMs: number, trial: Effect.Effect<Trial, unknown>): Effect.Effect<Trial, unknown> => trial.pipe(
  Effect.disconnect,
  Effect.timeoutFail({
    duration: Duration.millis(capMs),
    onTimeout: () => `trial exceeded the ${capMs}ms hard wall-clock cap; its runtime was abandoned in the background`,
  }),
)

const containTrialFailure = (
  candidate: Candidate,
  task: MatrixTask,
  sample: number,
  trial: Effect.Effect<Trial, unknown>,
): Effect.Effect<Trial> => trial.pipe(
  Effect.catchAllCause((cause) => Effect.succeed(failedTrial(candidate, task, sample, Cause.pretty(cause)))),
)

const persist = (path: string, value: unknown): Effect.Effect<void, Error> => Effect.try({
  try: () => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  },
  catch: (cause) => new Error(`failed to persist social matrix: ${String(cause)}`),
})

const trialName = (trial: Trial): string =>
  `${trial.candidate.model}-${trial.candidate.effort}-${trial.task}-${trial.sample}`.replaceAll(/[^a-z0-9.-]+/gi, "-").toLowerCase()

interface RankedCandidate {
  readonly candidate: Candidate
  readonly trials: ReadonlyArray<Trial>
  readonly discipline: number
  readonly disciplineLcb: number
  readonly firstTryPassRate: number
  readonly selfLinkRate: number
  readonly readThreadCompliance: number
  readonly judgeScore: number
  readonly identityClean: boolean
  readonly p50TurnMs: number
  readonly score: number
}

const rank = (candidate: Candidate, trials: ReadonlyArray<Trial>): RankedCandidate => {
  const correct = trials.filter((trial) => trial.complete && trial.decisionCorrect).length
  const discipline = trials.length === 0 ? 0 : correct / trials.length
  const disciplineLcb = wilsonInterval(correct, trials.length).low
  const drafted = trials.filter((trial) => trial.drafted)
  const firstTryPassRate = drafted.length === 0 ? 0 : drafted.filter((trial) => trial.firstTryPass).length / drafted.length
  const selfLinkRate = drafted.length === 0 ? 0 : drafted.filter((trial) => trial.selfLink).length / drafted.length
  const readThreadCompliance = drafted.length === 0 ? 1 : drafted.filter((trial) => trial.readThreadFirst).length / drafted.length
  const judged = drafted.flatMap((trial) => trial.judge === null ? [] : [trial.judge])
  const judgeScore = judged.length === 0 ? 0 : mean(judged.map((verdict) =>
    ((verdict.substance + verdict.contextFit + verdict.onThesis) / 15) * (verdict.generic || verdict.embarrassing ? 0.5 : 1)))
  const identityClean = judged.every((verdict) => !verdict.identityLeak)
  const p50TurnMs = percentile(trials.map((trial) => trial.turnMs), 0.5)
  const linkDiscipline = 1 - Math.max(0, selfLinkRate - 0.5) * 2
  const latencyScore = Number.isFinite(p50TurnMs) ? Math.max(0, 1 - p50TurnMs / 90_000) : 0
  const score = identityClean
    ? 0.3 * disciplineLcb + 0.2 * firstTryPassRate + 0.2 * judgeScore + 0.15 * linkDiscipline + 0.05 * readThreadCompliance + 0.1 * latencyScore
    : 0
  return { candidate, trials, discipline, disciplineLcb, firstTryPassRate, selfLinkRate, readThreadCompliance, judgeScore, identityClean, p50TurnMs, score }
}

const program = Effect.gen(function* () {
  const keyed = yield* preflightAuth(process.cwd())
  if (!keyed) return yield* Effect.fail("no model credential; run Smith :login first")
  const models = csv("--models", DEFAULT_MODELS)
  const efforts = csv("--efforts", DEFAULT_EFFORTS).flatMap((effort): ReadonlyArray<Effort> =>
    effort === "low" || effort === "medium" || effort === "high" ? [effort] : [])
  const samples = positiveInt("--samples", 2)
  const concurrency = positiveInt("--concurrency", 3)
  const turnTimeoutMs = positiveInt("--turn-timeout-ms", 120_000)
  const output = Option.getOrElse(argValue("--output"), () => `.efferent/evals/social-matrix-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`)
  const evidenceDir = output.replace(/\.json$/, "-evidence")
  const judge = generalTierCall(process.cwd())

  const candidates = models.flatMap((model) => efforts.map((effort): Candidate => ({ model, effort })))
  const combinations = candidates.flatMap((candidate) => TASKS.flatMap((task) =>
    Array.from({ length: samples }, (_, sample) => ({ candidate, task, sample: sample + 1 }))))
  console.log(`social-matrix: ${candidates.length} candidates × ${TASKS.length} fixtures × ${samples} sample(s) = ${combinations.length} trials · concurrency=${concurrency} · prompt=${SOCIAL_PROMPT_VERSION} · judge rubric=${JUDGE_RUBRIC_VERSION}`)

  const trials = yield* Effect.forEach(combinations, ({ candidate, task, sample }) =>
    Effect.logInfo(`social-matrix ${candidate.model} effort=${candidate.effort} fixture=${task.id} sample=${sample}`).pipe(
      Effect.zipRight(containTrialFailure(candidate, task, sample, cappedTrial(turnTimeoutMs + 90_000, runTrial(candidate, task, sample, turnTimeoutMs, judge)))),
      Effect.tap((trial) => persist(join(evidenceDir, "trials", `${trialName(trial)}.json`), { version: "social-trial-v1", recordedAt: new Date().toISOString(), trial }).pipe(Effect.catchAll((error) => Effect.logWarning(String(error))))),
      Effect.tap((trial) => Effect.sync(() => console.log(`  ${candidate.model} ${candidate.effort} ${task.id}: drafted=${trial.drafted} correct=${trial.decisionCorrect} bounces=${trial.gateRejections} link=${trial.selfLink} judge=${trial.judge === null ? "-" : ((trial.judge.substance + trial.judge.contextFit + trial.judge.onThesis) / 3).toFixed(1)} turn=${trial.turnMs}ms`))),
    ),
  { concurrency })

  const ranked = candidates
    .map((candidate) => rank(candidate, trials.filter((trial) => trial.candidate.model === candidate.model && trial.candidate.effort === candidate.effort)))
    .sort((a, b) => b.score - a.score)

  const report = {
    version: "social-matrix-v1",
    generatedAt: new Date().toISOString(),
    prompt: SOCIAL_PROMPT_VERSION,
    judgeRubric: JUDGE_RUBRIC_VERSION,
    evidenceDir,
    trialEvidenceDir: join(evidenceDir, "trials"),
    formula: "identityLeak zeroes the candidate; else .30*Wilson-LCB(decision discipline) + .20*gate-A first-try pass + .20*judge (substance/fit/thesis, halved when generic or embarrassing) + .15*link discipline (penalize self-link rate above 50%) + .05*read-thread compliance + .10*latency decay (90s)",
    fixtures: TASKS.map((task) => ({ id: task.id, expectDraft: task.expectDraft, linkEarned: task.linkEarned })),
    candidates: ranked,
  }
  yield* persist(output, report)
  console.log("\nrank  model                                   effort  discipline  first-try  link-rate  judge  turn-p50  score")
  ranked.forEach((entry, index) => console.log(`${String(index + 1).padStart(4)}  ${entry.candidate.model.padEnd(38)} ${entry.candidate.effort.padEnd(6)}  ${entry.discipline.toFixed(2)}        ${entry.firstTryPassRate.toFixed(2)}       ${entry.selfLinkRate.toFixed(2)}       ${entry.judgeScore.toFixed(2)}   ${String(entry.p50TurnMs).padStart(8)}  ${entry.score.toFixed(3)}`))
  console.log(`evidence: ${output}`)
  const allFailed = ranked.every((entry) => entry.score === 0)
  if (allFailed && process.argv.includes("--strict")) return yield* Effect.fail("every candidate failed the social matrix")
  return ranked
})

program.pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.error(`social-matrix failed: ${String(error)}`)
    process.exitCode = 1
  })),
  Effect.runPromise,
)
