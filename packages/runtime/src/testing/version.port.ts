import { Context } from "effect"
export class Version extends Context.Service<Version, { readonly value: number }>()("test/Version") {}
