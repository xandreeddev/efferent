import { homedir } from "node:os"
import { join } from "node:path"

/** One place for the social agent's filesystem layout — everything hangs off
 *  the workspace tree, derived from the HOME DIR at runtime (absolute paths
 *  never belong in source). The drafts tree and the ledger live TOGETHER —
 *  the ledger is the durable memory (dedup, caps, outcomes); the draft files
 *  are just the human-readable review artifacts. */
export const WORKSPACE_TREE = join(homedir(), "Workspace", "xandreed")
export const SOCIAL_ROOT = join(WORKSPACE_TREE, "posts")
export const DRAFTS_PENDING_DIR = join(SOCIAL_ROOT, "drafts", "pending")
export const DRAFTS_POSTED_DIR = join(SOCIAL_ROOT, "drafts", "posted")
export const DRAFTS_DISCARDED_DIR = join(SOCIAL_ROOT, "drafts", "discarded")
export const LEDGER_PATH = join(SOCIAL_ROOT, "ledger.jsonl")
export const POLICY_PATH = join(SOCIAL_ROOT, "policy.json")
