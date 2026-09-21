import { Context } from "effect"
export class Version extends Context.Tag("test/Version")<Version, { readonly value: number }>() {}
