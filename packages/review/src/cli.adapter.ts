import { join } from "node:path"
import { Console, Effect, Layer, Option, Schema } from "effect"
import { gitCheckout } from "./checkout-git.adapter.js"
import { USAGE, UsageError } from "./cli.entity.js"
import { ghForge } from "./forge-gh.adapter.js"
import { hostShell } from "./host-shell.adapter.js"
import { DIGEST_LIMITS } from "./log-digest.entity.js"
import { DEFAULT_BUDGET_TOKENS, PreparedReview } from "./prepare-review.entity.js"
import type { PrepareOptions } from "./prepare-review.entity.js"
import { summaryText } from "./prepare-review.entity.functions.js"
import { prepareReview } from "./prepare-review.usecase.js"
import { PullNumber, RepoName } from "./pull-request.entity.js"
import { directoryLogs } from "./review-logs.adapter.js"
import { processValidations } from "./validations.adapter.js"

/** What the command line reads of its process: the environment, the folder it runs in and the person's home. */
export interface CliHost {
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly home: string
}

/** The flags that take a value; `--run` and `--workflow` may be given more than once, the others once. */
const VALUED = ["--repo", "--run", "--budget", "--workflow", "--cache", "--timeout-ms"]
const REPEATED = ["--run", "--workflow"]
const SWITCHES = ["--json"]

/** A parsed command line: the positional words, each valued flag's values in order, and the switches given. */
interface Line {
  readonly words: ReadonlyArray<string>
  readonly values: ReadonlyMap<string, ReadonlyArray<string>>
  readonly switches: ReadonlySet<string>
}

const usage = (message: string) => new UsageError({ message: `${message}\n${USAGE}` })

/** Read the arguments: `--flag value` or `--flag=value`; a value is taken whole (a command is never split at commas). */
export const cliLine = (raw: ReadonlyArray<string>): Effect.Effect<Line, UsageError> => Effect.suspend(() => {
  const words: Array<string> = []
  const values = new Map<string, Array<string>>()
  const switches = new Set<string>()
  for (let at = 0; at < raw.length; at++) {
    const arg = raw[at] ?? ""
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1
    const flag = equals > 2 ? arg.slice(0, equals) : arg
    if (SWITCHES.includes(flag) && equals < 0) switches.add(flag)
    else if (VALUED.includes(flag)) {
      const value = equals > 2 ? Option.some(arg.slice(equals + 1)) : Option.fromNullishOr(raw[at + 1])
      if (Option.isNone(value) || value.value.length === 0) return Effect.fail(usage(`${flag} needs a value`))
      if (equals <= 2) at += 1
      if (!REPEATED.includes(flag) && values.has(flag)) return Effect.fail(usage(`${flag} is given more than once`))
      values.set(flag, [...(values.get(flag) ?? []), value.value])
    } else if (arg.startsWith("--")) return Effect.fail(usage(`${arg} is not a flag of efferent-review`))
    else words.push(arg)
  }
  return Effect.succeed({ words, values, switches })
})

const one = (line: Line, flag: string): Option.Option<string> => Option.fromNullishOr(line.values.get(flag)?.[0])

const decodedAs = <A>(schema: Schema.Codec<A, unknown>, value: unknown, what: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => usage(`${what} is not valid`)))

const wholeNumber = (text: string, what: string) => {
  const number = Number(text)
  return Number.isInteger(number) && number >= 1 ? Effect.succeed(number) : Effect.fail(usage(`${what} must be a whole number of at least 1, not ${JSON.stringify(text)}`))
}

/**
 * The command line: `prepare <number> --repo <owner/name>` reads the pull request, prepares it (`prepareReview`)
 * and prints a short summary, or the whole prepared review as JSON with `--json`. Clones and logs go under `--cache`
 * (`~/.efferent-review` by default; never inside a repository). `gh` and `git` run with the host's environment; the
 * `--run` commands with only `PATH` and a throwaway `HOME`. Answers the exit code: 0 once printed.
 */
export const reviewCli = Effect.fn("review.cli")(function* (raw: ReadonlyArray<string>, host: CliHost) {
  const line = yield* cliLine(raw)
  const [command, numberText] = line.words
  if (command !== "prepare" || line.words.length !== 2 || numberText === undefined) return yield* Effect.fail(usage("efferent-review takes the command prepare and a pull request's number"))
  const repo = yield* decodedAs(RepoName, Option.getOrElse(one(line, "--repo"), () => ""), "--repo (owner/name)")
  const number = yield* decodedAs(PullNumber, Number(numberText), "the pull request's number")
  const options: PrepareOptions = {
    budgetTokens: yield* Option.match(one(line, "--budget"), { onNone: () => Effect.succeed(DEFAULT_BUDGET_TOKENS), onSome: (text) => wholeNumber(text, "--budget") }),
    run: line.values.get("--run") ?? [],
    workflows: line.values.get("--workflow") ?? [],
    limits: DIGEST_LIMITS,
    timeoutMs: yield* Option.match(one(line, "--timeout-ms"), { onNone: () => Effect.succeed(600_000), onSome: (text) => wholeNumber(text, "--timeout-ms") }),
  }
  const cacheRoot = Option.getOrElse(one(line, "--cache"), () => join(host.home, ".efferent-review"))
  const shell = hostShell({ cwd: host.cwd, env: { ...host.env, GIT_TERMINAL_PROMPT: "0" } })
  const logs = directoryLogs(join(cacheRoot, ...repo.split("/"), "reviews"))
  const layers = Layer.mergeAll(ghForge, gitCheckout({ cacheRoot }), logs, processValidations({ path: host.env["PATH"] ?? "/usr/bin:/bin" }).pipe(Layer.provide(logs))).pipe(Layer.provide(shell))
  const prepared = yield* prepareReview(repo, number, options).pipe(Effect.provide(layers))
  if (line.switches.has("--json")) {
    const encoded = yield* Schema.encodeEffect(PreparedReview)(prepared).pipe(Effect.orDie)
    yield* Console.log(JSON.stringify(encoded, null, 2))
  } else yield* Console.log(summaryText(prepared))
  return 0
})
