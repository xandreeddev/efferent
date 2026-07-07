import { Effect, Fiber, Option, Queue } from "effect"
import { encodeSpecDocText } from "@xandreed/engine"
import type { SmithEvent } from "../domain/SmithEvent.js"
import type { ImplementorServices } from "../implementor/efferentImplementor.js"
import { renderEventLines } from "../presentation/eventLines.js"
import { makeRefineSession } from "./session.js"

/**
 * `smith spec "<idea>" -p [--yes]`: ONE unattended refiner turn — the draft
 * SpecDoc prints to stdout (the artifact IS the output), `--yes` locks it.
 * Exit: 0 = a draft exists (locked when --yes) · 2 = no draft / error.
 */
export const runHeadlessRefine = (
  cwd: string,
  idea: string,
  lockAfter: boolean,
): Effect.Effect<number, never, ImplementorServices> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Option.Option<SmithEvent>>()
    const publish = (event: SmithEvent) =>
      Queue.offer(queue, Option.some(event)).pipe(Effect.asVoid)

    const printer = yield* Effect.fork(
      Effect.gen(function* () {
        const next = yield* Queue.take(queue)
        return Option.match(next, {
          onNone: () => false,
          onSome: (event) => {
            Option.match(renderEventLines(event), {
              onNone: () => undefined,
              onSome: (lines) => console.error(lines),
            })
            return true
          },
        })
      }).pipe(Effect.repeat({ while: (more) => more }), Effect.asVoid),
    )

    const code = yield* Effect.gen(function* () {
      const session = yield* makeRefineSession(cwd, publish, { unattended: true })
      yield* publish({ type: "refine_start", idea: Option.some(idea) })
      const draft = yield* session.send(idea)
      if (Option.isNone(draft)) {
        yield* publish({
          type: "refine_error",
          message: "the refiner produced no draft (no propose_spec call)",
        })
        return 2
      }
      const final = lockAfter
        ? (yield* session.lock).doc
        : draft.value.doc
      // stdout carries the ARTIFACT; the event narration rides stderr.
      console.log(encodeSpecDocText(final))
      return 0
    }).pipe(Effect.catchAll(() => Effect.succeed(2)))

    yield* Queue.offer(queue, Option.none())
    yield* Fiber.join(printer)
    return code
  })
