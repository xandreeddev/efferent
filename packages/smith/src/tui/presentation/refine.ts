import { Match, Option } from "effect"
import type { SpecDoc } from "@xandreed/engine"
import type { SmithEvent } from "../../domain/SmithEvent.js"
import { agentEventLabel } from "../../presentation/eventLines.js"

export interface RefineLine {
  readonly who: "you" | "smith"
  readonly text: string
}

/**
 * The refine view model — one immutable state folded from the smith event
 * stream (pure; the driver adds `you` lines and flips `busy` directly, since
 * those are UI facts, not events).
 */
export interface RefineState {
  readonly transcript: ReadonlyArray<RefineLine>
  readonly feed: ReadonlyArray<string>
  readonly draft: Option.Option<SpecDoc>
  readonly draftPath: Option.Option<string>
  readonly locked: boolean
  readonly error: Option.Option<string>
}

const FEED_CAP = 100

export const initialRefine: RefineState = {
  transcript: [],
  feed: [],
  draft: Option.none(),
  draftPath: Option.none(),
  locked: false,
  error: Option.none(),
}

/** Fold one smith event into the refine state; forge-phase events are inert. */
export const reduceRefine = (state: RefineState, event: SmithEvent): RefineState =>
  Match.value(event).pipe(
    Match.when({ type: "spec_draft" }, (e) => ({
      ...state,
      draft: Option.some(e.doc),
      draftPath: Option.some(e.path),
    })),
    Match.when({ type: "spec_locked" }, (e) => ({
      ...state,
      draft: Option.some(e.doc),
      draftPath: Option.some(e.path),
      locked: true,
    })),
    Match.when({ type: "refine_error" }, (e) => ({
      ...state,
      error: Option.some(e.message),
    })),
    Match.when({ type: "agent" }, (e) =>
      Match.value(e.event).pipe(
        Match.when({ type: "assistant_message" }, (message) =>
          message.text.trim().length === 0
            ? state
            : {
                ...state,
                transcript: [
                  ...state.transcript,
                  { who: "smith" as const, text: message.text.trim() },
                ],
              },
        ),
        Match.orElse(() =>
          Option.match(agentEventLabel(e), {
            onNone: () => state,
            onSome: (label) => ({
              ...state,
              feed: [...state.feed, label].slice(-FEED_CAP),
            }),
          }),
        ),
      ),
    ),
    Match.orElse(() => state),
  )

/** The driver's half: the human's composer line. */
export const withUserLine = (state: RefineState, text: string): RefineState => ({
  ...state,
  error: Option.none(),
  transcript: [...state.transcript, { who: "you", text }],
})
