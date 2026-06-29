import { Prompt } from "@effect/ai"
import { HttpClient } from "@effect/platform"
import { Config, Effect, Layer, Schema } from "effect"
import {
  AuthStore,
  type Candidate,
  type DeliverableVerdict,
  FileSystem,
  type GateInput,
  selectionFromString,
  SettingsStore,
  type Verdict,
  Verifier,
  VerifierError,
  type VerifyContext,
} from "@xandreed/sdk-core"
import { makeProviderLanguageModel, prependClaudeCode } from "../llm/providers.js"
import { retryableLlm } from "../llm/retry.js"

/**
 * `StructuredVerifierLive` — the self-improving loop's **closer**, returning a
 * provider-ENFORCED structured verdict via `generateObject` instead of parsing
 * free text out of a `claude` CLI transcript.
 *
 * Why this replaced the CLI verifier: the old gate ran `claude -p … --output-format
 * json`, whose envelope wraps a FREE-TEXT answer — there is no schema-enforced
 * output mode in the CLI, so the verdict had to be scraped from prose with a
 * regex. An Opus assessment of CODE is full of braces, the scrape failed, and the
 * gate reported a (misleading) "verifier UNAVAILABLE — could not parse a verdict"
 * even though Opus answered perfectly. `generateObject` makes the verdict a typed
 * value the provider is forced to fill — a parse error is structurally impossible.
 *
 * Independence is preserved by a CONTROLLED system prompt (no project narrative)
 * + a PINNED model (`EFFERENT_VERIFY_MODEL`, default `anthropic:claude-opus-4-8`):
 * the gate is framed only as a skeptical referee, judging the deliverable against
 * the task, never steeped in the project it judges. The prose reasoning is NOT
 * lost — `assessment` is a first-class field on the schema, fed back to the swarm
 * as the retry's lessons exactly like before, only now reliably.
 *
 * Fail-soft, like the old gate: any error (no Anthropic credential, provider 4xx,
 * timeout) surfaces as `VerifierError`, which the caller treats as a reject /
 * falls back to the architect — a broken gate never blocks the user's task.
 */

const DEFAULT_VERIFY_MODEL = "anthropic:claude-opus-4-8"

/** The deliverable verdict, provider-enforced. `assessment` is the full prose
 *  judgment (preserved as feedback); `reasons` the concrete actionable items. */
const GateReplySchema = Schema.Struct({
  verdict: Schema.Literal("sound", "needs_work", "blocked"),
  assessment: Schema.String,
  reasons: Schema.Array(Schema.String),
})

/** The learning-gate verdict, provider-enforced. */
const RefuteReplySchema = Schema.Struct({
  accept: Schema.Boolean,
  score: Schema.Number,
  reason: Schema.String,
})

const VALIDATOR_SYSTEM =
  "You are the INDEPENDENT validation gate for a multi-agent engineering system. " +
  "You have NO allegiance to the work you are judging and NO project narrative framing you — " +
  "your only inputs are the task and the deliverable below. Be skeptical: do not take the " +
  "summary on faith; judge whether the deliverable actually satisfies the task. Fill the " +
  "structured verdict precisely. `assessment` is your full reasoning (it becomes the feedback " +
  "the system retries on); `reasons` are concrete, actionable items — what is wrong AND what to " +
  "do about it — empty when the verdict is sound."

export const gateJudgePrompt = (input: GateInput, changedFiles: string): string => {
  const hasFiles = input.filesChanged.length > 0
  const judge = hasFiles
    ? "Judge on correctness (does it actually do the task, edge cases included), completeness (every part covered), and fit (matches conventions, no obvious regression). The actual changed-file contents are included below — check against them, not the summary."
    : "Judge on: does it actually ANSWER the task (every part addressed, not dodged); is it SUPPORTED (concrete sources/citations, claims specific and plausible); is it HONEST about gaps; is it COHERENT (synthesized, not contradictory). A confident answer with no sources, or that ignores part of the question, is needs_work."
  return (
    `TASK the swarm was given:\n<task>\n${input.task}\n</task>\n\n` +
    `What it reports it did:\n<summary>\n${input.summary}\n</summary>\n\n` +
    (hasFiles ? `Files changed: ${input.filesChanged.join(", ")}\n${changedFiles}\n` : "") +
    `${judge}\n\n` +
    `Verdict levels: "sound" (correct + complete, ship it), "needs_work" (specific FIXABLE problems — list each in reasons), "blocked" (cannot proceed: missing info / contradictory task).`
  )
}

export const refuteJudgePrompt = (candidate: Candidate, ctx: VerifyContext): string => {
  const ev = candidate.evidence
  const existing =
    ctx.existing.length > 0 ? `\n\nAlready-saved learnings (reject if redundant):\n${ctx.existing.map((e) => `- ${e}`).join("\n")}` : ""
  const diff =
    ev.diff !== undefined && ev.diff.trim() !== "" ? `\n\nEvidence diff:\n${ev.diff}` : ""
  return (
    `Your job is to REFUTE this proposed learning — find why it should NOT be saved. Reject by default; accept (high score) only if the evidence makes it clearly correct, general, and worth keeping.\n\n` +
    `Proposed ${candidate.kind} "${candidate.name}":\n${candidate.description}\n\nBody:\n${candidate.body}` +
    existing +
    diff +
    `\n\nReject (accept:false, low score) if it is wrong, overfit to one case, already covered, or not generally useful. Set score to your confidence it SHOULD be saved (0.0–1.0).`
  )
}

/** sound → no feedback; otherwise the full prose assessment LEADS the reasons so
 *  the retry inherits the complete reasoning, not just terse bullets. Exported
 *  for unit tests. */
export const toDeliverable = (r: typeof GateReplySchema.Type): DeliverableVerdict => ({
  verdict: r.verdict,
  reasons:
    r.verdict === "sound"
      ? []
      : [r.assessment.trim(), ...r.reasons.map((x) => x.trim())].filter((x) => x.length > 0),
})

export const StructuredVerifierLive = Layer.effect(
  Verifier,
  Effect.gen(function* () {
    const auth = yield* AuthStore
    const settingsStore = yield* SettingsStore
    const fs = yield* FileSystem
    const http = yield* HttpClient.HttpClient
    const modelStr = yield* Config.string("EFFERENT_VERIFY_MODEL").pipe(
      Config.withDefault(DEFAULT_VERIFY_MODEL),
    )
    const sel = selectionFromString(modelStr)

    // One structured judge call on the pinned verify model — scoped + over the
    // shared HttpClient, mirroring UtilityLlm. Returns the decoded struct.
    const judge = <A, I extends Record<string, unknown>>(
      schema: Schema.Schema<A, I>,
      userPrompt: string,
    ): Effect.Effect<A, VerifierError> =>
      Effect.gen(function* () {
        const settings = yield* settingsStore.get()
        const cred = yield* auth.get(sel.provider)
        const key = yield* auth.resolveKey(sel.provider)
        const { svc, prependClaudeCode: shouldPrepend } = yield* makeProviderLanguageModel(
          sel,
          key,
          cred,
          settings,
        )
        const request = {
          schema,
          prompt: Prompt.make([
            { role: "system", content: VALIDATOR_SYSTEM },
            { role: "user", content: userPrompt },
          ] as never),
        }
        const res = yield* svc
          .generateObject(
            (shouldPrepend ? prependClaudeCode(request) : request) as typeof request,
          )
          .pipe(retryableLlm)
        return res.value as A
      }).pipe(
        Effect.scoped,
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.withSpan("agent.verify.structured", {
          attributes: { "verify.model": `${sel.provider}:${sel.modelId}` },
        }),
        Effect.mapError(
          (e) =>
            new VerifierError({
              message: `verify gate failed (${sel.provider}:${sel.modelId}): ${
                e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e)
              }`,
            }),
        ),
      )

    const gate = (input: GateInput): Effect.Effect<DeliverableVerdict, VerifierError> =>
      Effect.gen(function* () {
        // For a code deliverable, include the changed files' content so the gate
        // judges against ground truth (the diff in the prompt), not the summary.
        const changedFiles =
          input.filesChanged.length > 0
            ? yield* readChangedFiles(fs, input.repoDir, input.filesChanged)
            : ""
        const reply = yield* judge(GateReplySchema, gateJudgePrompt(input, changedFiles))
        return toDeliverable(reply)
      })

    const refute = (
      candidate: Candidate,
      ctx: VerifyContext,
    ): Effect.Effect<Verdict, VerifierError> =>
      judge(RefuteReplySchema, refuteJudgePrompt(candidate, ctx)).pipe(
        Effect.map((r) => ({ accept: r.accept, score: r.score, reason: r.reason.trim() })),
      )

    return { gate, refute }
  }),
)

/** A verifier that is always unavailable — for evals / tests / CI, where the gate
 *  must never make a real model call. Both methods fail with `VerifierError`, which
 *  every caller treats as fail-soft (the run proceeds, never silently "verified"). */
export const UnavailableVerifierLive = Layer.succeed(Verifier, {
  refute: () => Effect.fail(new VerifierError({ message: "verifier unavailable" })),
  gate: () => Effect.fail(new VerifierError({ message: "verifier unavailable" })),
})

/** Read each changed file (best-effort, capped) so the code gate sees ground truth. */
const readChangedFiles = (
  fs: FileSystem["Type"],
  repoDir: string,
  files: ReadonlyArray<string>,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const parts: Array<string> = []
    for (const f of files.slice(0, 20)) {
      const abs = f.startsWith("/") ? f : `${repoDir}/${f}`
      const content = yield* fs.read(abs, { limit: 400 }).pipe(
        Effect.map((r) => r.content),
        Effect.catchAll(() => Effect.succeed("(could not read)")),
      )
      parts.push(`\n<file path="${f}">\n${content}\n</file>`)
    }
    return parts.join("\n")
  })
