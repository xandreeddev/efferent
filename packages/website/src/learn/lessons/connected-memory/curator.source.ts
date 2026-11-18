// Lesson 18's curator.ts, a file of its own: who keeps the memory, outside
// the agent. It holds the host's `Curator` (one model call for each job: the
// kernel's prompt sent as one message, the reply's text handed back) and
// `keep`, which agent.ts runs after each turn's answer: the turn becomes a
// source (`turnSource`), and the kernel's curation step (`curate`) stores it
// in the knowledge session, asks the curator, checks the reply and stores
// what passed. A source no curation kept (Stop cut it short, or a try failed)
// is taken up first, with `curateAgain`: nothing else takes it up. The model
// the curator asks is the page's (`curatorModel`, which agent.ts hands to
// `curatorOn`): the gateway's when it is picked, else Echo, which curates by
// rule. The learner edits all of it; the page runs it as written, and
// program.test.ts compiles and runs it.

/** Read-only: where each name the curator uses comes from. */
export const CURATOR_IMPORTS = `import { Clock, Effect, Layer, Option, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { Sessions } from "@xandreed/core/kernel"
import { curate, curateAgain, CurationFailed, Curator, knowledgeOf, knowledgeSession, turnSource, turnsOf } from "@xandreed/sdk/kernel"
import { Chat } from "./chat.ts"`

/** Everything before the editable part. */
export const CURATOR_HEADER = `${CURATOR_IMPORTS}\n\n`

/** The review option with its comment: a second call checks the first one's reply. */
export const REVIEW_LINE = `// Whether a second call checks the curator's reply against the turn before anything is stored:
// on, as the kernel has it. Measured on a real model: 39 of 40 turns kept right with it, 36
// without.
const options = { review: true }`

/** The curator: the model call the curation step makes for each job. */
export const CURATOR = `// The curator: the kernel writes the prompt (the turn, what is stored about what it names, and
// the rules) and reads the reply; the curator sends the prompt to its model as one message and
// hands back the reply's text. \`model\` is the model it asks.
export const curatorOn = (model) =>
  Layer.effect(
    Curator,
    Effect.gen(function* () {
      const llm = yield* LanguageModel.LanguageModel
      return Curator.of({
        curate: ({ prompt }) =>
          llm.streamText({ prompt }).pipe(
            // A model that fails, or answers with nothing, gives no reply: the try fails, and the
            // kernel stores that it did.
            Stream.tap((part) =>
              part.type === "error"
                ? Effect.fail(new CurationFailed({ message: \`the model reported: \${part.error}\` }))
                : Effect.void,
            ),
            Stream.filter((part) => part.type === "text-delta"),
            Stream.map((part) => part.delta),
            Stream.mkString,
            Effect.catchTag("AiError", (error) =>
              Effect.fail(
                new CurationFailed({ message: \`the model could not curate: \${error.message}\` }),
              ),
            ),
            Effect.flatMap((text) =>
              text.trim() === ""
                ? Effect.fail(new CurationFailed({ message: "the model gave no reply" }))
                : Effect.succeed(text),
            ),
          ),
      })
    }),
  ).pipe(Layer.provide(model))`

/** What a curation came to, in a few words, for the chat's status line. */
export const SAID = `// What a curation came to, in a few words: what it kept, or why it failed.
const said = (outcome) => {
  if (outcome._tag === "Failed") return \`failed: \${outcome.reason} The next turn tries again.\`
  const { memories, restated, ended } = outcome.kept
  return \`\${memories.length} new, \${restated.length} said again, \${ended.length} ended; \${outcome.dropped.length} dropped\`
}`

/** What agent.ts runs after each turn's answer. */
export const KEEP = `// After each turn: what it said is kept. Sources an earlier turn left (Stop cut their curation
// short, or a try failed) are taken up first, each up to three tries; then this turn is stored as
// a source and curated. The chat's status line says what came of it.
export const keep = Effect.gen(function* () {
  const chat = yield* Chat
  const sessions = yield* Sessions
  const knowledge = yield* knowledgeSession
  const stored = knowledgeOf((yield* sessions.read(knowledge)).events)
  for (const { source, state } of stored.sources) {
    if (state._tag === "Curated" || (state._tag === "Failed" && state.attempts >= 3)) continue
    yield* chat.status(\`Curating \${source.id} again…\`)
    const again = yield* curateAgain(knowledge, source.id, options)
    yield* Option.match(again, {
      onNone: () => Effect.void,
      onSome: (outcome) => chat.status(\`\${source.id}: \${said(outcome)}\`),
    })
  }
  // This turn as a source: what you said, each tool call with its result, and the answer; the two
  // turns before it are its context, so the curator can tell who "she" is.
  const turns = turnsOf((yield* sessions.read(chat.session)).events)
  const last = turns.at(-1)
  if (last === undefined) return
  const source = turnSource(turns, last.turn)
  if (Option.isNone(source)) return
  yield* chat.status("Curating…")
  const outcome = yield* curate(
    knowledge,
    {
      said: source.value.said,
      context: source.value.context,
      at: yield* Clock.currentTimeMillis,
      from: { session: chat.session, turn: last.turn },
    },
    options,
  )
  yield* chat.status(\`Curated turn \${last.turn}: \${said(outcome)}\`)
}).pipe(
  Effect.catch((error) =>
    Effect.flatMap(Chat, (chat) => chat.status(\`Curating failed: \${error.message}\`)),
  ),
)`

/** What the learner edits. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_CURATOR = `${REVIEW_LINE}\n\n${CURATOR}\n\n${SAID}\n\n${KEEP}`

/** The whole file as the learner reads it. */
export const curatorDocumentOf = (curator: string): string => `${CURATOR_HEADER}${curator}\n`

/**
 * The same file as a module a test can compile: the curator's model is typed, and so is what `said` reads. Nothing
 * else needs a type, and nothing is cast.
 */
export const curatorModuleOf = (curator: string): string => `${CURATOR_HEADER.replace('import { Chat } from "./chat.ts"', 'import { Chat } from "./chat.ts"\nimport type { CurationOutcome } from "@xandreed/sdk/kernel"')}${curator
  .replace("export const curatorOn = (model) =>", "export const curatorOn = (model: Layer.Layer<LanguageModel.LanguageModel>) =>")
  .replace("const said = (outcome) => {", "const said = (outcome: CurationOutcome) => {")}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const curatorBodyOf = (curator: string): string => curator.replace(/^export /gm, "")
