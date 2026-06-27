import { unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config, Effect, Either, Layer, Schema } from "effect"
import {
  type Candidate,
  type DeliverableVerdict,
  type GateInput,
  Shell,
  type Verdict,
  Verifier,
  VerifierError,
  type VerifyContext,
} from "@xandreed/sdk-core"

/**
 * `ClaudeHeadlessVerifierLive` — the self-improving loop's **closer**
 * (`docs/self-improving-loop.md`). It refutes a candidate learning by running
 * **Opus via the real `claude` Claude Code headless CLI**, in the repo dir, over
 * the existing `Shell` port. Two reasons it shells out instead of reusing
 * efferent's own Anthropic client: (1) the Opus *subscription* rate only applies
 * through Claude Code, not the per-token API; (2) it's an INDEPENDENT process the
 * engine can't bias, and — running in the repo — it can read the files / grep /
 * check the cited evidence against ground truth, not just judge text.
 *
 * Everything is **fail-closed**: a missing binary, a non-zero exit, or
 * unparseable output surfaces as `VerifierError`, which the orchestrator treats
 * as a reject — an unverifiable candidate is never persisted.
 *
 * Config (env, all optional):
 * - `EFFERENT_CLAUDE_BIN` — the binary (default `claude`).
 * - `EFFERENT_VERIFY_MODEL` — the model alias (default `opus`).
 * - `EFFERENT_VERIFY_ARGS` — extra CLI args (default `--permission-mode plan`,
 *   Claude Code's read-only mode: it may read/grep the repo to verify, never edit).
 */

const VERIFY_TIMEOUT_MS = 180_000

/** Single-quote a token for safe embedding in a `bash -c` command. */
const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** The Claude Code `--output-format json` envelope (we only need `result`). */
const ResultEnvelope = Schema.parseJson(
  Schema.Struct({
    result: Schema.optional(Schema.String),
    is_error: Schema.optional(Schema.Boolean),
  }),
)

/** The verdict the refute prompt asks the model to emit (inside `result`). */
const VerdictReply = Schema.parseJson(
  Schema.Struct({
    accept: Schema.Boolean,
    score: Schema.Number,
    reason: Schema.optional(Schema.String),
  }),
)

/** The deliverable-gate verdict the model emits (inside `result`). */
const DeliverableReply = Schema.parseJson(
  Schema.Struct({
    verdict: Schema.Literal("sound", "needs_work", "blocked"),
    reasons: Schema.optional(Schema.Array(Schema.String)),
  }),
)

export const buildRefutePrompt = (
  candidate: Candidate,
  ctx: VerifyContext,
): string => {
  const ev = candidate.evidence
  const existing =
    ctx.existing.length > 0
      ? `\n\nAlready in the library (a candidate that merely restates one of these is REDUNDANT — reject): ${ctx.existing.join(", ")}.`
      : ""
  const diff =
    ev.diff !== undefined && ev.diff.trim() !== ""
      ? `\n\nCited diff:\n<diff>\n${ev.diff}\n</diff>`
      : ""
  return (
    `You are a strict verifier for a coding agent's self-improving loop. Your ONLY job is to REFUTE — find why this proposed learning should NOT be saved. Reject by default; accept only if the evidence makes it clearly correct, general, and worth keeping.\n\n` +
    `You are running inside the repository at ${ctx.repoDir}. You MAY read files and grep to check the claim against the actual code — do so before trusting it.\n\n` +
    `Proposed ${candidate.kind}:\n` +
    `- name: ${candidate.name}\n` +
    `- description: ${candidate.description}\n` +
    `- body:\n${candidate.body}\n\n` +
    `Evidence: conversation ${ev.conversationId}, transcript positions [${ev.positions.join(", ")}].${diff}${existing}\n\n` +
    `Reject (low score) if ANY of these is true:\n` +
    `1. NOT TRUE — the repo or the evidence contradicts it, or it can't be verified.\n` +
    `2. NOT GENERAL — it's a one-off about a specific file/value, not a reusable rule/procedure.\n` +
    `3. REDUNDANT — already covered by an existing library item.\n` +
    `4. UNSAFE — contains a secret, an absolute home path, a personal name, or a destructive instruction.\n` +
    `5. NOT USEFUL — wouldn't change what a future agent does. NOTE: a lesson that makes the next run more EFFICIENT (avoid over-researching, right-size a fleet, stop after enough sources, skip redundant work) counts as useful even when no error occurred — judge it on whether FOLLOWING it would measurably improve the next run, not on whether a mistake was made.\n\n` +
    `Reply with ONLY this JSON, no fences, no prose:\n` +
    `{"accept": <true|false>, "score": <0.0-1.0 confidence it SHOULD be saved>, "reason": "<one line>"}`
  )
}

/**
 * The **deliverable gate** prompt: Opus validates the swarm's output against the
 * task — judge only, never edit. Runs in the repo so it reads the changed files.
 */
export const buildGatePrompt = (input: GateInput): string => {
  const files =
    input.filesChanged.length > 0 ? input.filesChanged.join(", ") : "(none reported)"
  return (
    `You are the FINAL validation gate for a coding swarm's work. Your ONLY job is to VALIDATE the deliverable against the task — judge, never edit. Be skeptical; check against the ACTUAL code, do not take the summary on faith.\n\n` +
    `You are running inside the repository at ${input.repoDir}. READ the changed files and run read-only checks (the repo's build / typecheck / tests) to confirm the work is correct and complete.\n\n` +
    `TASK the swarm was given:\n<task>\n${input.task}\n</task>\n\n` +
    `What it reports it did:\n<summary>\n${input.summary}\n</summary>\n\n` +
    `Files changed: ${files}\n\n` +
    `Judge on correctness (does it actually do the task, edge cases included), completeness (every part covered), and fit (matches the codebase conventions, no obvious regression/bug). Then return a verdict:\n` +
    `- "sound" — correct and complete; ship it (reasons may be empty).\n` +
    `- "needs_work" — specific, FIXABLE problems. List each as a concrete, actionable reason the swarm can act on: what is wrong AND what to do about it.\n` +
    `- "blocked" — cannot proceed (missing info, contradictory task).\n\n` +
    `Reply with ONLY this JSON, no fences, no prose:\n` +
    `{"verdict": "sound"|"needs_work"|"blocked", "reasons": ["<concrete actionable reason>", ...]}`
  )
}

/** Pull the `result` text out of the JSON envelope; fall back to raw stdout if
 *  the envelope doesn't parse (so a non-JSON output path still yields a verdict). */
export const extractResultText = (stdout: string): string =>
  Either.match(Schema.decodeUnknownEither(ResultEnvelope)(stdout.trim()), {
    onLeft: () => stdout,
    onRight: (env) => env.result ?? stdout,
  })

/** Decode the verdict JSON embedded in the result text. `undefined` on any miss. */
export const parseVerdict = (resultText: string): Verdict | undefined => {
  const match = resultText.match(/\{[\s\S]*\}/)
  if (match === null) return undefined
  return Either.match(Schema.decodeUnknownEither(VerdictReply)(match[0]), {
    onLeft: () => undefined,
    onRight: (v): Verdict => ({
      accept: v.accept,
      score: v.score,
      reason: v.reason?.trim() ?? "",
    }),
  })
}

/** Decode the deliverable-gate verdict. `undefined` on any miss. */
export const parseDeliverableVerdict = (
  resultText: string,
): DeliverableVerdict | undefined => {
  const match = resultText.match(/\{[\s\S]*\}/)
  if (match === null) return undefined
  return Either.match(Schema.decodeUnknownEither(DeliverableReply)(match[0]), {
    onLeft: () => undefined,
    onRight: (v): DeliverableVerdict => ({
      verdict: v.verdict,
      reasons: (v.reasons ?? []).map((r) => r.trim()).filter((r) => r.length > 0),
    }),
  })
}

const writeTemp = (content: string): Effect.Effect<string, VerifierError> =>
  Effect.tryPromise({
    try: async () => {
      const path = join(
        tmpdir(),
        `efferent-verify-${Date.now()}-${process.pid}.txt`,
      )
      await writeFile(path, content, "utf8")
      return path
    },
    catch: (cause) =>
      new VerifierError({ message: `temp write failed: ${String(cause)}` }),
  })

const removeTemp = (path: string): Effect.Effect<void> =>
  Effect.tryPromise(() => unlink(path)).pipe(Effect.catchAll(() => Effect.void))

export const ClaudeHeadlessVerifierLive = Layer.effect(
  Verifier,
  Effect.gen(function* () {
    const shell = yield* Shell
    const bin = yield* Config.string("EFFERENT_CLAUDE_BIN").pipe(
      Config.withDefault("claude"),
    )
    const model = yield* Config.string("EFFERENT_VERIFY_MODEL").pipe(
      Config.withDefault("opus"),
    )
    const extraArgs = yield* Config.string("EFFERENT_VERIFY_ARGS").pipe(
      Config.withDefault("--permission-mode plan"),
    )

    // One claude-headless invocation, shared by both gates: write the prompt to a
    // temp file (so the multi-line content needs no shell escaping), run `claude -p`
    // in `repoDir`, return the result text (or fail with a VerifierError).
    const runClaude = (
      prompt: string,
      repoDir: string,
    ): Effect.Effect<string, VerifierError> =>
      Effect.acquireUseRelease(
        writeTemp(prompt),
        (tmp) =>
          Effect.gen(function* () {
            const command =
              `${bin} -p "$(cat ${sq(tmp)})" ` +
              `--output-format json --model ${sq(model)} ${extraArgs}`
            const res = yield* shell
              .exec({ command, cwd: repoDir, timeoutMs: VERIFY_TIMEOUT_MS })
              .pipe(
                Effect.mapError(
                  (e) =>
                    new VerifierError({ message: `claude exec failed (${e._tag})` }),
                ),
              )
            if (res.exitCode !== 0) {
              return yield* Effect.fail(
                new VerifierError({
                  message: `claude exited ${res.exitCode}: ${res.stderr.slice(0, 200).trim()}`,
                }),
              )
            }
            return extractResultText(res.stdout)
          }),
        (tmp) => removeTemp(tmp),
      )

    // The learning gate (fail-closed at the orchestrator).
    const refute = (
      candidate: Candidate,
      ctx: VerifyContext,
    ): Effect.Effect<Verdict, VerifierError> =>
      runClaude(buildRefutePrompt(candidate, ctx), ctx.repoDir).pipe(
        Effect.flatMap((text) => {
          const verdict = parseVerdict(text)
          return verdict === undefined
            ? Effect.fail(new VerifierError({ message: "could not parse a verdict" }))
            : Effect.succeed(verdict)
        }),
        Effect.withSpan("agent.verify.refute", {
          attributes: { "verify.kind": candidate.kind, "verify.name": candidate.name },
        }),
      )

    // The deliverable gate (fail-soft at the caller — the coordinator falls back to
    // the architect verdict on a VerifierError, so a missing `claude` never blocks).
    const gate = (
      input: GateInput,
    ): Effect.Effect<DeliverableVerdict, VerifierError> =>
      runClaude(buildGatePrompt(input), input.repoDir).pipe(
        Effect.flatMap((text) => {
          const verdict = parseDeliverableVerdict(text)
          return verdict === undefined
            ? Effect.fail(
                new VerifierError({ message: "could not parse a deliverable verdict" }),
              )
            : Effect.succeed(verdict)
        }),
        Effect.withSpan("agent.verify.deliverable", {
          attributes: { "verify.files": input.filesChanged.length },
        }),
      )

    return { refute, gate }
  }),
)

/**
 * A `Verifier` that is always unavailable — for environments with no `claude`
 * binary (evals, CI). `refute` fails (the orchestrator treats it as reject —
 * fail-closed, so evals never persist), and `gate` fails (the coordinator's
 * `verify_with_gate` catches it as `available: false` and falls back to the
 * architect). Lets the toolkit's `Verifier` requirement resolve without shelling
 * out to claude.
 */
export const UnavailableVerifierLive = Layer.succeed(Verifier, {
  refute: () =>
    Effect.fail(new VerifierError({ message: "verifier unavailable (no claude)" })),
  gate: () =>
    Effect.fail(new VerifierError({ message: "verifier unavailable (no claude)" })),
})
