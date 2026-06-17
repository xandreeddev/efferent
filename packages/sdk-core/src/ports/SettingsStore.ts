import { Context, type Effect } from "effect"
import type { Settings } from "../entities/Settings.js"

export class SettingsStore extends Context.Tag("@xandreed/sdk-core/SettingsStore")<
  SettingsStore,
  {
    readonly get: () => Effect.Effect<Settings, never>
    readonly update: (
      f: (current: Settings) => Settings,
    ) => Effect.Effect<Settings, never>
    readonly load: (cwd: string, homeDir: string) => Effect.Effect<Settings, never>
  }
>() {}
