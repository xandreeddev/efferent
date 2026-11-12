import { describe, expect, test } from "bun:test"
import { Array as Arr, Effect, Layer, Order, Result, Schema } from "effect"
import { Core, inspectionOf, kernel, Sessions, stored, storedEvent } from "@xandreed/core/kernel"
import type { JournalStorage, SessionId, TurnFailure } from "@xandreed/core/kernel"
import { inProcessJournal } from "./plugins/journal-in-process/journal.adapter.js"
import { sessions } from "./plugins/session/sessions.adapter.js"

/*
 * Core holds no workflow: an agent built of the kernel, a journal and the
 * session plugin, with one plugin of its own that opens a turn and appends
 * its own records, runs and stores the turn. No loop, no memory, no system
 * text and no model is in the stack, and its type says so.
 */

describe("core with no loop", () => {
  test("runs a turn that a plugin of its own opens, and stores the turn and the plugin's records", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      // A record of the plugin's own.
      const noted = storedEvent("notes", "noted", { data: Schema.Struct({ text: Schema.String }), skippable: false })

      // The plugin: when built, it opens a turn of the session and appends its records. It needs `Sessions` and nothing else.
      const notes = (session: SessionId, texts: ReadonlyArray<string>): Layer.Layer<never, TurnFailure, Sessions> =>
        Layer.effectDiscard(Effect.flatMap(Sessions, (sessions) => sessions.turn(session, (open) =>
          Effect.forEach(texts, (text) => open.append(stored(noted, { text })), { concurrency: 1, discard: true }))))

      // Core, a journal and the session plugin: everything below a workflow.
      const Base: Layer.Layer<Sessions | JournalStorage | Core> = sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))

      const base = yield* Layer.build(Base)
      const session = yield* Effect.provide(Effect.flatMap(Sessions, (all) => all.create({ owner: "recorder" })), base)
      yield* Layer.build(Layer.provide(notes(session, ["first", "second"]), Layer.succeedContext(base)))
      const journal = yield* Effect.provide(Effect.flatMap(Sessions, (all) => all.read(session)), base)
      return {
        services: Arr.sort(Array.from(base.mapUnsafe.keys()).filter((key) => !key.startsWith("effect/")), Order.String),
        names: journal.events.map((event): string => event.name),
        data: journal.events.map((event) => event.data),
        inspection: inspectionOf(journal),
      }
    })).pipe(Effect.timeout("5 seconds")))
    expect(result.services).toEqual(["@xandreed/core/kernel/Core", "@xandreed/core/kernel/JournalStorage", "@xandreed/core/kernel/Sessions"])
    expect(result.names).toEqual(["core.session.turn.started", "plugin.notes.noted", "plugin.notes.noted", "core.session.turn.ended"])
    expect(result.data).toEqual([{ turn: 1 }, { text: "first" }, { text: "second" }, { turn: 1, outcome: { _tag: "Completed" } }])
    expect(Result.map(result.inspection, (inspection) => inspection.state)).toEqual(Result.succeed({ _tag: "Free", turns: 1 }))
  })
})
