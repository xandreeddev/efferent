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
    import and the page's stand-ins (`PageParts`). An experiment that
    edits no file is a `data-fill` button: it sends the lesson's `fill`
    (lesson 10's call of a tool before its skill is loaded). An experiment
    that must change a second file with the first lists it under `also`
    (lesson 11's `recall-tool`: a tool in tools.ts, and no wrapper in
    memory.ts). `applyExperiment` gives every file's new text or none, so
    an experiment is never half applied; the page and the tests both call
    it.
  - `config-edit.ts`: each control's read and write and each experiment's
    edit; a line the learner rewrote is left alone (`None`).
  - `program.test.ts`: the shown files compiled with tsc (`tsconfig.learn.json`)
    and run on the kernel with `scriptedModel`. The typed module's `run`
    states that its program needs nothing more (`Effect.Effect<unknown,
    unknown>`), so a module `main` was not given is a compile error. The
    page runs the same text as untyped JavaScript, where nothing can say
    that before it runs: `programOf` (`evaluate.ts`) is the one place a
    lesson's `evaluate` says so. What a file made is read with `named`
    and held to a guard (`Layer.isLayer`, `typeof`), never cast; lesson
    7 alone says two types it cannot check, its store's and its
    `resume`'s, each with the reason beside it. Lesson 14 reuses lesson
    7's `storeOf` and says no type of its own: an Effect a file made
    (`resume`, what `branchFrom` gave) is run over the page's sessions
    with `Effect.provideService` and handed over with `programOf`, and
    what it gives is decoded with the kernel's `SessionId` schema
    (`sessionIdOf`). A
    lesson whose tool declares a service has a `type-level:` test that the
    program without it does not compile, naming the service (lesson 4's
    `Helper`). A loop written over any toolkit asks for the toolkit's own
    type, as `callTool` does (`Toolkit.WithHandler<Tools> & OwnTools<Tools>`,
    lesson 4's `loop.ts`).
  - `lesson.test.ts`: the lesson on the page's runtime with Echo: every claim
    the mdx makes, and every experiment.
  - Registered in `src/learn/lessons/index.ts` (`lessonSlugs` lists the
    track in order) and `index.test.ts`.
  - `lessons/wrong-values.test.ts` holds, for every lesson of that list, a
    file that makes the wrong kind of thing to a refusal in words that
    name the file: its table is compared with the lesson list, and every
    file a learner can edit has at least one case.
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
    of the Code pane. Lesson 10's skills.ts is such a file too: `skills(…)`
    is its last statement, so a skill that is none, two under one name or
    a tool two skills have is refused there, in the kernel's words. The
    program that ran before is stopped and none takes its place until a
    build passes; nothing is stored and the chat is untouched. A file
    whose rule must be made once is statements, as tools.ts is
    (`runStatements`, a body without `export`, an empty `formatPrefix`),
    not one expression after a read-only declaration.
  - The page is who a tool asks (lesson 9, ADR 0012):
    `PageParts.approvalOn(pane)` is a `Layer<Approval>` whose `ask` is
    traced as `Asking { id, action, detail }` and waits for
    `runtime.decide(id, decision)`. `Asked { id }` follows when the
    question no longer waits: answered, or dropped with its turn by Stop,
    a rebuild or Clear context (a finalizer of the wait, so it is always
    said). A decision for an id nothing waits under does nothing. The
    stand-in stores nothing: `approve` stores the answer.
  - The model watcher is one function of the model it wraps and the name
    its answers give (`watch` in `parts`), the one forwarding assertion of
    `streamText`; a lesson's model parts are each made with it. A
    `Prompt` trace names the model it was sent to (`model`) and the model
    picked when it was sent (`picked`). A stream that fails, or that holds
    an error part, says so in a `PromptFailed` trace from the stream
    itself, so it always follows its own prompt and comes before the
    next; a stream that was stopped says nothing, and a summarizer's
    carries `purpose: "summary"` and marks no try of the turn's call.
  - Lesson 13's parts: `PageParts.spare`, a second Echo built once per
    runtime (`loadEcho(undefined, "echo-spare")`), watched as the model
    picked is and never failing; and `PageParts.failing(failures)`, the
    model picked failing as failures.ts lists (`MadeFailure`, the fields
    of the scripted model's `Fails`), one entry each time it is asked, so
    a call tried again takes one for each try, a summarizer's call not
    counted. A call made to fail returns the page's own
    failing stream and never reaches the model: an `AiError` of the model
    picked, `InternalProviderError` when `retryable` and `UnknownError`
    otherwise, in the page's words (`madeFailureWords`, "failures.ts made
    this call fail, and said it is worth another try"); with `pieces` the
    answer starts and shows them first. The lesson calls `failing` once a
    build, so the list starts again whenever the program is built:
    Rebuild, Stop, Clear context and a model picked.
- **The Context tab** (`trace-model.ts`, pure, and `panes/trace.ts`) builds
  each turn's steps, journal, memory and prompt from the traces.
  - What a turn's records say (its start, its messages, each answer's
    calls with their results, how it closed) is read with the kernel's
    `turnsOf` (`readOf`), never by filters over the records. The page's
    own list of a board's turn numbers is `turnNumbersOf`.
  - It holds one board per session a turn ran in (`Boards`, `heardBy`),
    and its row of sessions (`sessionRow`) names each for what its header
    says it is (`kindOf`), never for its place in the row: the chat's
    conversation ("Chat"); a helper, which has a parent ("Helper N" and
    its task, lesson 4); the memory session, which the facts plugin owns
    and which has no parent ("Memory", lesson 11); any other session of
    the program's own ("Session N"). The runtime tells the page a
    session's header in a `Session` trace, for every session but the
    chat's, from its waited listener of a turn's start: so before the
    first record of that session's first turn here, and it cannot fail
    the turn. A header never heard makes a session "another", not a
    helper. A new conversation (`startedOver`: Clear context, or a
    durable lesson's program naming another one) retires every other
    session with the old chat's, but the memory session's board, which is
    no conversation's and keeps its records. A turn on the memory session
    is three steps (opened, the fact's record, closed) and no model call;
    a fact's record is summed up with where it came from, and its row
    says it is a fact's. The pane (`panes/trace.ts`) draws what these
    functions give; the DOM wiring itself is type-checked, not run by a
    test.
  - A turn has one context per model call, and one prompt per attempt: a
    call under a plan (lesson 13) may be tried again, and each try is a
    prompt. The prompts are grouped by call from the prompts' own marks
    (`attemptsByCall`): a prompt whose stream failed (`PromptFailed`)
    belongs to the call of the prompt after it, and the prompts after the
    last that did not fail are a call with no answer. Never from the order
    the records are heard in, which the page hears on a fiber of its own.
    The tools offered, the turn given, the usage and the pieces streamed
    are each prompt's, a `Usage` the turn's last prompt's. A failed try
    is a step of its own (`attempt`, "Attempt 1 failed", in the failure's
    words), which happened, so the steps after it are not taken for
    missing; the prompt step names the try that answered where the call
    was tried more than once or sent to a model other than the one picked.
    The live `plugin.model.attempt` events decide nothing here: lessons 1
    to 12 have none, and neither does Effect's plan alone. With no prompt
    marked, call `n` is prompt `n`. A call's `answeredBy` is the model its
    answer's record names, said only where the turn's answers name more
    than one model or one other than the model picked, so lessons 1 to 12
    draw as they did. Nothing of a try is stored: a turn drawn from its
    records alone shows none of its tries.
  - A prompt's row is "the same as the prompt before" when the message is
    the same one and was sent the same way: a tool's result matches its
    record by its call's id, whatever was sent for it, so its text is
    compared too. A memory may send one record two ways (lesson 8's
    `older-turns`).
  - A tool's result that was sent as something other than its record
    holds says so on a line of its own under the row, `sent as a pointer: N tok kept in
    the journal` (`keptInJournal`, lesson 8): decided by comparing what
    was sent with what is stored, never by a pointer's words.
  - The prompt's first row after the cache line, `tools`, lists the tools
    that model call was offered, in order (`CallView.tools`, from the
    `Prompt` trace): lesson 10 reads there that a skill's tool is offered
    from the call after its load. Token counts and "the same as the
    prompt before" are of a prompt's messages: tool definitions are in
    neither, so that line says nothing of a tool list that changed.
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
  - A turn whose answer was cut after its first words (lesson 13,
    `AnswerCut`) keeps the words shown, a row with no `seq`, and its
    failure's row says the answer was cut (`failureLine`), read from the
    record of the turn's end, so a chat drawn from the journal says the
    same and has no words. The status line says each failed try and each
    later one from the live `plugin.model.attempt` events (`attemptLine`,
    wired in `playground.ts`); a first try says nothing.
- **Lesson 13's failures.ts** is one list after a read-only declaration
  (`export const failures: ReadonlyArray<Failure> = `, with `type
  Failure` above it), as memory.ts's layer is, not a file of statements:
  the page runs the editable text as JavaScript and Format parses it with
  Babel, and neither takes a type annotation. Each entry is held to its
  fields by guards (`failuresOf`), and one that is not a failure is
  refused in words that name the file.
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
  - Lesson 14's branches. `Lesson.branch` is how a branch is made:
    branch.ts's `branchFrom`, from the sources last built, called with
    the conversation shown and the turn pressed. `runtime.branch(turn)`
    runs it on the page's own base `Sessions`, the sessions the chat
    reads over the store the program built, never on a kit's stack (a kit
    evaluates files over a store of its own, so a fork there would land
    where the chat never reads). While no program runs it refuses in
    words (`NOT_RUNNING`), whether no build ever passed (the base has no
    store) or the last one was refused. It stops nothing and switches
    nothing: a turn running in the chat goes on.
  - "Branch after turn N" sits at the last stored row of each closed
    turn (`branchPoints`, from the turns whose end the chat took,
    `ChatBoard.ended`): a row drawn from the journal knows its turn as a
    row drawn live does, and a turn still open has none.
  - The row of chats (`chats.ts`, `runtime.chats()`) lists the store's
    headers by creation that are the learner's own (`ownChat`: owner
    `learner`, no parent, this kernel's format, the conditions lesson
    7's `resume` keeps), labelled "Chat 1", and a branch for the chat it
    was cut from and the turn of its own record at `branch.through`
    ("Chat 1, branch after turn 2"; the same name twice is numbered).
  - `chosen` (`PageParts.chosen`, `runtime.chosen`) is the chat the page
    asks for, which chat.ts's `resume` is given and decides on. Picking
    a chat sets it and rebuilds through `start` (`runtime.choose`), the
    messages that waited dropped: they were written for the chat that
    was shown. A branch made sets it to the chat shown, so a rebuild
    does not move to the branch, the latest. Clear context clears it
    before it rebuilds, so `resume` finds the new chat as the latest. It
    is kept in the tab's `sessionStorage` (`RuntimeOptions.tab`,
    `CHOSEN_KEY`), so a reload shows the same chat and a new tab the
    latest; "Start over" removes it with the edits. The page says when a
    `Showing` names another chat of the row than `chosen` (`ignoredLine`).
  - A chat and its branch hold the same places and times up to the cut:
    a `Showing` of another session than the one shown is drawn anew
    (`drawsAnew`, which the page and its tests both call), whatever
    `continues` says. A `Showing` of a branch carries where it was cut
    (`branch`), and of a session this page showed before another
    (`again`): the Context tab says a copied turn was "copied from Chat
    1" and a turn of a chat shown again ran "before this chat was shown
    again" (`restoredWords`); a reload reads as lesson 7's.
  - `Lesson.kits` are kits the page runs over the learner's code
    (`runtime.runKit`), listed under a `data-kit` button: see "Kits and
    checks".
- **A workspace** (`Lesson.workspace`, lesson 15, ADR 0017): files the
  agent acts on, reached only by the kernel's file tools.
  - The runtime builds one `Files` in memory from the lesson's seed
    (`inMemoryFiles(seed)`), once, in its root scope, and gives it to the
    program as a value, `PageParts.files` (a `Layer<Files>` over that one
    service; `None` for every other lesson). The files outlive Rebuild,
    Stop, Clear context and every experiment; a reload (a new runtime)
    starts them over. A non-durable lesson has no Start over: its page
    says "a reload".
  - workspace.ts is the app's permission layer, one function of the
    page's files (`workspace(files)`), a file of statements. `evaluate`
    calls it once before agent.ts runs, so one that is no function, throws
    or gives no layer refuses the build in words that name workspace.ts.
    agent.ts merges the file tools into its toolkit
    (`Toolkit.merge(tools, fileTools)`) and provides `fileHandlers` and
    `workspace(files)`; its typed module takes `files` and `approvalOn` as
    parameters of `run`. The starter provides no `Approval`.
  - The Files tab (`data-file="files"`, beside Context, only for such a
    lesson; a step's `focus="files"` opens it) draws `WorkspacePane`
    (`workspace-pane.ts`, no DOM, the tests' too) through `panes/files.ts`.
    It reads `runtime.workspace`, the page's raw `Files`, never the journal
    and never what workspace.ts wraps: a person is not the agent. It reads
    again on `plugin.files.written` and on every `core.session.turn.ended`
    (`rereadsOn`), since a write interrupted before its result says
    nothing. A person's draft is kept when the file changes under it
    (`changedUnderDraft`); Save writes with `expected: Holds` the text the
    tab loaded, and on `FileChanged` says so (`saveRefused`) and shows the
    file as it is, the draft dropped.
  - The chat's status line says a tool's write (`wrote notes/todo.md`) and
    a write or an edit whose result failed (`workspaceLine`): refused by
    the person (`APPROVAL_REFUSED`, word for word), declined by the
    workspace (the start of the kernel's words for `FilesRefused`), or
    failed. The line stays until the next turn starts, when the program's
    own line is put back (`underWorkspace` in `playground.ts`).
- **Kits and checks** (`Lesson.kits`, `runtime.runKit`, a `data-kit`
  button with its `data-kit-results` list). A kit is a `LessonKit`:
  `checks(sources, storageOf, model)` gives its checks, or why the code
  did not evaluate, and the kit states two things of its own.
  - `timeout`: how long one check may run. Five seconds (`KIT_TIMEOUT`)
    when the kit states none, as lesson 7's; lesson 12's checks have two
    minutes, for a live check on a model that runs on the learner's
    machine. A check stopped at its limit is interrupted, and with it
    the stream it was reading. The models built on `modelStream` (WebLLM
    on the GPU, the CPU worker, Chrome's Prompt API) have their source
    cancelled by that stream's finalizer, so they stop generating; Echo
    has no source, and its stream ends with its reader. The check's line
    reads in Effect's words ("Operation timed out after …"). A lesson
    test cuts a live check on a model built on `modelStream` that never
    ends its answer, and reads that its source was cancelled once and
    that the checks are over; then, with Echo picked and the program
    built again, as the page does on a model change, the chat answers.
    No test cuts a check on a real model.
  - `alone`: the kit runs the learner's program on the model picked, so it
    and the chat take turns. `runKit` refuses it while a turn runs
    (`TURN_RUNNING`) and `runtime.checking` is true while it runs. The
    page (`refresh` in `playground.ts`) reads both: while such a kit runs
    the chat's Send, the chips and the model picker are off, and while a
    turn runs, a message waits or a model loads the kit's buttons are.
    That wiring is type-checked, not run by a test.
  - `model` is the model picked as it was loaded, not the one the page
    watches for the chat, and none while no model is picked: a check that
    runs on it leaves no `Prompt` trace.
  - A check is a `KitCheck`, `{ id, name, run }`; the kernel's
    `ConformanceCheck` is one. A check that passes may say something, as
    text (lesson 12's live check: "5 of 5 runs passed"). `kitLine`
    (`lesson.ts`) gives the line the list draws, and a check that said
    nothing reads as lesson 7's do: its mark, its id, its name. When the
    code did not evaluate the list says "The kit did not run.", or the
    words of its own `data-kit-refused`.
  - Lesson 12's checks (checks.ts, "Run checks") each run the program
    agent.ts exports on a stack of its own. The kit runs every file again,
    apart from the page's program: agent.ts is given the kernel's own
    `kernel`, `inProcessJournal` and `sessions` where the page's program
    is given stand-ins, memory.ts's memory as the file made it, not
    watched, and the shown chat.ts with its types taken out by named
    pieces (`chatBodyOf`: the page has no TypeScript compiler). So the
    page hears nothing of a check: no trace, no row in the chat, no
    session in its store. The build runs the same evaluation, so a
    checks.ts that makes no list of checks refuses the build. A check's
    `run` is handed over with `programOf`, as `main` is.
  - A shown file that exports a name another file imports (`export const
    program`) has a `moduleOf` of its own, which keeps that name at the
    module's top: the base's `typedModule` puts the whole text inside
    `run`. A name the page gives a file of statements and no import
    names (`model`, in checks.ts) is the parameter of the function its
    typed module exports (`checksWith`).
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
  Every page model is built by `makeBrowserModel(name, impl, tools)`, whose
  answers start with a `response-metadata` part naming the model (its
  choice's id, the same for a WebLLM model's f16 and f32 builds), so
  `modelAnswer` stores the name on the answer; `loadEcho(callId, name)`
  names a second Echo apart.
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
  - Lesson 10's rules, for skills, each asleep where `loadSkill` is not
    offered (the convert rule: where `convert` is not), and each ahead of
    every rule of lessons 2 to 9, in this order, with a test that fails
    when one is removed and one that fails when it is moved. "Use convert
    without loading" calls `convert` with 5 km to mi whether or not it is
    offered: the one call Echo makes of a tool it was not sent. "Load
    units" or "load the units skill" calls `loadSkill` with the word after
    "load". A length with a unit to convert it to ("5 km in miles") goes
    to `convert`. A message a skill's line in the catalogue covers calls
    `loadSkill` for the first such skill no result in the prompt has
    loaded: the catalogue is read from the system text by the kernel's
    first line, word for word, and a line covers a message when a word of
    the message, of four letters or more, is the skill's name or a word of
    its summary. After a result that loaded a skill Echo goes on in the
    same turn: the turn's messages are read again, and a call they ask
    for that the turn has not made is made. With none left, a load is
    answered "Loaded units." and a `convert` "5 km is 3.1 mi.". While a
    result in the prompt loaded the skill named `haiku`, Echo writes its
    own answers in three fixed lines: a message with no tool, and a load
    the message did not ask for by name; a tool's answer is passed on as
    before.
  - Lesson 11's rules, for facts, each asleep where its tool is not
    offered, placed after lesson 10's rules. Three orders decide a
    message, and each has a test that fails when the rule is moved: the
    forget rule before the remember rule, the remember rule before the
    sum's, and the forget rule before lesson 9's `forget` where a program
    offers both. The facts Echo knows of are the lines of the kernel's note of
    remembered facts (`factsNote`: its first line, word for word, then the
    frame), in the last such note of the prompt: never what the user
    typed, a call's parameters or a tool's result. A message that starts
    with "forget" or "please forget" is `forgetFact`'s: "forget f1" calls
    it with that id; any other with the id of the listed fact that shares
    the most words with the message (words of four letters or more, but
    "user", which every fact Echo writes holds; the first listed among
    equals); with no such fact it calls nothing and is answered "I
    remember no fact about that.". The rule sits before the next one,
    which "Forget that my name is Ana." would wake, and a test fails when
    it is moved after. "My name is X", "I live in X" and "remember that
    X", in a message that does not end with a question mark, call
    `rememberFact` with a sentence that reads on its own ("The user's
    name is X.", "The user lives in X.", "The user said: X."). The rule
    sits before the sum's, so "Remember that 2 + 2 is 4." is a fact where
    `rememberFact` is offered, and a test fails when it is moved after.
    Lesson 2's `remember({ note })` and lesson 9's `forget` are keyed on
    other tools, and stay asleep here, as these rules do there. "What do
    you remember?" or "what do you know" calls `recallFacts`, the tool
    of the lesson's `recall-tool` experiment, where it is offered. A
    `rememberFact` that stored a fact is answered "I will remember that:
    it is fact f1."; one that failed, and every result of `forgetFact`,
    as the tool's. With no call to make and facts listed, one message
    that ends with a question mark is answered from them: "what do you
    remember" with every listed fact, any other with the listed fact that
    shares the most words with it ("I remember: "…" That is fact f1.");
    one that shares none, like any other message. With no tool offered
    (`echoReply`), the facts' note is read past as the clock's is: it is
    no message of the conversation and no note of condensed turns.
  - Lesson 15's rules, for the workspace, each asleep where its tool is
    not offered, placed after lesson 11's rules and before every rule of
    lessons 2 to 9, each anchored at the start of the message, with a test
    that fails when they are moved after the recall, sum or remember rule.
    "List the files" (or "list the files in notes") calls `listFiles`;
    "read X", where X holds a dot or a slash with more after it, calls
    `readFile`, and "read X from N" from character N (lesson 8's "read
    more" is no path); "write X: text" calls `writeFile` with the text
    after the colon; "in X replace A with B" calls `editFile`. A page read
    is answered with the file, its range, its start and the message that
    reads on when more follows; a list with its paths (three named and the
    rest counted past five); a write or an edit with what the file holds
    now. A file tool that failed is answered as the tool's, in the
    kernel's words.
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
