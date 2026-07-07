# The education agent (`efferent math`)

**Oracle: strong** — the domain gives us a compiler-grade signal: answers are
machine-gradeable. The stashed slice already built it: `gradeAnswer` in
`MathContent.ts` is a pure, total, instant grader over exact rational
arithmetic (fractions, mixed numbers, decimals→rationals, tolerance, accept[]
alternates, choices). The harness effort goes to ADMISSION (nothing reaches a
student unverified) and the VALIDATED POOL (on-the-fly becomes
instant-from-pre-validated-stock).

## The shape

A structured tutor, not a chat: the model's ONLY output channel is
`render_math({items})` (batches of self-contained exercises: prompt, optional
MathML, choices, answer key, hint, worked solution, difficulty). The student
never chats — the server composes machine messages (`[action] start grade=4
theme="fractions"` / `more` / `harder` / `easier` / `topic`, prefixed by a
`[progress]` line) and grades every answer SERVER-SIDE via `gradeAnswer` — no
model in the check path. Substrate status: the full slice (entity+grader,
prompt, protocol, server, web components, eval) sits in `git stash@{0}`;
wiring (tool registration, subcommand, contract paths, sanitizeMathml, static
assets) must be re-authored — the stash never captured tracked-file edits.

## Placement

- `sdk-core/entities/MathContent.ts` — entity + grader + `parseMathItems`
  (the handler needs them; one implementation for handler, replay, pool, eval).
- `packages/web` — math design system, `sanitizeMathml`, assets (server-owned
  visuals; the model authors content, never markup).
- **NEW `packages/math`** (`@xandreed/math`, post-foundry standard: zero
  ratchet baseline, no-try-catch) — tutor prompt, driver protocol, pool
  domain/ports/adapters/pipeline.
- `packages/cli/src/math/` — the HTTP driver (mode/server/pump/reduce/render/
  replay) stays for now; shrinks to composition + HTTP once math owns the
  logic. Boundaries: `math` canImport core+foundry; cli+evals gain `math`;
  evals gains `web` (the eval must call the real sanitizer).

## Gate list

**Enforced in-handler** (`render_math`, `failureMode:"return"`, per-item
salvage — rejections are Finding-shaped so the bounce is a feedback brief):
G1 schema decode · G2 semantic invariants (unique ids, keys parse, choice key
∈ options, picture/diagram prompts REJECTED — MathML can't draw) · G3 key
self-consistency (`gradeAnswer(key, key.value).correct`) · G4 accept[]
consistency · G5 MathML strict-sanitize via an injected `validateMathml` seam
(core stays pure) · G6 session dedupe (ids + normalized prompts).

**Enforced in the driver**: G7 all grading server-side · G8 bounded
regeneration (short first batch → ONE `[reject]` machine message carrying the
findings, then pool fallback / error card — never silence) · G9 render-time
sanitize (defense in depth) · G10 interrupt-on-topic-switch + turn coalescing.

**Enforced at pool admission** (offline — latency is free, so the strongest
checks live here; quarantine + regenerate with a feedback brief, max 2):
G11 rerun G1–G5 · G12 dedupe-vs-pool (`UNIQUE(grade, theme, prompt_norm)`) ·
G13 difficulty-band membership · **G14 expression oracle** — expression-shaped
items are independently re-derived with the exact-rational arithmetic and must
match the key (a REAL independent oracle, zero model cost; non-expression
items skip) · **G15 solver cross-check** — a fast-tier model answers the
exercise WITHOUT seeing the key; `gradeAnswer(key, solverAnswer)` must agree ·
G16 serve dedupe + retirement cap.

**Advisory**: difficulty-floor on `harder`; dispute telemetry (`/action/report`
→ a disputes row + immediate quarantine of the pool entry — one student's
dispute protects the next). **Eval-only** (`mathUi.eval.ts`): batch size,
zero-rejections, key self-consistency, MathML hygiene, fresh-ids, harder-not-
easier + an arithmetic LLM judge; new cases for dispute handling and
admission-calibration (measures the harness itself).

## The validated pool (the product payoff)

Generate-ahead into per-(grade, theme, difficulty) buckets; validate offline
through G11–G16; serve INSTANTLY from the pool (`pool.take` → session-unique
id remap → render; a `[pool]` protocol message persists via
`ConversationStore.append` so `--resume` replay ≡ live); top up asynchronously
(a scoped fiber to a high-water mark + `efferent math warm` for CI). Pool
empty → the live generate path with the in-handler gates. Store:
`~/.efferent/math.db` (product-local bun:sqlite behind a `MathPoolStore` port
— NOT the switchable conversation store; content tables don't belong in a
dual-dialect migration chain). Doctrine note: with a warm pool, difficulty
adaptation moves from the model into code — the harness owns the loop; the
model only authors new stock.

## Student model (phase 2, minimal)

A `mastery` table in the same product store (EWMA per grade×theme, folded from
graded progress); one pure `selectDifficulty(mastery)` feeding pool band
selection and auto `harder`/`easier` — the student's explicit buttons always
win.

## PR phasing

M1 land the stash (`git stash branch feat/math-product 'stash@{0}'`; relocate
prompt+protocol into `packages/math`; re-author wiring; ratchet answer: comes
in CLEAN — enumerated let/loop/nullable/try-catch rewrites, branded ids,
Schema.Class) → M2 eval revival (boundary-legal imports, registered) →
M3 in-handler gates G3–G6 + G8 → M4 the pool (admission pipeline + pool-first
serve + `warm`) → M5 telemetry + eval cases → M6 mastery (design shipped,
build later). Verification: full test suites per PR + tmux/browser smoke;
pool proof = warm the pool, kill credentials, first batch still serves.
