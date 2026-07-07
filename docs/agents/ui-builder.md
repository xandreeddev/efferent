# The live UI builder (deterministic gates on `efferent web`)

**Oracle: medium-strong** — the artifact is structured markup, so whitelist /
wiring / schema gates behave like a type checker. `efferent web` already
streams htmx pages from `render_ui` through a security sanitizer; what's
missing is everything ABOVE security: today the design system (Tailwind,
post-pivot), a11y, and hx-wiring correctness are 100% advisory (prompt-taught,
never enforced). This plan promotes them to gates at the one seam with a
model-feedback loop.

## The two seams (verified)

- **Seam A** — the `render_ui` handler (`buildScopeRuntime.ts`,
  `failureMode:"return"` — the `HtmlTooLarge` precedent): the ONLY point where
  a rejection returns to the model as data, so the model self-corrects within
  the turn. Hard gates live here.
- **Seam B** — `renderRegion` (`packages/web/src/components/page.ts`, where
  `sanitizeHtml` runs): server→browser only, no feedback loop. Advisory
  findings surface here as the existing `dropped[]` corner-chip mechanism,
  extended into a findings strip.

## Architecture: the injected validator

Pure `validateUi(html, opts) → UiFinding[]` lives in `@xandreed/web`
(`src/validate.ts`), sharing the sanitizer's tokenizer so the two vocabularies
cannot drift. sdk-core cannot import web (boundaries: both `canImport: []`),
so the handler receives the validator by INJECTION — a new
`BuildScopeRuntimeOptions.validateUi` field, the `onBusEvent` precedent —
wired by the web driver's composition root (and the eval); TUI/daemon paths
pass nothing and are untouched. `UiFinding` is a structural readonly type
declared in sdk-core (`{rule, severity, message, fixHint?}` — foundry's
Finding discipline; fail ⟺ ≥1 error finding), satisfied structurally with no
cross-import. Error findings map to a `UiRejected` failure with a
deterministic sorted/capped `renderUiFeedback` brief; bounded regeneration =
the loop's remaining `maxSteps`; a page that never passes doesn't render —
fail-closed, and every enforced rule is mechanically fixable from findings.

## Gate list

**Enforced at Seam A**: size (existing 128KB) · id-sanity (kebab, no chrome
prefixes — today only the tool description says this) · **dangerous-
vocabulary** (a sanitize dry-run must drop nothing in the dangerous class —
script/style/iframe/svg/on*/hx-on/hx-swap-oob/non-`/action` targets; today
these are silently stripped so the model never learns; promoted to feedback) ·
**hx-wiring** (every `hx-target` resolves in-fragment; every form carries
`hx-post="/action/ui"` + hidden `ui-id` + `hx-swap="none"`; submitting
controls' inputs are named) · **a11y-minimum** (img alt; labeled form
controls; ≥1 heading per whole-page render; non-empty button/anchor text) ·
**no-arbitrary-value Tailwind classes** (`w-[437px]`, and critically
`bg-[url(https://…)]` — the Tailwind JIT would reopen the remote-fetch
channel the `style`-attribute ban closed; security-justified hard ban).

**Advisory at Seam B** (chips, never blocking): unknown-family utility
classes, unwrapped benign tags, skipped heading levels, unusual `hx-trigger`
values. **Eval-only** (taste/threshold — wrong as per-render hard rules):
design-system family conformance, page structure, multi-column, mermaid
presence, region isolation, no-file-punt trajectory, quality judge.
Promotions from eval to runtime: `sanitizer_clean` → dangerous-vocabulary;
`interactive_contract` → hx-wiring — and the eval predicates call the SAME
`validateUi` the runtime enforces (one oracle).

## Design-system policy (decided)

**Stay on Tailwind.** Resurrecting the ef-* kit as a typed component registry
fights the pivot (prompt, kit doc, and eval all teach Tailwind now) and fights
the model's native fluency — high cost, negative payoff. Conformance-by-
pattern-family (the eval's utility families generalized into an allow-table)
stays advisory + eval-scored; the ONE hard class rule is the arbitrary-value
ban. The replacement for a prop-schema registry is the **doc↔validator
contract test** (the `uiKit.test.ts` precedent): every enforced rule must be
taught in `RENDER_UI_KIT_DOC`, every taught pattern must be in an allowed
family. A Schema-described component registry remains a documented deferred
option if the hybrid is ever wanted.

## PR phasing

W1 `validateUi` in `@xandreed/web` + full test matrix (attack cases mirroring
`sanitize.test.ts`; wiring fixtures: dangling target, formless ui-id,
unlabeled input; `bg-[url(...)]`) → W2 Seam A wiring in sdk-core
(`validateUi?` option + structural `UiFinding` + golden-tested
`renderUiFeedback`; absent-validator path byte-identical) → W3 Seam B chips +
the kit-doc "enforced rules" block + the doc↔validator contract test →
W4 eval promotion (`wiring_valid`/`a11y_min`/`no_arbitrary_values` predicates;
evals layer legitimately gains `@xandreed/web`) + baseline defense (**the
web-ui eval's 0.93 must not regress** — expected neutral-to-up: passing pages
see zero change, broken wiring now self-corrects) + live smoke (a
deliberately broken form regenerates within the turn).
