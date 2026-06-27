import { Effect, Either, Schema } from "effect"
import type { AgentMessage } from "../entities/Conversation.js"
import {
  Candidate,
  CandidateKind,
  type Verdict,
} from "../entities/Distillation.js"
import { FileSystem } from "../ports/FileSystem.js"
import { UtilityLlm } from "../ports/UtilityLlm.js"
import { Verifier } from "../ports/Verifier.js"
import { persistArtifact, type PersistResult } from "./persistArtifact.js"

/**
 * The self-improving loop's **Reflector** (`docs/self-improving-loop.md`): read
 * a finished conversation and distill reusable lessons. Runs on the cheap `fast`
 * role (Kimi by default) — the article's "the engine learns" half. The lessons
 * it proposes are only candidates; the Verifier gate decides what survives.
 */

/** Cap on a single rendered transcript line — tool floods are summarized, never dumped. */
const MAX_LINE_CHARS = 600
/** Default accept threshold: the gate's score must clear this AND `accept` be true. */
const DEFAULT_THRESHOLD = 0.7

/** Summarize an arbitrary tool input/output to a short one-liner for the transcript. */
const summarize = (value: unknown): string => {
  if (value === undefined || value === null) return ""
  const text = typeof value === "string" ? value : JSON.stringify(value)
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > MAX_LINE_CHARS
    ? `${oneLine.slice(0, MAX_LINE_CHARS)}…`
    : oneLine
}

/**
 * Render a persisted transcript into a compact, **position-indexed** text the
 * miner reads. Each message is prefixed with its absolute index so the model can
 * cite evidence positions. Assistant tool calls and tool results are summarized
 * (head-capped), reasoning parts dropped — the miner needs the shape of what
 * happened, not every byte.
 */
export const renderTranscript = (
  messages: ReadonlyArray<AgentMessage>,
): string => {
  const lines: string[] = []
  messages.forEach((msg, i) => {
    if (msg.role === "user") {
      lines.push(`[${i}] user: ${summarize(msg.content)}`)
      return
    }
    if (msg.role === "assistant") {
      const parts: string[] = []
      for (const part of msg.content) {
        if (part.type === "text" && part.text.trim() !== "") {
          parts.push(summarize(part.text))
        } else if (part.type === "tool-call") {
          parts.push(`→ ${part.toolName}(${summarize(part.input)})`)
        }
      }
      if (parts.length > 0) lines.push(`[${i}] assistant: ${parts.join(" ")}`)
      return
    }
    // tool message
    for (const part of msg.content) {
      const err = part.isError === true ? " [ERROR]" : ""
      lines.push(`[${i}] tool ${part.toolName}${err}: ${summarize(part.output)}`)
    }
  })
  return lines.join("\n")
}

/** Outcome metadata that sharpens the miner: did the run succeed, what changed. */
export interface DistillOutcome {
  readonly status?: "ok" | "error"
  readonly summary?: string
  readonly filesChanged?: ReadonlyArray<string>
}

export const buildDistillPrompt = (input: {
  readonly transcript: string
  readonly outcome?: DistillOutcome
  readonly existing?: ReadonlyArray<string>
}): string => {
  const outcomeLine =
    input.outcome === undefined
      ? ""
      : [
          input.outcome.status !== undefined
            ? `Run outcome: ${input.outcome.status}.`
            : "",
          input.outcome.filesChanged !== undefined &&
          input.outcome.filesChanged.length > 0
            ? `Files changed: ${input.outcome.filesChanged.join(", ")}.`
            : "",
          input.outcome.summary !== undefined && input.outcome.summary.trim() !== ""
            ? `Summary: ${input.outcome.summary.trim()}`
            : "",
        ]
          .filter((s) => s.length > 0)
          .join(" ")
  const existingLine =
    input.existing !== undefined && input.existing.length > 0
      ? `\n\nAlready in the library (do NOT re-propose these): ${input.existing.join(", ")}.`
      : ""

  return (
    `You distill REUSABLE lessons from one finished coding-agent session, so the next session is smarter. ` +
    `Be strict: most sessions yield NOTHING worth saving. Return an empty list rather than padding.\n\n` +
    `Each lesson is one of:\n` +
    `- "skill" — a reusable PROCEDURE (how to do a recurring kind of task). Propose a skill ONLY from work that clearly SUCCEEDED.\n` +
    `- "constraint" — a hard RULE that would have prevented a mistake the agent actually made this session. Propose a constraint ONLY when the transcript shows a real misstep (an error it had to recover from, a wrong path, a violated convention).\n` +
    `- "memory" — a durable project FACT/decision worth remembering (an architecture choice, a gotcha).\n\n` +
    `Rules (these matter — violating them makes the lesson useless):\n` +
    `1. ABSTRACT THE ROUTINE, NOT THE LOG. Generalize away this-session-specific paths, ids, filenames, and values. "When editing a Zod schema, run \`bun typecheck\` after" is good; "I edited src/foo/bar.ts line 42" is useless.\n` +
    `2. FINE GRAINED. One lesson = one reusable idea. Never dump the whole session as one skill.\n` +
    `3. EVIDENCE. For each lesson, cite the transcript line numbers ([N]) that justify it in "positions".\n` +
    `4. SAFE. Never include secrets, absolute home paths, or personal names.\n\n` +
    (outcomeLine !== "" ? `${outcomeLine}\n` : "") +
    `Transcript (each line is prefixed with its [position]):\n<transcript>\n${input.transcript}\n</transcript>` +
    existingLine +
    `\n\nReply with ONLY this JSON, no fences, no prose:\n` +
    `{"candidates":[{"kind":"skill"|"memory"|"constraint","name":"<kebab-case-id>","description":"<one line>","body":"<the abstracted procedure or rule>","positions":[<line numbers>]}]}`
  )
}

/** The miner's wire output — decoded, never hand-parsed (mirrors `autoApproval`). */
const MinerOutput = Schema.parseJson(
  Schema.Struct({
    candidates: Schema.Array(
      Schema.Struct({
        kind: CandidateKind,
        name: Schema.String,
        description: Schema.String,
        body: Schema.String,
        positions: Schema.optional(Schema.Array(Schema.Number)),
      }),
    ),
  }),
)

/** Parse the miner's reply into stamped candidates. Strict by construction:
 *  malformed JSON / wrong shape collapses to `[]` (no candidates, never a throw).
 *  We stamp `evidence.conversationId` ourselves — the model never invents it. */
export const parseCandidates = (
  text: string,
  conversationId: string,
): ReadonlyArray<Candidate> => {
  const match = text.match(/\{[\s\S]*\}/)
  if (match === null) return []
  return Either.match(Schema.decodeUnknownEither(MinerOutput)(match[0]), {
    onLeft: (): ReadonlyArray<Candidate> => [],
    onRight: ({ candidates }): ReadonlyArray<Candidate> =>
      candidates.flatMap((c) => {
        const name = c.name.trim()
        const body = c.body.trim()
        if (name === "" || body === "") return []
        return [
          {
            kind: c.kind,
            name,
            description: c.description.trim(),
            body,
            evidence: { conversationId, positions: c.positions ?? [] },
          } satisfies Candidate,
        ]
      }),
  })
}

export interface DistillInput {
  readonly conversationId: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly outcome?: DistillOutcome
  /** Names already in the library — so the miner doesn't re-propose them. */
  readonly existing?: ReadonlyArray<string>
}

/**
 * Mine one conversation for candidate learnings (the Reflector). Total: a
 * provider error degrades to `[]` (an empty transcript or a flaky fast model is
 * never a crash). Used directly by `efferent distill --dry-run` (no verifier,
 * no writes — just show what the loop would learn).
 */
export const distill = (
  input: DistillInput,
): Effect.Effect<ReadonlyArray<Candidate>, never, UtilityLlm> =>
  Effect.gen(function* () {
    const utility = yield* UtilityLlm
    const transcript = renderTranscript(input.messages)
    if (transcript.trim() === "") return []
    const promptText = buildDistillPrompt({
      transcript,
      ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
      ...(input.existing !== undefined ? { existing: input.existing } : {}),
    })
    const res = yield* utility
      .complete(promptText, { role: "fast" })
      .pipe(Effect.catchAll(() => Effect.succeed({ text: "" })))
    return parseCandidates(res.text, input.conversationId)
  }).pipe(
    Effect.withSpan("agent.distill", {
      attributes: { "distill.conversation_id": input.conversationId },
    }),
  )

/** One candidate's journey through the gate, for the report. */
export interface DistillResult {
  readonly candidate: Candidate
  readonly verdict: Verdict
  readonly accepted: boolean
  readonly persisted?: PersistResult
}

export interface RunDistillationInput extends DistillInput {
  /** Repo dir: the gate runs here AND artifacts are written under its `.efferent/`. */
  readonly repoDir: string
  /** Show verdicts but write nothing (the `--dry-run` of the FULL pipeline). */
  readonly dryRun?: boolean
  /** Accept iff `verdict.accept && verdict.score >= threshold` (default 0.7). */
  readonly threshold?: number
}

/**
 * The full self-improving loop over one conversation: **Reflector → Verifier →
 * Curator**. Fail-closed at the gate — a verifier error or a sub-threshold score
 * means the candidate is dropped, never persisted. The Curator
 * (`persistArtifact`) merges survivors as delta items; a persist failure is
 * swallowed so one bad write never aborts the batch.
 */
export const runDistillation = (
  input: RunDistillationInput,
): Effect.Effect<
  ReadonlyArray<DistillResult>,
  never,
  UtilityLlm | Verifier | FileSystem
> =>
  Effect.gen(function* () {
    const candidates = yield* distill(input)
    if (candidates.length === 0) return []
    const verifier = yield* Verifier
    const threshold = input.threshold ?? DEFAULT_THRESHOLD
    const results: DistillResult[] = []
    for (const candidate of candidates) {
      // Fail-closed: any verifier error becomes a reject verdict.
      const verdict = yield* verifier
        .refute(candidate, {
          repoDir: input.repoDir,
          existing: input.existing ?? [],
        })
        .pipe(
          Effect.catchAll((e) =>
            Effect.succeed({
              accept: false,
              score: 0,
              reason: `verifier unavailable: ${e.message}`,
            } satisfies Verdict),
          ),
        )
      const accepted = verdict.accept && verdict.score >= threshold
      if (accepted && input.dryRun !== true) {
        const persisted = yield* persistArtifact(input.repoDir, candidate).pipe(
          Effect.catchAll(() => Effect.succeed(undefined)),
        )
        results.push({
          candidate,
          verdict,
          accepted,
          ...(persisted !== undefined ? { persisted } : {}),
        })
      } else {
        results.push({ candidate, verdict, accepted })
      }
    }
    return results
  }).pipe(
    Effect.withSpan("agent.distill.run", {
      attributes: { "distill.conversation_id": input.conversationId },
    }),
  )
