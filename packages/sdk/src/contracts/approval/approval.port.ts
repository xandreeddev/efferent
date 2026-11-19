import { Context } from "effect"
import type { Effect } from "effect"
import type { ApprovalRequest, Decision } from "./approval.entity.js"

/**
 * Who a tool asks before it acts (ADR 0012): `ask` puts one request to whoever decides, and answers with the
 * decision. The host provides it: a button in a chat, a prompt in a terminal, a policy. No kernel plugin decides
 * for a person. It has no failure in its type: a host that cannot ask answers `Refused`. A tool that asks
 * declares it, `Tool.make(name, { …, dependencies: [Approval, CurrentTurn] })`, and calls `approve` in its
 * handler, so a tool that asks cannot run in a stack that cannot answer.
 *
 * @public
 */
export class Approval extends Context.Service<Approval, {
  readonly ask: (request: ApprovalRequest) => Effect.Effect<Decision>
}>()("@xandreed/sdk/Approval") {}
