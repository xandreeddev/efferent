import { Effect, Schema } from "effect"

export const Thing = Schema.Struct({
  id: Schema.String,
  userId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  goodId: Schema.String.pipe(Schema.brand("GoodId")),
  name: Schema.String,
})

const Id = Schema.Trimmed.check(Schema.isNonEmpty())
const GoodId = Schema.String.pipe(Schema.brand("GoodId"))
/** Declared, not defined, in this file: trusted like an import. */
declare const ElsewhereId: typeof GoodId

export const Unbranded = Schema.Struct({
  checkedId: Schema.Trimmed.check(Schema.isNonEmpty()),
  annotatedId: Schema.String.annotate({ description: "an id" }),
  optionalId: Schema.optionalKey(Schema.String),
  maybeId: Schema.optional(Schema.NullOr(Schema.String)),
  absentId: Schema.OptionFromNullOr(Schema.String),
  keyedId: Schema.OptionFromOptionalKey(Id),
  listId: Schema.Array(Schema.NonEmptyString),
  defaultedId: Schema.withDecodingDefaultKey(Effect.succeed(""))(Schema.String),
  localId: Id,
})

export const Branded = Schema.Struct({
  localId: GoodId,
  optionalId: Schema.optionalKey(GoodId),
  pipedId: GoodId.pipe(Schema.optionalKey),
  checkedId: GoodId.check(Schema.isMinLength(1)),
  elsewhereId: ElsewhereId.pipe(Schema.optionalKey),
  appliedId: Schema.brand("AppliedId")(Schema.String),
  kind: Schema.optionalKey(Schema.String),
})
