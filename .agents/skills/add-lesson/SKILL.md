---
name: add-lesson
description: Checklist for adding or changing a lesson of the website's learn track (/learn) — the kernel cut first, the shown sources as strings with typed modules for tsc, deriving agent.ts from the base program by named pieces, the kernel's modelAnswer and callTool for the loop, starter texts Format leaves alone, Echo rules with failing-without tests, page tests for every claim the mdx makes, budgets probed on Echo and a real model, and a WebGPU browser pass that presses every button the mdx names. Read before creating src/learn/lessons/<slug>/ or src/content/learn/NN-<slug>.mdx.
---

# Add a lesson

A lesson teaches one kernel idea by letting the learner run and break it.
`packages/website/AGENTS.md` describes the parts; this is the order and the
checks.

## 1. The kernel cut first

- What the lesson needs from the kernel lands first, with its tests, an ADR
  when it decides something (skill `kernel-architecture`) and a section of
  `docs/kernel.md` quoting a pinned test region.
- The lesson imports only the two kernel entries (`imports.test.ts`).

## 2. The files the learner sees

- Each file is a string in `<name>.source.ts`: read-only imports, then the
  editable part. Build on an earlier text by replacing named pieces of it
  (`REPLACED`, pairs of `[from, to]`, applied with `replaced`), never by
  copying it, and add a test that the earlier text still holds each `from`
  once (a silent `replace` miss shows the wrong program).
- A new lesson's `agent.ts` derives from `lessons/base/agent.source.ts`
  (`BASE_AGENT`, `IMPORTS`, `typedModule`): lesson 2's program on the
  kernel's two functions. Its loop reads the model's stream with
  `modelAnswer(stream, session, { onText })` and runs each call with
  `callTool(toolkit, call, session)`; neither block is written by hand
  after lesson 2. A program of another shape (lesson 4's `loop.ts`) is a
  text of its own, on the same two functions.
- A tool's handler that reaches its turn declares
  `dependencies: [CurrentTurn]` and takes it with `yield* CurrentTurn`:
  `callTool` provides it. Its `append` and `publish` cannot fail in their
  type, so the handler needs no `Effect.orDie`.
- `lesson.ts` gives each file the names its shown imports list, no more and
  no fewer.
- Every starter text is tidy: the page's Format button changes none
  (`format.test.ts`). Run the formatter over a new text and adopt its
  output, then read it: a comment still sits above the line it explains.
  A control's pattern matches its line in both forms Format can leave it
  (a long `const system =` wraps onto two lines).
- `moduleOf` turns the text into a typed module for tsc: replace exactly the
  lines that need types (a parameter, a table of kinds), nothing else. With
  the kernel's functions a loop needs no cast.
- Comments are for the learner: what it does and why, in sentences.
- A tool whose result the UI shows works out what it shows from a few words
  of the model's: the model's call is conversation and is sent again (ADR
  0009).

## 3. Tests that can fail

- `program.test.ts`: tsc over every shown file, and the program run on
  `scriptedModel`, asserting the prompts the model received exactly.
- `lesson.test.ts`: the page's runtime with Echo. Assert each claim the mdx
  makes as it is worded, without a filter that hides the case it is about
  (no role filter on "the model never sees it"; no count that a vacuous run
  passes). Each experiment does what its text says.
- An Echo rule gets a direct test in `models/models.test.ts` that fails
  without the rule.

## 4. Numbers

- Probe budgets, sizes and counts on Echo before writing them into the mdx
  (how many presses compact, how long a turn is), then pin them in a test.
- Run one real model on the GPU through the lesson's main path. Write what
  it does into the mdx (a small model may not call a tool; a summary may not
  fit a small budget) rather than promising Echo's behaviour.

## 5. The page

- `NN-<slug>.mdx` steps focus a pane and a file; the last step links the next
  lesson and the ADR. The previous lesson's "Next" links here; the learn
  index lists what is still to come.
- Controls and experiments go in `src/components/learn/<slug>/`.

## 6. Checks

- [ ] Kernel cut merged or in the same PR, with its docs and ADR
- [ ] `imports.test.ts`, `format.test.ts`, `program.test.ts` (the base holds
      each piece replaced), `lesson.test.ts`, the Echo rule's test
- [ ] Every button and chip the mdx names pressed in WebGPU Chrome, at
      1600×1000 and 390×844, light and dark, the screenshots looked at; Stop,
      Rebuild and Clear context tried where the lesson's state lives
- [ ] One real-model run, and the mdx says what it did
- [ ] CHANGELOG entry; the full definition of done
