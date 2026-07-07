import { Effect, Fiber, Option, Queue } from "effect"
import type { FileSystem, SpecDoc } from "@xandreed/engine"
import type { SmithEvent } from "../domain/SmithEvent.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import type { ImplementorServices } from "../implementor/efferentImplementor.js"
import { renderEventLines } from "../presentation/eventLines.js"
import { runForgeSession } from "../forge/session.js"

/**
 * `-p` mode: run the forge session with every event rendered live as stdout
 * lines. Exit code: 0 accepted · 1 rejected · 2 infrastructure error.
 */
export const runHeadless = (
  run: SmithRunConfig,
  doc: Option.Option<SpecDoc> = Option.none(),
): Effect.Effect<number, never, ImplementorServices | FileSystem> =>
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
              onSome: (lines) => console.log(lines),
            })
            return true
          },
        })
      }).pipe(Effect.repeat({ while: (more) => more }), Effect.asVoid),
    )

    const outcome = yield* runForgeSession(run, publish, doc).pipe(
      Effect.map((result) => (result.run.outcome._tag === "accepted" ? 0 : 1)),
      Effect.catchAll(() => Effect.succeed(2)),
    )
    // Flush: the None sentinel ends the printer after every queued event printed.
    yield* Queue.offer(queue, Option.none())
    yield* Fiber.join(printer)
    return outcome
  })
