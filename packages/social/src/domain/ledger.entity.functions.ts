import type { LedgerEntry } from "./ledger.entity.js"

export const engagedTweetIds = (entries: ReadonlyArray<LedgerEntry>): ReadonlySet<string> =>
  new Set(
    entries
      .filter(
        (entry) =>
          entry.targetTweetId !== undefined &&
          entry.event !== "skipped" &&
          entry.event !== "gate_rejected",
      )
      .map((entry) => entry.targetTweetId as string),
  )

export const postedInWindow = (
  entries: ReadonlyArray<LedgerEntry>,
  now: Date,
  windowMs: number,
): ReadonlyArray<LedgerEntry> =>
  entries.filter(
    (entry) => entry.event === "posted" && now.getTime() - Date.parse(entry.at) < windowMs,
  )

export const postedToAuthor = (
  entries: ReadonlyArray<LedgerEntry>,
  author: string,
): ReadonlyArray<LedgerEntry> =>
  entries.filter(
    (entry) =>
      entry.event === "posted" &&
      entry.targetAuthor !== undefined &&
      entry.targetAuthor.toLowerCase() === author.toLowerCase(),
  )
