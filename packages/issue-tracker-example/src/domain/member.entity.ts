import { Schema } from "effect"
import { MemberId } from "./issue.entity.js"

export const Member = Schema.Struct({
  id: MemberId,
  name: Schema.String.pipe(Schema.minLength(1)),
  active: Schema.Boolean,
})
export type Member = typeof Member.Type

export const MemberNotFound = Schema.TaggedStruct("MemberNotFound", { memberId: MemberId })
export type MemberNotFound = typeof MemberNotFound.Type

export const NoAvailableMember = Schema.TaggedStruct("NoAvailableMember", {})
export type NoAvailableMember = typeof NoAvailableMember.Type
