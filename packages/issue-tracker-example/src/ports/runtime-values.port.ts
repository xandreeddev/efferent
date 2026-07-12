import { Context, Effect } from "effect"
import type { IssueId } from "../domain/issue.entity.js"

export class IssueClock extends Context.Tag("IssueTracker/IssueClock")<
  IssueClock,
  { readonly now: Effect.Effect<string> }
>() {}

export class IssueIdGenerator extends Context.Tag("IssueTracker/IssueIdGenerator")<
  IssueIdGenerator,
  { readonly next: Effect.Effect<IssueId> }
>() {}
