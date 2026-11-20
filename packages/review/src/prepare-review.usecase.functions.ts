import { Option } from "effect"
import { groupFiles } from "./file-group.entity.functions.js"
import { fileVerdict } from "./file-verdict.entity.functions.js"
import type { CiRun } from "./forge.entity.js"
import { digestLog } from "./log-digest.entity.functions.js"
import { packDiff } from "./packed-diff.entity.functions.js"
import type { ReviewPolicies } from "./prepare-review.entity.js"
import type { Permission, PullRequest } from "./pull-request.entity.js"
import { rulesAlong } from "./repo-rules.entity.functions.js"

/** The conclusions of a CI run that are not a failure: everything else (failure, timed out, cancelled…) is one. */
export const PASSING: ReadonlyArray<string> = ["success", "skipped", "neutral"]

/** The permissions that let an author's commands run, in a sandbox the host gives. */
export const WRITERS: ReadonlyArray<Permission> = ["admin", "maintain", "write"]

/**
 * The stock policies: `fileVerdict`, `packDiff` (source first, in git's order), `rulesAlong` over `RULE_FILES`,
 * `digestLog`; commands may run for a head in the base repository whose author is one of `WRITERS`; a finished run
 * whose conclusion is not one of `PASSING` failed (a run still going has none and is not read yet); `groupFiles`.
 */
export const STOCK_POLICIES: ReviewPolicies = {
  group: groupFiles,
  verdict: fileVerdict,
  pack: (files, budgetTokens, earlier) => packDiff(files, budgetTokens, earlier),
  rulesAlong: (changedPaths) => rulesAlong(changedPaths),
  digest: digestLog,
  mayRun: (pull: PullRequest) => pull.sameRepo && WRITERS.includes(pull.permission),
  failed: (run: CiRun) => Option.match(run.conclusion, { onNone: () => false, onSome: (conclusion) => !PASSING.includes(conclusion) }),
}
