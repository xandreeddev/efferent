import { join } from "node:path"
import { Effect, Option } from "effect"
import { loadConfig, renderQualityBar } from "@xandreed/foundry"
import type { QualityBar } from "@xandreed/foundry"
import { FileSystem } from "@xandreed/engine"

/**
 * The workspace's ARMED quality bar, rendered from its own gate config —
 * shared by the forge session (coder briefs + judge) and the refine session.
 * Same precedence as gate discovery: an explicit config path wins, else the
 * workspace's `foundry.config.ts`, else none. Errors read as ABSENT — the
 * bar is an aid, never a reason a run can't start (the gates themselves
 * still fail loudly on a broken config).
 */
export const loadQualityBar = (
  cwd: string,
  configPath: Option.Option<string> = Option.none(),
): Effect.Effect<Option.Option<QualityBar>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const conventional = join(cwd, "foundry.config.ts")
    const resolved = yield* Option.match(configPath, {
      onSome: (path) => Effect.succeed(Option.some(path)),
      onNone: () =>
        fs
          .exists(conventional)
          .pipe(
            Effect.map((has) => (has ? Option.some(conventional) : Option.none<string>())),
            Effect.catchAll(() => Effect.succeed(Option.none<string>())),
          ),
    })
    return yield* Option.match(resolved, {
      onNone: () => Effect.succeed(Option.none<QualityBar>()),
      onSome: (path) =>
        loadConfig(path).pipe(
          Effect.map(({ config, registry }) => renderQualityBar(config, registry)),
          Effect.catchAll(() => Effect.succeed(Option.none<QualityBar>())),
        ),
    })
  })
