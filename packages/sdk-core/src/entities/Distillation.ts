import { Schema } from "effect"

/**
 * The self-improving loop's data shapes (`docs/self-improving-loop.md`). As the
 * daemon runs real tasks, a cheap **Reflector** mines each finished conversation
 * for candidate learnings; an Opus **Verifier** refutes each one against the real
 * repo; a deterministic **Curator** persists the survivors as delta items the
 * next run auto-loads. These are the values that flow between those stages.
 */

/**
 * What a distilled learning becomes once persisted. `skill`/`memory`/`constraint`
 * are filed under `.efferent/{skills,memory,CONSTRAINTS.md}`. `process` is the
 * META layer — a rule about HOW the agent should WORK (plan first, check
 * assumptions, right-size the fleet); it edits the operating-guidance prompt
 * overlay (`.efferent/prompts/coder.md`). Because it changes the agent's OWN
 * instructions it is high-stakes: it ALWAYS passes the Opus gate — the
 * user-correction bypass never applies to it (see `runDistillation`).
 */
export const CandidateKind = Schema.Literal("skill", "memory", "constraint", "process")
export type CandidateKind = typeof CandidateKind.Type

/**
 * Where a learning is filed. `global` (general — a language/framework/style rule
 * that applies to ANY project: Effect patterns, `const` over `let`, "typed errors
 * not try/catch in domain code") → `~/.efferent/`, loaded into every workspace.
 * `project` (this-repo specifics: its structure, a named decision, a local
 * convention) → `<repo>/.efferent/`. The read side already walks both tiers
 * (closer shadows farther); this routes the WRITE.
 */
export const CandidateScope = Schema.Literal("global", "project")
export type CandidateScope = typeof CandidateScope.Type

/**
 * Who authored the rule. `user` — the human stated it explicitly (a correction /
 * instruction); it is authoritative, so it is persisted WITHOUT the Opus refute
 * gate (trustworthy by construction, like the deterministic efficiency gate).
 * `inferred` — the loop deduced it from the run; it must pass the Opus gate.
 * NOTE: the bypass is only for *additive* deposits (constraint/skill/memory),
 * never for a prompt-overlay rewrite — those always pass Opus (see Phase 2).
 */
export const CandidateSource = Schema.Literal("user", "inferred")
export type CandidateSource = typeof CandidateSource.Type

/**
 * Pointers into the real record so the verifier can **check, not trust** — the
 * conversation it came from, the message positions that evidence it, and (when
 * a file change is the evidence) the diff. The whole point of evidence is that
 * the Opus gate, running in the repo, can re-derive the claim from ground truth.
 */
export const CandidateEvidence = Schema.Struct({
  conversationId: Schema.String,
  positions: Schema.Array(Schema.Number),
  diff: Schema.optional(Schema.String),
})
export type CandidateEvidence = typeof CandidateEvidence.Type

/**
 * One candidate learning the Reflector proposes from a finished run — the
 * routine, not the raw log (AWM): `body` is the abstracted, reusable procedure
 * or rule with this-run-specific paths/ids generalized away. `kind` decides
 * where the Curator files it.
 */
export const Candidate = Schema.Struct({
  kind: CandidateKind,
  /** Short kebab-ish identity; the Curator slugifies it into a filename / bullet id. */
  name: Schema.String,
  /** One-line index summary (becomes the skill `description` / memory title). */
  description: Schema.String,
  /** The abstracted procedure (skill) or hard rule (constraint) or fact (memory). */
  body: Schema.String,
  /** Global (applies everywhere) vs project-local — routes the Curator's write. */
  scope: CandidateScope,
  /** Human-stated (authoritative, gate-bypassed) vs loop-inferred (gated). */
  source: CandidateSource,
  evidence: CandidateEvidence,
})
export type Candidate = typeof Candidate.Type

/**
 * The verify gate's structured verdict. `accept` is the gate's own boolean;
 * the orchestrator additionally requires `score >= threshold` before persisting
 * (fail-closed — see `runDistillation`). `reason` is a one-line justification,
 * surfaced in the report and in a `needs_human` decision when the gate is unsure.
 */
export const Verdict = Schema.Struct({
  accept: Schema.Boolean,
  score: Schema.Number,
  reason: Schema.String,
})
export type Verdict = typeof Verdict.Type

/**
 * The Opus **deliverable gate**'s verdict — the *other* gate (see `Verifier.gate`
 * vs `Verifier.refute`). Where `Verdict` judges a learning, this judges the
 * swarm's *output against the task*: SOUND (ship it), NEEDS WORK (the reasons are
 * the lessons the loop learns + retries on), or BLOCKED (can't proceed). Mirrors
 * the Kimi architect's three-way verdict so the coordinator reads them uniformly.
 */
export const DeliverableVerdictLevel = Schema.Literal("sound", "needs_work", "blocked")
export type DeliverableVerdictLevel = typeof DeliverableVerdictLevel.Type

export const DeliverableVerdict = Schema.Struct({
  verdict: DeliverableVerdictLevel,
  /** Concrete, actionable reasons — empty on SOUND; the retry's lessons on NEEDS WORK. */
  reasons: Schema.Array(Schema.String),
})
export type DeliverableVerdict = typeof DeliverableVerdict.Type
