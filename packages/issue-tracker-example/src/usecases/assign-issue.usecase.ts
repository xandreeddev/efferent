import { Schema } from "effect"
import { Issue, IssueId, MemberId } from "../domain/issue.entity.js"

export const AssignIssueInput = Schema.Struct({ issueId: IssueId, memberId: MemberId })
export type AssignIssueInput = typeof AssignIssueInput.Type

export const AssignIssueOutput = Issue
export type AssignIssueOutput = typeof AssignIssueOutput.Type
