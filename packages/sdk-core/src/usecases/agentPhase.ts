// Re-export from entities for backward compatibility.
// The canonical location is `@xandreed/sdk-core/entities/AgentPhase`.
export {
  AgentPhase,
  type PhaseState,
  initialPhaseState,
  submittedPhaseState,
  reducePhase,
  derivePhase,
} from "../entities/AgentPhase.js"
