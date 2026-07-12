import { describe, expect, test } from "bun:test"
import { Tool } from "@effect/ai"
import { Effect } from "effect"
import { ConversationId } from "@xandreed/engine"
import { applicationReference, architectureReference, landingReference } from "./reference-pages.functions.js"
import { foldPageEvents } from "./domain/ui-page.entity.functions.js"
import { normalizeInitialUiAdmission, uiPlannerPrompt, validatePageCompleteness, validateUiAgentProfile } from "./index.js"
import { makeUiAgentHandlers, StartUi, uiAgentToolkit } from "./toolkit.js"
import type { UiHostService } from "./ports/ui-host.port.js"
import type { UiPageStoreService } from "./ports/ui-page-store.port.js"
import type { UiPageEvent } from "./domain/ui-page.entity.js"

const host: UiHostService = {
  tokens: {
    schemaVersion: 1, id: "efferent-canvas", version: "1.0.0",
    colors: { page: "#000000", surface: "#111111", raised: "#222222", line: "#333333", text: "#ffffff", muted: "#aaaaaa", accent: "#ff7700", success: "#00aa66", warning: "#ddaa00", danger: "#dd3344" },
    typography: { display: "geometric", body: "system", mono: "mono", scale: "standard" },
    density: "standard", radius: "soft", shadow: "subtle", motion: "standard",
  },
  recipes: new Set(["landing.hero-grid", "app.workspace", "doc.architecture"]),
  assets: new Map(),
  actions: new Map([
    ["canvas.acknowledge", { decode: Effect.succeed, authorize: () => Effect.void, run: () => Effect.succeed({ blocks: [], notice: undefined }) }],
    ["canvas.request-demo", { decode: Effect.succeed, authorize: () => Effect.void, run: () => Effect.succeed({ blocks: [], notice: undefined }) }],
  ]),
  queries: new Map(),
}

describe("the structured UI-agent contract", () => {
  test("the model tool vocabulary contains no raw markup escape hatch", () => {
    const schema = JSON.stringify(Tool.getJsonSchema(StartUi as never))
    expect(schema).not.toContain('"html"')
    expect(schema).not.toContain('"css"')
    expect(schema).not.toContain('"class"')
    expect(schema).toContain("criticalBlocks")
  })

  test("all three reference archetypes satisfy their deterministic quality floor", () => {
    ;[landingReference, applicationReference, architectureReference].forEach((reference) => {
      expect(validatePageCompleteness({ manifest: reference.page, blocks: reference.blocks, complete: true })).toEqual([])
    })
  })

  test("host-owned admission data cannot cause the all-zero matrix failure", () => {
    const hero = landingReference.blocks[0]!
    expect(hero.kind).toBe("hero")
    if (hero.kind !== "hero") return
    const admitted = normalizeInitialUiAdmission(
      {
        ...landingReference.page,
        designSystem: { id: "hallucinated-system", version: "9" },
        slots: landingReference.page.slots.filter((slot) => slot.id !== hero.id),
      },
      [{ ...hero, assetId: "hallucinated-asset" }],
      {
        designSystem: { id: host.tokens.id, version: host.tokens.version },
        assetIds: new Set(host.assets.keys()),
      },
    )
    expect(admitted.manifest.designSystem).toEqual({ id: "efferent-canvas", version: "1.0.0" })
    expect(admitted.manifest.slots).toContainEqual({ id: hero.id, blockKind: "hero", importance: "critical" })
    expect(admitted.blocks[0]).not.toHaveProperty("assetId")
  })

  test("planner receives the exact dynamic host contract", () => {
    const prompt = uiPlannerPrompt({
      designSystem: { id: host.tokens.id, version: host.tokens.version },
      recipes: [...host.recipes],
      assets: [...host.assets.keys()],
      capabilities: [...host.actions.keys()],
    })
    expect(prompt).toContain('{"id":"efferent-canvas","version":"1.0.0"}')
    expect(prompt).toContain("registered assets: none — omit every assetId")
    expect(prompt).toContain("identical id and blockKind")
  })

  test("accepted events persist before publication and replay deterministically", async () => {
    const events: Array<UiPageEvent> = []
    const order: Array<string> = []
    const store: UiPageStoreService = {
      append: (_conversationId, event) => Effect.sync(() => { order.push(`store:${event.type}`); events.push(event) }),
      list: () => Effect.succeed(events),
    }
    const layer = makeUiAgentHandlers(
      ConversationId.make("00000000-0000-4000-8000-000000000111"),
      store,
      host,
      (event) => Effect.sync(() => { order.push(`sink:${event.type}`) }),
    )
    const hero = landingReference.blocks.find((block) => block.kind === "hero")!
    const malformedPage = {
      ...landingReference.page,
      designSystem: { id: "hallucinated-system", version: "9" },
      slots: landingReference.page.slots.filter((slot) => slot.id !== hero.id),
    }
    const outcome = await Effect.runPromise(Effect.gen(function* () {
      const toolkit = yield* uiAgentToolkit
      yield* toolkit.handle("start_ui", {
        page: malformedPage,
        criticalBlocks: [{ ...hero, assetId: "hallucinated-asset" }],
      })
      return yield* toolkit.handle("patch_ui", { pageId: landingReference.page.id, blocks: landingReference.blocks.slice(1), complete: true })
    }).pipe(Effect.provide(layer)))
    expect(outcome.isFailure).toBe(false)
    expect(order).toEqual([
      "store:page_opened", "sink:page_opened",
      "store:blocks_upserted", "sink:blocks_upserted",
      "store:page_completed", "sink:page_completed",
    ])
    const replayed = foldPageEvents(events)
    expect(replayed[0]?.manifest.designSystem).toEqual({ id: "efferent-canvas", version: "1.0.0" })
    expect(replayed[0]?.blocks[0]).not.toHaveProperty("assetId")
    expect(replayed[0]?.blocks).toHaveLength(5)
    expect(replayed[0]?.complete).toBe(true)
  })

  test("the composer can refine critical content but cannot change its declared kind", async () => {
    const events: Array<UiPageEvent> = []
    const store: UiPageStoreService = {
      append: (_conversationId, event) => Effect.sync(() => { events.push(event) }),
      list: () => Effect.succeed(events),
    }
    const layer = makeUiAgentHandlers(
      ConversationId.make("00000000-0000-4000-8000-000000000112"), store, host, () => Effect.void,
    )
    const accepted = await Effect.runPromise(Effect.gen(function* () {
      const toolkit = yield* uiAgentToolkit
      yield* toolkit.handle("start_ui", { page: landingReference.page, criticalBlocks: [landingReference.blocks[0]!] })
      const hero = landingReference.blocks[0]!
      if (hero.kind !== "hero") return yield* Effect.die("landing reference must start with hero")
      return yield* toolkit.handle("patch_ui", { pageId: landingReference.page.id, blocks: [{ ...hero, title: "A sharper promise" }] })
    }).pipe(Effect.provide(layer)))
    expect(accepted.isFailure).toBe(false)
    const rejected = await Effect.runPromise(Effect.gen(function* () {
      const toolkit = yield* uiAgentToolkit
      return yield* toolkit.handle("patch_ui", { pageId: landingReference.page.id, blocks: [{ kind: "prose", id: "hero", paragraphs: ["wrong kind"] }] })
    }).pipe(Effect.provide(layer)))
    expect(rejected.isFailure).toBe(true)
    expect(JSON.stringify(rejected.result)).toContain("is not declared")
  })

  test("profile validation pins models, budgets, prompt versions, schema, and recipes", () => {
    expect(validateUiAgentProfile({
      profile: "streaming-ui-v1", version: "5.0.0", schemaVersion: "1.0.0", recipeSetVersion: "1.0.0",
      prompts: { planner: "5.0.0", composer: "6.0.0", repair: "3.0.0" },
      planner: { model: "opencode:deepseek-v4-flash", effort: "low", timeoutMs: 15000, maxOutputTokens: 2400, maxSteps: 2 },
      composer: { model: "opencode:deepseek-v4-flash", effort: "low", timeoutMs: 20000, maxOutputTokens: 5000, maxSteps: 2 },
      repair: { model: "opencode:deepseek-v4-flash", effort: "low", timeoutMs: 8000, maxOutputTokens: 1800, maxSteps: 2, maxAttempts: 1 },
      fallback: { policy: "none" },
    }, { planner: "5.0.0", composer: "6.0.0", repair: "3.0.0" })).toEqual([])
  })
})
