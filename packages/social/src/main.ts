import { homedir } from "node:os"
import { Command } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { SettingsStore } from "@xandreed/engine"
import {
  LanguageModelLive,
  LocalAuthStoreLive,
  LocalSettingsStoreLive,
} from "@xandreed/providers"

import { PlaywrightXPlatformLive } from "./adapters/PlaywrightXPlatform.js"
import { AstroBlogReaderLive } from "./adapters/AstroBlogReader.js"
import { startDaemon } from "./usecases/scheduler.js"
import { runReviewQueue } from "./usecases/reviewQueue.js"
import { findOpportunitiesAndDraft } from "./usecases/opportunityFinder.js"

/* ------------------------------------------------------------------ */
/* Composition root                                                    */
/* ------------------------------------------------------------------ */

const CredentialsLive = Layer.mergeAll(
  LocalAuthStoreLive(process.cwd(), homedir()),
  LocalSettingsStoreLive(process.cwd(), homedir()),
)

const SocialAppLive = Layer.mergeAll(
  LanguageModelLive,
  PlaywrightXPlatformLive,
  AstroBlogReaderLive,
).pipe(
  Layer.provideMerge(CredentialsLive)
)

/* ------------------------------------------------------------------ */
/* CLI Commands                                                       */
/* ------------------------------------------------------------------ */

// Bun auto-loads the launch dir's .env; a stale EFFERENT_MODEL there silently
// overrides the configured model (the smith/math lesson).
const envModel = process.env["EFFERENT_MODEL"]
if (envModel !== undefined) {
  console.error(`social: ignoring EFFERENT_MODEL=${envModel} — configure .efferent/config.json`)
  delete process.env["EFFERENT_MODEL"]
}

/** Settings must LOAD before any model call — the router reads the store. */
const withSettings = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const settings = yield* (yield* SettingsStore).load
    const model = settings.model._tag === "Some" ? settings.model.value : "(no model configured)"
    yield* Effect.logInfo(`social: agent on ${model}`)
    return yield* effect
  })

const daemonCmd = Command.make("daemon", {}, () =>
  withSettings(startDaemon()).pipe(Effect.provide(SocialAppLive))
)

const reviewCmd = Command.make("review", {}, () =>
  withSettings(runReviewQueue()).pipe(Effect.provide(SocialAppLive))
)

const testCmd = Command.make("test", {}, () =>
  Effect.gen(function* () {
    yield* Effect.logInfo("Testing Playwright X platform connection...")
    yield* withSettings(findOpportunitiesAndDraft(["EffectTS"]))
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
