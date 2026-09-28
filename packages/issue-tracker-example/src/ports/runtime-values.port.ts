import { Context, Effect } from "effect"
import type { IssueId } from "../domain/issue.entity.js"

export class IssueClock extends Context.Service<IssueClock, { readonly now: Effect.Effect<string> }>()("IssueTracker/IssueClock") {}

export class IssueIdGenerator extends Context.Service<IssueIdGenerator, { readonly next: Effect.Effect<IssueId> }>()("IssueTracker/IssueIdGenerator") {}
