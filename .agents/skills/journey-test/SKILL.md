---
name: journey-test
description: Write a key-free test that drives Agent.define and Agent.turn with a scripted LanguageModel and asserts on the requests the model saw, the events and the stored journal — where it lives, the -tests boundaries layer, in-memory sessions, determinism, goldens and the proxy caveat. Read before testing a plugin's behaviour end to end.
---

# Write a journey test

A journey runs the real registry, loop, memory and session with a model that
answers from a script. It shows what the framework does with a given model
reply, never what a model would do; it needs no key and no network.

Read one before writing one:

- `packages/plugin-workspace/src/workspace-tools.journey.test.ts`: a plugin's
  tools through a turn, with grants, progress events and the request the
  model saw.
- `packages/sdk/src/resume.journey.test.ts`: several turns on one session,
  cancelled and resumed.
- `packages/plugin-telemetry/src/scripted-turn.testing.ts`: a shared scripted
  turn for a package's tests.

## 1. Place it

- In the plugin: `<thing>.journey.test.ts` beside the code. Its tests import
  `Agent` from `@xandreed/sdk` and the plugins an agent needs, so the package
  needs a `<name>-tests` layer in `foundry.config.ts` and those packages in
  its `devDependencies` (as `plugin-workspace-tests`; skill `add-plugin`, step
  A.3). Core's names come from `@xandreed/core`, which the plugin depends on
  already: the sdk re-exports only those a host writes beside `Agent`.
- Or in `packages/sdk/src`, whose `sdk-tests` layer may import every plugin.
- A helper several test files share is `<name>.testing.ts`: the build drops
  it, and the `-tests` layer path must match it (`**/*.test*.ts`, as
  `plugin-telemetry-tests` does).

## 2. Build it

1. The model: `LanguageModel.make` (from `effect/ai`) whose `generateText`
   returns the next scripted reply and records each request (its tool names
   and prompt) in a `Ref`; `streamText: () => Stream.die("not scripted")`
   with `limits: { streaming: false }`. A reply is a list of parts:
   `{ type: "tool-call", id, name, params }` then
   `{ type: "finish", reason: "tool-calls", usage }`; a final answer is
   `textReply(text)` from `@xandreed/core/conformance`.
2. Sessions in memory: build `SessionsLive(sessionsDefaults)` over
   `Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)` with `Layer.build`,
   take `Sessions` from it, and `sessions.create({ owner, id })` with a fixed
   `ConversationId`.
3. The agent: `Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, <yours>], capabilities, turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps } })`.
   Options go as `{ plugin, options }` entries.
4. The turn: `agent.turn({ turn: { session, userMessage: new UserMessage({ text }), runId }, services }, use)`,
   where `services` is `Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions))`
   and `use` subscribes, then runs
   `turn.tools.select(turn.userMessage)` and `turn.run({})`, and returns
   `{ outcome, reply: Option.some(text) }`.
5. Observe: `subscribeAll(turn.events, [onEvent(…), onTool(schema, …)])`
   inside `use`; the stored journal with `sessions.read(address)` after the turn.

## 3. Assert on what matters

- The outcome and the reply.
- The requests the model saw: tools active at each step, and the exact text
  it was given (descriptions and sections; skill `write-model-text`).
- Events and their order, and the journal kinds stored.
- Side effects in a temporary directory, made with `Effect.acquireRelease`
  over `mkdtemp` so it is removed.

## 4. Keep it deterministic

- Fixed run ids, conversation ids and scripts; no wall clock in assertions
  (`TestClock` from `effect/testing`, or the fixed clock of
  `agent.golden.test.ts`).
- No provider keys, no network, no `process.env` reads. Real-provider
  evaluations are evals (`docs/composable-evaluations.md`), not journeys.
- Bun's fetch sends even loopback requests to `HTTP_PROXY`/`HTTPS_PROXY`:
  run tests with them unset.

## 5. Goldens

`packages/sdk/src/agent.golden.test.ts` pins one composed agent: what the
model and host see (`packages/sdk/golden/agent-turn.model.json`) and what
the session stores (`agent-turn.journal.json`). A change to either fails it.
Re-record only on purpose, and read the diff:

```bash
EFFERENT_UPDATE_MODEL_GOLDEN=1 bun test packages/sdk/src/agent.golden.test.ts   # what the model sees
EFFERENT_UPDATE_GOLDEN=1 bun test packages/sdk/src/agent.golden.test.ts         # the stored journal
git diff packages/sdk/golden
```

## Checklist

- [ ] File and `-tests` layer in place; devDependencies added, no cycle
- [ ] Scripted `LanguageModel`, in-memory sessions, `Agent.define` with the plugins the behaviour needs
- [ ] Asserts on outcome, requests the model saw, events and the journal
- [ ] Deterministic: fixed ids, no clock, no keys, temp dirs released
- [ ] Goldens re-recorded only on purpose, diff reviewed
- [ ] `env -u HTTP_PROXY -u HTTPS_PROXY bun test <file>` and `bun run typecheck`
