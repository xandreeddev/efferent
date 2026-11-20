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
import { DEFAULT_BUDGET, DEFAULT_MAX_COST, DEFAULT_REVIEW_MODEL } from "./review-model.entity.js"
import type { Finder } from "./review-prompt.entity.js"
import { DEFAULT_CLOSING_RESERVE, DEFAULT_PASSES, DEFAULT_VERIFY_CONCURRENCY, DEFAULT_VERIFY_STEPS } from "./review.entity.js"
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
export const reviewLayers = (repo: RepoName, roots: { readonly cache: string; readonly records: string }, host: CliHost) => {
  const shell = hostShell({ cwd: host.cwd, env: { ...host.env, GIT_TERMINAL_PROMPT: "0" } })
  return Layer.mergeAll(ghForge, gitCheckout({ cacheRoot: roots.cache }), directoryLogs(join(roots.records, ...repo.split("/")))).pipe(Layer.provide(shell))
}

/**
 * What the command line adds when commands are asked for (`--run`, `--validate`): `Validations` in bubblewrap
 * sandboxes, the toolchain found on the host's `PATH`, what is kept between reviews under the cache root. A host that
 * cannot make a sandbox fails here with `SandboxUnavailable`: nothing runs outside one. Never a `Shell`.
 */
export const validationLayers = (repo: RepoName, roots: { readonly cache: string; readonly records: string }, host: CliHost) =>
  Layer.provideMerge(
    sandboxValidations.pipe(Layer.provide(Layer.mergeAll(bwrapSandboxes({ path: host.env["PATH"] ?? "/usr/bin:/bin" }), directoryCache(roots.cache)))),
    reviewLayers(repo, roots, host),
  )

/** The flags that take a value; `--workflow` may be given more than once, the others once. */
const VALUED = ["--repo", "--budget", "--workflow", "--cache", "--records", "--at", "--max-cost", "--find-cost", "--verify-cost", "--max-steps", "--verify-steps", "--passes", "--finder", "--model", "--price", "--run"]
const REPEATED = ["--workflow", "--run"]
const SWITCHES = ["--json", "--validate", "--vote", "--no-verify"]

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

/** `--max-cost`, `--find-cost`, `--verify-cost`: a positive number of USD. */
const costOf = (flag: string) => (text: string) => {
  const cost = Number(text)
  return Number.isFinite(cost) && cost > 0 ? Effect.succeed(cost) : Effect.fail(usage(`${flag} must be a positive number of USD, not ${JSON.stringify(text)}`))
}

const wholeNumber = (text: string, what: string) => {
  const number = Number(text)
  return Number.isInteger(number) && number >= 1 ? Effect.succeed(number) : Effect.fail(usage(`${what} must be a whole number of at least 1, not ${JSON.stringify(text)}`))
}

/** The flags only `review` reads. */
const REVIEW_ONLY = ["--max-cost", "--find-cost", "--verify-cost", "--max-steps", "--verify-steps", "--passes", "--finder", "--model", "--price"]

/** The switches only `review` reads. */
const REVIEW_SWITCHES = ["--vote", "--no-verify"]

/** `--finder`: `strict` or `candidates`. */
const finderOf = (text: string): Effect.Effect<Finder, UsageError> =>
  text === "strict" || text === "candidates" ? Effect.succeed(text) : Effect.fail(usage(`--finder must be strict or candidates, not ${JSON.stringify(text)}`))

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
 * prepares it and reviews it (`reviewPullRequest`): `--passes` passes (`DEFAULT_PASSES`) finding as `--finder` says
 * (`candidates` by default, or `strict`), each capped at `--max-steps` (`DEFAULT_MAX_STEPS`); the findings merged, the
 * vote filtering them only with `--vote`; each kept bucket checked unless `--no-verify`, each check capped at
 * `--verify-steps` (`DEFAULT_VERIFY_STEPS`). The model is `DEFAULT_REVIEW_MODEL`, its key read from the environment
 * variable it names (another id of its endpoint with `--model` and its `--price`), every call charged to one ledger
 * capped at `--max-cost` (`DEFAULT_MAX_COST`), the passes within `--find-cost` and the checks within `--verify-cost`
 * (`DEFAULT_BUDGET`'s, at most the total); it prints the report, or the report as JSON with `--json`. `--at` reviews
 * the head (the default), the first head (`first`) or a commit by its sha. Clones and worktrees go under `--cache`
 * (`~/.efferent-review` by default; never inside a repository); logs and each review's records under `--records`
 * (`~/.efferent-review/records` by default), kept: nothing cleans them. `gh` and `git` run with the host's environment.
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
  const cache = Option.getOrElse(one(line, "--cache"), () => join(host.home, ".efferent-review"))
  const roots = { cache, records: Option.getOrElse(one(line, "--records"), () => join(host.home, ".efferent-review", "records")) }
  const json = line.switches.has("--json")
  const asked = options.run.length > 0 || options.validate
  if (command === "prepare") {
    const ofReview = [...REVIEW_ONLY.filter((flag) => Option.isSome(one(line, flag))), ...REVIEW_SWITCHES.filter((flag) => line.switches.has(flag))][0]
    if (ofReview !== undefined) return yield* Effect.fail(usage(`${ofReview} is a flag of review, not of prepare`))
    const prepared = asked
      ? yield* prepareReview(repo, number, options).pipe(Effect.provide(validationLayers(repo, roots, host)))
      : yield* prepareReview(repo, number, options).pipe(Effect.provide(reviewLayers(repo, roots, host)))
    yield* Console.log(json ? JSON.stringify(yield* Schema.encodeEffect(PreparedReview)(prepared).pipe(Effect.orDie), null, 2) : summaryText(prepared))
    return 0
  }
  const maxCost = yield* Option.match(one(line, "--max-cost"), { onNone: () => Effect.succeed(DEFAULT_MAX_COST), onSome: costOf("--max-cost") })
  const findCost = yield* Option.match(one(line, "--find-cost"), { onNone: () => Effect.succeed(Math.min(DEFAULT_BUDGET.find, maxCost)), onSome: costOf("--find-cost") })
  const verifyCost = yield* Option.match(one(line, "--verify-cost"), { onNone: () => Effect.succeed(Math.min(DEFAULT_BUDGET.verify, maxCost)), onSome: costOf("--verify-cost") })
  const maxSteps = yield* Option.match(one(line, "--max-steps"), { onNone: () => Effect.succeed(DEFAULT_MAX_STEPS), onSome: (text) => wholeNumber(text, "--max-steps") })
  const verifySteps = yield* Option.match(one(line, "--verify-steps"), { onNone: () => Effect.succeed(DEFAULT_VERIFY_STEPS), onSome: (text) => wholeNumber(text, "--verify-steps") })
  const passes = yield* Option.match(one(line, "--passes"), { onNone: () => Effect.succeed(DEFAULT_PASSES), onSome: (text) => wholeNumber(text, "--passes") })
  const finder = yield* Option.match(one(line, "--finder"), { onNone: () => Effect.succeed<Finder>("candidates"), onSome: finderOf })
  const model = yield* modelOf(one(line, "--model"), one(line, "--price"))
  const apiKey = yield* Config.Redacted(model.keyVariable).parse(ConfigProvider.fromEnv({ env: host.env })).pipe(
    Effect.mapError(() => usage(`review needs the model's key in the environment variable ${model.keyVariable}`)),
  )
  const base = asked ? validationLayers(repo, roots, host) : reviewLayers(repo, roots, host)
  const needs = Layer.mergeAll(base, findingsInMemory, modelSpendMemory)
  const layers = kernelPasses({ model: reviewModel(model, apiKey, maxCost) }).pipe(Layer.provideMerge(needs))
  const report = yield* reviewPullRequest(repo, number, {
    prepare: options,
    passes,
    pass: { maxSteps, reserve: DEFAULT_CLOSING_RESERVE },
    finder,
    vote: line.switches.has("--vote"),
    verify: !line.switches.has("--no-verify"),
    verifyConcurrency: DEFAULT_VERIFY_CONCURRENCY,
    verifySteps,
    budget: { total: maxCost, find: findCost, verify: verifyCost },
    model: model.model,
  }).pipe(Effect.provide(layers))
  yield* Console.log(json ? JSON.stringify(yield* Schema.encodeEffect(ReviewReport)(report).pipe(Effect.orDie), null, 2) : reportText(report))
  return 0
})
