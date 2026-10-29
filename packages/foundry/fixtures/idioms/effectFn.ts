import { Context, Effect, Layer } from "effect"

export const load = (id: string) => Effect.gen(function* () { return id })
export function save(id: string) { return Effect.gen(function* () { return id }) }
class Store extends Context.Service<Store, { readonly read: (id: string) => Effect.Effect<string> }>()("Store") {}
export const StoreLive = Layer.succeed(Store, Store.of({
  read: (id) => Effect.gen(function* () { return id }),
}))
export const traced = Effect.fn("store.load")(function* (id: string) { return id })
export const spanned = (id: string) => Effect.gen(function* () { return id }).pipe(Effect.withSpan("store.load"))
const helper = (id: string) => Effect.gen(function* () { return id })
export const handled = (n: number) => Effect.succeed(n).pipe(Effect.flatMap((x) => helper(String(x))))
export const tables = Effect.fail({ _tag: "A" as const }).pipe(Effect.catchTags({ A: () => Effect.gen(function* () { return 1 }) }))
