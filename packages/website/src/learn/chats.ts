// The row of chats (lesson 14): the learner's own conversations and their
// branches, each labelled from its header, and what the page says when the
// learner's `resume` shows a chat other than the one picked. Pure: the
// runtime reads the headers and each branch's turn from the store, and the
// page draws what this gives.
import { Option, Result } from "effect"
import { currentFormat } from "@xandreed/core/kernel"
import type { SessionHeader, SessionId } from "@xandreed/core/kernel"

/** Who the page's chats belong to: the owner lesson 7's `resume` keeps, and the one `Clear context` creates under. */
export const CHAT_OWNER = "learner"

/**
 * A chat of the learner's own: owned by the learner, with no parent (a helper is never one) and of this kernel's
 * format. The same three conditions lesson 7's `resume` keeps a conversation by, and lesson 14's accepts `chosen` by.
 */
export const ownChat = (header: SessionHeader): boolean =>
  header.owner === CHAT_OWNER && header.parent === undefined && Result.isSuccess(currentFormat(header))

/** One button of the row of chats. */
export interface ChatEntry {
  readonly id: SessionId
  /** "Chat 1", or for a branch "Chat 1, branch after turn 2". */
  readonly label: string
  /** Where a branch was cut: the chat it was cut from, and the turn its last copied record closed, when it was read. */
  readonly branch: Option.Option<{ readonly of: SessionId; readonly turn: Option.Option<number> }>
}

/**
 * The row of chats, by creation: every header of the learner's own (`ownChat`), labelled. A chat that is no branch
 * is numbered among those ("Chat 1"); a branch is named for the chat it was cut from and the turn it was cut after,
 * read from the branch's own record at `branch.through` (`turns`, by the branch's id): "Chat 1, branch after turn
 * 2", and a branch of that one "Chat 1, branch after turn 2, branch after turn 3". A turn that could not be read is
 * left out ("Chat 1, a branch"), and a second branch with the same name is numbered ("…, branch after turn 2 (2)").
 */
export const chatsOf = (headers: ReadonlyArray<SessionHeader>, turns: ReadonlyMap<string, number>): ReadonlyArray<ChatEntry> => {
  const labels = new Map<string, string>()
  const used = new Map<string, number>()
  let roots = 0
  return headers.filter(ownChat).map((header): ChatEntry => {
    const turn = Option.fromNullishOr(turns.get(header.id))
    const branch = Option.map(Option.fromNullishOr(header.branch), ({ of }) => ({ of, turn }))
    const named = Option.match(branch, {
      onNone: () => `Chat ${++roots}`,
      onSome: ({ of }) => `${labels.get(of) ?? "Another chat"}, ${Option.match(turn, { onNone: () => "a branch", onSome: (n) => `branch after turn ${n}` })}`,
    })
    const seen = (used.get(named) ?? 0) + 1
    used.set(named, seen)
    const label = seen === 1 ? named : `${named} (${seen})`
    labels.set(header.id, label)
    return { id: header.id, label, branch }
  })
}

/**
 * What the page says when the learner's `resume` showed a chat other than the one the page asked for (picked in the
 * row, or the one shown when a branch was made): `chosen` names a chat of
 * the row, and the program named another. A `chosen` the row does not list (a session gone from the store) says
 * nothing: `resume` could not have shown it.
 */
export const ignoredLine = (chosen: Option.Option<string>, shown: string, chats: ReadonlyArray<ChatEntry>): Option.Option<string> =>
  Option.flatMap(Option.filter(chosen, (id) => id !== shown), (id) =>
    Option.flatMap(Option.fromNullishOr(chats.find((chat) => chat.id === id)), (picked) => {
      const showing = chats.find((chat) => chat.id === shown)?.label ?? "another conversation"
      return Option.some(`The page asked for ${picked.label}, and the resume in chat.ts showed ${showing}: it decides which chat is shown, and it did not take the one asked for.`)
    }))
