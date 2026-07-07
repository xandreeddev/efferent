/** @xandreed/foundry — the factory: a verification loop + gate pipeline.
 *  Spec → implement → deterministic gates → typed feedback → retry until
 *  sound. The public surface; drivers compose Layers at their own edge. */

// domain
export * from "./domain/Brands.js"
export * from "./domain/Errors.js"
export * from "./domain/EvalContract.js"
export * from "./domain/FactoryRun.js"
export * from "./domain/Finding.js"
export * from "./domain/Rules.js"
export * from "./domain/Spec.js"
export * from "./domain/Verdict.js"

// ports
export * from "./ports/Gate.js"
export * from "./ports/Implementor.js"
export * from "./ports/RunSink.js"

// pipeline
export * from "./pipeline/baseline.js"
export * from "./pipeline/forge.js"
export * from "./pipeline/renderFeedback.js"
export * from "./pipeline/runPipeline.js"

// gates
export * from "./gates/astWalk.js"
export * from "./gates/boundariesGate.js"
export * from "./gates/evalShapeGate.js"
export * from "./gates/idiomGate.js"
export * from "./gates/judgeGate.js"
export * from "./gates/rules/index.js"
export * from "./gates/TsProject.js"
export * from "./gates/typecheckGate.js"

// adapters
export * from "./adapters/claudeImplementor.js"
export * from "./adapters/fileRunSink.js"
export * from "./adapters/scriptedImplementor.js"
export * from "./adapters/tempWorkspace.js"

// cli building blocks (renderers only — the driver is main.ts)
export * from "./cli/check.js"
export * from "./cli/report.js"
