import { Effect, Layer, Option } from "effect"
import type { Issue, MemberId } from "../domain/issue.entity.js"
import type { Member } from "../domain/member.entity.js"
import { MemberDirectory } from "../ports/member-directory.port.js"

export const StaticMemberDirectoryLive = (
  members: ReadonlyArray<Member>,
): Layer.Layer<MemberDirectory> =>
  Layer.succeed(MemberDirectory, {
    get: (id: MemberId) =>
      Option.match(Option.fromNullable(members.find((member) => member.id === id)), {
        onNone: () => Effect.fail({ _tag: "MemberNotFound" as const, memberId: id }),
        onSome: Effect.succeed,
      }),
    recommend: (_issue: Issue) =>
      Option.match(Option.fromNullable(members.find((member) => member.active)), {
        onNone: () => Effect.fail({ _tag: "NoAvailableMember" as const }),
        onSome: Effect.succeed,
      }),
  })
