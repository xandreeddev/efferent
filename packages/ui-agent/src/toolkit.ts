import { Tool, Toolkit } from "@effect/ai"
import { Effect, Schema } from "effect"
import type { ConversationId } from "@xandreed/engine"
import { Failure } from "@xandreed/engine"
import { PageManifest, UiBlock } from "./domain/ui-page.entity.js"
import type { UiPageEvent } from "./domain/ui-page.entity.js"
import { foldPageEvents } from "./domain/ui-page.entity.functions.js"
import { canonicalizeUiBlocks, normalizeInitialUiAdmission } from "./domain/ui-page.entity.functions.js"
import { renderUiAdmissionFindings, validateBlocks, validateManifest, validatePageCompleteness } from "./domain/ui-quality.functions.js"
import type { UiHostService } from "./ports/ui-host.port.js"
import type { UiPageStoreService } from "./ports/ui-page-store.port.js"

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

export const uiAgentToolkit = Toolkit.make(StartUi, PatchUi)
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
) =>
  uiAgentToolkit.toLayer({
    start_ui: ({ page, criticalBlocks }) =>
      Effect.gen(function* () {
        yield* bounded({ page, criticalBlocks }, criticalBlocks)
        const admitted = normalizeInitialUiAdmission(page, criticalBlocks, {
          designSystem: { id: host.tokens.id, version: host.tokens.version },
          assetIds: new Set(host.assets.keys()),
        })
        const findings = [
          ...validateManifest(admitted.manifest, host),
          ...validateBlocks(admitted.manifest, admitted.blocks, host),
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
        const findings = validateBlocks(page.manifest, admitted, host)
        if (findings.length > 0) return yield* Effect.fail({ error: "UiRejected", message: renderUiAdmissionFindings(findings) })
        const event: UiPageEvent = { type: "blocks_upserted", pageId, blocks: admitted, at: Date.now() }
        yield* store.append(conversationId, event).pipe(Effect.mapError((message) => ({ error: "PageStoreError", message })))
        yield* sink(event)
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
  })
