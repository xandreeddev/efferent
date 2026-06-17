import { Command } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { FetchHttpClient } from "@effect/platform"
import { Effect, Layer } from "effect"
import {
  LocalAuthStoreLive,
  LocalFileSystemLive,
  LocalSettingsStoreLive,
  HttpLive,
  ModelLive,
  ModelRegistryLive,
} from "@efferent/sdk-adapters"

import { PlaywrightXPlatformLive } from "./adapters/PlaywrightXPlatform.js"
import { AstroBlogReaderLive } from "./adapters/AstroBlogReader.js"
import { startDaemon } from "./usecases/scheduler.js"
import { runReviewQueue } from "./usecases/reviewQueue.js"
import { findOpportunitiesAndDraft } from "./usecases/opportunityFinder.js"

/* ------------------------------------------------------------------ */
/* Composition root                                                    */
/* ------------------------------------------------------------------ */

const CredentialsLive = Layer.mergeAll(
  LocalAuthStoreLive,
  LocalSettingsStoreLive.pipe(Layer.provide(LocalFileSystemLive)),
)

const SocialAppLive = Layer.mergeAll(
  ModelLive,
  LocalFileSystemLive,
  HttpLive,
  PlaywrightXPlatformLive,
  AstroBlogReaderLive,
).pipe(
  Layer.provideMerge(CredentialsLive)
)

/* ------------------------------------------------------------------ */
/* CLI Commands                                                       */
/* ------------------------------------------------------------------ */

const daemonCmd = Command.make("daemon", {}, () =>
  startDaemon().pipe(Effect.provide(SocialAppLive))
)

const reviewCmd = Command.make("review", {}, () =>
  runReviewQueue().pipe(Effect.provide(SocialAppLive))
)

const testCmd = Command.make("test", {}, () =>
  Effect.gen(function* () {
    yield* Effect.logInfo("Testing Playwright X platform connection...")
    yield* findOpportunitiesAndDraft(["EffectTS"])
  }).pipe(Effect.provide(SocialAppLive))
)

const root = Command.make("social", {}).pipe(
  Command.withSubcommands([daemonCmd, reviewCmd, testCmd])
)

const cli = Command.run(root, {
  name: "efferent-social",
  version: "0.1.0",
})

const program = cli(process.argv).pipe(
  Effect.provide(BunContext.layer)
) as Effect.Effect<void, any, never>

BunRuntime.runMain(program)
