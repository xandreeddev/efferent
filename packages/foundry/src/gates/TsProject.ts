import { Context, Effect, Layer, SynchronizedRef } from "effect"
import * as path from "node:path"
import * as ts from "typescript"
import { ProjectLoadError } from "../domain/Errors.js"

export interface LoadedProject {
  readonly program: ts.Program
  readonly checker: ts.TypeChecker
  /** Absolute directory containing the tsconfig. */
  readonly configDir: string
}

/**
 * ONE `ts.Program` shared by the idiom, boundaries, typecheck, and eval-shape
 * gates — parse once, and rank 0 + rank 1 become nearly free relative to a
 * per-gate `tsc` subprocess.
 */
export class TsProject extends Context.Tag("@xandreed/foundry/TsProject")<
  TsProject,
  {
    readonly load: (tsconfigAbsPath: string) => Effect.Effect<LoadedProject, ProjectLoadError>
  }
>() {}

const buildProject = (tsconfigAbsPath: string): Effect.Effect<LoadedProject, ProjectLoadError> =>
  Effect.suspend(() => {
    const configDir = path.dirname(tsconfigAbsPath)
    const read = ts.readConfigFile(tsconfigAbsPath, ts.sys.readFile)
    if (read.error !== undefined) {
      return Effect.fail(
        new ProjectLoadError({
          tsconfig: tsconfigAbsPath,
          message: ts.flattenDiagnosticMessageText(read.error.messageText, " "),
        }),
      )
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, configDir)
    const fatal = parsed.errors.filter((d) => d.category === ts.DiagnosticCategory.Error)
    if (fatal.length > 0) {
      return Effect.fail(
        new ProjectLoadError({
          tsconfig: tsconfigAbsPath,
          message: fatal
            .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))
            .join("; "),
        }),
      )
    }
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
    return Effect.succeed({ program, checker: program.getTypeChecker(), configDir })
  })

/**
 * Memoizes per tsconfig path — for ONE-SHOT runs (`foundry check`), where the
 * workspace cannot change under the gates. `SynchronizedRef` serializes the
 * build so concurrent gates share a single program.
 */
export const TsProjectCachedLive: Layer.Layer<TsProject> = Layer.effect(
  TsProject,
  Effect.gen(function* () {
    const cache = yield* SynchronizedRef.make(
      new Map<string, LoadedProject>() as ReadonlyMap<string, LoadedProject>,
    )
    return {
      load: (tsconfigAbsPath: string) =>
        SynchronizedRef.modifyEffect(cache, (map) => {
          const hit = map.get(tsconfigAbsPath)
          return hit !== undefined
            ? Effect.succeed([hit, map] as const)
            : buildProject(tsconfigAbsPath).pipe(
                Effect.map(
                  (project) =>
                    [project, new Map(map).set(tsconfigAbsPath, project)] as const,
                ),
              )
        }),
    }
  }),
)

/**
 * Rebuilds on every load — for the FORGE loop, where the implementor rewrites
 * the workspace between attempts and a memoized program would judge attempt
 * N against attempt N-1's source (a stale-cache bug by construction).
 */
export const TsProjectFreshLive: Layer.Layer<TsProject> = Layer.succeed(TsProject, {
  load: buildProject,
})
