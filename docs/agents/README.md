# The agent line

Four agents, one doctrine: **Agent = Model + Harness**. The model is rented and
changes under you; the harness — instructions, tools, sandboxes, orchestration,
guardrails/hooks, observability — is what we own and where the leverage is.
Two aspects are never advisory: **validation** (deterministic gates the model
cannot skip) and **looping** (failure output is the next input; the GATE
declares victory, never the model). Foundry (`docs/foundry.md`) is the house
factory that embodies both; every agent below either drives it directly or
mirrors its Finding/verdict/fail-closed/feedback-brief discipline.

The runtime's old self-improving harness (Opus LLM-judge gate, gateLoop,
autoLoop, autoDistill, Verifier, Directive/`:verify`) was a **bad version of
foundry** — an LLM judge where a deterministic gate belongs. It gets excised;
the CLI adapts to foundry, not the other way around (see `coder.md`).

Investment follows **validation-oracle strength** — the cheaper the
deterministic oracle, the less human oversight needed:

| Agent | Oracle | Where the harness effort goes | Human-in-loop |
|---|---|---|---|
| [Coder](coder.md) | Strong (typecheck/tests/static gates) | SpecDoc refinement + the forge loop | Spec refinement only |
| [Education](education.md) | Strong (deterministic grader + expression oracle) | Admission gates + validated pool | Low |
| [UI builder](ui-builder.md) | Medium (schema/whitelist/wiring gates) | `validateUi` at the render seam | Low–medium |
| [Social](social.md) | Weak (subjective) | Policy gates + ledger + approval queue | High (replies: forever) |

Shared architecture rules: gates fail **closed** (a gate that cannot run is a
`fail`, never a silent pass); a rejected run is a **result**, not an error;
every enforced rule is mechanically fixable from its findings (the model
self-corrects via `failureMode: "return"`); packages stay decoupled behind the
boundaries gate; every new line rides the repo ratchet (zero new findings).

**Testing discipline** (`../evals-v3.md`): every agent's definition of done is a
**full-scenario battery**, not a smoke — a multi-step evals-v3 scenario pack
(live model + deterministic evidence checks over the event trail, the persisted
conversation, and the workspace, plus anchored judges) with a **committed
baseline** the default eval run regression-gates against. The pack ships in the
same PR as the agent behavior it covers.
