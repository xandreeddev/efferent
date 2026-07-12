import { Schema } from "effect"
import { Issue, IssueId } from "../domain/issue.entity.js"

export const CloseIssueInput = Schema.Struct({ issueId: IssueId })
export type CloseIssueInput = typeof CloseIssueInput.Type

export const CloseIssueOutput = Issue
export type CloseIssueOutput = typeof CloseIssueOutput.Type
