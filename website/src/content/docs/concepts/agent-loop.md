---
title: The agent loop
description: What runAgent does each turn — and why iteration across turns is the SDK's job, not the provider's.
sidebar:
  label: The agent loop
  order: 2
---

One use case drives the whole interaction: **`runAgent(config, conversationId, prompt, hooks?)`**
(`usecases/runAgent.ts`). The loop itself lives in `usecases/agentLoop.ts`.

## Why the loop is ours

`@effect/ai` resolves a **single** model step's tool calls — their handlers are your Effects — but it
does **not** iterate across turns. So the turn loop is the SDK's:

1. Map the message buffer to an `@effect/ai` `Prompt`.
2. Call `LanguageModel.generateText({ prompt, toolkit })` — this resolves the step's tool calls.
3. Append the response parts as the new tail of the buffer.
4. Re-invoke **until** `finishReason !== "tool-calls"` (the model answered) or `maxSteps` is hit.

```
runAgent(config, conversationId, prompt, hooks)
  ├─ ConversationStore.append(user) ; load history
  ├─ loop turn 0..N:
  │    onTurnStart → Prompt.make([system, ...messages])
  │                → LanguageModel.generateText({ prompt, toolkit })
  │                → append response parts to the buffer
  │                → re-emit onBeforeToolCall / onAfterToolCall / onAssistantMessage
  │                → continue iff finishReason === "tool-calls"
  ├─ ConversationStore.append(tail)
  └─ return AgentResult { finalText, messages, newTail }
```

`maxSteps` defaults to 20 (`Settings.maxSteps`). The result is an `AgentResult` — see
[`runAgent`](/efferent/reference/run-agent/).

## Prompt mapping

The persisted message shape (`AgentMessage`) and `@effect/ai`'s `Prompt`/`Response` are bridged in
`usecases/promptMapping.ts`. The opaque provider blob is carried verbatim both ways
(`providerOptions ↔ metadata`), which is how Gemini's `thought_signature` round-trips across turns.

## Graceful tool errors

A tool's `failureMode: "return"` means a *handler* failure (a missing file, an ambiguous edit) is
returned to the model as a tool result — the turn survives and the model adjusts. But `@effect/ai`
decodes a call's parameters **before** the handler runs, so a malformed or hallucinated call fails with
`AiError.MalformedOutput`, which `failureMode` can't catch. `recoverMalformedToolCalls` (in
`agentLoop.ts`) converts that into an ordinary tool result too, so the loop proceeds and the model reads
the decode error from context. Same recovery path, no retry machinery. See
[Define a tool](/efferent/guides/define-a-tool/).

## Hooks

The loop re-emits a small event vocabulary from each response — `onTurnStart`, the tool events,
`onAssistantMessage`, and more — so a driver (the TUI, your app) can observe and steer without owning the
loop. See [Hooks](/efferent/guides/hooks/) and the [`AgentHooks` reference](/efferent/reference/hooks/).
