import { Schema } from "effect"

/** A place in a result's view, counted in characters from its start. */
const ViewOffset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * How much of its view a result showed when a call asked for text inside
 * it: its `head`, the first characters before a notice, or its `whole` view.
 */
export const ShownPart = Schema.Literals(["head", "whole"])
export type ShownPart = typeof ShownPart.Type

/**
 * What follows the text already read, for a call refused inside a page: the
 * page that holds the offset, and every page already read that follows on
 * from it.
 */
export const ReadOn = Schema.Union([
  /** Text no page already read holds starts at `offset`: the page's end, or the end of the last page that follows on from it. */
  Schema.TaggedStruct("From", { offset: ViewOffset }),
  /** The page that holds the offset ended the result. */
  Schema.TaggedStruct("PageEndsResult", {}),
  /** Pages read after that page hold the text from its end to the result's end. */
  Schema.TaggedStruct("ReadToEnd", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ReadOn = typeof ReadOn.Type

/**
 * Why `recall_context` returns no page: the text asked for was in the
 * request the model answered from, so returning it would only repeat it.
 * Each case is named for the `Failure` the tool returns. The failure is
 * recorded as the call's result and is read again in later requests, after
 * memory may have shortened the result it is about: a case holds only what
 * stays true of it then.
 */
export const RecallRefusal = Schema.Union([
  /**
   * The offset was inside the text the result showed. No offset is held: what
   * the result shows can shrink later (a spill under pressure, a compact view
   * in a later turn), and the notice it ends with then is what says where the
   * text it no longer shows starts.
   */
  Schema.TaggedStruct("ResultShown", { shown: ShownPart }),
  /**
   * The offset is inside a page the asking run read earlier in the turn, and
   * that page is still shown whole: `next` is what follows the text already
   * read from there on. A page is never shortened by the strategies that
   * contribute the tool, and the pages `next` speaks of were read in the same
   * turn, so it stays true in every request that shows this refusal.
   */
  Schema.TaggedStruct("AlreadyRecalled", { next: ReadOn }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type RecallRefusal = typeof RecallRefusal.Type
