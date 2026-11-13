import { Context } from "effect"

/** A stand-in contract for the wrapping tests: any contract a part reads and nothing else is needed for. */
export class Label extends Context.Service<Label, { readonly system: string }>()("@xandreed/sdk/kernel/testing/Label") {}
