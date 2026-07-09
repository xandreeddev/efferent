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

/**
 * The TRAJECTORY CRITIC (agent-as-a-judge, Day-4 pattern): grade a real
 * forge run's PROCESS on the six axes the deterministic gates cannot see.
 * Manual and keyed — never CI (the scripted packs stay the regression bar):
 *
 *   bun packages/scenarios/src/critic.ts <workspace-cwd>
 *
 * Reads the newest conversation from the workspace's smith.db + its newest
 * run artifact, feeds trail + outcome to the STRONG tier with the rubric,
 * prints the graded table.
 */

const Grades = Schema.parseJson(
  Schema.Struct({
    planning: Schema.Number,
    tool_selection: Schema.Number,
    interpretation: Schema.Number,
    efficiency: Schema.Number,
    robustness: Schema.Number,
    summary: Schema.String,
  }),
)

const rubric = (transcript: string, outcome: string): string => `You are a trajectory CRITIC for a coding agent. Grade the PROCESS below — not the final code (deterministic gates already judged that). Score each axis 1-5 (5 = excellent):

- planning: was the reasoning coherent and goal-directed (no context pollution, no repetitive loops)?
- tool_selection: right tools, valid parameters, no unnecessary or hallucinated calls?
- interpretation: did the agent correctly read tool RESULTS — especially error states — and react to them?
- efficiency: steps proportionate to the task (no redundant calls, no thrash)?
- robustness: failures retried or reported honestly, never papered over?

Run outcome: ${outcome}

TRANSCRIPT:
${transcript}

Reason briefly per axis, then end with EXACTLY one JSON object on the last line:
{"planning": n, "tool_selection": n, "interpretation": n, "efficiency": n, "robustness": n, "summary": "one sentence"}`

const lastJson = (text: string): string => {
  const start = text.lastIndexOf('{"planning"')
  return start >= 0 ? text.slice(start).trim() : text.trim()
}

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
      prompt: rubric(renderTrailForDigest(trail), outcome),
    })
    const grades = yield* Schema.decodeUnknown(Grades)(lastJson(reply.text))
    console.log(`trajectory critic — ${cwd} (${outcome})`)
    console.log(`  planning        ${grades.planning}/5`)
    console.log(`  tool selection  ${grades.tool_selection}/5`)
    console.log(`  interpretation  ${grades.interpretation}/5`)
    console.log(`  efficiency      ${grades.efficiency}/5`)
    console.log(`  robustness      ${grades.robustness}/5`)
    console.log(`  ${grades.summary}`)
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
