// Lesson 15's files, compiled as written and as each experiment leaves them,
// and run on the kernel: branch.ts's `branchFrom` makes a session whose
// journal is the conversation's, record for record, up to the end of the turn
// it names, and chat.ts's `resume` shows the chat the page asks for when it is
// one of the learner's own. Each derived text is held to the text it starts
// from.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Effect, Layer, Option } from "effect"
import { assistantMessage, kernel, Sessions, userMessage } from "@xandreed/core"
import type { SessionId } from "@xandreed/core"
import { inProcessJournal, sessions } from "@xandreed/sdk"
import { CHAT_INTRO as KEEP_INTRO, DEFAULT_RESUME as KEEP_RESUME } from "../keep-the-conversation/chat.source.ts"
import { moduleOf as keepModuleOf } from "../keep-the-conversation/agent.source.ts"
import { DEFAULT_STORE, storeModuleOf } from "../keep-the-conversation/store.source.ts"
import { slowCalculator } from "../tools/config-edit.ts"
import { DEFAULT_MEMORY, memoryModuleOf } from "../tools/memory.source.ts"
import { DEFAULT_TOOLS, toolsModuleOf } from "../tools/tools.source.ts"
import { DEFAULT_AGENT, moduleOf, TYPED as AGENT_TYPED } from "./agent.source.ts"
import { branchModuleOf, DEFAULT_BRANCH, FORK_AT_TURN, TYPED as BRANCH_TYPED } from "./branch.source.ts"
import { ASKED, chatDocumentOf, chatModuleOf, DEFAULT_RESUME, REPLACED_INTRO, REPLACED_RESUME, TYPED as CHAT_TYPED } from "./chat.source.ts"
import { latest, openTurn, resumeIgnores } from "./config-edit.ts"

const dir = new URL("./generated-program-check/", import.meta.url)
const tsconfig = new URL("./tsconfig.json", dir)

/** How many times `piece` is in `text`. */
const times = (text: string, piece: string): number => text.split(piece).length - 1

/** The six files as typed modules, under `name`, with the texts given. */
const write = (name: string, texts: { readonly branch?: string; readonly resume?: string; readonly tools?: string } = {}) => {
  const at = new URL(`./${name}/`, dir)
  mkdirSync(at, { recursive: true })
  writeFileSync(new URL("./agent.ts", at), moduleOf(DEFAULT_AGENT))
  writeFileSync(new URL("./branch.ts", at), branchModuleOf(texts.branch ?? DEFAULT_BRANCH))
  writeFileSync(new URL("./chat.ts", at), chatModuleOf(texts.resume ?? DEFAULT_RESUME))
  writeFileSync(new URL("./memory.ts", at), memoryModuleOf(DEFAULT_MEMORY))
  writeFileSync(new URL("./store.ts", at), storeModuleOf(DEFAULT_STORE))
  writeFileSync(new URL("./tools.ts", at), toolsModuleOf(texts.tools ?? DEFAULT_TOOLS))
  return at
}

type BranchFrom = (conversation: SessionId, turn: number) => Effect.Effect<SessionId, { readonly _tag: string; readonly message: string }, Sessions>
type ResumeOf = (chosen: Option.Option<SessionId>) => Effect.Effect<SessionId, unknown, Sessions>

const branchFromOf = async (at: URL): Promise<BranchFrom> => ((await import(new URL("./branch.ts", at).href)) as { branchFrom: BranchFrom }).branchFrom
const resumeOfAt = async (at: URL): Promise<ResumeOf> => ((await import(new URL("./chat.ts", at).href)) as { resumeOf: ResumeOf }).resumeOf

const store = sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))

/** One turn of a conversation: a message, and an answer. */
const said = (conversation: SessionId, message: string, answer: string) =>
  Effect.gen(function* () {
    const all = yield* Sessions
    return yield* all.turn(conversation, (session) => Effect.andThen(session.append(userMessage(message)), session.append(assistantMessage(answer))))
  })

/** A conversation of two turns, then `branchFrom` run on it as the page runs it. */
const branchedWith = (branchFrom: BranchFrom, turn: number) => Effect.gen(function* () {
  const all = yield* Sessions
  const conversation = yield* all.create({ owner: "learner" })
  yield* said(conversation, "My name is Ana.", "Hello, Ana.")
  yield* said(conversation, "What is 12 * 3?", "36.")
  const before = yield* all.read(conversation)
  const branch = yield* Effect.result(branchFrom(conversation, turn))
  return { conversation, before, after: yield* all.read(conversation), branch: yield* Effect.result(Effect.flatMap(Effect.fromResult(branch), all.read)), sessions: (yield* all.list).length }
}).pipe(Effect.provide(store))

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe("lesson 15's displayed program", () => {
  test("lesson 7's chat still holds what this lesson's chat.ts replaces, and each typed module's pieces are in its text", () => {
    for (const [from] of REPLACED_INTRO) expect({ from, held: times(KEEP_INTRO, from) }).toEqual({ from, held: 1 })
    for (const [from] of REPLACED_RESUME) expect({ from, held: times(KEEP_RESUME, from) }).toEqual({ from, held: 1 })
    for (const [from] of CHAT_TYPED) expect({ from, held: times(chatDocumentOf(DEFAULT_RESUME), from) }).toEqual({ from, held: 1 })
    for (const [from] of AGENT_TYPED) expect({ from, held: times(keepModuleOf(DEFAULT_AGENT), from) }).toEqual({ from, held: 1 })
    for (const [from] of BRANCH_TYPED) expect({ from, held: times(DEFAULT_BRANCH, from) }).toEqual({ from, held: 1 })
    // Each experiment's piece is in the text it edits, once.
    expect([times(DEFAULT_BRANCH, FORK_AT_TURN), times(DEFAULT_RESUME, ASKED)]).toEqual([1, 1])
    // branch.ts makes one call of the sessions, and chat.ts reads `chosen` once, where it picks the chat.
    expect(times(DEFAULT_BRANCH, "sessions.fork(")).toBe(1)
    // The line step 4 of the page quotes.
    expect(times(DEFAULT_BRANCH, "    return yield* sessions.fork(conversation, { through: TurnNumber.make(turn) })\n")).toBe(1)
    expect(times(DEFAULT_RESUME, "chosen")).toBe(1)
    // chat.ts keeps lesson 7's three conditions, and its fallback.
    expect(DEFAULT_RESUME).toContain('header.owner === "learner" &&\n      header.parent === undefined &&\n      Result.isSuccess(currentFormat(header)),')
    expect(DEFAULT_RESUME).toContain("?? mine.at(-1)")
  })

  test("branchFrom as written: the branch's journal is the conversation's up to the end of the turn named, and the conversation is unchanged", async () => {
    const ran = await Effect.runPromise(branchedWith(await branchFromOf(write("branch")), 1))
    const branch = Effect.runSync(Effect.fromResult(ran.branch))
    const ended = ran.before.events.filter((event) => event.name === "core.session.turn.ended")
    expect(ended.map((event) => [Number(event.turn), Number(event.seq)])).toEqual([[1, 4], [2, 8]])
    // The prefix, record for record: places, turns and times as they were stored.
    expect(branch.events).toEqual(ran.before.events.slice(0, 4))
    expect([branch.header.branch?.of, Number(branch.header.branch?.through), String(branch.header.owner), branch.header.parent]).toEqual([ran.conversation, 4, "learner", undefined])
    expect(ran.after).toEqual(ran.before)
    expect(ran.sessions).toBe(2)
  })

  test("latest: branchFrom without a turn cuts at the end of the last closed turn, whichever turn it is given", async () => {
    const ran = await Effect.runPromise(branchedWith(await branchFromOf(write("latest", { branch: Option.getOrThrow(latest(DEFAULT_BRANCH)) })), 1))
    const branch = Effect.runSync(Effect.fromResult(ran.branch))
    expect(branch.events).toEqual(ran.before.events)
    expect(Number(branch.header.branch?.through)).toBe(8)
  })

  test("open-turn: branchFrom asks for the turn after the one pressed, and a turn that never was is refused with NoClosedTurn, nothing made", async () => {
    const ran = await Effect.runPromise(branchedWith(await branchFromOf(write("open-turn", { branch: Option.getOrThrow(openTurn(DEFAULT_BRANCH)) })), 2))
    expect(ran.branch._tag).toBe("Failure")
    expect(ran.sessions).toBe(1)
    const refused = Effect.runSync(Effect.flip(Effect.fromResult(ran.branch)))
    expect(refused).toMatchObject({ _tag: "SessionRefused", reason: "NoClosedTurn" })
    expect(refused.message).toBe(`turn 3 of session ${ran.conversation} is not closed: a branch is cut at the end of a closed turn`)
  })

  test("resume as written shows the chat asked for when it is one of yours, else the last; resume-ignores always the last", async () => {
    const resumeOf = await resumeOfAt(write("resume"))
    const ignores = await resumeOfAt(write("resume-ignores", { resume: Option.getOrThrow(resumeIgnores(DEFAULT_RESUME)) }))
    const shown = await Effect.runPromise(Effect.gen(function* () {
      const all = yield* Sessions
      const first = yield* all.create({ owner: "learner" })
      yield* Effect.sleep("5 millis")
      const helper = yield* all.create({ owner: "learner", parent: first })
      yield* Effect.sleep("5 millis")
      const second = yield* all.create({ owner: "learner" })
      const nobody = yield* all.create({ owner: "someone" })
      const picks = [Option.some(first), Option.none(), Option.some(helper), Option.some(nobody), Option.some(second)]
      return {
        ids: { first, second },
        asWritten: yield* Effect.forEach(picks, resumeOf, { concurrency: 1 }),
        ignoring: yield* Effect.forEach(picks, ignores, { concurrency: 1 }),
      }
    }).pipe(Effect.provide(store)))
    const { first, second } = shown.ids
    // The chat asked for; none, the last; a helper (it has a parent) and another owner's session are not yours: the last.
    expect(shown.asWritten).toEqual([first, second, second, second, second])
    expect(shown.ignoring).toEqual([second, second, second, second, second])
  })

  test("type-checks as TypeScript: the six files as shown, and as each experiment leaves them", () => {
    write("typed")
    write("typed-latest", { branch: Option.getOrThrow(latest(DEFAULT_BRANCH)) })
    write("typed-open-turn", { branch: Option.getOrThrow(openTurn(DEFAULT_BRANCH)) })
    write("typed-resume-ignores", { resume: Option.getOrThrow(resumeIgnores(DEFAULT_RESUME)) })
    write("typed-slow", { tools: Option.getOrThrow(slowCalculator(DEFAULT_TOOLS)) })
    writeFileSync(tsconfig, JSON.stringify({ extends: "../../../../../tsconfig.learn.json", include: ["./*/*.ts"], exclude: [] }))
    const checked = Bun.spawnSync(["bunx", "tsc", "-p", fileURLToPath(tsconfig)], { cwd: fileURLToPath(new URL("../../../../", import.meta.url)) })
    expect(`${checked.stdout.toString()}${checked.stderr.toString()}`).toBe("")
    expect(checked.exitCode).toBe(0)
  }, 120_000)
})
