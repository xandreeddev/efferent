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
  Lessons 13 and 19 alone may also name the eval package
  (`@xandreed/evals`, `@xandreed/evals/stats`), each in its own files, and
  the page loads it only when the lesson's button is pressed (a dynamic
  import of its `run.ts`), so no other page carries it. A lesson that needs
  another package names it the same way: in its own files alone, loaded
  when it is used, with `imports.test.ts` widened for that lesson and no
  other, and the built JS of another lesson's page compared before and
  after. A file the learner edits that imports such a package is run by
  the build without it (a name read only when the code runs), and again
  with it when the button is pressed.
- A lesson that needs a model's judgement with no model in the page (lesson
  19's Jev) has a stand-in of recorded answers, keyed on the whole request,
  that refuses any other request in words that ask for a key; it never
  invents answers. The real path runs over a fake `fetch` in tests.

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
- A file whose editable part must carry a type (lesson 14's failures.ts:
  `ReadonlyArray<Failure>`) ends its read-only part with the typed
  declaration and leaves one expression to edit, as memory.ts does: the
  page runs the editable text as JavaScript and Format parses it with
  Babel, and neither takes a type annotation. The tests then compile the
  file as shown, with no named piece.
- `moduleOf` turns the text into a typed module for tsc: replace exactly the
  lines that need types (a parameter, a table of kinds), nothing else. With
  the kernel's functions a loop needs no cast. Its `run` is annotated
  `): Effect.Effect<unknown, unknown> =>`: the program needs nothing more,
  so a module `main` was not given does not compile. What the page gives
  and no import names (`pane`, `model`, lesson 9's `approvalOn`) is a
  parameter of `run`.
- No cast around a tool, a toolkit, a call or a layer, in the shown files,
  the typed modules or the page's code. A loop written over any toolkit
  takes `Toolkit.WithHandler<Tools> & OwnTools<Tools>`, as `callTool` does.
  `lesson.ts` reads the untyped values a file made with `named`
  (`evaluate.ts`) and guards (`Layer.isLayer`, `typeof`), and hands `main`
  over with `programOf`, the one place the page says an untyped program
  needs nothing more.
  An Effect a file made that needs a service the page holds (lesson 15's
  `resume`, what `branchFrom` gave) gets it with `Effect.provideService`,
  goes through `programOf`, and what it gives is decoded with the
  kernel's schema (`SessionId`), never cast.
- Comments are for the learner: what it does and why, in sentences.
- A tool whose result the UI shows works out what it shows from a few words
  of the model's: the model's call is conversation and is sent again (ADR
  0009).

- A lesson whose state outlives the page sets `Lesson.durable`
  (`packages/website/AGENTS.md`, "A durable lesson"): its tests reload by
  closing a storage view, and its browser script removes the lesson's keys
  first and reloads for real.
  What it keeps for one tab alone (lesson 15's chat picked) goes in the
  tab's `sessionStorage` (`RuntimeOptions.tab`): its tests reload with the
  same tab storage, and open a new tab with an empty one.

- A lesson whose world is the page's (lesson 16's workspace, `Lesson.workspace`)
  gets it built once per runtime and given as a value (`PageParts.files`), never
  built by the learner's code. A learner's function of it (workspace.ts) is called
  once in `evaluate` before agent.ts runs, so a bad one is refused in words that
  name its own file. A pane that shows that world reads the page's own service,
  not the learner's wrapper, and its model is a class with no DOM that the tests
  drive (`WorkspacePane`).

- A pane that shows what the kernel says live (lesson 18's Graph tab, from
  `plugin.graph.recalled`) folds the `Event` trace the page already hears,
  with no listener of its own, and draws a pure function of the event's data
  with tests of its own, apart from the DOM. Seed data the page loads (lesson
  18's world) goes straight into its session as records, in one turn, never
  through a tool (a call per record would fill the chat's journal); a test
  pins that the page heard every record of the burst.

## 3. Tests that can fail

- `program.test.ts`: tsc over every shown file, and the program run on
  `scriptedModel`, asserting the prompts the model received exactly. A
  lesson whose tool declares a service has a `type-level:` test: the
  program without that service does not compile, and the compiler's error
  names it (lesson 4's `Helper`, lesson 9's `Approval`).
- `lesson.test.ts`: the page's runtime with Echo. Page tests and browser
  scripts run on Echo: they pin the UI, the wiring and the mdx's claims,
  never what a real model does. A model's behaviour is said only from a
  real-model run, noted in the mdx (`{/* REAL-MODEL NOTE */}` until one
  is made); lesson 13's comparison of a model against Echo is how such a
  run is measured, as a rate with its interval. Assert each claim the mdx
  makes as it is worded, without a filter that hides the case it is about
  (no role filter on "the model never sees it"; no count that a vacuous run
  passes). Each experiment does what its text says.
- An Echo rule gets a direct test in `models/models.test.ts` that fails
  without the rule, and, where it must come before another rule, one that
  fails when it is moved after it.
- A lesson whose state outlives Clear context and Rebuild (lesson 11's
  facts: only a reload empties the memory session) pins its page's steps
  as one walk on one runtime, press by press in the page's order, and
  each experiment's text names the state it starts from, which its test
  sets up the same way.
- Code that waits on time (lesson 17's helper, three seconds) is held on a
  signal in every test, never slept through: a page test edits the wait
  into a wait on a function the test gives, and program.test.ts compiles
  a module whose wait comes from a file the test writes. Work that runs
  beside the chat's turn (a task) shares the model with it: each page
  model stops one request alone, and the page's Stop stops them all.
- An experiment that must edit two files lists the second under `also`,
  and its tests apply it with `applyExperiment`, as the page does.
- A lesson whose page runs a kit or checks (`Lesson.kits`, lessons 7 and
  12) pins them through `runtime.runKit`: each check's id, name and
  result, and the line the list draws (`kitLine`). One that runs the
  learner's program (lesson 12) also pins that the page holds the same
  traces, chat rows, journal and sessions after a run as before it, with
  a check on the model picked applied: the model is the one thing a check
  shares with the page. The same test asserts that the checks passed, so
  it cannot pass on checks that never ran.
- `lessons/wrong-values.test.ts`: add the lesson's cases to its table. It
  is compared with the lesson list (`lessonSlugs`), and every file a
  learner can edit needs a case: what the file makes, made the wrong kind
  of thing, is refused in words that name the file and the name. A
  definition the kernel refuses is a case too, in the kernel's words.

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
- Write for a reader who knows a little JavaScript and nothing else: not
  agents, models, Effect or this kernel. Two rules, for the prose, the
  controls' and experiments' text and the comments of shown code:
  - no comparison with something outside the page (an editor, a framework,
    a product): say what the thing does instead;
  - every term is said in plain words where the track first uses it, in a
    clause beside it ("a **record**: your message, the model's answer…").
    A later lesson may point back to it ("the journal, lesson 1").
- Test it: give a fresh agent only the text of the lessons up to this one,
  and ask for every word it cannot explain from them. Keep every step,
  claim, code name, button label and quoted string while you reword: a
  script that compares them before and after shows what went.

## 6. Checks

- [ ] Kernel cut merged or in the same PR, with its docs and ADR
- [ ] `imports.test.ts`, `format.test.ts`, `program.test.ts` (the base holds
      each piece replaced; a `type-level:` test for a service a tool
      declares), `lesson.test.ts`, the Echo rule's test,
      `lessons/wrong-values.test.ts` (a case for every editable file)
- [ ] No cast in what the lesson adds; `run` annotated; `programOf` in
      `lesson.ts`
- [ ] Every button and chip the mdx names pressed in WebGPU Chrome, at
      1600×1000 and 390×844, light and dark, the screenshots looked at; Stop,
      Rebuild and Clear context tried where the lesson's state lives
- [ ] One real-model run, and the mdx says what it did
- [ ] The prose read by a fresh agent: no word it cannot explain from the
      lessons so far, no comparison with something outside the page
- [ ] CHANGELOG entry; the full definition of done
