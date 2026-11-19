import { Effect, Layer } from "effect"
import type { ApprovalRequest } from "../../contracts/approval/approval.entity.js"
import { Approval } from "../../contracts/approval/approval.port.js"

/**
 * A policy before the person (ADR 0012): a wrapper of `Approval`, given the one it wraps. A request the policy
 * allows is answered `Allowed`, with nobody asked; every other goes to the wrapped one. It never answers
 * `ApprovedAlways`: a standing approval is a person's, and one minted here would outlive this configuration.
 * `autoApprove(() => true)` approves everything.
 *
 * @public
 */
export const autoApprove = (allows: (request: ApprovalRequest) => boolean) =>
  <E, R>(asked: Layer.Layer<Approval, E, R>): Layer.Layer<Approval, E, R> =>
    Layer.effect(Approval, Effect.map(Approval, (person) => Approval.of({
      ask: (request) => (allows(request) ? Effect.succeed({ _tag: "Allowed" as const }) : person.ask(request)),
    }))).pipe(Layer.provide(asked))
