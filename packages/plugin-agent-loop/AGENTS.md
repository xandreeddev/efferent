# @xandreed/plugin-agent-loop

The step loop: `runLoop`, a provider-agnostic loop over effect/ai's `LanguageModel` that sends a step, resolves its tool calls through the toolkit and iterates until the model stops, the step cap or the degenerate-loop breaker; and `runSteps`, core's `StepLoop` over it, which maps a turn's `StepRequest` (plan, record, events, completion, tasks, steering) onto the loop's callbacks. Node 24 and Bun; layer `plugin-agent-loop` in `foundry.config.ts` (imports core only).

## Rules

- Keep the decisions pure and tested alone: `foldProgress` (nudge at 3 stale steps, stop at 5) and `nextPhase` (the breaker, then completion, then the step cap).
- Only the model's own undecodable output (`InvalidOutputError`, `ToolParameterValidationError`, `ToolNotFoundError`) gets a corrective turn, bounded by `MAX_MALFORMED`; a provider's `InvalidResponseError` fails the step.
- A corrective turn counts against `maxSteps`, and every appended message (corrective, nudge, steering) goes through `onTail` before the next call.
- Progress is keyed on results, not arguments, and pollable tools never count toward the breaker.
- A stream that fails before its first part falls back to `generateText` for the rest of the run with one `stream_fallback`; once a part arrived, a failure fails the step.
- A request refused over an image is sent again only before any part arrived, and only when `onMediaRejected` dealt with the images.
- Step spans carry a call's usage under the GenAI names and the run span the sum under `engine.usage.*`; content only with `captureTraceContent`, images by size.
- `runSteps` computes a step's plan once and serves the model, the messages and the tool choice from it.
- The default corrective texts are model-facing: a host's `correctives` replaces them, and a change to them updates their pins.

## Public surface

- `runLoop` with its types (`RunLoopOptions`, `CompactionPlan`, `StepView`, `LoopToolChoice`, `Phase`), `foldProgress`, `nextPhase`, `DEFAULT_MAX_STEPS`, `DEFAULT_TOOL_CONCURRENCY`, `DEGENERATE_REPEAT_NUDGE`, `DEGENERATE_LOOP_STOP` (`src/loop.ts`).
- `stepLoopPlugin` (also the default export), `StepLoopLive`, `runSteps`, `STEP_LOOP` (`src/step-loop.adapter.ts`).

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `stepLoopPlugin` | `@xandreed/plugin-agent-loop/steps` | runtime | `efferent/StepLoop` | none | none (the turn supplies everything per run) |

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| `DEGENERATE_REPEAT_NUDGE` (a user-role message) | `src/loop.ts:241-245` | by reference only, `src/loop.test.ts:211`; wording unpinned |
| `DEGENERATE_LOOP_STOP` (the reply of a run the breaker stopped with no text) | `src/loop.ts:247-248` | unpinned |
| Default malformed corrective (`Your previous reply could not be parsed: …`) | `src/loop.ts:575-578` | contains, `src/loop.test.ts:171`, `:193` |
| Default incomplete corrective (`The host reports that required actions are incomplete. …`) | `src/loop.ts:659` | unpinned |

Steering text (`pendingInput`) is the host's; the fold's summary message is core's `handoffToMessage`.

## Erasure files

`src/loop.ts`, the prompt assembly: the rendered `AgentMessage`s into `Prompt.make` (`:398`), the instrumented toolkit's `handle` over the generic `Tools` (`:424`) and the tool choice into its tool-name union (`:430`).

## Layout

| File | Role |
|---|---|
| `src/loop.ts` | `runLoop`, the pure decisions, metrics and span attributes |
| `src/step-loop.adapter.ts` | `runSteps`, `StepLoopLive`, the plugin |
| `src/index.ts` | the public exports |

## Tests

- `src/step-loop.adapter.test.ts` runs core's `stepLoopConformance` against `StepLoopLive` and a minimal loop (`:84`), plus streaming fallback and trace content.
- `src/loop.test.ts`: scripted-model runs (correctives, breaker, cap, the compact seam, steering, streaming parity and fallback, image refusals, a host's initial batch, spans) and the pure decisions (`:669`).
- The sdk golden composes `stepLoopPlugin`.
- Run: `bun test packages/plugin-agent-loop packages/sdk/src/agent.golden.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.
