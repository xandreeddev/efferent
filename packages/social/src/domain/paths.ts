/** One place for the social agent's filesystem layout. The drafts tree and
 *  the ledger live TOGETHER — the ledger is the durable memory (dedup, caps,
 *  outcomes); the draft files are just the human-readable review artifacts. */
export const SOCIAL_ROOT = "/home/asiborro/Workspace/xandreed/posts"
export const DRAFTS_PENDING_DIR = `${SOCIAL_ROOT}/drafts/pending`
export const DRAFTS_POSTED_DIR = `${SOCIAL_ROOT}/drafts/posted`
export const DRAFTS_DISCARDED_DIR = `${SOCIAL_ROOT}/drafts/discarded`
export const LEDGER_PATH = `${SOCIAL_ROOT}/ledger.jsonl`
export const POLICY_PATH = `${SOCIAL_ROOT}/policy.json`
