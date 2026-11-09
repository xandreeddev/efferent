import { Effect, Ref } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, expect } from "../conformance.functions.js"
import { SessionIncarnation } from "../session/session-log.entity.js"
import { ConversationId } from "../domain/message.entity.js"
import { RunId } from "../domain/run.entity.js"
import { HarnessError } from "../harness/plugin.entity.js"
import type { CommittedTurnObserver } from "../ports/committed-turn-observers.port.js"
import type { CommittedTurn } from "./committed-turn.entity.js"

/** Notification application edge, implemented by notifyCommittedTurn. @public */
export type CommittedTurnNotifier = (turn: CommittedTurn, observers: ReadonlyArray<CommittedTurnObserver>) => Effect.Effect<void>

const turn: CommittedTurn = { session: { id: ConversationId.make("00000000-0000-4000-8000-0000000000c1"), owner: "fixture", incarnation: SessionIncarnation.make("00000000-0000-4000-8000-000000000001") }, runId: RunId.make("committed-fixture"), turn: 1 }

/** Sequential delivery, independent snapshots, soft failures and bounded callbacks. @public */
export const committedTurnObserversConformance = (notify: CommittedTurnNotifier): ReadonlyArray<ConformanceCheck> => [
  check("committed observers preserve order", "order", () => Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([])
    yield* notify(turn, ["first", "second"].map((id) => ({ id, committed: () => Ref.update(calls, (all) => [...all, id]) })))
    yield* expect("order", (yield* Ref.get(calls)).join() === "first,second", "observers were omitted or reordered")
  })),
  check("committed observers receive independent snapshots", "snapshots", () => Effect.gen(function* () {
    const input = { ...turn, session: { ...turn.session } }
    const seen = yield* Ref.make("")
    yield* notify(input, [
      { id: "mutates", committed: (copy) => Effect.sync(() => { Object.assign(copy.session, { owner: "changed" }) }) },
      { id: "reads", committed: (copy) => Ref.set(seen, copy.session.owner) },
    ])
    yield* expect("snapshots", input.session.owner === "fixture" && (yield* Ref.get(seen)) === "fixture", "a callback mutated caller or sibling input")
  })),
  check("committed observer failures are soft", "soft-failure", () => Effect.gen(function* () {
    const delivered = yield* Ref.make(false)
    yield* notify(turn, [
      { id: "fails", committed: () => Effect.fail(new HarnessError({ code: "turn.failed", message: "fixture observer failure" })) },
      { id: "dies", committed: () => Effect.die("fixture observer defect") },
      { id: "continues", committed: () => Ref.set(delivered, true) },
    ])
    yield* expect("soft-failure", yield* Ref.get(delivered), "a failure prevented a later callback")
  })),
  check("committed observer waits are bounded", "timeout", () => Effect.gen(function* () {
    const delivered = yield* Ref.make(false)
    yield* notify(turn, [
      { id: "stalls", committed: () => Effect.never },
      { id: "continues", committed: () => Ref.set(delivered, true) },
    ])
    yield* expect("timeout", yield* Ref.get(delivered), "a stalled callback prevented later delivery")
  })),
]
