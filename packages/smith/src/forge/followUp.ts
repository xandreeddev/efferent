import { Effect, Layer, Option, Runtime } from "effect"
import { runAgent, UtilityLlm } from "@xandreed/engine"
import type { AuthStore, ConversationId, SettingsStore } from "@xandreed/engine"
import {
  LanguageModelLive,
  LocalShellLive,
  roleModelView,
  SandboxedShellLive,
} from "@xandreed/providers"
import type { SmithEvent } from "../domain/SmithEvent.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import {
  digestPrompt,
  renderTrailForDigest,
} from "../implementor/efferentImplementor.js"
import type { ImplementorServices } from "../implementor/efferentImplementor.js"
import { makeSmithCodingHandlers, smithCodingToolkit } from "../implementor/codingToolkit.js"
import { smithCoderSystemPrompt } from "../implementor/prompt.js"
import { discoverSkills, renderSkillsBlock } from "../skills/skills.js"

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
 * prefix stays warm, the persona stays identical), same compaction, same
 * streaming, same steering seam.
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
    // The live Bash tap — same wire as the forge floor's.
    const runtime = yield* Effect.runtime<never>()
    const onBashChunk = (chunk: string): void => {
      const line = chunk
        .split("\n")
        .map((piece) => piece.trim())
        .filter((piece) => piece.length > 0)
        .pop()
      if (line === undefined) return
      Runtime.runSync(runtime)(
        publish({ type: "bash_progress", line: line.slice(0, 160) }),
      )
    }
    // The coder's Bash keeps the run's sandbox policy — follow-up is the
    // same coder, not a privilege escalation.
    const shellLayer = run.sandbox ? SandboxedShellLive(run.cwd) : LocalShellLive
    const handlers = yield* Layer.build(
      smithCodingToolkit.toLayer(
        makeSmithCodingHandlers(run.cwd, { onBashChunk }).pipe(
          Effect.provide(shellLayer),
          Effect.provide(services),
        ),
      ),
    )
    return yield* runAgent(
      {
        system: smithCoderSystemPrompt(run.cwd, skills),
        toolkit: smithCodingToolkit,
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
      // The coder stays on the CODE role, exactly like the forge run that
      // opened this conversation.
      Effect.provide(
        LanguageModelLive.pipe(
          Layer.provide(roleModelView("code")),
          Layer.provide(Layer.succeedContext(services)),
        ),
      ),
      Effect.provide(services),
    )
  }).pipe(Effect.asVoid, Effect.scoped)
