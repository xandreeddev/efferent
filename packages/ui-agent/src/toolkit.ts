import { Tool, Toolkit } from "@effect/ai"
import { Effect, Schema } from "effect"
import type { ConversationId } from "@xandreed/engine"
import { Failure } from "@xandreed/engine"
import { PageManifest, UiBlock } from "./domain/ui-page.entity.js"
import type { UiPageEvent } from "./domain/ui-page.entity.js"
import { ThemeDelta } from "./domain/design-system.entity.js"
import { applyThemeDelta, themeFingerprint, themeIntentFromTokens, validateThemeIntent } from "./domain/design-system.entity.functions.js"
import { UiComponentDefinition } from "./domain/ui-component.entity.js"
import { CORE_UI_COMPONENTS } from "./domain/core-components.functions.js"
import { admitComponent, normalizeComponentDefinition } from "./domain/ui-component.entity.functions.js"
import { foldPageEvents } from "./domain/ui-page.entity.functions.js"
import { canonicalizeUiBlocks, normalizeInitialUiAdmission } from "./domain/ui-page.entity.functions.js"
import { renderUiAdmissionFindings, validateBlocks, validateManifest, validatePageCompleteness } from "./domain/ui-quality.functions.js"
import type { UiHostService } from "./ports/ui-host.port.js"
import type { UiPageStoreService } from "./ports/ui-page-store.port.js"
import type { UiComponentCatalogService } from "./ports/ui-component-catalog.port.js"
import type { UiThemeStoreService } from "./ports/ui-theme-store.port.js"

export const UI_BATCH_MAX_BYTES = 32_768
export const UI_BATCH_MAX_BLOCKS = 8

export const StartUi = Tool.make("start_ui", {
  description: "Open a governed page from a versioned recipe and publish its first meaningful blocks. Emit structured data only; HTML, CSS, classes, HTMX, Alpine expressions, SVG, and URLs are not accepted.",
  parameters: { page: PageManifest, criticalBlocks: Schema.Array(UiBlock) },
  success: Schema.Struct({ opened: Schema.Boolean, pageId: Schema.String, accepted: Schema.Number }),
  failure: Failure,
  failureMode: "return",
})

export const PatchUi = Tool.make("patch_ui", {
  description: "Upsert up to eight governed blocks into an open page. Prefer one complete refinement patch so useful content arrives atomically. Set complete only after every required recipe slot has content.",
  parameters: { pageId: Schema.String, blocks: Schema.Array(UiBlock), complete: Schema.optional(Schema.Boolean) },
  success: Schema.Struct({ patched: Schema.Boolean, pageId: Schema.String, accepted: Schema.Number, complete: Schema.Boolean }),
  failure: Failure,
  failureMode: "return",
})

export const ProposeComponent = Tool.make("propose_component", {
  description: "Propose one reusable component only when the registered catalog and typed composition cannot express the required anatomy or behavior. The constrained template AST contains no HTML, CSS, classes, URLs, HTMX attributes, Alpine expressions, SVG, or JavaScript.",
  parameters: { definition: UiComponentDefinition },
  success: Schema.Struct({ canonicalId: Schema.String, disposition: Schema.Literal("reused", "variant", "admitted"), similarity: Schema.Number }),
  failure: Failure,
  failureMode: "return",
})

export const PatchTheme = Tool.make("patch_theme", {
  description: "Patch semantic theme tokens for an open page. Use this for shades, typography, borders, radius, density, shadow, contrast, or motion; never create a styling-only component.",
  parameters: { pageId: Schema.String, delta: ThemeDelta },
  success: Schema.Struct({ patched: Schema.Boolean, pageId: Schema.String, themeId: Schema.String }),
  failure: Failure,
  failureMode: "return",
})

export const PatchUiProp = Tool.make("patch_ui_prop", {
  description: "Patch one declared prop on an accepted component node so useful fields can paint progressively before the whole section is complete.",
  parameters: { pageId: Schema.String, nodeId: Schema.String, key: Schema.String, value: Schema.Unknown },
  success: Schema.Struct({ patched: Schema.Boolean, pageId: Schema.String, nodeId: Schema.String, key: Schema.String }),
  failure: Failure,
  failureMode: "return",
})

export const uiAgentToolkit = Toolkit.make(StartUi, PatchUi, PatchUiProp, ProposeComponent, PatchTheme)
export type UiAgentToolkit = typeof uiAgentToolkit

const bounded = (value: unknown, blocks: ReadonlyArray<UiBlock>): Effect.Effect<void, { readonly error: string; readonly message: string }> => {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
  if (blocks.length > UI_BATCH_MAX_BLOCKS) {
    return Effect.fail({ error: "TooManyBlocks", message: `send at most ${UI_BATCH_MAX_BLOCKS} blocks per patch` })
  }
  return bytes > UI_BATCH_MAX_BYTES
    ? Effect.fail({ error: "PatchTooLarge", message: `patch is ${bytes} bytes; maximum is ${UI_BATCH_MAX_BYTES}` })
    : Effect.void
}

export const makeUiAgentHandlers = (
  conversationId: ConversationId,
  store: UiPageStoreService,
  host: UiHostService,
  sink: (event: UiPageEvent) => Effect.Effect<void>,
  catalog: UiComponentCatalogService = {
    list: Effect.succeed(CORE_UI_COMPONENTS.map(normalizeComponentDefinition)),
    admit: (definition) => Effect.succeed(admitComponent(definition, CORE_UI_COMPONENTS.map(normalizeComponentDefinition))),
    recordUsage: () => Effect.void,
    usages: () => Effect.succeed([]),
  },
  themes: UiThemeStoreService = { list: Effect.succeed([]), put: () => Effect.void },
) =>
  uiAgentToolkit.toLayer({
    start_ui: ({ page, criticalBlocks }) =>
      Effect.gen(function* () {
        yield* bounded({ page, criticalBlocks }, criticalBlocks)
        const admitted = normalizeInitialUiAdmission(page, criticalBlocks, {
          designSystem: { id: host.tokens.id, version: host.tokens.version },
          assetIds: new Set(host.assets.keys()),
        })
        const definitions = yield* catalog.list.pipe(Effect.mapError((message) => ({ error: "CatalogError", message })))
        const findings = [
          ...validateManifest(admitted.manifest, host),
          ...validateBlocks(admitted.manifest, admitted.blocks, host, new Map(definitions.map((definition) => [definition.id, definition]))),
        ]
        if (findings.length > 0) return yield* Effect.fail({ error: "UiRejected", message: renderUiAdmissionFindings(findings) })
        const event: UiPageEvent = {
          type: "page_opened",
          page: admitted.manifest,
          blocks: admitted.blocks,
          at: Date.now(),
        }
        yield* store.append(conversationId, event).pipe(Effect.mapError((message) => ({ error: "PageStoreError", message })))
        yield* sink(event)
        yield* Effect.forEach(admitted.blocks, (block) => block.kind === "component"
          ? catalog.recordUsage({ componentId: block.component, pageId: page.id, intent: page.title, renderedAt: event.at }).pipe(Effect.catchAll((message) => Effect.logWarning(`component usage was not recorded: ${message}`)))
          : Effect.void, { concurrency: "unbounded" })
        return { opened: true, pageId: page.id, accepted: criticalBlocks.length }
      }),
    patch_ui: ({ pageId, blocks, complete }) =>
      Effect.gen(function* () {
        yield* bounded({ pageId, blocks, complete }, blocks)
        const events = yield* store.list(conversationId).pipe(Effect.mapError((message) => ({ error: "PageStoreError", message })))
        const page = foldPageEvents(events).find((candidate) => candidate.manifest.id === pageId)
        if (page === undefined) return yield* Effect.fail({ error: "PageNotFound", message: `open ${pageId} with start_ui before patching it` })
        const admitted = canonicalizeUiBlocks(blocks, {
          designSystem: { id: host.tokens.id, version: host.tokens.version },
          assetIds: new Set(host.assets.keys()),
        })
        const definitions = yield* catalog.list.pipe(Effect.mapError((message) => ({ error: "CatalogError", message })))
        const findings = validateBlocks(page.manifest, admitted, host, new Map(definitions.map((definition) => [definition.id, definition])))
        if (findings.length > 0) return yield* Effect.fail({ error: "UiRejected", message: renderUiAdmissionFindings(findings) })
        const event: UiPageEvent = { type: "blocks_upserted", pageId, blocks: admitted, at: Date.now() }
        yield* store.append(conversationId, event).pipe(Effect.mapError((message) => ({ error: "PageStoreError", message })))
        yield* sink(event)
        yield* Effect.forEach(admitted, (block) => block.kind === "component"
          ? catalog.recordUsage({ componentId: block.component, pageId, intent: page.manifest.title, renderedAt: event.at }).pipe(Effect.catchAll((message) => Effect.logWarning(`component usage was not recorded: ${message}`)))
          : Effect.void, { concurrency: "unbounded" })
        if (complete === true) {
          const completedPage = foldPageEvents([...events, event]).find((candidate) => candidate.manifest.id === pageId)
          const incomplete = completedPage === undefined ? ["page state is unavailable"] : validatePageCompleteness(completedPage)
          if (incomplete.length > 0) return yield* Effect.fail({ error: "PageIncomplete", message: renderUiAdmissionFindings(incomplete) })
          const completed: UiPageEvent = { type: "page_completed", pageId, at: Date.now() }
          yield* store.append(conversationId, completed).pipe(Effect.mapError((message) => ({ error: "PageStoreError", message })))
          yield* sink(completed)
        }
        return { patched: true, pageId, accepted: blocks.length, complete: complete === true }
      }),
    patch_ui_prop: ({ pageId, nodeId, key, value }) => Effect.gen(function* () {
      const events = yield* store.list(conversationId).pipe(Effect.mapError((message) => ({ error: "PageStoreError", message })))
      const page = foldPageEvents(events).find((candidate) => candidate.manifest.id === pageId)
      if (page === undefined) return yield* Effect.fail({ error: "PageNotFound", message: `open ${pageId} with start_ui before patching a prop` })
      const node = page.blocks.find((block) => block.id === nodeId)
      if (node?.kind !== "component") return yield* Effect.fail({ error: "ComponentNotFound", message: `${nodeId} is not an accepted component node` })
      const block: UiBlock = { ...node, props: { ...node.props, [key]: value } }
      const definitions = yield* catalog.list.pipe(Effect.mapError((message) => ({ error: "CatalogError", message })))
      const findings = validateBlocks(page.manifest, [block], host, new Map(definitions.map((definition) => [definition.id, definition])))
      if (findings.length > 0) return yield* Effect.fail({ error: "UiRejected", message: renderUiAdmissionFindings(findings) })
      const event: UiPageEvent = { type: "blocks_upserted", pageId, blocks: [block], at: Date.now() }
      yield* store.append(conversationId, event).pipe(Effect.mapError((message) => ({ error: "PageStoreError", message })))
      yield* sink(event)
      return { patched: true, pageId, nodeId, key }
    }),
    propose_component: ({ definition }) => catalog.admit(definition).pipe(
      Effect.map((admission) => ({ canonicalId: admission.canonicalId, disposition: admission.disposition, similarity: admission.similarity })),
      Effect.mapError((message) => ({ error: "ComponentRejected", message })),
    ),
    patch_theme: ({ pageId, delta }) => Effect.gen(function* () {
      const events = yield* store.list(conversationId).pipe(Effect.mapError((message) => ({ error: "PageStoreError", message })))
      const page = foldPageEvents(events).find((candidate) => candidate.manifest.id === pageId)
      if (page === undefined) return yield* Effect.fail({ error: "PageNotFound", message: `open ${pageId} with start_ui before patching its theme` })
      const intent = applyThemeDelta(page.manifest.theme ?? themeIntentFromTokens(host.tokens), delta)
      const findings = validateThemeIntent(intent)
      if (findings.length > 0) return yield* Effect.fail({ error: "ThemeRejected", message: renderUiAdmissionFindings(findings) })
      const fingerprint = themeFingerprint(intent)
      yield* themes.put({ id: fingerprint, version: "1.0.0", designSystem: { id: host.tokens.id, version: host.tokens.version }, intent, status: "workspace", fingerprint, createdAt: Date.now() }).pipe(
        Effect.mapError((message) => ({ error: "ThemeStoreError", message })),
      )
      const event: UiPageEvent = { type: "theme_patched", pageId, theme: intent, at: Date.now() }
      yield* store.append(conversationId, event).pipe(Effect.mapError((message) => ({ error: "PageStoreError", message })))
      yield* sink(event)
      return { patched: true, pageId, themeId: fingerprint }
    }),
  })
