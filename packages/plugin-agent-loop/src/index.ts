export {
  type CompactionPlan,
  DEFAULT_MAX_STEPS,
  DEFAULT_TOOL_CONCURRENCY,
  DEGENERATE_LOOP_STOP,
  DEGENERATE_REPEAT_NUDGE,
  foldProgress,
  type LoopToolChoice,
  nextPhase,
  type Phase,
  runLoop,
  type RunLoopOptions,
  type StepView,
} from "./loop.js"
export { runSteps, STEP_LOOP, StepLoopLive, stepLoopPlugin, stepLoopPlugin as default } from "./step-loop.adapter.js"
