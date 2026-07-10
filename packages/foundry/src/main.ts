import { Effect, Match, Option } from "effect"
import { runCheck } from "./cli/check.js"
import { runDemo } from "./cli/demo.js"
import type { DemoImplementor } from "./cli/demo.js"
import { TsProjectCachedLive } from "./gates/TsProject.js"

/**
 * The foundry CLI driver — argv at the edge, Layers composed here, nothing
 * effectful above this file.
 *
 *   foundry check [--config <f>] [--baseline <f>] [--update-baseline [--allow-grow]]
 *   foundry demo  [--implementor scripted|claude]
 */

const flagValue = (argv: ReadonlyArray<string>, flag: string): Option.Option<string> => {
  const index = argv.indexOf(flag)
  return index >= 0 ? Option.fromNullable(argv[index + 1]) : Option.none()
}

const USAGE = [
  "usage:",
  "  foundry check [--config <foundry.config.ts>] [--baseline <f.json>] [--update-baseline [--allow-grow]]",
  "  foundry demo  [--implementor scripted|claude]",
].join("\n")

const program = Effect.gen(function* () {
  const argv = process.argv.slice(2)
  const command = argv[0] ?? "help"
  return yield* Match.value(command).pipe(
    Match.when("check", () =>
      runCheck({
        configPath: Option.getOrElse(
          flagValue(argv, "--config"),
          () => "packages/foundry/foundry.config.ts",
        ),
        baselinePath: flagValue(argv, "--baseline"),
        updateBaseline: argv.includes("--update-baseline"),
        allowGrow: argv.includes("--allow-grow"),
      }).pipe(Effect.provide(TsProjectCachedLive)),
    ),
    Match.when("demo", () => {
      const implementor: DemoImplementor = Option.match(
        flagValue(argv, "--implementor"),
        {
          onNone: () => "scripted" as const,
          onSome: (value) => (value === "claude" ? ("claude" as const) : ("scripted" as const)),
        },
      )
      return runDemo(implementor)
    }),
    Match.orElse(() => Effect.sync(() => console.log(USAGE)).pipe(Effect.as(2))),
  )
})

const main = program.pipe(
  Effect.tap((code) => Effect.sync(() => (process.exitCode = code))),
  Effect.tapError((error) =>
    Effect.sync(() => {
      console.error(`foundry: ${error._tag}: ${error.message}`)
      process.exitCode = 2
    }),
  ),
  Effect.ignore,
)

await Effect.runPromise(main)
