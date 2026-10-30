# @xandreed/plugin-agent-loop

The step loop: `runLoop`, a provider-agnostic loop over effect/ai's `LanguageModel` that sends a step, resolves its tool calls through the toolkit and iterates until the model stops, the step cap or the degenerate-loop breaker; and `runSteps`, core's `StepLoop` over it, which maps a turn's `StepRequest` (plan, record, events, completion, tasks, steering) onto the loop's callbacks. Node 24 and Bun; layer `plugin-agent-loop` in `foundry.config.ts` (imports core only).

## Rules

- Keep the decisions pure and tested alone: `foldProgress` (nudge at 3 stale steps, stop at 5) and `nextPhase` (the breaker, then completion, then the step cap).
- Only the model's own undecodable output (`InvalidOutputError`, `ToolParameterValidationError`, `ToolNotFoundError`) gets a corrective turn, bounded by `MAX_MALFORMED`; a provider's `InvalidResponseError` fails the step.
- A corrective turn counts against `maxSteps`, and every appended message (corrective, nudge, steering) goes through `onTail` before the next call, under the next step, and only when that step runs: `onTail(messages, step)` records a step's own tail under it, nothing under it after it settled, and nothing under a step the run never takes (a run the step cap, the breaker or completion ends drops the corrective or nudge it would have sent).
- A step runs in two parts. It executes (the call, the tools, the tail), then settles: `onStepSettled(step, status)` runs exactly once, with that execution's exit (`completed`, `failed`, `cancelled`, or `malformed` for a response the model could not form). Only then does the loop decide: `isComplete(step)` (a query, never asked after a malformed step), the breaker, compaction, steering. A decision that fails fails the run, never the settled step.
- `runSteps` publishes `step.ended` from `onStepSettled` and nowhere else, keeps what it carries across steps in one `Ref<StepLedger>` (the plan cache, the last usage, each step's recorded results, the steps started) updated by the pure functions of `step-ledger.entity.functions.ts`, and returns `RunResult`'s union (`completed`/`completed`, or `partial` with `step-cap` or `degenerate-loop`).
- Progress is keyed on results, not arguments, and pollable tools never count toward the breaker.
- A stream that fails before its first part falls back to `generateText` for the rest of the run with one `stream_fallback`; once a part arrived, a failure fails the step.
- A request refused over an image is sent again only before any part arrived, and only when `onMediaRejected` dealt with the images.
- Step spans carry a call's usage under the GenAI names and the run span the sum under `engine.usage.*`; content only with `captureTraceContent`, images by size.
- `runSteps` computes a step's plan once and serves the model, the messages and the tool choice from it.
- `runSteps` fails with a turn's `TurnError` as it is (`isTurnError`: the writer's `TurnClosed` keeps its tag, typed or carried as a defect), and with anything else (a provider's `AiError`) as `loop.failed`, that failure its `cause`.
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
| `DEGENERATE_REPEAT_NUDGE` (a user-role message) | `src/loop.ts:268-272` | by reference only, `src/loop.test.ts:231`; wording unpinned |
| `DEGENERATE_LOOP_STOP` (the reply of a run the breaker stopped with no text) | `src/loop.ts:274-275` | unpinned |
| Default malformed corrective (`Your previous reply could not be parsed: …`) | `src/loop.ts:681-684` | contains, `src/loop.test.ts:188`, `:206` |
| Default incomplete corrective (`The host reports that required actions are incomplete. …`) | `src/loop.ts:735` | unpinned |

Steering text (`pendingInput`) is the host's; the fold's summary message is core's `handoffToMessage`.

## Erasure files

`src/loop.ts`, the call assembly: the instrumented toolkit's `handle` over the generic `Tools` (`:457`) and the tool choice into its tool-name union (`:463`).

## Layout

| File | Role |
|---|---|
| `src/loop.ts` | `runLoop`, the pure decisions, metrics and span attributes |
| `src/step-loop.adapter.ts` | `runSteps`, `StepLoopLive`, the plugin |
| `src/step-ledger.entity.ts`, `src/step-ledger.entity.functions.ts` | `StepLedger`, what `runSteps` keeps across a run's steps, and its pure updates |
| `src/index.ts` | the public exports |

## Tests

- `src/step-loop.adapter.test.ts` runs core's `stepLoopConformance` against `StepLoopLive` and a minimal loop (`:100`), its self-test (`runSteps` made careless, ending its steps in its completion check and recording a corrective under a step the cap stops it from taking, must fail the settle checks), plus streaming fallback, failures (`loop.failed`, a turn's own tag) and trace content.
- `src/loop.test.ts`: scripted-model runs (correctives, breaker, cap, settling each step once, nothing recorded under a step that never runs, the compact seam, steering, streaming parity and fallback, image refusals, a host's initial batch, spans) and the pure decisions (`:785`).
- `src/step-ledger.entity.functions.test.ts`: the ledger's updates.
- The sdk golden composes `stepLoopPlugin`.
- Run: `bun test packages/plugin-agent-loop packages/sdk/src/agent.golden.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.
