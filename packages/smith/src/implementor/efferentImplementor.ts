import type { LanguageModel } from "@effect/ai"
import { Effect, Layer, Option, Ref } from "effect"
import { Implementor, ImplementorError } from "@xandreed/foundry"
import type { WorkspacePath } from "@xandreed/foundry"
import {
  buildMcpBridge,
  ConversationStore,
  FileSystem,
  McpClient,
  runAgent,
  Shell,
  UtilityLlm,
} from "@xandreed/engine"
import { Toolkit } from "@effect/ai"
import type { AgentMessage, ConversationId, LoopEvent, SpecDoc } from "@xandreed/engine"
import type { SmithEvent } from "../domain/SmithEvent.js"
import { capturePath } from "./filesTouched.js"
import { discoverSkills, renderSkillsBlock } from "../skills/skills.js"
import { makeSmithCodingHandlers, smithCodingToolkit } from "./codingToolkit.js"
import { renderBrief, renderRetryBrief, smithCoderSystemPrompt } from "./prompt.js"

/**
 * The coder at the forge, RE-FOUNDED on the new line: a capable DIRECT agent
 * (the engine's loop + the smith coding toolkit) doing agentic engineering,
 * with foundry's gates entirely OUTSIDE it — no fleet, no sub-agent tree, no
 * gates-inside-gates. Refine happened upstream (the locked SpecDoc IS the
 * refined prompt); the forge loop drives attempts and the gate pipeline
 * judges the workspace.
 *
 * Each forge run gets ONE persisted conversation: attempt 1 opens it with
 * the brief; every retry continues the SAME conversation with the gate
 * feedback as the next user prompt — cache-warm, full context. The receipt's
 * `ref` ("conversation:<id>") links the FactoryRun artifact back to it.
 *
 * Error mapping: only INFRA failures (a provider error that survived the
 * retry ladder, a defect) become `ImplementorError` — forge retries those
 * twice. A finished-but-weak turn returns a normal receipt: the gates judge.
 */

export type ImplementorServices =
  | FileSystem
  | Shell
  | ConversationStore
  | UtilityLlm
  | McpClient
  | LanguageModel.LanguageModel

// 100 (raised from 40 on user call): real ports kept handing off mid-slice.
// The runaway bounds are the degenerate-loop breaker + the empty-write guard
// + the wall-clock budget — the ceiling only sets the gate-feedback cadence.
const MAX_ATTEMPT_STEPS = 100

// ATTEMPT-BOUNDARY COMPACTION. Retries resend the FULL trail (cache-warm but
// unbounded): the live whole-tree port grew 73k→110k input tokens across
// attempts and kimi-k2.7-code degenerated well before its 256k window (80k
// siblings were healthy). Past this threshold, a gate rejection becomes a
// fold point: the trail is digested into a handoff (fast model) and the next
// attempt starts from summary + gate brief. claw-code — the product that
// surfaced this — ships auto-compaction @200k/256k; we fold earlier because
// quality drops long before the window fills.
const CHECKPOINT_THRESHOLD_TOKENS = 80_000
/** The digest call rides the FAST tier — keep the transcript inside its
 *  window; the brief (head) and the newest state (tail) survive a clip. */
const DIGEST_TRANSCRIPT_CAP_CHARS = 120_000
const PART_CLIP_CHARS = 400

const clipTo = (text: string, cap: number): string =>
  text.length <= cap ? text : `${text.slice(0, cap)}…`

const renderMessage = (message: AgentMessage): string => {
  if (message.role === "user") return `USER: ${clipTo(message.content, PART_CLIP_CHARS * 2)}`
  if (message.role === "assistant") {
    return message.content
      .map((part) =>
        part.type === "text"
          ? `ASSISTANT: ${clipTo(part.text, PART_CLIP_CHARS)}`
          : part.type === "reasoning"
            ? `THOUGHT: ${clipTo(part.text, PART_CLIP_CHARS)}`
            : `TOOL CALL: ${part.toolName}(${clipTo(JSON.stringify(part.input), 160)})`,
      )
      .join("\n")
  }
  return message.content
    .map(
      (part) =>
        `TOOL RESULT ${part.toolName}${part.isError === true ? " (ERROR)" : ""}: ${clipTo(
          JSON.stringify(part.output),
          240,
        )}`,
    )
    .join("\n")
}

/** The trail as a dense transcript for the digest call. Over the cap, the
 *  HEAD (the original brief — the task) and the TAIL (the newest state) both
 *  survive; only the middle exploration is dropped. */
export const renderTrailForDigest = (messages: ReadonlyArray<AgentMessage>): string => {
  const rendered = messages.map(renderMessage)
  const joined = rendered.join("\n")
  if (joined.length <= DIGEST_TRANSCRIPT_CAP_CHARS) return joined
  const head = rendered[0] ?? ""
  const tail = rendered
    .slice(1)
    .join("\n")
    .slice(-(DIGEST_TRANSCRIPT_CAP_CHARS - head.length))
  return `${head}\n[…mid-transcript clipped…]\n${tail}`
}

/** Bump when `digestPrompt` changes — the digest battery records it. */
export const DIGEST_PROMPT_VERSION = "1.0.0"

/** The handoff instruction — the digest is the ONLY memory the next attempt
 *  keeps, so it must restate the task, the workspace state, and the dead ends. */
export const digestPrompt = (
  transcript: string,
  previous: Option.Option<string>,
): string => `You are compacting a coding agent's working conversation between verification attempts. Write the HANDOFF the same agent resumes from — it will see ONLY your summary plus the next instruction, never this transcript again.

Preserve, in this order:
1. THE TASK — the goal, acceptance criteria, and constraints from the original brief.
2. WORKSPACE STATE — every file created or modified and what it now contains (exports, signatures, key decisions).
3. VERIFICATION — commands run and their outcomes; findings already fixed.
4. DEAD ENDS — approaches tried and abandoned, so they are not repeated.

Dense prose and lists; no narration, no praise.${Option.match(previous, {
  onNone: () => "",
  onSome: (prior) => `\n\nAn EARLIER handoff already covers the oldest turns — fold its facts in:\n${prior}`,
})}

TRANSCRIPT:
${transcript}`

/**
 * Fold the conversation's active window into a checkpoint summary. BEST-EFFORT
 * by design: any failure (store, fast model, empty digest) simply leaves the
 * trail unfolded — the attempt runs on full context, exactly as before this
 * feature existed. A successful fold publishes `context_folded` so the pane
 * shows why the next attempt opens from a summary.
 */
export const foldConversation = (options: {
  readonly conversationId: ConversationId
  readonly attempt: number
  readonly contextTokens: number
  readonly publish: (event: SmithEvent) => Effect.Effect<void>
}): Effect.Effect<void, never, ConversationStore | UtilityLlm> =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const utility = yield* UtilityLlm
    const active = yield* store.listActive(options.conversationId)
    if (active.length === 0) return
    const previous = yield* store
      .latestCheckpoint(options.conversationId)
      .pipe(Effect.map(Option.map((checkpoint) => checkpoint.summary)))
    const digest = yield* utility.complete(digestPrompt(renderTrailForDigest(active), previous))
    const summary = digest.text.trim()
    if (summary.length === 0) return
    yield* store.checkpoint(options.conversationId, summary)
    yield* options.publish({
      type: "context_folded",
      attempt: options.attempt,
      tokens: options.contextTokens,
    })
  }).pipe(
    Effect.withSpan("smith.fold", { attributes: { "context.tokens": options.contextTokens } }),
    Effect.catchAll(() => Effect.void),
  )

export interface EfferentImplementorOptions {
  /** The workspace the coder works in — the same dir the gates snapshot. */
  readonly cwd: string
  /** The smith event sink; the coder's LoopEvents ride it as `{type:"agent"}`. */
  readonly publish: (event: SmithEvent) => Effect.Effect<void>
  /** The locked SpecDoc driving this run — its constraints/non-goals reach the
   *  brief here (foundry's `Spec` never carries them). `None` = shorthand path. */
  readonly doc: Option.Option<SpecDoc>
  /** Rendered forge-history lessons (foundry's deterministic memory) — folded
   *  into the attempt-1 brief; retries already carry the gate feedback. */
  readonly lessons?: Option.Option<string>
  /** The workspace's standing rules file (AGENTS.md convention), pre-rendered —
   *  the human's instructions outrank history in the brief. */
  readonly rules?: Option.Option<string>
  /** The curated workspace memory block (memory v2), pre-rendered. */
  readonly memory?: Option.Option<string>
  /** MID-TURN steering (the engine's `pendingInput` seam): a human's note
   *  typed while an attempt runs lands at the coder's next step. */
  readonly pendingInput?: () => Effect.Effect<Option.Option<string>>
}

export const makeEfferentImplementorLive = (
  options: EfferentImplementorOptions,
): Layer.Layer<Implementor, never, ImplementorServices> =>
  Layer.scoped(
    Implementor,
    Effect.gen(function* () {
      const context = yield* Effect.context<ImplementorServices>()
      const store = yield* ConversationStore
      const utility = yield* UtilityLlm
      // Skills discovered ONCE per forge run — the system prompt stays
      // byte-stable across turns (prompt-cache friendly).
      const skillMetas = yield* discoverSkills(options.cwd)
      const skills = renderSkillsBlock(skillMetas)
      const handlers = yield* Layer.build(
        smithCodingToolkit.toLayer(makeSmithCodingHandlers(options.cwd)),
      )
      // External MCP tools (user-configured servers) merge into the kit —
      // snapshot once per run; an unreachable server yields the empty bridge.
      const mcp = yield* buildMcpBridge
      const toolkit = Toolkit.merge(smithCodingToolkit, mcp.toolkit)

      // Surface the loaded capabilities ONCE, at session start — progressive
      // disclosure is otherwise invisible (skills/MCP tools only appear when
      // the coder reaches for one). Silent when the workspace has neither.
      const mcpServers = new Set(mcp.descriptors.map((d) => d.server)).size
      yield* skillMetas.length > 0 || mcp.descriptors.length > 0
        ? options.publish({
            type: "capabilities",
            skills: skillMetas.length,
            mcpServers,
            mcpTools: mcp.descriptors.length,
          })
        : Effect.void
      const externalTools =
        mcp.descriptors.length === 0
          ? ""
          : `## External MCP tools (user-configured servers — call mcp_describe{server, tool} for a tool's parameter schema, then mcp_call{server, tool, args} to run it)\n${mcp.descriptors
              .map(
                (d) =>
                  `- ${d.server} / ${d.name}: ${Option.getOrElse(d.description, () => "(no description)")}`,
              )
              .join("\n")}`

      const conversationRef = yield* Ref.make(Option.none<ConversationId>())
      // The latest turn's input tokens ARE the live context cost — tracked
      // from the loop's own events, read at the next attempt boundary.
      const contextRef = yield* Ref.make(0)
      const conversation = Effect.gen(function* () {
        const existing = yield* Ref.get(conversationRef)
        if (Option.isSome(existing)) return existing.value
        const fresh = yield* store.create(options.cwd)
        yield* Ref.set(conversationRef, Option.some(fresh))
        return fresh
      })

      return Implementor.of({
        implement: (input) =>
          Effect.gen(function* () {
            const filesRef = yield* Ref.make<ReadonlyArray<WorkspacePath>>([])
            const cid = yield* conversation.pipe(
              Effect.mapError(
                (cause) =>
                  new ImplementorError({
                    attempt: input.attempt,
                    message: `conversation store: ${String(cause)}`,
                  }),
              ),
            )
            const onEvent = (event: LoopEvent) =>
              (event.type === "tool_end"
                ? Ref.update(filesRef, (all) =>
                    Option.match(capturePath(event, options.cwd), {
                      onNone: () => all,
                      onSome: (path) => (all.includes(path) ? all : [...all, path]),
                    }),
                  )
                : event.type === "assistant_message"
                  ? Ref.set(contextRef, event.usage.inputTokens)
                  : Effect.void
              ).pipe(
                Effect.zipRight(
                  // A mid-run fold rides the SAME pane vocabulary as the
                  // attempt-boundary fold — one notice, one meaning.
                  event.type === "compaction"
                    ? options.publish({
                        type: "context_folded",
                        attempt: input.attempt,
                        tokens: event.tokens,
                      })
                    : options.publish({ type: "agent", event }),
                ),
              )

            const brief = Option.match(input.feedback, {
              onNone: () =>
                renderBrief(input.spec, options.doc, {
                  lessons: options.lessons ?? Option.none(),
                  rules: options.rules ?? Option.none(),
                  memory: options.memory ?? Option.none(),
                }),
              onSome: renderRetryBrief,
            })

            // A RETRY over an outgrown trail folds first: the gate rejection
            // is the natural compaction point; the summary + this brief
            // replace the full history the next turn would have resent.
            const grown = yield* Ref.get(contextRef)
            yield* Option.isSome(input.feedback) && grown > CHECKPOINT_THRESHOLD_TOKENS
              ? foldConversation({
                  conversationId: cid,
                  attempt: input.attempt,
                  contextTokens: grown,
                  publish: options.publish,
                }).pipe(Effect.zipRight(Ref.set(contextRef, 0)), Effect.provide(context))
              : Effect.void

            // The turn's prose is not the deliverable — the workspace state the
            // gates snapshot is; the run is driven for its side effects. Loop
            // failures AND defects map to ImplementorError (infra), never a
            // silent success.
            yield* runAgent(
              {
                system: smithCoderSystemPrompt(
                  options.cwd,
                  [skills, externalTools].filter((block) => block.length > 0).join("\n\n"),
                ),
                toolkit,
                maxSteps: MAX_ATTEMPT_STEPS,
                // Tokens render live on the forge floor; a pre-first-part
                // stream failure falls back to settled turns for the run.
                streaming: true,
                // WITHIN-attempt compaction: same threshold and digest as the
                // attempt-boundary fold — a single long attempt no longer
                // outgrows the healthy range before a gate rejection saves it.
                compaction: {
                  thresholdTokens: CHECKPOINT_THRESHOLD_TOKENS,
                  keepTurns: 2,
                  summarize: (transcript, previous) =>
                    utility
                      .complete(digestPrompt(renderTrailForDigest(transcript), previous))
                      .pipe(Effect.map((digest) => digest.text)),
                },
              },
              cid,
              brief,
              {
                onEvent,
                ...(options.pendingInput !== undefined
                  ? { pendingInput: options.pendingInput }
                  : {}),
              },
            ).pipe(
              Effect.provide(handlers),
              Effect.provide(mcp.handlers),
              Effect.provide(context),
              Effect.mapError(
                (cause) =>
                  new ImplementorError({
                    attempt: input.attempt,
                    message: String(cause),
                  }),
              ),
              Effect.catchAllDefect((defect) =>
                Effect.fail(
                  new ImplementorError({
                    attempt: input.attempt,
                    message: `implementor crashed: ${String(defect)}`,
                  }),
                ),
              ),
            )

            return {
              filesTouched: [...(yield* Ref.get(filesRef))].sort(),
              ref: Option.some(`conversation:${cid}`),
            }
          }).pipe(
            Effect.withSpan("smith.implement", {
              attributes: { "attempt.n": input.attempt },
            }),
          ),
      })
    }),
  )
