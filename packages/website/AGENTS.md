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
    and run on the kernel with `scriptedModel`. The typed module's `run`
    states that its program needs nothing more (`Effect.Effect<unknown,
    unknown>`), so a module `main` was not given is a compile error. The
    page runs the same text as untyped JavaScript, where nothing can say
    that before it runs: `programOf` (`evaluate.ts`) is the one place a
    lesson's `evaluate` says so. A
    lesson whose tool declares a service has a `type-level:` test that the
    program without it does not compile, naming the service (lesson 4's
    `Helper`). A loop written over any toolkit asks for the toolkit's own
    type, as `callTool` does (`Toolkit.WithHandler<Tools> & OwnTools<Tools>`,
    lesson 4's `loop.ts`).
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
    there, and one removed is removed. What the page gives and no import
    names (`pane`, `model`, lesson 9's `approvalOn`) is said in a comment
    of `main`, and is a parameter of the typed module's `run`.
- **The runtime** (`runtime.ts`) builds the kernel, journal and sessions once,
  so the conversation outlives a rebuild, and runs the learner's `main` on a
  fiber. It wraps what it hands the program to watch it: the model (each
  prompt and its usage, a `Trace`), memory (`watchMemory`, each context) and
  a summarizer (`watchSummarizer`, so its model calls are counted apart).
  A prompt's session and turn are read from `CurrentTurn` as the model's
  stream runs; only a program that calls the model by hand, which provides
  none (lessons 1 and 2), is placed by the last memory call.
  - A definition that is refused as the learner's file runs refuses
    the build (lesson 8: `pointed` given numbers it refuses, a statement
    of memory.ts above the layer): `start` returns `Refused` with the
    file's name and the refusal's words, which the page shows at the foot
    of the Code pane. The program that ran before is stopped and none
    takes its place until a build passes; nothing is stored and the chat
    is untouched. A file whose rule must be made once is statements, as
    tools.ts is (`runStatements`, a body without `export`, an empty
    `formatPrefix`), not one expression after a read-only declaration.
  - The page is who a tool asks (lesson 9, ADR 0012):
    `PageParts.approvalOn(pane)` is a `Layer<Approval>` whose `ask` is
    traced as `Asking { id, action, detail }` and waits for
    `runtime.decide(id, decision)`. `Asked { id }` follows when the
    question no longer waits: answered, or dropped with its turn by Stop,
    a rebuild or Clear context (a finalizer of the wait, so it is always
    said). A decision for an id nothing waits under does nothing. The
    stand-in stores nothing: `approve` stores the answer.
- **The Context tab** (`trace-model.ts`, pure, and `panes/trace.ts`) builds
  each turn's steps, journal, memory and prompt from the traces.
  - A prompt's row is "the same as the prompt before" when the message is
    the same one and was sent the same way: a tool's result matches its
    record by its call's id, whatever was sent for it, so its text is
    compared too. A memory may send one record two ways (lesson 8's
    `older-turns`).
  - A tool's result that was sent as something other than its record
    holds says so on a line of its own under the row, `sent as a pointer: N tok kept in
    the journal` (`keptInJournal`, lesson 8): decided by comparing what
    was sent with what is stored, never by a pointer's words.
- **The chat** (`chat-model.ts`, pure, and `panes/chat.ts`) is rows. Every
  row drawn from a stored record comes from one step, `stored`, whether the
  record was just announced or is read back from a journal (`chatRowsOf`);
  a journal's rows only grow at the end. What a program says and never
  stores (an answer being written, a waiting message, a reply that is no
  stored answer, the page's own notes) is a row with no `seq`, drawn live
  and absent from a chat drawn from the journal (`drawFrom` in
  `playground.ts`, lesson 6's redraw button). The messages still waiting
  are the chat's last rows and a new row goes before them, so the stored
  rows are always in the journal's order. The pane renders the rows it
  is given, by the row's id, and never reorders an element. Views are not rows: `views.ts` folds the same
  records with `viewsOf`. A new kind of thing in the chat is a case of
  `stored` when it has a record, with a test in `chat-model.test.ts`.
  - A question a tool asks (lesson 9) is a row of kind `ask` with no
    `seq`: its text is the request's detail, and it carries the id and
    the action its three buttons use (`answersTo`: Approve, Refuse,
    Always approve the action). It goes when `Asked` is heard. Its answer
    is a record, `plugin.approval.decided`, and a note row from `stored`
    (`decidedLine`). While a question waits the status chip says so
    (`questionsWaiting`, `WAITING_FOR_ANSWER`), and the input takes
    messages as during any turn.
- **A durable lesson** (`Lesson.durable`, lesson 7) keeps its journal in
  the browser's storage, through the learner's own store.
  - The runtime creates no session and keeps no journal: its base's
    storage hands every call to the store the program builds
    (`PageParts.storeOn`), over `localStorage` seen through the lesson's
    prefix (`prefixed`), and the conversation is the one the learner's
    `resume` gives (`PageParts.chatWith`). The program names it as it
    starts, in a `Showing` trace that carries the journal read then: the
    chat is drawn from it (`drawFrom`) and the Context tab seeded, and a
    record at or below the last one taken is passed over, so one read
    from the journal and then heard announced is drawn once. A session
    can come back under another journal (the learner changed the store):
    the page draws from scratch unless the records it holds are a prefix
    of the journal it is handed (`continues`: same place, same time).
  - The page is the store's one writer (ADR 0010): it holds a Web Lock
    while it is open, and a second tab waits (`whenWriter`). The learner's
    edits are kept in `sessionStorage`, so an experiment survives a reload.
  - A test's reload is a second runtime over the same storage value, after
    the first one's view of it was closed (every call of a closed view
    throws): disposing the first would close its turn as `Interrupted`.
    Two sessions created in one millisecond are listed by id: a test that
    creates a second root session waits a few milliseconds first.
  - A browser script starts by removing the lesson's keys: the Chrome
    profile is kept between runs, and so is its storage.
  - `Lesson.kits` are kits the page runs over the learner's code
    (`runtime.runKit`), listed under a `data-kit` button.
- **Echo** (`models/mock.ts`) answers by rule, so a lesson can rely on it: a
  sum to the calculator, "ask a helper" to `delegate`, "show a table of" to
  `show`, a summarizer's request summarized by count; it reads past every
  host note. A new rule gets a test in `models/models.test.ts` that fails
  without it. Real models run in the browser (WebLLM on WebGPU, a CPU
  worker, Chrome's Prompt API). A model in the page mints the ids of its
  own tool calls with `callIds` (`models/call-ids.ts`), which differ
  between page loads: a counter alone starts again on a reload, and a
  durable lesson would store two calls under one id. A test that needs
  the same ids on two pages passes its own minter (`loadEcho(callIds(…))`).
  - Lesson 8's rules: "look up" or "tell me about" tides, volcanoes or
    honeybees goes to `lookup`. A `lookup` result is answered with the
    first sentence of what Echo was sent and how much of the whole that is:
    a pointer (read by the kernel's exact words, ADR 0011) or the article
    whole. "Read more", "read on" or "go on" calls `readResult` with 400
    characters from the latest place the prompt gives, looking back from
    its end: where the last part read stopped, or what the last pointer
    names, whichever comes later. It answers in words when `readResult`
    is not offered, when nothing was cut short, or when the last part
    reached the end. A part is answered with its range and its first whole
    sentence. The rule is asleep where nothing was cut short and neither
    tool is offered, so "go on" in another lesson is a message like any
    other.
  - Lesson 9's rules: "forget", "delete" or "clear" my notes, the notes or
    all notes goes to `forget`, where it is offered. The rule sits before
    the one that sends any message about notes to `recall`, and a test
    fails when it is moved after. A `forget` that failed with the
    kernel's `APPROVAL_REFUSED`, word for word, is answered "I did not
    delete anything: you did not approve it."; any other result of it,
    and the same refusal of another tool, as the tool's.
  - A turn that failed leaves its message in the journal with no answer:
    Echo treats it as waiting, and the next turn answers it with the new
    one (two calls where one was expected).
- Skill `add-lesson` is the checklist for a new lesson.

## Rules

- Text a lesson shows is code the learner reads: plain, commented in full
  sentences, and the same text the tests compile and run.
- Draw what a model or a user wrote as text nodes, never as markup, unless it
  goes through `markdown.ts` (the agent's answers).
- A browser check runs Chrome with WebGPU (`--enable-unsafe-webgpu`), at
  desktop and phone widths, in light and dark.
