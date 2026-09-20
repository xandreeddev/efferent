import { Toolkit } from "@effect/ai"
import { Effect, Layer, Option, Schema } from "effect"
import { buildMcpBridge, UtilityLlm } from "@xandreed/core"
import { runAgent } from "@xandreed/plugin-agent-loop"
import type { AuthStore, ConversationId, SettingsStore } from "@xandreed/core"
import { LanguageModelLive, roleModelView } from "@xandreed/plugin-models"
import { LocalShellLive, SandboxedShellLive } from "@xandreed/plugin-tools-local"
import type { SmithEvent } from "../domain/SmithEvent.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import {
  digestPrompt,
  renderTrailForDigest,
} from "../implementor/efferentImplementor.js"
import type { ImplementorServices } from "../implementor/efferentImplementor.js"
import { bashProgressTap, makeSmithCodingHandlers, smithCodingToolkit } from "../implementor/codingToolkit.js"
import { renderExternalToolsBlock } from "../implementor/externalTools.js"
import { armProfileTripwire } from "../implementor/profileTripwire.js"
import { smithCoderSystemPrompt } from "../implementor/prompt.js"
import { discoverSkills, renderSkillsBlock } from "../skills/skills.js"
import { gateRequestFromSpec } from "../spec/toForgeSpec.js"

/**
 * FREE-FORM follow-up with the coder that just forged: one turn CONTINUING
 * the run's persisted implementor conversation ("test the edge cases",
 * "run bun run evals:live refiner", "tighten that error message") — the
 * full run context, the full coding toolkit, NO spec pipeline in between.
 *
 * Deliberately gate-free: the forge loop's gates declare victory for
 * AUTONOMOUS work; follow-up is the human interactively directing — they
 * re-`:forge` when the next slice deserves the gates again. Same system
 * prompt construction as the implementor (the conversation's prompt-cache
 * prefix stays warm, the persona stays identical), same MCP bridge, same
 * compaction, same streaming, same steering seam — and the SAME armed-profile
 * tripwire: gate-free never meant guard-free (live-caught: a follow-up could
 * rewrite the gate profile the next :forge would then be judged by).
 */

/** The run's last attempt's conversation, when the artifact carried one. */
export const followUpTarget = (
  refs: ReadonlyArray<Option.Option<string>>,
): Option.Option<string> => {
  const last = refs.reduce<string | undefined>(
    (found, ref) =>
      Option.match(ref, {
        onNone: () => found,
        onSome: (value) => (value.startsWith("conversation:") ? value : found),
      }),
    undefined,
  )
  return Option.fromNullable(last).pipe(Option.map((ref) => ref.slice("conversation:".length)))
}

/** The follow-up turn edited the armed gate profile — reported, never absorbed. */
export class FollowUpTripwire extends Schema.TaggedError<FollowUpTripwire>()("FollowUpTripwire", {
  paths: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

const FOLLOW_UP_MAX_STEPS = 100
const FOLLOW_UP_FOLD_TOKENS = 80_000

export const runFollowUpTurn = (
  run: SmithRunConfig,
  conversationId: ConversationId,
  prompt: string,
  publish: (event: SmithEvent) => Effect.Effect<void>,
  pendingInput: () => Effect.Effect<Option.Option<string>>,
): Effect.Effect<void, unknown, ImplementorServices | SettingsStore | AuthStore> =>
  Effect.gen(function* () {
    const services = yield* Effect.context<ImplementorServices | SettingsStore | AuthStore>()
    const utility = yield* UtilityLlm
    const skills = renderSkillsBlock(yield* discoverSkills(run.cwd))
    const runtime = yield* Effect.runtime<never>()
    const onBashChunk = bashProgressTap(runtime, publish)
    // The same protected paths the forge armed: the conventional profile
    // plus the run's explicit `--config`, refused by the file tools AND
    // fingerprinted against Bash.
    const protectedPaths = Option.toArray(gateRequestFromSpec(run, Option.none()).configPath)
    const tripwire = yield* armProfileTripwire(run.cwd, protectedPaths)
    const shellLayer = run.sandbox ? SandboxedShellLive(run.cwd) : LocalShellLive
    const handlers = yield* Layer.build(
      smithCodingToolkit.toLayer(
        makeSmithCodingHandlers(run.cwd, { onBashChunk, protectedPaths }).pipe(
          Effect.provide(shellLayer),
          Effect.provide(services),
        ),
      ),
    )
    const mcp = yield* buildMcpBridge
    const externalTools = renderExternalToolsBlock(mcp.descriptors)
    yield* runAgent(
      {
        system: smithCoderSystemPrompt(
          run.cwd,
          [skills, externalTools].filter((block) => block.length > 0).join("\n\n"),
        ),
        toolkit: Toolkit.merge(smithCodingToolkit, mcp.toolkit),
        maxSteps: FOLLOW_UP_MAX_STEPS,
        pollableTools: ["todo_write"],
        streaming: true,
        compaction: {
          thresholdTokens: FOLLOW_UP_FOLD_TOKENS,
          keepTurns: 2,
          summarize: (transcript, previous) =>
            utility
              .complete(digestPrompt(renderTrailForDigest(transcript), previous))
              .pipe(Effect.map((digest) => digest.text)),
        },
      },
      conversationId,
      prompt,
      {
        onEvent: (event) => publish({ type: "agent", event }),
        pendingInput,
      },
    ).pipe(
      Effect.provide(handlers),
      Effect.provide(mcp.handlers),
      Effect.provide(
        LanguageModelLive.pipe(
          Layer.provide(roleModelView("code")),
          Layer.provide(Layer.succeedContext(services)),
        ),
      ),
      Effect.provide(services),
    )
    const drifted = yield* tripwire.check
    yield* drifted.length === 0
      ? Effect.void
      : Effect.fail(
          new FollowUpTripwire({
            paths: drifted,
            message: `the coder MODIFIED the armed gate profile (${drifted.join(", ")}) — the judged must not edit the judge; restore the profile before continuing`,
          }),
        )
  }).pipe(Effect.asVoid, Effect.scoped)
