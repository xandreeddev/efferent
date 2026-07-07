# @xandreed/math

**`efferent math` — a standalone math-practice product on the smith pattern**
(`docs/agents/education.md`): the tutor agent authors SELF-CONTAINED exercises
(question + answer key + hint + worked solution) through its ONE tool,
`render_math`; the SERVER grades every answer instantly against the exercise's
own key — no model round-trip, no chat. Private, source-run only
(`bun run math`); depends on sdk-core + sdk-adapters + @xandreed/web and
NEVER on the cli (boundaries-gated both ways).

```bash
bun run math --grade 4 --theme "fractions" --open   # generate before the browser opens
bun run math                                        # setup form first; nothing runs until the student starts
bun run math --resume <conversationId>              # continue a practice session
```

## The harness (why this is trustworthy)

- **Strong oracle**: `gradeAnswer` (`src/domain/MathContent.ts`) grades
  integer/decimal/fraction/text/choice answers with exact rational arithmetic
  (fraction keys accept equivalent forms) — deterministic, instant, no LLM.
- **Enforced item admission**: `parseMathItems` validates every `render_math`
  item structurally + semantically (unique ids, parseable keys, choice keys
  reference an option, no picture-referring prompts); rejected items return to
  the model as data (`failureMode: "return"`) with the exact reason — the
  model fixes and re-sends ONLY those. The UI shows accepted items only.
- **The student never chats**: the server composes machine-formatted
  `[action]`/`[progress]` messages (`src/protocol.ts` — format AND parse in
  one module, so live sends and replay can never drift). The tutor adapts
  from the `[progress]` line, not from conversation.
- **Replay ≡ live-fold**: `replayMath` rebuilds the UI model from the
  persisted log through the same `parseMathItems` + `putItems` the live path
  uses (`--resume` serves answered exercises as answered, never again).

## Layout (boundaries: math → core + adapters + web, never cli)

```
src/
├── main.ts        argv fold → composition root (sdk-adapters at the edge, BunContext) → runMathMode
├── mode.ts        the driver: fresh-or-resumed conversation → MathSession → pump → HTTP server
├── session.ts     the chassis (smith pattern): ONE persisted conversation + an append-only
│                  event ledger (AgentEvent ∪ math_render); send serializes turns; interrupt
│                  stops the in-flight fiber; subscribe replays by seq then streams live
├── toolkit.ts     render_math (Tool.make, permissive Unknown items → per-item salvage in the
│                  handler) + mathAgentBundle (config + handler layer bound to the render sink)
├── prompt.ts      the tutor system prompt (versioned; the full-exemplar render_math contract)
├── protocol.ts    [action]/[progress] compose + parse (Option-returning; one module, no drift)
├── domain/        MathContent: item schemas + parseMathItems (admission) + gradeAnswer (oracle)
└── web/           the product UI: model (pure state machine) · reduce (session events → model)
                   · replay · render (model → @xandreed/web math views) · pump (model Ref +
                   OOB fragment hub) · server (typed /action/* routes; check/reveal/report/
                   next/setup are server-instant; more/harder/easier/topic fire ONE agent turn,
                   coalesced while generating) · openBrowser
```

The math VIEWS (topbar/stage/exercise card/controls/setup, math.css/math.js,
`sanitizeMathml`) live in `@xandreed/web` — pure server-rendered strings, the
same package the web canvas uses. Model-authored MathML renders ONLY through
the strict rejecting `sanitizeMathml` (one well-formed `<math>`, presentation
elements + layout attributes only; anything else simply doesn't display).

## Rules

- ZERO-entry ratchet baseline (like smith): any new `let`/loop/nullable-return/
  tag-switch/as-any/try-catch in `packages/math/src/**` fails `bun run typecheck`.
- The grader and admission gates never call an LLM. The agent's only output
  channel is `render_math`; everything the student sees is server-rendered.
- Model selection comes from the user's `.efferent/config.json` (the smith
  lesson: `EFFERENT_MODEL` is dropped at the edge with a stderr note).

## Testing

`bun test packages/math` — key-free: the grader (equivalent fractions,
tolerance decimals, choice labels), admission (rejections carry reasons),
protocol round-trips, the pure model state machine, reducer, replay≡live-fold.
The web views' tests live in `packages/web`. Live keyed runs are manual
(`bun run math --grade … --theme …` + the browser).
