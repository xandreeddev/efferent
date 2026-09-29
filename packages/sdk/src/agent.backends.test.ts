import { afterAll, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { SessionLog, SessionLogMemoryLive } from "@xandreed/core"
import type { JsonObject } from "@xandreed/core"
import { SessionLogSqliteLive } from "@xandreed/plugin-session-sqlite"
import { Agent } from "./agent.adapter.js"
import { goldenConfig, goldenTexts, runGolden } from "./agent.golden.test.js"

/*
 * What the model sees must not depend on where a session is stored. The
 * golden conversation runs over each backend (in memory, a SQLite file, and
 * a store that hands every object back with its keys reversed, as a JSON
 * column may reorder them); each must give the golden's model half, byte
 * for byte.
 */

const reversedKeys = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(reversedKeys)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reversedKeys((value as Record<string, unknown>)[key])]))
      : value

/** A session log whose reads return every stored object with its keys in reverse order. */
const keyReversing: Layer.Layer<SessionLog> = Layer.effect(SessionLog, Effect.gen(function* () {
  const inner = yield* SessionLog
  return SessionLog.of({
    ...inner,
    head: (id) => inner.head(id).pipe(Effect.map((head) => ({ ...head, state: reversedKeys(head.state) as JsonObject }))),
    read: (id, query) => inner.read(id, query).pipe(Effect.map((events) => events.map((event) => ({ ...event, data: reversedKeys(event.data) as JsonObject })))),
  })
})).pipe(Layer.provide(SessionLogMemoryLive))

const directory = join(tmpdir(), `efferent-golden-${crypto.randomUUID()}`)
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const backends: ReadonlyArray<readonly [string, Layer.Layer<SessionLog, unknown>]> = [
  ["in memory", SessionLogMemoryLive],
  ["in a SQLite file", SessionLogSqliteLive(join(directory, "sessions.db"))],
  ["with its keys reordered", keyReversing],
]

describe("the model sees the same requests wherever the session is stored", () => {
  backends.map(([name, log]) => test(name, async () => {
    const model = await Bun.file(`${import.meta.dir}/../golden/agent-turn.model.json`).text()
    const actual = goldenTexts(await Effect.runPromise(runGolden(Agent.define(goldenConfig), log)))
    expect(actual.model).toBe(model)
  }))
})
