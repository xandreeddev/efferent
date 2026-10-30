import { Effect, Layer, Stream } from "effect"

type Ambient = unknown
export const erased = (effect: Effect.Effect<number, never, unknown>) => effect
export type Handler = (input: unknown) => Stream.Stream<string, Error, unknown>
export declare const layer: Layer.Layer<never, never, Ambient>
export const named = (effect: Effect.Effect<number, never, never>) => effect
export const free = <R>(effect: Effect.Effect<number, never, R>) => effect
export const open: Effect.Effect<unknown, unknown> = Effect.succeed(1)
declare namespace Local {
  export interface Layer<A, E, R> { readonly a: A; readonly e: E; readonly r: R }
}
export declare const local: Local.Layer<string, never, unknown>
