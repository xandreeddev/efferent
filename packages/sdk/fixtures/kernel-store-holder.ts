/*
 * A process over a durable kernel journal, for the tests that kill one
 * (`src/node/testing.ts`, `holder`). Arguments: the store (`directory`
 * or `sqlite`), its path, and what to do: `hold` opens the store and waits;
 * `turn` also creates a session, opens a turn in it, stores a user message
 * and waits inside the turn. Its first line of output says what it holds, as
 * JSON (`{"held":true}`, or `{"session":"<id>"}`), or why it could not
 * (`{"refused":"<reason>","message":"..."}`). It waits until it is killed.
 */
import { Effect, Layer } from "effect"
import { kernel, Sessions, userMessage } from "@xandreed/core"
import { sessions } from "../src/index.js"
import { directoryJournal, sqliteJournal } from "../src/node/index.js"

const [kind, path, mode] = process.argv.slice(2)
if (path === undefined) process.exit(2)
const store = kind === "sqlite" ? sqliteJournal({ path }) : directoryJournal({ directory: path })
const say = (value: unknown) => Effect.sync(() => { process.stdout.write(`${JSON.stringify(value)}\n`) })

const program = Effect.gen(function* () {
  if (mode !== "turn") return yield* Effect.andThen(say({ held: true }), Effect.never)
  const all = yield* Sessions
  const session = yield* all.create({ owner: "holder" })
  return yield* all.turn(session, (open) => Effect.andThen(open.append(userMessage("Are you there?")), Effect.andThen(say({ session }), Effect.never)))
})

await Effect.runPromise(Effect.scoped(program.pipe(
  Effect.provide(sessions().pipe(Layer.provideMerge(store), Layer.provideMerge(kernel()))),
  Effect.catchTag("JournalOpenFailed", (failed) => Effect.andThen(say({ refused: failed.reason, message: failed.message }), Effect.never)),
)))
