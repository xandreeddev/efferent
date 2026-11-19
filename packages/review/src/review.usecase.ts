import { Clock, Effect, Schema } from "effect"
import { PassNumber } from "./finding.entity.js"
import { Findings } from "./findings.port.js"
import { PreparedReview } from "./prepare-review.entity.js"
import type { ReviewPolicies } from "./prepare-review.entity.js"
import { reviewFolderOf } from "./prepare-review.entity.functions.js"
import { STOCK_POLICIES } from "./prepare-review.usecase.functions.js"
import { prepareReview } from "./prepare-review.usecase.js"
import type { PullNumber, RepoName } from "./pull-request.entity.js"
import { ReviewLogs } from "./review-logs.port.js"
import { ReviewPasses } from "./review-pass.port.js"
import { REVIEW_PROMPT } from "./review-prompt.entity.js"
import { reviewPrompt } from "./review-prompt.entity.functions.js"
import { ReviewReport } from "./review-report.entity.js"
import { reviewReport } from "./review-report.entity.functions.js"
import { REVIEW_TOOLS_VERSION } from "./review-tools.entity.js"
import type { ReviewOptions } from "./review.entity.js"

/** Write a value as JSON through its schema; a value of the review's own that does not encode is a defect. */
const jsonOf = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
  Effect.map(Effect.orDie(Schema.encodeEffect(schema)(value)), (encoded) => `${JSON.stringify(encoded, null, 2)}\n`)

/**
 * Review a pull request: prepare it (`prepareReview`, at the commit `options.prepare.at` names), run one pass of the
 * model over it (`ReviewPasses`, its journal in `pass-1/` of the review's folder), and build the report from what the
 * pass recorded (`Findings`). The review's folder (`<number>-<sha12>/` in `ReviewLogs`) keeps, for offline scoring,
 * the prepared review (`prepared.json`) and the report (`review.json`: the prompt's and the tool set's versions, each
 * finding with its pass, each call's tokens and cost) beside the pass's journal.
 */
export const reviewPullRequest = Effect.fn("review.review")(function* (repo: RepoName, number: PullNumber, options: ReviewOptions, policies: ReviewPolicies = STOCK_POLICIES) {
  const started = yield* Clock.currentTimeMillis
  const logs = yield* ReviewLogs
  const passes = yield* ReviewPasses
  const findings = yield* Findings
  const prepared = yield* prepareReview(repo, number, options.prepare, policies)
  const folder = reviewFolderOf(prepared.pullRequest.number, prepared.at.sha)
  yield* logs.keep(`${folder}/prepared.json`, yield* jsonOf(PreparedReview, prepared))
  const pass = PassNumber.make(1)
  const result = yield* passes.run({
    prompt: reviewPrompt(prepared, { order: prepared.diff.kept }),
    reviewed: { repo, at: prepared.at.sha, files: prepared.files, pass },
    journalDir: yield* logs.folder(`${folder}/pass-${pass}`),
    options: options.pass,
  })
  const report = reviewReport({
    prepared,
    passes: [result],
    findings: yield* findings.all,
    promptVersion: REVIEW_PROMPT,
    toolsVersion: REVIEW_TOOLS_VERSION,
    model: options.model,
    wallMs: (yield* Clock.currentTimeMillis) - started,
  })
  yield* logs.keep(`${folder}/review.json`, yield* jsonOf(ReviewReport, report))
  return report
})
