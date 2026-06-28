---
"@xandreed/sdk-core": minor
"efferent": minor
---

Gate every swarm objective through the Opus verifier (mandatory, fail-closed).

When a run uses sub-agents, the finished objective is now validated by the independent Opus gate in `driveLoop` — the single use case every mode funnels through — before the run is done, regardless of whether a coordinator was used or the model called a tool. On `needs_work` the loop distills reusable lessons, re-runs with the gate's reasons fed back, and re-gates, up to `maxLoopAttempts`; an unavailable verifier is surfaced loudly (a new `gate` `AgentEvent`), never a silent pass. Gated by the existing `autoLoop` setting (default on); a run with no sub-agents is unaffected.
