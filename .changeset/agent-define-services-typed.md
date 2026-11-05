---
"@xandreed/sdk": minor
---

`Agent.define` keeps the type of its `services`: `AgentConfig<S>.services` is a `Context.Context<S>`, inferred, and the agent is an `Agent<S>` whose `turn` does not require what `use` reads of them. A host passes the context it built without a cast; an `Agent<S>` is still a `TurnRunner` (`AgentTurn`). Tools still check their `requires` by key when a turn opens them.
