import type { RequestAttempt } from "./request-attempt.entity.js"

export const initialAttempt = (streamable: boolean): RequestAttempt => ({
  _tag: streamable ? "Streamable" : "SettledOnly", visibility: "Silent", media: "Available", overflow: "Available",
})

export const visibleAttempt = (state: RequestAttempt): RequestAttempt => ({ ...state, visibility: "Visible" })
export const settledAttempt = (state: RequestAttempt): RequestAttempt => ({ ...state, _tag: "SettledOnly" })

/** Claim before invoking a callback; neither recovery rearms the other. */
export const claimRecovery = (state: RequestAttempt, kind: "media" | "overflow"): readonly [boolean, RequestAttempt] =>
  state[kind] === "Used" || (kind === "overflow" && state.visibility === "Visible")
    ? [false, state] : [true, { ...state, [kind]: "Used" }]
