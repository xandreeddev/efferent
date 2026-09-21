import { homedir } from "node:os"
import { Command } from "@effect/cli"
import { LanguageModel } from "@effect/ai"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { Harness } from "@xandreed/sdk"
import { loadConfig, loadPlugins } from "@xandreed/runtime"
import { XPlatform } from "./ports/x-platform.port.js"
import { BlogReader } from "./ports/blog-reader.port.js"
import { SocialWorkspace } from "./ports/social-workspace.port.js"
import { SocialDraftRunner } from "./ports/draft-runner.port.js"
import { socialAgent } from "./agent.js"
import { startDaemon } from "./usecases/scheduler.js"
import { runReviewQueue } from "./usecases/reviewQueue.js"
import { findOpportunitiesAndDraft } from "./usecases/opportunityFinder.js"

type Services = LanguageModel.LanguageModel | XPlatform | BlogReader | SocialWorkspace
const withSdk = <A, E>(program: Effect.Effect<A, E, Services>) => Effect.scoped(Effect.gen(function* () {
  const workspace = process.cwd()
  const preset = socialAgent(workspace)
  const loaded = yield* loadConfig({ workspace, home: homedir(), preset: preset.config })
  const plugins = yield* loadPlugins(loaded.config, [...preset.plugins, ...loaded.plugins], workspace, homedir())
  const harness = yield* Harness.make({ workspace, config: loaded.config, plugins })
  const host = yield* harness.create()
  const platform = yield* host.use(XPlatform, Effect.succeed)
  const blog = yield* host.use(BlogReader, Effect.succeed)
  const files = yield* host.use(SocialWorkspace, Effect.succeed)
  const model = yield* host.use(LanguageModel.LanguageModel, Effect.succeed)
  return yield* program.pipe(
    Effect.provideService(XPlatform, platform), Effect.provideService(BlogReader, blog),
    Effect.provideService(SocialWorkspace, files), Effect.provideService(LanguageModel.LanguageModel, model),
    Effect.provideService(SocialDraftRunner, { run: (prompt) => Effect.gen(function* () {
      const session = yield* harness.create()
      return yield* session.send(prompt).pipe(Effect.zipRight(session.history), Effect.map((events) => ({ finalText: String(events.filter((event) => event.name === "run.completed").at(-1)?.data.text ?? "") })), Effect.ensuring(session.close))
    }) }),
  )
}))

const daemonCmd = Command.make("daemon", {}, () => withSdk(startDaemon()))
const reviewCmd = Command.make("review", {}, () => withSdk(runReviewQueue()))
const testCmd = Command.make("test", {}, () => withSdk(findOpportunitiesAndDraft(["EffectTS"])))
const root = Command.make("social", {}).pipe(Command.withSubcommands([daemonCmd, reviewCmd, testCmd]))
const cli = Command.run(root, { name: "efferent-social", version: "0.2.0-next.0" })
BunRuntime.runMain(cli(process.argv).pipe(Effect.provide(BunContext.layer)))
