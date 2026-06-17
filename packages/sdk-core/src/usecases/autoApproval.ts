import { resolve } from "node:path"
import { Effect, Either, FiberRef, Schema } from "effect"
import type { Prompt } from "../entities/Prompt.js"
import type { ApprovalRequest } from "../ports/Approval.js"
import type { TokenUsage } from "../ports/LlmInfo.js"
import { UtilityLlm } from "../ports/UtilityLlm.js"
import { recordApprovalVerdict } from "../telemetry/metrics.js"
import { RunContextRef } from "./runContext.js"

/**
 * **Auto-approval** — a FAST-tier classifier in front of the human approval
 * modal. Not a security boundary (the scope sandbox owns that); a prompt-
 * fatigue killer: most tool calls an agent makes are ordinary development
 * actions inside folders the human already handed over, and asking about each
 * one trains the rubber-stamp reflex the modal exists to avoid.
 *
 * The model is asked one question: *does this command stay inside the
 * permitted folders, doing ordinary development work?* Two verdicts only —
 * `allow` (waved through silently) or `prompt` (the human sees the modal,
 * enriched with the judge's reason). The judge can never approve LESS than
 * the human would see otherwise, and any error — no model, bad JSON, 429 —
 * degrades to `prompt`, i.e. exactly today's behavior.
 *
 * Permission is **path-based**: the permitted set starts at the workspace
 * root (opening efferent in a cwd is the standing grant) and grows by
 * folder — when a command reaches outside, the judge names the folder and
 * the human's session/project answer grants THAT FOLDER once, not the
 * command string. Future commands in a granted folder pass the judge.
 */
export interface JudgeVerdict {
  readonly verdict: "allow" | "prompt"
  /** The out-of-bounds folder the command touches, when that's why it prompts. */
  readonly folder?: string
  /** ≤12-word justification, shown in the modal / auto-approve notice. */
  readonly reason?: string
}

export interface JudgeOutcome extends JudgeVerdict {
  /** FAST-tier tokens billed by the judgment (absent when the call failed). */
  readonly usage?: TokenUsage
}

/** Resolve a judge-named folder against the request cwd; strip trailing sep. */
export const normalizeFolder = (folder: string, cwd: string): string => {
  const abs = resolve(cwd, folder.trim())
  return abs.length > 1 && abs.endsWith("/") ? abs.slice(0, -1) : abs
}

const APPROVAL_JUDGE_PROMPT_VERSION = "1.0.0"

const approvalJudgePrompt = (text: string): Prompt => ({
  name: "approval-judge",
  version: APPROVAL_JUDGE_PROMPT_VERSION,
  text,
})

export const buildJudgePrompt = (input: {
  readonly tool: string
  readonly summary: string
  readonly cwd: string
  readonly permittedFolders: ReadonlyArray<string>
}): string => {
  const folders = input.permittedFolders.map((f) => `- ${f}`).join("\n")
  return (
    `You classify one tool call made by a coding agent. This is routing, not enforcement: ` +
    `"allow" skips a confirmation prompt, "prompt" shows it to the human. When unsure, prompt.\n\n` +
    `Permitted folders (the call may read or write anything under these):\n${folders}\n\n` +
    `Tool: ${input.tool}\n` +
    `Working directory: ${input.cwd}\n` +
    `Input:\n<input>\n${input.summary}\n</input>\n\n` +
    `Verdict rules:\n` +
    `- "allow" — ordinary development work (listing, reading, searching, building, testing, ` +
    `version control, editing files) whose paths all stay inside the permitted folders. ` +
    `Relative paths resolve against the working directory.\n` +
    `- "prompt" — it touches a path outside the permitted folders (set "folder" to that ` +
    `directory, absolute), or it installs software, changes global system state, deletes ` +
    `broadly, talks to the network, or its effect is unclear.\n\n` +
    `Reply with ONLY this JSON, no fences, no prose:\n` +
    `{"verdict":"allow"|"prompt","folder":"<out-of-bounds dir, omit if none>","reason":"<at most 12 words>"}`
  )
}

/**
 * The judge's wire reply, decoded — never parsed by hand. `Schema.parseJson`
 * subsumes `JSON.parse`: malformed JSON, a third verdict value, and a
 * wrong-typed field all surface as the same decode failure, as a value —
 * no exception machinery in the domain.
 */
const JudgeReply = Schema.parseJson(
  Schema.Struct({
    verdict: Schema.Literal("allow", "prompt"),
    folder: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
  }),
)

/**
 * Parse the judge's reply. Strict by construction: anything that isn't a
 * clean verdict — malformed JSON, a third verdict value, a wrong-typed
 * field, prose — collapses to `prompt`, so a confused model can only ever
 * cause a prompt the human would have seen anyway.
 */
export const parseJudgeVerdict = (text: string): JudgeVerdict => {
  const match = text.match(/\{[\s\S]*\}/)
  if (match === null) return { verdict: "prompt" }
  return Either.match(Schema.decodeUnknownEither(JudgeReply)(match[0]), {
    onLeft: (): JudgeVerdict => ({ verdict: "prompt" }),
    onRight: ({ verdict, folder, reason }): JudgeVerdict => {
      const f = folder?.trim()
      const r = reason?.trim()
      return {
        verdict,
        ...(f !== undefined && f.length > 0 ? { folder: f } : {}),
        ...(r !== undefined && r.length > 0 ? { reason: r } : {}),
      }
    },
  })
}

/**
 * Run the FAST-tier judgment for one approval request. Total: every failure
 * path returns `{ verdict: "prompt" }` — the human modal is the fallback,
 * never a dead turn. A named folder comes back normalized (absolute, no
 * trailing separator) so grants compare stably.
 */
export const judgeApproval = (
  req: ApprovalRequest,
  permittedFolders: ReadonlyArray<string>,
): Effect.Effect<JudgeOutcome, never, UtilityLlm> =>
  Effect.gen(function* () {
    const utility = yield* UtilityLlm
    const promptText = buildJudgePrompt({
      tool: req.tool,
      summary: req.summary,
      cwd: req.cwd,
      permittedFolders,
    })
    const prompt = approvalJudgePrompt(promptText)
    const rc = yield* FiberRef.get(RunContextRef)
    const res = yield* utility.complete(promptText, { role: "fast" }).pipe(
      Effect.locally(RunContextRef, { ...rc, prompt }),
    )
    const verdict = parseJudgeVerdict(res.text)
    return {
      ...verdict,
      ...(verdict.folder !== undefined ? { folder: normalizeFolder(verdict.folder, req.cwd) } : {}),
      ...(res.usage !== undefined ? { usage: res.usage } : {}),
    }
  }).pipe(
    Effect.tap((o) =>
      Effect.annotateCurrentSpan({
        "approval.verdict": o.verdict,
        ...(o.folder !== undefined ? { "approval.folder": o.folder } : {}),
      }).pipe(Effect.zipRight(recordApprovalVerdict(o.verdict))),
    ),
    Effect.catchAll(() =>
      recordApprovalVerdict("prompt").pipe(Effect.as({ verdict: "prompt" } as JudgeOutcome)),
    ),
    Effect.withSpan(`agent.approval.judge: ${req.tool}`, { attributes: { "approval.tool": req.tool } }),
  )
