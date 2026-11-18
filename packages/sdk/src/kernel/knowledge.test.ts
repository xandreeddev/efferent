import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref } from "effect"
import { assistantMessage, kernel, readJournal, Sessions, stored, TurnNumber, userMessage } from "@xandreed/core/kernel"
import type { SessionId } from "@xandreed/core/kernel"
import {
  CurationFailed, curationOf, curationPrompt, Curator, draftsOf, endedBy, inProcessJournal, KNOWLEDGE_OWNER, KNOWLEDGE_VOCABULARY, knowledgeOf, MemoryId, nextIds, sessions, shownFor,
  sourceEvent, staged, standing, turnSource, turnsOf,
} from "./index.js"
import type { SourceData, TurnSource } from "./index.js"

/*
 * Knowledge kept by a curator (ADR 0022), as a test: a turn of a conversation becomes a source, the host's curator
 * reads it with what is stored, and what passes the checks is appended to a journal of its own. `docs/kernel.md`
 * quotes the function that does it and what is read back. The kernel ships the parts and no service yet: `keep` is
 * what a host's own program does with them.
 */

// #region curate
/** One source kept: stored, read by the host's curator, checked, and what passed appended. It answers what the checks dropped. */
const keep = (session: SessionId, turn: TurnSource, at: number, from: { readonly session: SessionId; readonly turn: TurnNumber }) => Effect.gen(function* () {
  const all = yield* Sessions
  const curator = yield* Curator
  // The source is stored first, in a turn of the knowledge session: every later record names it.
  const source = yield* all.turn(session, (open) => Effect.gen(function* () {
    const id = nextIds(knowledgeOf(yield* open.journal)).source
    const made: SourceData = { id, said: turn.said, context: turn.context, at, from }
    yield* open.append(stored(sourceEvent, made))
    return made
  }))
  // The curator is shown what is stored about the entities the source names, and asked with the kernel's prompt.
  const shown = shownFor(knowledgeOf((yield* all.read(session)).events), source)
  const reply = yield* curator.curate({ prompt: curationPrompt(source, shown), job: { source: source.id, attempt: 1, purpose: "extract" } })
  // The reply is read item by item; each item is checked alone against the source and what was shown.
  const read = yield* Effect.fromOption(curationOf(reply), () => new CurationFailed({ message: "the reply holds no JSON object" }))
  const stage = staged(read.curation, source, shown)
  // What passed is stored in one turn, over the knowledge as it stands now.
  yield* all.turn(session, (open) => Effect.gen(function* () {
    const drafts = draftsOf(stage, knowledgeOf(yield* open.journal), source)
    yield* Effect.forEach(drafts, (draft) => open.append(draft), { concurrency: 1, discard: true })
  }))
  return stage.dropped
})
// #endregion curate

/** Noon of 12 November 2026, a Thursday: when the conversation happened. */
const THURSDAY = Date.parse("2026-11-12T12:00:00Z")

/** What a model would answer for each source: the first plainly, the second in a code fence, with one memory the turn does not support. */
const REPLIES: Record<string, string> = {
  s1: `{"entities":[{"key":"a","name":"Ana Silva","kind":"person"},{"key":"b","name":"Porto","kind":"place"}],"aliases":[],"memories":[{"kind":"fact","text":"Ana Silva lives in Porto.","about":["a","b"],"quote":"My friend Ana Silva lives in Porto.","by":"user","on":null,"ends":[],"why":null},{"kind":"fact","text":"Ana Silva is the user's friend.","about":["n1","a"],"quote":"My friend Ana Silva","by":"user","on":null,"ends":[],"why":null}],"restates":[],"forget":[]}`,
  s2: "```json\n" + `{"entities":[{"key":"a","name":"Braga","kind":"place"}],"aliases":[],"memories":[{"kind":"fact","text":"Ana Silva lives in Braga since 2026-10.","about":["n2","a"],"quote":"she moved to Braga last month","by":"user","on":"2026-10","ends":["m1"],"why":"changed"},{"kind":"fact","text":"Braga is a lovely city.","about":["a"],"quote":"Braga is a lovely city","by":"user","on":null,"ends":[],"why":null}],"restates":[],"forget":[]}` + "\n```",
}

describe("knowledge kept by a curator", () => {
  test("a turn is curated into a journal of its own: the new memory stands, and the one it replaced is kept, ended, with what came in its place", async () => {
    const { journal, prompts, dropped } = await Effect.runPromise(Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      // The host's curator, scripted: it records each prompt and answers what a model would.
      const curator = Layer.succeed(Curator, Curator.of({
        curate: ({ prompt, job }) => Effect.as(Ref.update(asked, (all) => [...all, prompt]), REPLIES[job.source] ?? "{}"),
      }))
      const ran = yield* Effect.gen(function* () {
        const all = yield* Sessions
        // A conversation of two turns, stored as a host's program stores them.
        const conversation = yield* all.create({ owner: "learner" })
        const said = (message: string, answer: string) => all.turn(conversation, (open) => Effect.andThen(open.append(userMessage(message)), open.append(assistantMessage(answer))))
        yield* said("My friend Ana Silva lives in Porto.", "Good to know.")
        yield* said("And she moved to Braga last month.", "Noted. Braga is a lovely city.")
        const turns = turnsOf((yield* all.read(conversation)).events)
        // The knowledge session: a journal of its own, under the plugin's owner.
        const knowledge = yield* all.create({ owner: KNOWLEDGE_OWNER })
        const first = yield* keep(knowledge, Option.getOrThrow(turnSource(turns, 1)), THURSDAY, { session: conversation, turn: TurnNumber.make(1) })
        const second = yield* keep(knowledge, Option.getOrThrow(turnSource(turns, 2)), THURSDAY, { session: conversation, turn: TurnNumber.make(2) })
        return { journal: (yield* all.read(knowledge)).events, dropped: [first, second] }
      }).pipe(Effect.provide(curator), Effect.provide(sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))))
      return { ...ran, prompts: yield* Ref.get(asked) }
    }).pipe(Effect.orDie))

    // #region records
    const knowledge = knowledgeOf(journal)
    // Nothing is deleted: the memory the second turn replaced is still there, ended, and names what came in its place.
    expect(knowledge.memories.map((memory) => `${memory.id}: ${memory.text} ${Option.match(memory.ended, {
      onNone: () => "(stands)",
      onSome: (ended) => `(ended: ${ended.why}, by ${Option.getOrElse(ended.by, () => "nothing")})`,
    })}`)).toEqual([
      "m1: Ana Silva lives in Porto. (ended: changed, by m3)",
      "m2: Ana Silva is the user's friend. (stands)",
      "m3: Ana Silva lives in Braga since 2026-10. (stands)",
    ])
    expect(standing(knowledge).map((memory) => memory.text)).toEqual(["Ana Silva is the user's friend.", "Ana Silva lives in Braga since 2026-10."])
    expect(endedBy(knowledge, MemoryId.make("m3")).map((memory) => memory.text)).toEqual(["Ana Silva lives in Porto."])
    // A memory is a sentence about entities, with the words of the source it rests on.
    expect(knowledge.entities.map((entity) => `${entity.id} ${entity.name} (${entity.kind})`)).toEqual(["n1 the user (person)", "n2 Ana Silva (person)", "n3 Porto (place)", "n4 Braga (place)"])
    expect<unknown>(knowledge.memories.map((memory) => [memory.about, memory.quote, memory.by, Option.getOrNull(memory.on)])).toEqual([
      [["n2", "n3"], "My friend Ana Silva lives in Porto.", "user", null],
      [["n1", "n2"], "My friend Ana Silva", "user", null],
      [["n2", "n4"], "she moved to Braga last month", "user", "2026-10"],
    ])
    // The journal is the whole of it: each source in a turn of its own, then what its curation kept.
    expect(journal.map((event) => String(event.name)).filter((name) => name.startsWith("plugin."))).toEqual([
      "plugin.knowledge.source", "plugin.knowledge.entity", "plugin.knowledge.entity", "plugin.knowledge.memory", "plugin.knowledge.memory",
      "plugin.knowledge.source", "plugin.knowledge.entity", "plugin.knowledge.memory", "plugin.knowledge.ended",
    ])
    // #endregion records

    // The checks dropped the one memory that rested on the assistant's words, alone, and kept the rest of that reply.
    expect(dropped).toEqual([[], [{ what: `memory "Braga is a lovely city."`, why: "Its quote is not in what the user said, a tool returned or the host wrote." }]])
    // The second turn names nobody ("she"): its context does, so the curator was shown Ana Silva and what is stored about her.
    expect(prompts).toHaveLength(2)
    expect(prompts[1]?.includes("<earlier-turns>\nUser: My friend Ana Silva lives in Porto.\nAssistant's final answer: Good to know.\n</earlier-turns>")).toBe(true)
    expect(prompts[1]?.includes("<this-turn>\nUser: And she moved to Braga last month.\nAssistant's final answer: Noted. Braga is a lovely city.\n</this-turn>")).toBe(true)
    expect(prompts[1]?.includes("<stored-entities>\nn1: the user (person; also called I, me)\nn2: Ana Silva (person)\nn3: Porto (place)\n</stored-entities>")).toBe(true)
    // "Said on" is the day the first turn happened (its source's `at`), whenever the records were stored.
    expect(prompts[1]?.includes("\nm1: Ana Silva lives in Porto. [fact; about n2, n3; said on 2026-11-12]\n")).toBe(true)
    expect(prompts[1]?.includes("The turn happened on 2026-11-12, a Thursday.")).toBe(true)
    // The knowledge session's journal holds nothing its vocabulary refuses, and every source is still pending: the record that says a source was curated is the service's, which comes next.
    expect(readJournal(KNOWLEDGE_VOCABULARY)(journal)._tag).toBe("Success")
    expect<unknown>(knowledge.sources.map((one) => [one.source.id, one.state._tag, one.source.from?.turn])).toEqual([["s1", "Pending", 1], ["s2", "Pending", 2]])
  })
})
