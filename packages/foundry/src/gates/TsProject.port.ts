import { Context, Effect, Layer, Option, SynchronizedRef } from "effect"
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
export class TsProject extends Context.Service<TsProject, {
    readonly load: (tsconfigAbsPath: string) => Effect.Effect<LoadedProject, ProjectLoadError>
  }>()("@xandreed/foundry/TsProject") {}

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

interface Built {
  readonly project: LoadedProject
  /** Every SourceFile the last program used, by path — handed back to
   *  TypeScript as the same OBJECT when its text has not changed. */
  readonly files: ReadonlyMap<string, ts.SourceFile>
}

/** A compiler host that returns the SAME SourceFile object for a file whose
 *  text did not change since the previous build — what TypeScript needs to
 *  reuse the old program's structure instead of re-parsing everything. Every
 *  file's text is still re-read on every build: never stale by construction. */
const incrementalHost = (
  options: ts.CompilerOptions,
  previous: ReadonlyMap<string, ts.SourceFile>,
  next: Map<string, ts.SourceFile>,
): ts.CompilerHost => {
  const base = ts.createCompilerHost(options, true)
  return {
    ...base,
    getSourceFile: (fileName, languageVersionOrOptions, onError) => {
      const text = base.readFile(fileName)
      if (text === undefined) {
        onError?.(`could not read ${fileName}`)
        return undefined
      }
      const cached = previous.get(fileName)
      const file =
        cached !== undefined && cached.text === text
          ? cached
          : ts.createSourceFile(fileName, text, languageVersionOrOptions, true)
      next.set(fileName, file)
      return file
    },
  }
}

const buildIncremental = (
  tsconfigAbsPath: string,
  previous: Option.Option<Built>,
): Effect.Effect<Built, ProjectLoadError> =>
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
    const files = new Map<string, ts.SourceFile>()
    const host = incrementalHost(
      parsed.options,
      Option.match(previous, { onNone: () => new Map<string, ts.SourceFile>(), onSome: (b) => b.files }),
      files,
    )
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
      host,
      ...Option.match(previous, {
        onNone: () => ({}),
        onSome: (b) => ({ oldProgram: b.project.program }),
      }),
    })
    return Effect.succeed({
      project: { program, checker: program.getTypeChecker(), configDir },
      files,
    })
  })

/**
 * Rebuilds on every load — for the FORGE loop, where the implementor rewrites
 * the workspace between attempts and a memoized program would judge attempt
 * N against attempt N-1's source (a stale-cache bug by construction). But it
 * REUSES what did not change: the previous program and its SourceFiles are
 * handed to TypeScript, so the gates that follow within one attempt re-parse
 * nothing and the next attempt re-parses only the files the coder touched.
 * (Three full `createProgram`s per attempt before — one per gate.)
 */
export const TsProjectFreshLive: Layer.Layer<TsProject> = Layer.effect(
  TsProject,
  Effect.gen(function* () {
    const last = yield* SynchronizedRef.make(Option.none<Built>())
    return {
      load: (tsconfigAbsPath: string) =>
        SynchronizedRef.modifyEffect(last, (previous) =>
          buildIncremental(
            tsconfigAbsPath,
            // A different tsconfig is a different project — never reuse across.
            Option.filter(previous, (b) => b.project.configDir === path.dirname(tsconfigAbsPath)),
          ).pipe(Effect.map((built) => [built.project, Option.some(built)] as const)),
        ),
    }
  }),
)
