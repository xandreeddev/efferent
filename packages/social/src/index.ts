/**
 * The social agent's public surface — what a scenario pack (or the parent
 * tree's tooling) may import: the deterministic policy gates, the ledger,
 * and policy loading. Adapters and usecases stay package-internal.
 */
export { runSocialGates, renderFindings } from "./domain/gates.js"
export { LedgerEntry } from "./domain/ledger.entity.js"
export { engagedTweetIds, postedInWindow, postedToAuthor } from "./domain/ledger.entity.functions.js"
export { DEFAULT_POLICY, SocialPolicy } from "./domain/social-policy.entity.js"
export {
  appendLedger,
  loadPolicy,
  LocalSocialWorkspaceLive,
  readLedger,
} from "./adapters/local-social-workspace.adapter.js"
/** Scenario/test seams: deterministic handlers over injectable edge ports. */
export { makeSocialHandlers } from "./usecases/socialToolkit.js"
export { BlogReader } from "./ports/blog-reader.port.js"
export { XPlatform } from "./ports/x-platform.port.js"
export { SocialWorkspace } from "./ports/social-workspace.port.js"
export type { BlogPost } from "./ports/blog-reader.port.js"
export type { XNotification, XSearchResult } from "./ports/x-platform.port.js"
export {
  DRAFTS_DISCARDED_DIR,
  DRAFTS_PENDING_DIR,
  DRAFTS_POSTED_DIR,
  LEDGER_PATH,
  POLICY_PATH,
  SOCIAL_ROOT,
} from "./domain/paths.js"
