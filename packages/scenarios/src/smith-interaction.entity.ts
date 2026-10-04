import { Schema } from "effect"

export const SmithInteractionCase = Schema.Struct({ id: Schema.Literals(["greeting", "restricted-greeting", "read-recovery"]), task: Schema.String, readOnly: Schema.Boolean })
export type SmithInteractionCase = typeof SmithInteractionCase.Type
export const smithInteractionCases: ReadonlyArray<SmithInteractionCase> = [
  { id: "greeting", task: "hello", readOnly: false },
  { id: "restricted-greeting", task: "hello", readOnly: true },
  { id: "read-recovery", task: "Read the missing file, recover by reading README.md, and report the result.", readOnly: false },
]

export const SmithInteractionEvidence = Schema.Struct({
  caseId: SmithInteractionCase.fields.id, outcome: Schema.String, reply: Schema.String, error: Schema.NullOr(Schema.String),
  outerGraphFingerprint: Schema.String, controllerPromptVersion: Schema.String, immutableWorkspace: Schema.Boolean,
  parentEvents: Schema.Array(Schema.Unknown), requests: Schema.Array(Schema.Unknown), checks: Schema.Array(Schema.Struct({ name: Schema.String, pass: Schema.Boolean })),
})
export type SmithInteractionEvidence = typeof SmithInteractionEvidence.Type
