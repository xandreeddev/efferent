# @xandreed/website

The docs site (Astro), not published. The reference pages under
`src/content/docs` are generated (`bun run docs:generate`); the learn track,
`/learn`, is written by hand: interactive lessons that run a learner's agent
in the browser on the kernel. Check it with `bun run --cwd packages/website
check` (tsc over the learn code, the build, the link check) and
`bun test packages/website/src/learn`.

## The learn track (`src/learn`, `src/content/learn`, `src/components/learn`)

- **The kernel alone.** The track runs on `@xandreed/core/kernel` and
  `@xandreed/sdk/kernel`, never the old engine; `src/learn/imports.test.ts`
  fails on any other `@xandreed/` specifier, in the page's code or in a
  source a lesson shows.
- **A lesson** is `src/content/learn/NN-<slug>.mdx` (its steps, `Step`
  components that focus a pane and a file) and `src/learn/lessons/<slug>/`:
  - `*.source.ts`: the text of each file the learner sees, as strings. The
    page runs that text as written; `moduleOf`-style functions turn it into
    a typed module for the tests. A lesson that builds on an earlier text
    derives its own from it by replacing named pieces (`REPLACED`, pairs of
    `[from, to]`), and a test checks the earlier text still holds each
    `from`. Every starter text is as the page's Format button leaves it
    (`format.test.ts`).
  - `lesson.ts`: the `Lesson` (files, chips, the messages "Send three" and
    `data-fill` send, controls bound to a line of a file, experiments that
    edit a file) and `evaluate`, which runs the files with the names they
    import and the page's stand-ins (`PageParts`).
  - `config-edit.ts`: each control's read and write and each experiment's
    edit; a line the learner rewrote is left alone (`None`).
  - `program.test.ts`: the shown files compiled with tsc (`tsconfig.learn.json`)
    and run on the kernel with `scriptedModel`.
  - `lesson.test.ts`: the lesson on the page's runtime with Echo: every claim
    the mdx makes, and every experiment.
  - Registered in `src/learn/lessons/index.ts` and `index.test.ts`.
- **The loop's two blocks.** Lesson 2 writes them by hand: reading the
  model's stream, and running a tool call. From lesson 3 on a program uses
  the kernel's functions, `modelAnswer(stream, session, { onText })` and
  `callTool(toolkit, call, session)`: each stores what it read or ran, and
  provides `CurrentTurn` while it does.
  - `lessons/base/agent.source.ts` is lesson 2's `agent.ts` on those two
    functions (`BASE_AGENT`): no lesson, no page. A lesson's `agent.ts`
    derives from it by named pieces, with the test that the base holds
    each; `base/program.test.ts` runs the base beside lesson 2's program
    and pins their one difference.
  - A tool's handler that must reach its turn declares
    `dependencies: [CurrentTurn]` and reads it with `yield* CurrentTurn`.
    Its `append` and `publish` cannot fail in their type, so the handler
    writes no `Effect.orDie`.
  - `lesson.ts` gives each file exactly the names its imports list
    (`agentNames`, `toolsNames`, …): a name added to shown imports is added
    there, and one removed is removed.
- **The runtime** (`runtime.ts`) builds the kernel, journal and sessions once,
  so the conversation outlives a rebuild, and runs the learner's `main` on a
  fiber. It wraps what it hands the program to watch it: the model (each
  prompt and its usage, a `Trace`), memory (`watchMemory`, each context) and
  a summarizer (`watchSummarizer`, so its model calls are counted apart).
  A prompt's session and turn are read from `CurrentTurn` as the model's
  stream runs; only a program that calls the model by hand, which provides
  none (lessons 1 and 2), is placed by the last memory call.
- **The Context tab** (`trace-model.ts`, pure, and `panes/trace.ts`) builds
  each turn's steps, journal, memory and prompt from the traces.
- **The chat** (`chat-model.ts`, pure, and `panes/chat.ts`) is rows. Every
  row drawn from a stored record comes from one step, `stored`, whether the
  record was just announced or is read back from a journal (`chatRowsOf`);
  a journal's rows only grow at the end. What a program says and never
  stores (an answer being written, a waiting message, a reply that is no
  stored answer, the page's own notes) is a row with no `seq`, drawn live
  and absent from a chat drawn from the journal (`drawFrom` in
  `playground.ts`, lesson 6's redraw button). The pane renders the rows it
  is given, by the row's id. Views are not rows: `views.ts` folds the same
  records with `viewsOf`. A new kind of thing in the chat is a case of
  `stored` when it has a record, with a test in `chat-model.test.ts`.
- **Echo** (`models/mock.ts`) answers by rule, so a lesson can rely on it: a
  sum to the calculator, "ask a helper" to `delegate`, "show a table of" to
  `show`, a summarizer's request summarized by count; it reads past every
  host note. A new rule gets a test in `models/models.test.ts` that fails
  without it. Real models run in the browser (WebLLM on WebGPU, a CPU
  worker, Chrome's Prompt API).
- Skill `add-lesson` is the checklist for a new lesson.

## Rules

- Text a lesson shows is code the learner reads: plain, commented in full
  sentences, and the same text the tests compile and run.
- Draw what a model or a user wrote as text nodes, never as markup, unless it
  goes through `markdown.ts` (the agent's answers).
- A browser check runs Chrome with WebGPU (`--enable-unsafe-webgpu`), at
  desktop and phone widths, in light and dark.
