import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Metric, Option, Schema } from "effect"
import { GateCrash, GateName, makeJudgeGate } from "@xandreed/foundry"
import type { Gate, Spec, Workspace } from "@xandreed/foundry"
import type { SpecDoc } from "@xandreed/engine"

/**
 * The smith judge — the rank-4 LLM gate over the strong (code) tier, wired
 * ON by default (a spec opts out with `judge: false`). It runs LAST: only
 * work that already survived every deterministic rank spends judge tokens,
 * and it judges what those ranks cannot — INTENT fulfillment and honesty of
 * the implementation (real code, not stubs; checks satisfied, not gamed).
 * Fail-closed: an unreachable model or an unparseable verdict is a
 * GateCrash, which the pipeline folds into a fail — never a silent pass.
 */

const FILE_BUDGET_CHARS = 50_000
const PER_FILE_CAP_CHARS = 6_000
const SOURCE_FILE = /\.(tsx?|jsx?|mjs|cjs|py|rs|go|java|rb|json|toml|ya?ml|md)$/
const EXCLUDED = /(^|\/)(node_modules|\.git|\.foundry|\.efferent|dist|build)(\/|$)|bun\.lock|package-lock/

const JUDGE_GATE = GateName.make("judge")

/** Bump when `judgePrompt` changes — the calibration battery records it in
 *  its baseline so a score delta is attributable to the prompt change. */
export const JUDGE_PROMPT_VERSION = "1.0.0"

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n[…clipped…]`

/** The verdict the model must end with — one JSON object on the LAST line. */
const Verdict = Schema.parseJson(
  Schema.Struct({
    sound: Schema.Boolean,
    reasons: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  }),
)

/**
 * The LAST balanced `{…}` block that starts with `{"sound"` — reasoning
 * comes first by instruction, so the verdict is the tail. Balanced-brace
 * scan (reasons may contain braces); `None` when no verdict exists.
 */
export const extractVerdictJson = (text: string): Option.Option<string> => {
  const start = text.lastIndexOf('{"sound"')
  if (start < 0) return Option.none()
  const end = [...text.slice(start)].reduce(
    (state: { readonly depth: number; readonly end: number }, char, index) =>
      state.end >= 0
        ? state
        : char === "{"
          ? { depth: state.depth + 1, end: -1 }
          : char === "}"
            ? state.depth === 1
              ? { depth: 0, end: start + index + 1 }
              : { depth: state.depth - 1, end: -1 }
            : state,
    { depth: 0, end: -1 },
  ).end
  return end < 0 ? Option.none() : Option.some(text.slice(start, end))
}

/** Bounded workspace evidence: source files, newest first, per-file and
 *  total caps; unreadable files skip silently (evidence is best-effort —
 *  the VERDICT is what fails closed). */
export const gatherEvidence = (
  workspace: Workspace,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const candidates = workspace.files
      .map(String)
      .filter((path) => SOURCE_FILE.test(path) && !EXCLUDED.test(path))
    const withMtime = yield* Effect.forEach(candidates, (path) =>
      Effect.tryPromise({
        try: () => stat(join(workspace.rootDir, path)),
        catch: () => "unreadable" as const,
      }).pipe(
        Effect.map((s) => [{ path, mtime: s.mtimeMs }]),
        Effect.orElseSucceed(() => [] as ReadonlyArray<{ path: string; mtime: number }>),
      ),
    )
    const newestFirst = withMtime.flat().sort((a, b) => b.mtime - a.mtime)
    const picked = yield* Effect.reduce(
      newestFirst,
      { used: 0, blocks: [] as ReadonlyArray<string> },
      (acc, file) =>
        acc.used >= FILE_BUDGET_CHARS
          ? Effect.succeed(acc)
          : Effect.tryPromise({
              try: () => readFile(join(workspace.rootDir, file.path), "utf-8"),
              catch: () => "unreadable" as const,
            }).pipe(
              Effect.map((content) => {
                const body = clip(content, PER_FILE_CAP_CHARS)
                return {
                  used: acc.used + body.length,
                  blocks: [...acc.blocks, `=== ${file.path} ===\n${body}`],
                }
              }),
              Effect.orElseSucceed(() => acc),
            ),
    )
    return `FILES (${workspace.files.length} total):\n${workspace.files
      .map(String)
      .filter((path) => !EXCLUDED.test(path))
      .slice(0, 400)
      .join("\n")}\n\nCONTENTS (newest first, bounded):\n${picked.blocks.join("\n\n")}`
  })

export const judgePrompt = (
  spec: Spec,
  doc: Option.Option<SpecDoc>,
  evidence: string,
): string => {
  const extras = Option.match(doc, {
    onNone: () => "",
    onSome: (d) =>
      `${d.constraints.length > 0 ? `\nConstraints (must hold):\n${d.constraints.map((c) => `- ${c}`).join("\n")}` : ""}${
        d.nonGoals.length > 0 ? `\nNon-goals (must NOT have been done):\n${d.nonGoals.map((n) => `- ${n}`).join("\n")}` : ""
      }`,
  })
  return `You are the FINAL JUDGE gate in a deterministic software factory. Typecheck, tests, and the spec's machine checks have ALL already passed — judge only what they cannot:
1. INTENT: does the workspace actually fulfill the goal, or just technically satisfy the checks?
2. HONESTY: real implementations (no stubs, no hardcoded outputs shaped to pass a check, no weakened/deleted tests).
3. CONSTRAINT ADHERENCE and scope (non-goals untouched).

Be strict about dishonesty, lenient about style — style is the other gates' job. An unsound verdict MUST name concrete, actionable reasons (they brief the next attempt).

GOAL:
${spec.goal}

Acceptance criteria:
${spec.acceptance.map((a) => `- ${a}`).join("\n")}
${extras}

WORKSPACE EVIDENCE:
${evidence}

First reason step by step. Then end your reply with EXACTLY one JSON object on the last line:
{"sound": true} or {"sound": false, "reasons": ["...", "..."]}`
}

/**
 * The judge gate, closed over a one-shot strong-tier call supplied at the
 * session edge (composition happens there; the gate itself is `R = never`).
 */
/** The judge's verdict counter — `smith_judge_verdicts_total{verdict}` in
 *  Prometheus (via providers' TracingLive), the P4.1 telemetry the
 *  calibration battery tunes against: false-block/false-pass move HERE in
 *  production, agreement moves in the battery. */
const judgeVerdicts = Metric.counter("smith.judge.verdicts", {
  description: "judge gate verdicts by outcome",
  incremental: true,
})
const countVerdict = (verdict: "sound" | "unsound" | "crash"): Effect.Effect<void> =>
  Metric.increment(Metric.tagged(judgeVerdicts, "verdict", verdict)).pipe(Effect.asVoid)

export const makeSmithJudgeGate = (options: {
  readonly spec: Spec
  readonly doc: Option.Option<SpecDoc>
  readonly call: (prompt: string) => Effect.Effect<string, unknown>
}): Gate<never> =>
  makeJudgeGate("judge", (workspace) =>
    Effect.gen(function* () {
      const evidence = yield* gatherEvidence(workspace)
      const reply = yield* options.call(judgePrompt(options.spec, options.doc, evidence)).pipe(
        Effect.mapError(
          (cause) =>
            new GateCrash({
              gate: JUDGE_GATE,
              message: `the judge model call failed: ${String(cause)}`,
            }),
        ),
      )
      const raw = extractVerdictJson(reply)
      if (Option.isNone(raw)) {
        return yield* Effect.fail(
          new GateCrash({
            gate: JUDGE_GATE,
            message: `the judge reply carried no {"sound": ...} verdict (fail-closed): ${clip(reply, 300)}`,
          }),
        )
      }
      const verdict = yield* Schema.decodeUnknown(Verdict)(raw.value).pipe(
        Effect.mapError(
          (error) =>
            new GateCrash({
              gate: JUDGE_GATE,
              message: `the judge verdict did not decode (fail-closed): ${String(error).slice(0, 300)}`,
            }),
        ),
      )
      yield* countVerdict(verdict.sound ? "sound" : "unsound")
      yield* Effect.annotateCurrentSpan({
        "smith.judge.sound": verdict.sound,
        "smith.judge.reasons": verdict.reasons.slice(0, 3).join(" | ").slice(0, 300),
      })
      return { sound: verdict.sound, reasons: verdict.reasons }
    }).pipe(
      // A crash (unreachable model, unparseable verdict) counts too — a
      // fail-closed judge that crashes often is a signal, not noise.
      Effect.tapError(() => countVerdict("crash")),
      Effect.withSpan("smith.judge"),
    ),
  )
