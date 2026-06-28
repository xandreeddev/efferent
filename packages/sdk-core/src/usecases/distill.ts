import { Effect, Either, Schema } from "effect"
import type { AgentMessage } from "../entities/Conversation.js"
import {
  Candidate,
  CandidateKind,
  CandidateScope,
  CandidateSource,
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
      // Caps so the miner can attribute authority — a rule stated in a USER turn
      // is an authoritative correction (source:"user"), not an agent inference.
      lines.push(`[${i}] USER: ${summarize(msg.content)}`)
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
    `- "constraint" — a hard RULE that would make the next session better: either it would have PREVENTED A MISTAKE the agent actually made (an error it had to recover from, a wrong path, a violated convention) OR it would have AVOIDED A PROCESS INEFFICIENCY the transcript clearly shows — e.g. it OVER-RESEARCHED (many redundant searches/fetches for a small answer), spawned more workers than the task needed, or repeated near-identical work. Propose one ONLY when the transcript shows that misstep or inefficiency actually happening (not a hypothetical), and write it as a general rule ("for a question answerable from a few sources, use one researcher and stop after a couple of searches"), never a play-by-play.\n` +
    `- "memory" — a durable project FACT/decision worth remembering (an architecture choice, a gotcha).\n` +
    `- "process" — a META rule about HOW the agent should WORK (plan before a multi-step task; verify an assumption before acting on it; right-size the fleet rather than over-delegating). Unlike a constraint (a domain rule), a process rule edits the agent's OWN operating instructions. Propose one ONLY for a clear, recurring process improvement the transcript shows would have helped — it is held to a HIGH bar (it always passes the Opus gate, never the user-bypass). Write it as a short imperative ("Before a multi-step task, write the plan and confirm the decomposition before executing").\n` +
    `  DECIDE constraint vs process BY SUBJECT — this is the most-missed call: a rule about the CODE/output (style, language, an API, a convention, "use const", "no try/catch in domain code", "run typecheck after a schema edit") is a "constraint"; a rule about the agent's WORKING METHOD (planning, verifying assumptions before acting, sequencing a change, when to delegate vs do it yourself) is a "process". This holds EVEN WHEN A USER states the rule — "plan before a multi-step task" stated by the user is still kind:process, not constraint.\n\n` +
    `For EACH lesson also set:\n` +
    `- "scope": "global" if it is a GENERAL language/framework/style rule that applies to ANY project (an Effect or TypeScript pattern, "use const not let", "in Effect domain code return typed errors instead of throwing / no try-catch"); "project" if it is specific to THIS repository (its structure, a named architectural decision, a local convention). When unsure, prefer "project".\n` +
    `- "source": "user" if the lesson comes from an explicit instruction or correction a USER turn gave the agent (the human telling it a rule); "inferred" if you deduced it from the agent's own behavior.\n\n` +
    `Rules (these matter — violating them makes the lesson useless):\n` +
    `1. ABSTRACT THE ROUTINE, NOT THE LOG. Generalize away this-session-specific paths, ids, filenames, and values. "When editing a Zod schema, run \`bun typecheck\` after" is good; "I edited src/foo/bar.ts line 42" is useless.\n` +
    `2. FINE GRAINED. One lesson = one reusable idea. Never dump the whole session as one skill.\n` +
    `3. EVIDENCE. For each lesson, cite the transcript line numbers ([N]) that justify it in "positions".\n` +
    `4. SAFE. Never include secrets, absolute home paths, or personal names.\n` +
    `5. ALWAYS CAPTURE USER CORRECTIONS. The strictness above has ONE exception: when a USER turn states a rule or corrects the agent ("use const", "don't use try/catch in the domain", "always run typecheck first", "plan before a multi-step task"), ALWAYS capture it with source:"user" — EVEN IF it seems obvious or generic. That is exactly the correction the human does not want to repeat. CLASSIFY ITS KIND by what the rule is about (see the SUBJECT test above) — do NOT default to "constraint": a code/domain rule → "constraint", a working-method rule (plan, verify, sequence, delegate) → "process". Pick its scope honestly (a general rule → global, a this-repo rule → project).\n\n` +
    (outcomeLine !== "" ? `${outcomeLine}\n` : "") +
    `Transcript (each line is prefixed with its [position]; USER turns are the human):\n<transcript>\n${input.transcript}\n</transcript>` +
    existingLine +
    `\n\nReply with ONLY this JSON, no fences, no prose:\n` +
    `{"candidates":[{"kind":"skill"|"memory"|"constraint"|"process","scope":"global"|"project","source":"user"|"inferred","name":"<kebab-case-id>","description":"<one line>","body":"<the abstracted procedure or rule>","positions":[<line numbers>]}]}`
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
        // Optional on the wire — a miner that omits them defaults conservatively
        // (project / inferred) so an old prompt or a sloppy reply never crashes.
        scope: Schema.optional(CandidateScope),
        source: Schema.optional(CandidateSource),
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
            scope: c.scope ?? "project",
            source: c.source ?? "inferred",
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
  /** Repo dir: the gate runs here AND `project`-scoped artifacts are written under its `.efferent/`. */
  readonly repoDir: string
  /** Global root (`~`): `global`-scoped learnings land under ITS `.efferent/`, loaded
   *  into every workspace. Omit ⇒ everything stays project-local. */
  readonly globalDir?: string
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
      // A rule the USER stated is authoritative — the human IS the gate. Persist it
      // directly, no Opus refutation (the same "trustworthy by construction" bypass
      // the deterministic efficiencyGate uses). An INFERRED lesson still passes the
      // gate, fail-closed. CRITICAL: a `process` learning edits the agent's OWN
      // instructions (the prompt overlay), so it ALWAYS passes Opus — the bypass
      // never applies to it, even when a human prompted the insight.
      const userStated = candidate.source === "user" && candidate.kind !== "process"
      const verdict: Verdict = userStated
        ? { accept: true, score: 1, reason: "stated by the user (authoritative)" }
        : yield* verifier
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
      const accepted = userStated || (verdict.accept && verdict.score >= threshold)
      if (accepted && input.dryRun !== true) {
        const persisted = yield* persistArtifact(
          input.repoDir,
          candidate,
          undefined,
          input.globalDir,
        ).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
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
