// The review eval for `efferent-eval`, on Node 24 (from packages/evals-cli: `node --import tsx src/main.ts run replay
// --config ../review/eval.config.ts --split tuning`): the app is `src/evals/review-eval.adapter.ts`, gated there.
import { Effect } from "effect"
import { reviewEvalApp } from "./src/evals/review-eval.adapter.js"

export default () => Effect.runPromise(reviewEvalApp)
