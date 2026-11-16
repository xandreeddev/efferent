// Lesson 16's experiments edit the learner's code in place, so the code and
// the buttons never disagree. Each is one of the app's ways to decide who may
// change a file (ADR 0017): a workspace that declines, a loop that asks you,
// a judge before you. A line the learner rewrote beyond recognition is left
// alone (None) rather than guessed at.
import { Option } from "effect"
import { FILES_LINES } from "./agent.source.ts"
import { DECLARATION, SANDBOX } from "./workspace.source.ts"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, () => to)) : Option.none()

/** workspace.ts's function, wrapping the page's files with a `write` of its own, its comment first. */
const wrapping = (comment: string, write: string) => `${comment}
${DECLARATION}
  Layer.effect(
    Files,
    Effect.gen(function* () {
      const inner = yield* Files
      return Files.of({
        ...inner,
${write}
      })
    }),
  ).pipe(Layer.provide(files))`

/** The reason a write under docs/ is declined with: the agent reads it in the tool's failed result. */
export const DOCS_REASON = "the docs folder is read-only"

/** workspace.ts that declines every write under docs/, with a reason, and lets everything else through. */
export const KEEP_DOCS = wrapping(
  `// Writes under docs/ are declined, with a reason the agent reads. Reads, and every other
// write, go through to the page's files.`,
  `        write: (path, text, expected) =>
          path.startsWith("docs/")
            ? Effect.fail(
                new FilesRefused({
                  path,
                  reason: "${DOCS_REASON}",
                  message: \`declined \${path}\`,
                }),
              )
            : inner.write(path, text, expected),`,
)

/** workspace.ts whose writes are made at once and answered four seconds later: the time to press Stop in. */
export const SLOW_WRITES = wrapping(
  `// Every write is made at once, and answered four seconds later: press Stop in between, and the
// file is changed while the call has no result.`,
  `        write: (path, text, expected) =>
          Effect.andThen(inner.write(path, text, expected), Effect.sleep("4 seconds")),`,
)

/** workspace.ts as a workspace that declines writes under docs/. */
export const keepDocs = swap(SANDBOX, KEEP_DOCS)

/** workspace.ts as a workspace whose writes are answered late. */
export const slowWrites = swap(SANDBOX, SLOW_WRITES)

/** The base's line that runs a call. */
const RUN_CALL = "          yield* callTool(toolkit, call, session)\n"

/** The same step, asked for first when the call writes: the loop asks you, and stores a no as the call's result. */
export const ASK_FIRST = `          // The app asks before a call that writes: the file tools ask no one. The key is the path
          // as the workspace has it, so Always covers that file alone. A path that is no path in
          // the workspace is not asked about: the tool refuses it in words.
          const writes = call.name === "writeFile" || call.name === "editFile"
          const path =
            Predicate.hasProperty(call.params, "path") && typeof call.params.path === "string"
              ? workspacePath(call.params.path)
              : Result.fail("no path")
          if (writes && Result.isSuccess(path)) {
            const approved = yield* approveIn(session, {
              action: \`files.write:\${path.success}\`,
              detail: \`Let the agent write \${path.success}.\`,
            }).pipe(
              Effect.matchEffect({
                // A no is stored as the call's result: a call with no result is never sent again.
                onFailure: (refusal) =>
                  Effect.as(session.append(toolResult(call, refusal, true)), false),
                onSuccess: () => Effect.succeed(true),
              }),
            )
            if (!approved) continue
          }
          yield* callTool(toolkit, call, session)
`

/** main's line that gives the loop somebody to ask: the page's approval, you in the chat. */
export const ASKING_LINE = "  Effect.provide(approvalOn(pane)), // who the loop asks before a write: you, in the chat\n"

/**
 * agent.ts whose loop asks before a write, and whose main gives it you to ask. A loop that asks already is left
 * alone (None): the block it adds ends with the line it replaces, so a second press would nest it.
 */
export const askFirst = (source: string): Option.Option<string> =>
  source.includes(ASK_FIRST) ? Option.none() : Option.flatMap(swap(RUN_CALL, ASK_FIRST)(source), swap(FILES_LINES, `${FILES_LINES}${ASKING_LINE}`))

/** The comment above main, before which the judge's definition goes. */
const RUN_IT = "// Run it: give the program the modules it asks for. Each can use the ones given after it.\n"

/** An `Approval` of the app's over yours: a rule answers first, and what it does not allow goes to you. */
export const JUDGE = `// An Approval of the app's over yours: a judge answers first, and what it does not allow goes to
// you. An app's judge would ask a model. This one is a rule, so the page's test is the same every
// time: a write under scratch/ is allowed, with nobody asked.
const judgedFirst = (person) =>
  Layer.effect(
    Approval,
    Effect.gen(function* () {
      const below = yield* Approval
      return Approval.of({
        ask: (request) =>
          request.action.startsWith("files.write:scratch/")
            ? Effect.succeed({ _tag: "Allowed" })
            : below.ask(request),
      })
    }),
  ).pipe(Layer.provide(person))

`

/** main's line with the judge before you. */
export const JUDGED_LINE = "  Effect.provide(judgedFirst(approvalOn(pane))), // a rule answers first, then you\n"

/**
 * agent.ts that asks before a write, as `askFirst` leaves it, with a judge that answers before you: from the starter,
 * or from the code `askFirst` left (the page's buttons are pressed in order, with no Reset between them).
 */
export const judged = (source: string): Option.Option<string> => {
  const asking = source.includes(ASK_FIRST) && source.includes(ASKING_LINE) ? Option.some(source) : askFirst(source)
  return Option.flatMap(Option.flatMap(asking, swap(ASKING_LINE, JUDGED_LINE)), swap(RUN_IT, `${JUDGE}${RUN_IT}`))
}
