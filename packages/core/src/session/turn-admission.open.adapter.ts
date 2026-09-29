import { Layer } from "effect"
import { TurnAdmission } from "../ports/turn-admission.port.js"

/** Every turn is admitted: for hosts without a budget. */
export const TurnAdmissionOpen: Layer.Layer<TurnAdmission> = Layer.succeed(TurnAdmission, TurnAdmission.of({ admit: (_turn, open) => open }))
