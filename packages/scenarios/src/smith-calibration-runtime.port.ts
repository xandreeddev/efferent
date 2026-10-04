import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { Plugin } from "@xandreed/core"
import type { SmithCalibrationCandidate } from "./smith-calibration.entity.js"

export type SmithCalibrationTransport = { readonly plugin: Plugin; readonly requests: Effect.Effect<ReadonlyArray<unknown>> }
export class SmithCalibrationRuntime extends Context.Service<SmithCalibrationRuntime, {
  readonly candidate: SmithCalibrationCandidate
  readonly mode: "scripted" | "live"
  readonly transport: Option.Option<SmithCalibrationTransport>
}>()("scenarios/SmithCalibrationRuntime") {}
