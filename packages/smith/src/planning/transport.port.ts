import { Context } from "effect"
import type { Option, Redacted } from "effect"

/** Foreign HTTP is a boundary; test transports still execute the production decision protocol. */
export type PlanningFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class SmithPlanningTransport extends Context.Service<SmithPlanningTransport, {
  readonly fetch: PlanningFetch
  readonly apiKey: Option.Option<Redacted.Redacted<string>>
}>()("smith/PlanningTransport") {}
