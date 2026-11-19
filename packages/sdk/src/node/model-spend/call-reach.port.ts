import { Context } from "effect"
import type { Ref } from "effect"
import type { Reach } from "./model-spend.entity.js"

/**
 * How far the request of the call being charged got, as the provider's HTTP client marks it (`reaching`): provided
 * by the charge around the call's own send, so a provider's shared client marks the call it is sending for.
 */
export class CallReach extends Context.Service<CallReach, Ref.Ref<Reach>>()("@xandreed/sdk/kernel/node/CallReach") {}
