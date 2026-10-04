import { Schema } from "effect"

export const SmithCalibrationCandidate = Schema.Struct({ id: Schema.NonEmptyString, driverModel: Schema.NonEmptyString, editorModel: Schema.NonEmptyString, modules: Schema.Array(Schema.String) })
export type SmithCalibrationCandidate = typeof SmithCalibrationCandidate.Type
export const SmithCodingReference = Schema.Struct({ completed: Schema.Literal(true), requiredChecks: Schema.Array(Schema.NonEmptyString), editorRequired: Schema.Literal(true) })
export type SmithCodingReference = typeof SmithCodingReference.Type
export const SmithInteractionReference = Schema.Struct({ completed: Schema.Literal(true), modelRequests: Schema.Int, toolCalls: Schema.Int, recovery: Schema.Boolean })
export type SmithInteractionReference = typeof SmithInteractionReference.Type

export const smithScriptedCandidate: SmithCalibrationCandidate = { id: "split-scripted", driverModel: "opencode:fixture-controller", editorModel: "opencode:fixture-editor", modules: ["foundations", "schema", "services", "concurrency", "ai", "architecture"] }
export const smithInteractionCandidate: SmithCalibrationCandidate = { id: "interaction-scripted", driverModel: "opencode:deepseek-fixture", editorModel: "opencode:deepseek-fixture", modules: [] }
