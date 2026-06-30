---
"@xandreed/sdk-core": patch
"@xandreed/sdk-adapters": patch
"@xandreed/cli": patch
---

fix(verifier): revert to the Claude Code (`claude -p`) gate with a robust parse — no more "verifier UNAVAILABLE".

The verify gate fell open ("⚠ verifier UNAVAILABLE — work NOT verified") on a live headless run. #88 had swapped the `claude -p` subprocess verifier for `StructuredVerifierLive`, which calls the **Anthropic API** via `generateObject` on a pinned `anthropic:claude-opus-4-8`. That is wrong for a headless opencode setup: it's not the engine's model, the opencode provider has no `generateObject` at all, and Anthropic's `generateObject` is a *forced tool call + client-side decode* — Anthropic treats the schema as a hint, not a contract. Opus returned `reasons: ""` (string), the strict `Schema.Array(Schema.String)` decode rejected it, and the gate surfaced `unavailable` → the work shipped unverified.

- **Restore `ClaudeHeadlessVerifierLive`** — an INDEPENDENT Opus referee run via the real `claude` Claude Code CLI in a clean-room sandbox (verified empirically: with `HOME=<sandbox>` + a controlled cwd, **no project/global `CLAUDE.md`/`AGENT.md` leaks into the judgment, even with `--add-dir`**). Provider-agnostic of the engine's model; uses the Claude subscription rate. Re-wired in `main.ts` (needs only `Shell`); `StructuredVerifierLive` removed.
- **Robust parse (the reason #88 dropped the CC verifier).** The old greedy `/\{[\s\S]*\}/` grabbed first-brace-to-last and broke on a brace-heavy Opus assessment. New shared `extractJsonObjects` (sdk-core) does a string-aware **balanced-brace scan**, returning objects last-first so the trailing verdict wins past pages of code-laden prose. The verdict schema is **tolerant** (`reasons` accepts an array, a bare string, or missing — the exact `reasons: ""` shape that broke the structured verifier). A present-but-unparseable reply degrades to `needs_work` (**fail-closed**, re-check the work) via a keyword fallback — `unavailable` now means only its true cause: `claude` absent, a non-zero exit, or no output.

Verified live: the real `claude` gate returns a parsed `sound` for a well-sourced answer and `needs_work` (with concrete reasons) for a vague one — no decode failure, no "unavailable". Guarded by unit tests for the brace-heavy and `reasons:""` cases that the old tests never covered.
