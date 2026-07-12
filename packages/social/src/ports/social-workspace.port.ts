import { Context, Effect } from "effect"
import type { LedgerEntry, LedgerError } from "../domain/ledger.entity.js"
import type { SocialPolicy } from "../domain/social-policy.entity.js"

export class SocialWorkspace extends Context.Tag("Social/SocialWorkspace")<
  SocialWorkspace,
  {
    readonly readLedger: (path: string) => Effect.Effect<ReadonlyArray<LedgerEntry>>
    readonly appendLedger: (path: string, entry: LedgerEntry) => Effect.Effect<void, LedgerError>
    readonly loadPolicy: (path: string) => Effect.Effect<SocialPolicy>
    readonly writeDraft: (path: string, content: string) => Effect.Effect<void, LedgerError>
  }
>() {}
