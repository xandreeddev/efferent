import { Context, type Effect } from "effect"
import type { Settings } from "../entities/Settings.js"

/** Which config tier a write targets — machine-wide vs this folder. The default
 *  is `"local"` (a per-folder, gitignored override); onboarding writes `"global"`. */
export type ConfigScope = "global" | "local"

export class SettingsStore extends Context.Tag("@xandreed/sdk-core/SettingsStore")<
  SettingsStore,
  {
    /** The merged, effective settings (`defaults < global < local`). */
    readonly get: () => Effect.Effect<Settings, never>
    /** The global tier alone — what the onboarding gate reads so a per-folder
     *  file can neither re-trigger nor suppress onboarding. */
    readonly global: () => Effect.Effect<Settings, never>
    /**
     * Apply `f` to the merged settings and persist the changed keys to the
     * chosen tier's file only (default `"local"`), preserving the rest of that
     * file. Returns the new merged settings.
     */
    readonly update: (
      f: (current: Settings) => Settings,
      scope?: ConfigScope,
    ) => Effect.Effect<Settings, never>
    readonly load: (cwd: string, homeDir: string) => Effect.Effect<Settings, never>
  }
>() {}
