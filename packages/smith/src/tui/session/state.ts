import { Match, Option } from "effect"
import type { Fiber } from "effect"
import type { ConversationId, SpecDoc } from "@xandreed/core"
import type { ShipPlan } from "../../forge/ship.js"
import type { RefineSession } from "../../refine/session.js"
import type { SmithMode } from "../state/store.js"

/**
 * THE workspace session as ONE value. Before, what the session was doing
 * lived in five Refs (the refine session, the forge fiber, the turn fiber,
 * the ship plan, the follow-up target) plus the store's mode, the floor's
 * phase, and a busy flag — and every decision (Esc, plain text, :forge,
 * :resume) re-derived "what is running" from a different subset of them.
 * The Esc-on-a-fresh-dashboard bug, the un-interruptible stalled follow-up,
 * and the resume-onto-a-running-turn bug were all that re-derivation.
 *
 * Here the transitions are pure and total (an inapplicable transition is
 * the identity), the queries are the only way the runtime asks "what is
 * running", and the TUI's mode is a PROJECTION of the state, never set by
 * hand. Fibers register themselves as their first action and unregister in
 * `ensuring`, so the parent never holds a handle that may already be dead.
 */

export type Turn = Fiber.RuntimeFiber<unknown, unknown>

export type SessionState =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Refining"
      readonly session: RefineSession
      /** The refiner turn in flight, if any. */
      readonly turn: Option.Option<Turn>
    }
  | {
      readonly _tag: "Forging"
      readonly doc: SpecDoc
      /** The forge fiber — registers itself as its first action. */
      readonly fiber: Option.Option<Turn>
      /** The refine session the forge came from (so :lock/:branch keep working after). */
      readonly session: Option.Option<RefineSession>
    }
  | {
      readonly _tag: "Forged"
      readonly session: Option.Option<RefineSession>
      /** The coder's own conversation, when the run left one — plain text continues it. */
      readonly followUp: Option.Option<ConversationId>
      /** Armed by an ACCEPTED run; consumed by :ship. */
      readonly ship: Option.Option<ShipPlan>
      /** A follow-up turn in flight, if any. */
      readonly turn: Option.Option<Turn>
    }

export const idle: SessionState = { _tag: "Idle" }

/* ------------------------------- queries ------------------------------- */

export const currentSession = (state: SessionState): Option.Option<RefineSession> =>
  Match.value(state).pipe(
    Match.tag("Idle", () => Option.none<RefineSession>()),
    Match.tag("Refining", (s) => Option.some(s.session)),
    Match.tag("Forging", (s) => s.session),
    Match.tag("Forged", (s) => s.session),
    Match.exhaustive,
  )

export const runningTurn = (state: SessionState): Option.Option<Turn> =>
  Match.value(state).pipe(
    Match.tag("Refining", (s) => s.turn),
    Match.tag("Forged", (s) => s.turn),
    Match.orElse(() => Option.none<Turn>()),
  )

export const forgeFiber = (state: SessionState): Option.Option<Turn> =>
  state._tag === "Forging" ? state.fiber : Option.none()

export const followUpTarget = (state: SessionState): Option.Option<ConversationId> =>
  state._tag === "Forged" ? state.followUp : Option.none()

export const shipPlan = (state: SessionState): Option.Option<ShipPlan> =>
  state._tag === "Forged" ? state.ship : Option.none()

/** What Esc stops: a turn first, else the forge. */
export const interruptTarget = (
  state: SessionState,
): Option.Option<{ readonly kind: "turn" | "forge"; readonly fiber: Turn }> =>
  Option.match(runningTurn(state), {
    onSome: (fiber) => Option.some({ kind: "turn" as const, fiber }),
    onNone: () => Option.map(forgeFiber(state), (fiber) => ({ kind: "forge" as const, fiber })),
  })

/** Something is running: a turn, or the forge itself. */
export const isRunning = (state: SessionState): boolean =>
  state._tag === "Forging" || Option.isSome(runningTurn(state))

/** The TUI's mode is a projection — never set by hand. */
export const modeOf = (state: SessionState): SmithMode =>
  Match.value(state).pipe(
    Match.tag("Idle", () => "idle" as const),
    Match.tag("Refining", () => "refine" as const),
    Match.tag("Forging", () => "forge" as const),
    Match.tag("Forged", () => "forge" as const),
    Match.exhaustive,
  )

/* ----------------------------- transitions ----------------------------- */

/** A refine session opens (a new idea, :resume, an opened spec) — from anywhere. */
export const beginRefine = (session: RefineSession) => (_state: SessionState): SessionState => ({
  _tag: "Refining",
  session,
  turn: Option.none(),
})

/** A turn fiber registers itself (its first action). Only a state that can
 *  host a turn takes it; elsewhere the transition is the identity. */
export const turnStarted = (fiber: Turn) => (state: SessionState): SessionState =>
  Match.value(state).pipe(
    Match.tag("Refining", (s) => ({ ...s, turn: Option.some(fiber) })),
    Match.tag("Forged", (s) => ({ ...s, turn: Option.some(fiber) })),
    Match.orElse(() => state),
  )

/** The turn fiber unregisters itself (`ensuring`) — only ITS registration. */
export const turnEnded = (fiber: Turn) => (state: SessionState): SessionState =>
  Match.value(state).pipe(
    Match.tag("Refining", (s) => (Option.exists(s.turn, (t) => t === fiber) ? { ...s, turn: Option.none() } : s)),
    Match.tag("Forged", (s) => (Option.exists(s.turn, (t) => t === fiber) ? { ...s, turn: Option.none() } : s)),
    Match.orElse(() => state),
  )

/** A forge starts on a locked doc; the refine session it came from rides along. */
export const beginForge = (doc: SpecDoc) => (state: SessionState): SessionState => ({
  _tag: "Forging",
  doc,
  fiber: Option.none(),
  session: currentSession(state),
})

/** The forge fiber registers itself (its first action). */
export const forgeStarted = (fiber: Turn) => (state: SessionState): SessionState =>
  state._tag === "Forging" ? { ...state, fiber: Option.some(fiber) } : state

/** The forge settled — with its follow-up conversation and, when accepted,
 *  a ship plan. An interrupted or crashed forge settles with neither. */
export const forgeEnded =
  (result: { readonly followUp: Option.Option<ConversationId>; readonly ship: Option.Option<ShipPlan> }) =>
  (state: SessionState): SessionState =>
    state._tag === "Forging"
      ? { _tag: "Forged", session: state.session, followUp: result.followUp, ship: result.ship, turn: Option.none() }
      : state

/** A persisted run replayed from the dashboard — reads like a settled forge. */
export const replayed =
  (result: { readonly followUp: Option.Option<ConversationId>; readonly ship: Option.Option<ShipPlan> }) =>
  (state: SessionState): SessionState =>
    state._tag === "Forging"
      ? state
      : { _tag: "Forged", session: currentSession(state), followUp: result.followUp, ship: result.ship, turn: Option.none() }

/** :ship succeeded — the plan is consumed. */
export const shipped = (state: SessionState): SessionState =>
  state._tag === "Forged" ? { ...state, ship: Option.none() } : state

/** :new — back to the dashboard. */
export const dropped = (_state: SessionState): SessionState => idle
