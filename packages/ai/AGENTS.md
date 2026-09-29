# @xandreed/ai

Versioned prompts on effect/ai. Runtime dependencies are Effect (effect/ai included)
and @xandreed/core only: no provider SDKs, no host imports.

- Model prompts (`prompt.entity.ts` + `.functions.ts`): `definePrompt` gives
  a prompt an id and a version; variants carry fragments per provider and per
  model, and `renderPrompt` composes the one a `ModelTarget` selects and
  records its `PromptProvenance`. `generateText` / `generateObject` call the
  LanguageModel under that provenance; `promptSection` makes a prompt a
  system-prompt section.
- Decision prompts (`decision.entity.ts` + `.functions.ts`): boolean and
  choice questions about a state, asked of an `EvaluationModel`; answers must
  answer exactly the questions asked, choosing only offered choices.
- `PromptId`, `PromptProvenance` and `CurrentPromptProvenance` stay in core,
  where model adapters read them; this package re-exports them.
- Hashes are SHA-256 hex over Web Crypto (`hash.adapter.ts`): of the encoded
  prompt for model prompts, of `{ state, questions }` for decisions. Keep
  them byte-stable: recorded provenance depends on it.

Service tags live in `src/ports`; the transport bridge is
`evaluation-model.adapter.ts`. See the root AGENTS.md for the enforced
zero-baseline rules and checks.
