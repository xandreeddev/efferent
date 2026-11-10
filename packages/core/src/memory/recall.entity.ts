import { Schema } from "effect"

/** A place in a result's view, counted in characters from its start. */
const ViewOffset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * Why `recall_context` returns no page: the text asked for is already in the
 * request the model is answering, so returning it would only repeat it. Each
 * case is named for the `Failure` the tool returns and holds the offset to
 * read on from, none when nothing of the result lies past what is shown.
 */
export const RecallRefusal = Schema.Union([
  /** The offset is inside the text the result still shows: its first `next` characters, or all of it (none). */
  Schema.TaggedStruct("ResultShown", { next: Schema.Option(ViewOffset) }),
  /** The page from this offset was read earlier in the turn and is still shown: `next` is where it ended, none when it ended the result. */
  Schema.TaggedStruct("AlreadyRecalled", { next: Schema.Option(ViewOffset) }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type RecallRefusal = typeof RecallRefusal.Type
