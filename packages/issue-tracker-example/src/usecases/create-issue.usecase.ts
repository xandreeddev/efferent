import { Schema } from "effect"
import { Issue, NewIssue } from "../domain/issue.entity.js"

export const CreateIssueInput = NewIssue
export type CreateIssueInput = typeof CreateIssueInput.Type

export const CreateIssueOutput = Issue
export type CreateIssueOutput = typeof CreateIssueOutput.Type
