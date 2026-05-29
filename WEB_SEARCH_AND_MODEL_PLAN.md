# Proposed Plan: Three-Tier Model Configuration & Provider-Aware Web Search

## Context

Today, `agent` uses a single, globally active model (e.g., `google:gemini-3.5-flash`) for all tasks. This is a bottleneck:
1. **Background Tasks** (like context compaction / summarization) and **Structural Checks** don't need expensive developer models. They should use a high-speed, cost-efficient "cheap/light" model (e.g., `gemini-2.5-flash` or `gpt-4o-mini`).
2. **Sub-agent Loops** (for scoped delegations) need high-speed reasoning and low latencies. They should use a "fast" model (e.g., `gemini-1.5-flash` or `claude-3-5-haiku`).
3. **Complex Coding Tasks** (main chat/editing) should use the "main" developer model (e.g., `gpt-4o` or `claude-3-5-sonnet`).

Additionally, **Web Search & Grounding** is currently unimplemented. Both Google and OpenAI offer highly optimized, free, provider-native web search tools (`GoogleSearch`/`WebSearch`) which execute on the server side (`requiresHandler: false`).

This plan outlines how to integrate **Three-Tier Model Selection (Main, Fast, Cheap)** alongside **Provider-Aware Web Search** inside the Effect-based ports/adapters architecture.

---

## 1. Three-Tier Model Configuration

We will extend our persistence and registries to track separate selections for three model tiers:
* **Main Model:** Complex coding, reasoning, and direct user chat.
* **Fast Model:** Sub-agent loops, single-file edits, syntax checkups.
* **Cheap Model:** Background context compaction (turn-summarization) and token budgeting.

### 1.1 Extend Settings Schema (`packages/core/src/entities/Settings.ts`)
```typescript
export const Settings = Schema.Struct({
  allowBash: Schema.Boolean,
  maxSteps: Schema.Number,
  editorMode: EditorMode,
  // Three model tiers (saved as "<provider>:<modelId>")
  model: Schema.String.annotations({
    description: "Main developer model (e.g., 'openai:gpt-4o', 'google:gemini-1.5-pro').",
  }),
  fastModel: Schema.String.annotations({
    description: "Fast model for sub-agent delegation & small edits (e.g., 'google:gemini-1.5-flash').",
  }),
  cheapModel: Schema.String.annotations({
    description: "Cheap model for background summarization & token math (e.g., 'google:gemini-2.5-flash').",
  }),
})

export const DefaultSettings: Settings = {
  allowBash: false,
  maxSteps: 20,
  editorMode: "insert",
  model: "google:gemini-1.5-pro",
  fastModel: "google:gemini-1.5-flash",
  cheapModel: "google:gemini-2.5-flash",
}
```

### 1.2 Extend the ModelRegistry Port (`packages/core/src/ports/ModelRegistry.ts`)
```typescript
export class ModelRegistry extends Context.Tag("@agent/core/ModelRegistry")<
  ModelRegistry,
  {
    /** The models assigned to each tier */
    readonly current: Effect.Effect<ModelSelection>
    readonly currentFast: Effect.Effect<ModelSelection>
    readonly currentCheap: Effect.Effect<ModelSelection>

    /** Live, chat-capable model catalogue */
    readonly list: Effect.Effect<ReadonlyArray<ModelInfo>, ModelListError>

    /** Switch and persist a tier selection */
    readonly select: (
      tier: "main" | "fast" | "cheap",
      selection: { readonly provider: Provider; readonly modelId: string }
    ) => Effect.Effect<ModelSelection>
  }
>() {}
```

### 1.3 Update TUI Commands & Slash Palette (`packages/cli/src/tui/`)
* **`/model` (no args):** Prints currently configured models for all 3 tiers.
* **`/model [main|fast|cheap] <#|id>`:** Persists and switches a specific tier.
  - *Example:* `/model fast 3` or `/model cheap google:gemini-2.5-flash`.

---

## 2. Using Tiers in Use Cases (The "Effect Wedge")

Because our model router delegates calls dynamically at runtime by reading `ModelRegistry`, we can execute specific Effect blocks under the **Fast** or **Cheap** configurations locally and ephemerally.

### 2.1 Background Compaction (Uses Cheap Model)
When context size grows too large, compaction runs in the background. We route it through the Cheap Model by dynamically overriding the `ModelRegistry` service:
```typescript
// packages/core/src/usecases/compaction.ts
const compactedHistory = runSummarizer(messages).pipe(
  Effect.provideService(ModelRegistry, {
    current: registry.currentCheap, // Route generation turns to cheap model
    currentFast: registry.currentFast,
    currentCheap: registry.currentCheap,
    list: registry.list,
    select: registry.select,
  })
)
```

### 2.2 Sub-Agent Loops (Uses Fast Model)
When parent agents delegate tasks via `delegate_to_<child>`, the sub-agent is initialized using the **Fast Model** runtime to ensure fast execution and minimal latency.

---

## 3. Provider-Aware Web Search

Rather than hardcoding a custom search API (like Tavily) or managing API keys for a third-party scraper, we can leverage native search/grounding features built into Gemini and OpenAI models.

```
                  Active Model Selection?
                        /         \
              "google" /           \ "openai"
                      ▼             ▼
         [GoogleTool.GoogleSearch]  [OpenAiTool.WebSearch] (Bing)
```

### 3.1 Define Virtual Search Tool in Core (`packages/core/src/usecases/webToolkit.ts`)
We expose a generic `web_search` tool signature to our core agent loops, keeping them vendor-agnostic:
```typescript
import { Tool } from "@effect/ai"
import { Schema } from "effect"

export const webSearch = Tool.make("web_search", {
  description: "Search the web for real-time information, news, or reference documentation.",
  parameters: Schema.Struct({
    query: Schema.String.annotations({ description: "Search query" }),
  }),
  success: Schema.Struct({
    results: Schema.Array(Schema.Struct({
      title: Schema.String,
      url: Schema.String,
      snippet: Schema.String,
    })),
  }),
  failureMode: "return",
})
```

### 3.2 Dynamic Grounding Routing (`packages/adapters/src/llm/router.ts`)
In our multi-provider router, before delegating the `generateText`/`streamText` call to the underlying SDKs, we intercept and translate the virtual `web_search` tool:

1. **If the active provider is `"google"`:**
   - Remove the `web_search` tool from the options.
   - Inject `@effect/ai-google`'s native `GoogleTool.GoogleSearch()` into the toolkit. 
   - Gemini natively performs Google Search and formats grounding results on their servers.
2. **If the active provider is `"openai"`:**
   - Remove the `web_search` tool from the options.
   - Inject `@effect/ai-openai`'s native `OpenAiTool.WebSearch()` into the toolkit.
   - OpenAI natively executes Bing Search grounding.
3. **If Anthropic (when supported):**
   - Fall back to a manual search handler that uses our standard `Http` port (e.g. hitting a public duckduckgo/html endpoint or custom search API).

---

## 4. Verification & Testing

1. **Verify Config Storage:** 
   Check `.agent/config.json` after running `/model fast google:gemini-1.5-flash` to ensure separate serialization of `model`, `fastModel`, and `cheapModel`.
2. **Verify Compaction Model:**
   Trigger background summarization and verify that the request utilizes the cheap model's context window.
3. **Verify Grounding:**
   Ask the TUI: *"Who won the most recent formula 1 race?"* Verify that:
   - For Gemini, a Google Search tool-pill fires under the hood.
   - For OpenAI, a Bing Search tool-pill fires under the hood.
   - Correct, up-to-date real-time answers are printed.
