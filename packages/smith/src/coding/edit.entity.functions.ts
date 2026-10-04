import { fingerprintOf } from "@xandreed/core"
import { Option } from "effect"
import type { EditProposal, ProposedChange } from "./edit.entity.js"

export const changeOf = (path: string, original: Option.Option<string>, content: Option.Option<string>): ProposedChange => ({
  path, original, originalFingerprint: Option.map(original, fingerprintOf), content,
})
export const changed = (change: ProposedChange): boolean => !Option.makeEquivalence((left: string, right: string) => left === right)(change.original, change.content)
const changePreview = (change: ProposedChange): string => {
  const before = Option.getOrElse(change.original, () => "").split("\n")
  const after = Option.getOrElse(change.content, () => "").split("\n")
  const prefix = before.findIndex((line, index) => line !== after[index])
  const at = prefix < 0 ? Math.min(before.length, after.length) : prefix
  const reverseBefore = [...before].reverse()
  const reverseAfter = [...after].reverse()
  const reverseDifference = reverseBefore.findIndex((line, index) => line !== reverseAfter[index])
  const suffix = Math.min(reverseDifference < 0 ? Math.min(before.length, after.length) : reverseDifference, Math.min(before.length, after.length) - at)
  return `@@ line ${at + 1} @@\n${before.slice(Math.max(0, at - 2), at).map((line) => ` ${line}`).join("\n")}\n${before.slice(at, before.length - suffix).map((line) => `-${line}`).join("\n")}\n${after.slice(at, after.length - suffix).map((line) => `+${line}`).join("\n")}\n${after.slice(after.length - suffix, after.length - suffix + 2).map((line) => ` ${line}`).join("\n")}`
}
export const renderProposal = (proposal: EditProposal): string => [
  `Proposal ${proposal.id}`,
  proposal.summary,
  ...proposal.changes.map((change) => `${Option.isNone(change.original) ? "create" : Option.isNone(change.content) ? "delete" : "update"} ${change.path}\n${changePreview(change)}`),
].join("\n\n")
