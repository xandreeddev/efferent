import { Context, Effect } from "effect"
import type { Issue, MemberId } from "../domain/issue.entity.js"
import type { Member, MemberNotFound, NoAvailableMember } from "../domain/member.entity.js"

export class MemberDirectory extends Context.Tag("IssueTracker/MemberDirectory")<
  MemberDirectory,
  {
    readonly get: (id: MemberId) => Effect.Effect<Member, MemberNotFound>
    readonly recommend: (issue: Issue) => Effect.Effect<Member, NoAvailableMember>
  }
>() {}
