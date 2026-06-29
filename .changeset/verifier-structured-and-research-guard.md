---
"@xandreed/sdk-core": patch
"@xandreed/sdk-adapters": minor
"@xandreed/cli": patch
"@xandreed/evals": patch
---

fix(verifier): structured (provider-enforced) verdicts — no more "could not parse a verdict"; plus a non-vacuous research-read-only guard.

A live run hit `⚠ verifier UNAVAILABLE — work NOT verified: could not parse a deliverable verdict`. claude had answered fine (43–56s, three times) — the failure was the **extractor**: the gate ran the `claude` CLI (`--output-format json`, a free-text answer) and scraped the verdict with a greedy `/\{[\s\S]*\}/`. An Opus assessment of CODE is full of braces, so the greedy span swallowed the prose into an unparseable blob. The CLI has no schema-enforced output mode, so *some* parsing was unavoidable on that path.

- **Structured verdicts (the real fix).** A new `StructuredVerifierLive` judges with Opus via `generateObject` and a Schema — a **provider-enforced** `{ verdict, assessment, reasons }`. A parse error is structurally impossible. Independence is preserved by a controlled validator system prompt (no project narrative) + a pinned model (`EFFERENT_VERIFY_MODEL`, default `anthropic:claude-opus-4-8`); a code gate embeds the changed-file contents in the prompt to check against ground truth. **Prose feedback is preserved, not lost** — `assessment` is a first-class field that leads the `reasons` fed back to the retry loop. Fail-soft as before (any error → `VerifierError` → caller falls back to the architect). The old `claude`-CLI verifier (`ClaudeHeadlessVerifierLive`) is removed.
- **Research read-only guard, de-vacuumed.** The `researchReadOnly` eval scorer scored 1 whenever the fleet wrote nothing — which is trivially true when the root never delegated (the live run's actual behavior), a false pass. It now scores 1 only when the fleet ran AND wrote nothing; a no-delegation run scores 0 with a clear detail, so the read-only property is never claimed without being exercised.
- **Deterministic Fix-3 wiring test.** `constrainToReadOnly` was unit-tested, but the `researchSubtree` flag → handler path wasn't. New tests drive the real `run_agent` handler: with `researchSubtree` set, `agent:"coordinator"` is refused (`ResearchStaysReadOnly`); without it, the same spawn proceeds — proving the flag is what gates it.
