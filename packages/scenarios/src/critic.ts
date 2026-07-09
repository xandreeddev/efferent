import { homedir } from "node:os"
import { join } from "node:path"
import { LanguageModel } from "@effect/ai"
import { Effect, Layer, Option, Schema } from "effect"
import { readRuns } from "@xandreed/foundry"
import { ConversationStore } from "@xandreed/engine"
import {
  LanguageModelLive,
  LocalAuthStoreLive,
  LocalSettingsStoreLive,
  roleModelView,
  SqliteConversationStoreLive,
} from "@xandreed/providers"
import { renderTrailForDigest } from "@xandreed/smith"
import { gradesToReason, gradesToScore, Grades, criticRubric, lastGradesJson } from "./judges/trajectoryCritic.js"

/**
 * The trajectory critic CLI — a thin driver over `judges/trajectoryCritic.ts`
 * (the same rubric/parse/score the live scenario packs use as a Judge).
 * Manual and keyed — never CI:
 *
 *   bun packages/scenarios/src/critic.ts <workspace-cwd>
 *
 * Reads the newest conversation from the workspace's smith.db + its newest
 * run artifact, grades the PROCESS on the strong tier, prints the table.
 */

const program = (cwd: string) =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const sessions = yield* store.listByWorkspace(cwd)
    const newest = Option.fromNullable(sessions[0])
    if (Option.isNone(newest)) {
      console.error(`no conversations in ${cwd}/.efferent/smith.db`)
      return 2
    }
    const trail = yield* store.list(newest.value.id)
    const runs = yield* readRuns(join(cwd, ".foundry", "runs"))
    const outcome = Option.match(Option.fromNullable(runs[runs.length - 1]), {
      onNone: () => "unknown (no run artifact)",
      onSome: (run) => `${run.outcome._tag} after ${run.attempts.length} attempt(s)`,
    })

    const reply = yield* LanguageModel.generateText({
      prompt: criticRubric(renderTrailForDigest(trail), outcome),
    })
    const grades = yield* Schema.decodeUnknown(Grades)(lastGradesJson(reply.text))
    console.log(`trajectory critic — ${cwd} (${outcome})`)
    console.log(`  score ${gradesToScore(grades).toFixed(2)} — ${gradesToReason(grades)}`)
    return 0
  })

const cwd = process.argv[2] ?? process.cwd()
const services = Layer.mergeAll(
  SqliteConversationStoreLive(join(cwd, ".efferent", "smith.db")),
  LanguageModelLive.pipe(
    Layer.provide(roleModelView("code")),
    Layer.provide(
      Layer.mergeAll(
        LocalAuthStoreLive(cwd, homedir()),
        LocalSettingsStoreLive(cwd, homedir()),
      ),
    ),
  ),
)

const code = await Effect.runPromise(
  Effect.scoped(
    program(cwd).pipe(
      Effect.provide(services),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.error(`critic failed: ${String(error)}`)
          return 2
        }),
      ),
    ),
  ),
)
process.exit(code)
