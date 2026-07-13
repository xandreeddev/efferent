import { Context, Effect } from "effect"
import type { ThemeDefinition } from "../domain/design-system.entity.js"

export interface UiThemeStoreService {
  readonly list: Effect.Effect<ReadonlyArray<ThemeDefinition>, string>
  readonly put: (theme: ThemeDefinition) => Effect.Effect<void, string>
}

export class UiThemeStore extends Context.Tag("@xandreed/ui-agent/UiThemeStore")<UiThemeStore, UiThemeStoreService>() {}
