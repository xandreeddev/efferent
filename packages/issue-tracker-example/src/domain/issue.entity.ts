import { Schema } from "effect"

export const IssueId = Schema.String.pipe(Schema.minLength(1), Schema.brand("IssueId"))
export type IssueId = typeof IssueId.Type

export const MemberId = Schema.String.pipe(Schema.minLength(1), Schema.brand("MemberId"))
export type MemberId = typeof MemberId.Type

export const IssueStatus = Schema.Literal("open", "assigned", "closed")
export type IssueStatus = typeof IssueStatus.Type

export const Issue = Schema.Struct({
  id: IssueId,
  title: Schema.String.pipe(Schema.minLength(1)),
  description: Schema.String,
  status: IssueStatus,
  assigneeId: Schema.OptionFromSelf(MemberId),
  createdAt: Schema.String.pipe(Schema.minLength(1)),
  updatedAt: Schema.String.pipe(Schema.minLength(1)),
})
export type Issue = typeof Issue.Type

export const NewIssue = Schema.Struct({
  title: Schema.String.pipe(Schema.minLength(1)),
  description: Schema.String,
})
export type NewIssue = typeof NewIssue.Type

export const InvalidIssue = Schema.TaggedStruct("InvalidIssue", { reason: Schema.String })
export type InvalidIssue = typeof InvalidIssue.Type

export const IssueClosed = Schema.TaggedStruct("IssueClosed", { issueId: IssueId })
export type IssueClosed = typeof IssueClosed.Type

export const IssueNotFound = Schema.TaggedStruct("IssueNotFound", { issueId: IssueId })
export type IssueNotFound = typeof IssueNotFound.Type
