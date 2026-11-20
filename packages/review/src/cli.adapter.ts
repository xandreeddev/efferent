import { join } from "node:path"
import { Config, ConfigProvider, Console, Effect, Layer, Option, Schema } from "effect"
import { modelSpendMemory } from "@xandreed/core"
import { bwrapSandboxes } from "./bwrap-shell.adapter.js"
import { gitCheckout } from "./checkout-git.adapter.js"
import { USAGE, UsageError } from "./cli.entity.js"
import { ghForge } from "./forge-gh.adapter.js"
import { hostShell } from "./host-shell.adapter.js"
import { DIGEST_LIMITS } from "./log-digest.entity.js"
import { findingsInMemory } from "./findings.adapter.js"
import { DEFAULT_BUDGET_TOKENS, PreparedReview } from "./prepare-review.entity.js"
import type { PrepareOptions, ReviewAt } from "./prepare-review.entity.js"
import { summaryText } from "./prepare-review.entity.functions.js"
import { prepareReview } from "./prepare-review.usecase.js"
import { CommitSha, PullNumber, RepoName } from "./pull-request.entity.js"
import { directoryCache } from "./review-cache.adapter.js"
import { directoryLogs } from "./review-logs.adapter.js"
import { DEFAULT_MAX_COST, DEFAULT_REVIEW_MODEL } from "./review-model.entity.js"
import type { ReviewModel } from "./review-model.entity.js"
import { reviewModel } from "./review-model.adapter.js"
import { kernelPasses } from "./review-pass.adapter.js"
import { DEFAULT_MAX_STEPS } from "./review-pass.entity.js"
import { ReviewReport } from "./review-report.entity.js"
import { reportText } from "./review-report.entity.functions.js"
import { reviewPullRequest } from "./review.usecase.js"
import { sandboxValidations } from "./validations.adapter.js"
import { VALIDATION_TIMES } from "./validations.entity.js"

/** What the command line reads of its process: the environment, the folder it runs in and the person's home. */
export interface CliHost {
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly home: string
}

/**
 * What the command line gives `prepareReview`: the forge through `gh`, the clone through `git`, both on the host's
 * shell, and the logs under the cache root. No `Validations` and no `Shell`: nothing of the pull request's runs.
 */
export const reviewLayers = (repo: RepoName, cacheRoot: string, host: CliHost) => {
  const shell = hostShell({ cwd: host.cwd, env: { ...host.env, GIT_TERMINAL_PROMPT: "0" } })
  return Layer.mergeAll(ghForge, gitCheckout({ cacheRoot }), directoryLogs(join(cacheRoot, ...repo.split("/"), "reviews"))).pipe(Layer.provide(shell))
}

/**
 * What the command line adds when commands are asked for (`--run`, `--validate`): `Validations` in bubblewrap
 * sandboxes, the toolchain found on the host's `PATH`, what is kept between reviews under the cache root. A host that
 * cannot make a sandbox fails here with `SandboxUnavailable`: nothing runs outside one. Never a `Shell`.
 */
export const validationLayers = (repo: RepoName, cacheRoot: string, host: CliHost) =>
  Layer.provideMerge(
    sandboxValidations.pipe(Layer.provide(Layer.mergeAll(bwrapSandboxes({ path: host.env["PATH"] ?? "/usr/bin:/bin" }), directoryCache(cacheRoot)))),
    reviewLayers(repo, cacheRoot, host),
  )

/** The flags that take a value; `--workflow` may be given more than once, the others once. */
const VALUED = ["--repo", "--budget", "--workflow", "--cache", "--at", "--max-cost", "--max-steps", "--model", "--price", "--run"]
const REPEATED = ["--workflow", "--run"]
const SWITCHES = ["--json", "--validate"]

/** A parsed command line: the positional words, each valued flag's values in order, and the switches given. */
interface Line {
  readonly words: ReadonlyArray<string>
  readonly values: ReadonlyMap<string, ReadonlyArray<string>>
  readonly switches: ReadonlySet<string>
}

const usage = (message: string) => new UsageError({ message: `${message}\n${USAGE}` })

/** Read the arguments: `--flag value` or `--flag=value`; a value is taken whole (never split at commas). */
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

/** `--at`: `head`, `first`, or a commit's full sha. */
const atOf = (text: string): Effect.Effect<ReviewAt, UsageError> =>
  text === "head" ? Effect.succeed({ _tag: "Head" })
    : text === "first" ? Effect.succeed({ _tag: "First" })
      : Effect.map(decodedAs(CommitSha, text, "--at (head, first or a commit's full sha)"), (sha): ReviewAt => ({ _tag: "Sha", sha }))

/** `--max-cost`: a positive number of USD. */
const costOf = (text: string) => {
  const cost = Number(text)
  return Number.isFinite(cost) && cost > 0 ? Effect.succeed(cost) : Effect.fail(usage(`--max-cost must be a positive number of USD, not ${JSON.stringify(text)}`))
}

const wholeNumber = (text: string, what: string) => {
  const number = Number(text)
  return Number.isInteger(number) && number >= 1 ? Effect.succeed(number) : Effect.fail(usage(`${what} must be a whole number of at least 1, not ${JSON.stringify(text)}`))
}

/** The flags only `review` reads. */
const REVIEW_ONLY = ["--max-cost", "--max-steps", "--model", "--price"]

/**
 * The model a review asks: `DEFAULT_REVIEW_MODEL`, or another id of the same endpoint (`--model`), which needs its
 * price (`--price <input>,<cached input>,<output>`, USD per million tokens), since the ledger holds and settles by it.
 */
const modelOf = (id: Option.Option<string>, price: Option.Option<string>): Effect.Effect<ReviewModel, UsageError> => {
  const parsed = Option.map(price, (text) => text.split(",").map(Number))
  const prices = Option.filter(parsed, (numbers) => numbers.length === 3 && numbers.every((number) => Number.isFinite(number) && number >= 0))
  if (Option.isSome(price) && Option.isNone(prices)) return Effect.fail(usage(`--price must be three numbers of USD per million tokens, input,cached,output, not ${JSON.stringify(price.value)}`))
  const named = Option.getOrElse(id, () => DEFAULT_REVIEW_MODEL.model)
  if (named !== DEFAULT_REVIEW_MODEL.model && Option.isNone(prices)) return Effect.fail(usage(`--model ${named} needs its --price (input,cached,output, USD per million tokens)`))
  return Effect.succeed({
    ...DEFAULT_REVIEW_MODEL,
    model: named,
    price: Option.match(prices, { onNone: () => DEFAULT_REVIEW_MODEL.price, onSome: ([input = 0, cacheRead = 0, output = 0]) => ({ input, cacheRead, output }) }),
  })
}

/** The commands of the command line. */
const COMMANDS = ["prepare", "review"]

/**
 * The command line. `prepare <number> --repo <owner/name>` reads the pull request, prepares it (`prepareReview`) and
 * prints a short summary, or the whole prepared review as JSON with `--json`. `review <number> --repo <owner/name>`
 * prepares it and runs one pass of the model over it (`reviewPullRequest`): the model is `DEFAULT_REVIEW_MODEL`, its
 * key read from the environment variable it names (another id of its endpoint with `--model` and its `--price`), every
 * call charged to one ledger capped at `--max-cost` (`DEFAULT_MAX_COST`), the pass capped at `--max-steps`
 * (`DEFAULT_MAX_STEPS`); it prints the report, or the report as JSON with `--json`. `--at` reviews the head (the
 * default), the first head (`first`) or a commit by its sha. Clones, logs and records go under `--cache`
 * (`~/.efferent-review` by default; never inside a repository). `gh` and `git` run with the host's environment.
 * `--run <command>` (again for more) and `--validate` (the repository's profile), for either command, run the pull
 * request's commands in bubblewrap sandboxes (`validationLayers`), only for a head in the repository whose author may
 * write to it; without either nothing of the pull request's runs. Answers the exit code: 0 once printed.
 */
export const reviewCli = Effect.fn("review.cli")(function* (raw: ReadonlyArray<string>, host: CliHost) {
  const line = yield* cliLine(raw)
  const [command, numberText] = line.words
  if (command === undefined || !COMMANDS.includes(command) || line.words.length !== 2 || numberText === undefined) return yield* Effect.fail(usage("efferent-review takes the command prepare or review and a pull request's number"))
  const repo = yield* decodedAs(RepoName, Option.getOrElse(one(line, "--repo"), () => ""), "--repo (owner/name)")
  const number = yield* decodedAs(PullNumber, Number(numberText), "the pull request's number")
  const options: PrepareOptions = {
    at: yield* Option.match(one(line, "--at"), { onNone: () => Effect.succeed<ReviewAt>({ _tag: "Head" }), onSome: atOf }),
    budgetTokens: yield* Option.match(one(line, "--budget"), { onNone: () => Effect.succeed(DEFAULT_BUDGET_TOKENS), onSome: (text) => wholeNumber(text, "--budget") }),
    run: line.values.get("--run") ?? [],
    validate: line.switches.has("--validate"),
    workflows: line.values.get("--workflow") ?? [],
    limits: DIGEST_LIMITS,
    timeoutMs: VALIDATION_TIMES.commandTimeoutMs,
    budgetMs: VALIDATION_TIMES.budgetMs,
  }
  const cacheRoot = Option.getOrElse(one(line, "--cache"), () => join(host.home, ".efferent-review"))
  const json = line.switches.has("--json")
  const asked = options.run.length > 0 || options.validate
  if (command === "prepare") {
    const ofReview = REVIEW_ONLY.find((flag) => Option.isSome(one(line, flag)))
    if (ofReview !== undefined) return yield* Effect.fail(usage(`${ofReview} is a flag of review, not of prepare`))
    const prepared = asked
      ? yield* prepareReview(repo, number, options).pipe(Effect.provide(validationLayers(repo, cacheRoot, host)))
      : yield* prepareReview(repo, number, options).pipe(Effect.provide(reviewLayers(repo, cacheRoot, host)))
    yield* Console.log(json ? JSON.stringify(yield* Schema.encodeEffect(PreparedReview)(prepared).pipe(Effect.orDie), null, 2) : summaryText(prepared))
    return 0
  }
  const maxCost = yield* Option.match(one(line, "--max-cost"), { onNone: () => Effect.succeed(DEFAULT_MAX_COST), onSome: costOf })
  const maxSteps = yield* Option.match(one(line, "--max-steps"), { onNone: () => Effect.succeed(DEFAULT_MAX_STEPS), onSome: (text) => wholeNumber(text, "--max-steps") })
  const model = yield* modelOf(one(line, "--model"), one(line, "--price"))
  const apiKey = yield* Config.Redacted(model.keyVariable).parse(ConfigProvider.fromEnv({ env: host.env })).pipe(
    Effect.mapError(() => usage(`review needs the model's key in the environment variable ${model.keyVariable}`)),
  )
  const base = asked ? validationLayers(repo, cacheRoot, host) : reviewLayers(repo, cacheRoot, host)
  const needs = Layer.mergeAll(base, findingsInMemory, modelSpendMemory)
  const layers = kernelPasses().pipe(Layer.provideMerge(reviewModel(model, apiKey, maxCost).pipe(Layer.provideMerge(needs))))
  const report = yield* reviewPullRequest(repo, number, { prepare: options, pass: { maxSteps }, model: model.model }).pipe(Effect.provide(layers))
  yield* Console.log(json ? JSON.stringify(yield* Schema.encodeEffect(ReviewReport)(report).pipe(Effect.orDie), null, 2) : reportText(report))
  return 0
})
