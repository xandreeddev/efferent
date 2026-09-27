import { Effect, Layer, Option, Schema } from "effect"
import { definePlugin, HarnessError, ResultDigester, UtilityLlm } from "@xandreed/core"
import type { DigestOutcome, DigestTask } from "@xandreed/core"

const Config = Schema.Struct({
  /** The digester's source text is clipped to this many characters. */
  maxSourceChars: Schema.Int.pipe(Schema.between(1_000, 400_000)),
})
type Config = typeof Config.Type
const defaults: Config = { maxSourceChars: 48_000 }

export const UTILITY_DIGESTER = { id: "utility-digest", version: "1" } as const

const clip = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max)}…`

/** The digest prompt: the tool's own instructions, the request, then the result. */
export const digestPrompt = (task: DigestTask, maxSourceChars: number): string => task.mode === "select"
  ? [
    task.instructions,
    `Request: ${task.question}`,
    "Items:",
    ...task.items.map((item) => `[${item.key}] ${clip(item.text, Math.max(200, Math.floor(maxSourceChars / Math.max(1, task.items.length))))}`),
    "Reply with the keys of the items to keep, one per line, and nothing else.",
  ].join("\n\n")
  : [
    task.instructions,
    `Request: ${task.question}`,
    `Result:\n${clip(task.source, maxSourceChars)}`,
    "Reply with the summary only.",
  ].join("\n\n")

/** Keys the reply names, in reply order, restricted to the task's items. */
export const keysOf = (task: DigestTask, reply: string): ReadonlyArray<string> => {
  const known = new Set(task.items.map((item) => item.key))
  const named = reply.split("\n").map((line) => line.trim().replace(/^[-*\d.)\s]+/, "").replace(/^\[(.*)\]$/, "$1").trim())
  return [...new Set(named.filter((key) => known.has(key)))]
}

export const outcomeOf = (task: DigestTask, reply: string): DigestOutcome => task.mode === "select"
  ? { keep: keysOf(task, reply), summary: Option.none() }
  : { keep: [], summary: reply.trim().length === 0 ? Option.none() : Option.some(reply.trim()) }

/**
 * Runs tools' digest prompts on the turn's UtilityLlm, so digests are
 * budgeted with the turn. Session scope: it is built per turn from the
 * turn's services. The memory strategy decides when to digest; the tool
 * decides how; this plugin only asks.
 */
export const memoryDigestPlugin = definePlugin({
  id: "@xandreed/plugin-memory-digest", version: "0.6.0-next.0", scope: "session",
  config: Config, defaults,
  requires: [UtilityLlm],
  provides: [ResultDigester],
  layer: (config) => Layer.effect(ResultDigester, Effect.gen(function* () {
    const utility = yield* UtilityLlm
    return ResultDigester.of({
      ...UTILITY_DIGESTER,
      digest: (task) => utility.complete(digestPrompt(task, config.maxSourceChars)).pipe(
        Effect.map((completion) => outcomeOf(task, completion.text)),
        Effect.mapError((error) => new HarnessError({ code: "memory.digest", message: `${task.tool}: ${error.message}` })),
      ),
    })
  })),
})
export default memoryDigestPlugin
