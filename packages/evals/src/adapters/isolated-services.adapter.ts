import { Layer } from "effect"

/** Each case runs on its own instances: counters, budgets and clients never leak between cases. */
export const isolatedServices = <R, E, In>(layer: Layer.Layer<R, E, In>): Layer.Layer<R, E, In> => Layer.fresh(layer)
