import type { ModelCallData } from "@xandreed/core"
import type { ModelCallRecorderPhase, ObservedModelCall } from "./model-call-recorder.entity.js"

export const modelCallKey = (data: ModelCallData): string => `${data.callId}:${data.attempt}`

/** Fresh durable order wins; retain facts whose accepted ACK is newer than the snapshot. */
export const mergeModelCalls = (phase: ModelCallRecorderPhase, calls: ReadonlyArray<ObservedModelCall>): ModelCallRecorderPhase => {
  const keys = new Set(calls.map((call) => modelCallKey(call.data)))
  return { ...phase, calls: [...calls, ...phase.calls.filter((call) => !keys.has(modelCallKey(call.data)))] }
}
