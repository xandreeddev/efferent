/**
 * The social agent's public surface — what a scenario pack (or the parent
 * tree's tooling) may import: the deterministic policy gates, the ledger,
 * and policy loading. Adapters and usecases stay package-internal.
 */
export { runSocialGates, renderFindings } from "./domain/gates.js"
export { appendLedger, LedgerEntry, readLedger } from "./domain/Ledger.js"
export { DEFAULT_POLICY, loadPolicy, SocialPolicy } from "./domain/policy.js"
/** Scenario/test seams: deterministic handlers over injectable edge ports. */
export { makeSocialHandlers } from "./usecases/socialToolkit.js"
export { BlogReader } from "./ports/BlogReader.js"
export { XPlatform } from "./ports/XPlatform.js"
export type { BlogPost } from "./ports/BlogReader.js"
export type { XNotification, XSearchResult } from "./ports/XPlatform.js"
export {
  DRAFTS_DISCARDED_DIR,
  DRAFTS_PENDING_DIR,
  DRAFTS_POSTED_DIR,
  LEDGER_PATH,
  POLICY_PATH,
  SOCIAL_ROOT,
} from "./domain/paths.js"
