import { STOCK_POLICIES } from "@xandreed/review"
import type { ReviewPolicies } from "@xandreed/review"

// The stock policies with two replaced. Everything else (grouping, packing, the file verdicts, the log digests)
// stays as it ships. Give them as reviewPullRequest's fourth argument, or prepareReview's.
export const policies: ReviewPolicies = {
  ...STOCK_POLICIES,
  // Never run a pull request's commands, whoever opened it.
  mayRun: () => false,
  // The instruction files the stock way, and a review guide at the root too.
  rulesAlong: (changedPaths) => [...STOCK_POLICIES.rulesAlong(changedPaths), "REVIEW.md"],
}
