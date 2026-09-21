import { Effect, Option, Ref } from "effect"
import type { FileSystem, Shell } from "@xandreed/core"
import type { SmithEvent } from "../domain/SmithEvent.js"
import { assembleContext } from "./assemble.js"
import type { ContextBundle } from "./assemble.js"
import { loadContextSet } from "./store.js"

/**
 * The turn-level INJECTION seam for the conversational paths (refine and
 * follow-up): before a turn, assemble the pins and hand the block back ONLY
 * when it changed since the last injection — the model reads the context
 * once, and again exactly when the human changed it, never on every turn.
 * The forge brief takes the bundle whole at attempt 1 instead (a run is one
 * unit of work; see forge/session.ts).
 */

export interface ContextInjector {
  /** The block to prepend to the next turn, when it changed; also publishes
   *  `context_assembled` so the pane shows what the model was handed. */
  readonly next: Effect.Effect<Option.Option<string>, never, FileSystem | Shell>
}

const EMPTY_FINGERPRINT = "00000000"

export const makeContextInjector = (
  cwd: string,
  publish: (event: SmithEvent) => Effect.Effect<void>,
): Effect.Effect<ContextInjector> =>
  Effect.map(Ref.make<string>(EMPTY_FINGERPRINT), (lastRef) => ({
    next: Effect.gen(function* () {
      const set = yield* loadContextSet(cwd)
      if (set.pins.length === 0) {
        // Pins removed since the last turn: forget the old fingerprint so
        // pins added later are seen as new.
        yield* Ref.set(lastRef, EMPTY_FINGERPRINT)
        return Option.none<string>()
      }
      const bundle = yield* assembleContext(cwd, set, { execute: true })
      const last = yield* Ref.get(lastRef)
      if (bundle.fingerprint === last) return Option.none<string>()
      yield* Ref.set(lastRef, bundle.fingerprint)
      yield* publish(contextAssembledEvent(bundle, true))
      return bundle.text
    }),
  }))

export const contextAssembledEvent = (bundle: ContextBundle, injected: boolean): SmithEvent => ({
  type: "context_assembled",
  sources: bundle.blocks.map((b) => ({ label: b.label, chars: b.chars, status: b.status })),
  totalChars: bundle.totalChars,
  injected,
})

/** The user turn with the context block ahead of it, when there is one. */
export const withContextBlock = (block: Option.Option<string>, text: string): string =>
  Option.match(block, { onNone: () => text, onSome: (ctx) => `${ctx}\n\n---\n\n${text}` })
