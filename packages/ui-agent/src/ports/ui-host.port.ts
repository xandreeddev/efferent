import { Context, Effect } from "effect"
import type { DesignTokens, RegisteredAsset } from "../domain/design-system.entity.js"
import type { UiBlock } from "../domain/ui-page.entity.js"

export interface UiRequestContext {
  readonly sessionId: string
  readonly principal: string | undefined
  readonly csrfToken: string
}

export interface UiActionResult {
  readonly blocks: ReadonlyArray<UiBlock>
  readonly notice: string | undefined
}

export interface UiCapability {
  readonly decode: (input: unknown) => Effect.Effect<unknown, string>
  readonly authorize: (input: unknown, context: UiRequestContext) => Effect.Effect<void, string>
  readonly run: (input: unknown, context: UiRequestContext) => Effect.Effect<UiActionResult, string>
}

export interface UiHostService {
  readonly tokens: DesignTokens
  readonly recipes: ReadonlySet<string>
  readonly assets: ReadonlyMap<string, RegisteredAsset>
  readonly actions: ReadonlyMap<string, UiCapability>
  readonly queries: ReadonlyMap<string, UiCapability>
}

export class UiHost extends Context.Tag("@xandreed/ui-agent/UiHost")<UiHost, UiHostService>() {}
