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
  source a lesson shows. Lessons 13 and 19 alone may also name the eval
  package, `@xandreed/evals` and `@xandreed/evals/stats`, each in its own
  files (`lessons/evals/`, `components/learn/evals/`, `13-evals.mdx`;
  `lessons/grade-the-grader/`, `components/learn/grade-the-grader/`,
  `19-grade-the-grader.mdx`). The package takes only the kernel's
  `ModelSpend` ledger of the framework, which no other lesson loads. The
  page loads it
  only when the lesson's button is pressed ("Run evals", "Check the
  graders": a dynamic import of the lesson's `run.ts`), so no other
  lesson's page carries it; a lesson's `lesson.ts`, which every page
  imports, names no value of it. The dependencies that part brings are
  listed in `astro.config.mjs`'s `optimizeDeps.include`: found only when
  the button is pressed, the dev server would reload the page and lose the
  press.
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
    `resume`'s, each with the reason beside it. Lesson 15 reuses lesson
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
  - Lesson 14's parts: `PageParts.spare`, a second Echo built once per
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
  - Lesson 18's parts: `PageParts.curatorModel`, the model a curator asks:
    the model picked when its kind is `echo` or `gateway`, else a page Echo
    built once per runtime (a model that runs in the browser cannot read the
    curation prompt, about 2,300 tokens, in one request); and
    `PageParts.watchCurator(layer)`, a wrapper of the learner's `Curator`
    that runs each `curate` with the page's `Curating` reference set to the
    knowledge session and the turn that stored the job's source (read from
    its journal), so the model watcher files the call there with `purpose:
    "curation"`, never under the chat's last memory call, and counts it in
    no failures list; the reply is traced as `CuratorAnswered`. The lesson
    calls the learner's `curatorOn(curatorModel)` once at build, so one that
    makes no layer refuses the build, and hands agent.ts a `curatorOn` whose
    layer is watched. `runtime.curating` is true from a source's record (a
    waited listener of `plugin.knowledge.source`), or a curator's first call
    for a source taken up again, until its `plugin.knowledge.curated` or
    `plugin.knowledge.failed`; Load the world, a kit that runs alone and
    `runAlone` are refused meanwhile (`CURATING`), and the page keeps the
    world button and the model picker off and Stop on. Stop, Rebuild and
    Clear context stop the program, which cuts a curation short: its source
    stays pending (the kernel stores nothing more), the page says so in a
    `CurationCut` trace for each source being kept, and empties the set.
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
    its task, lesson 4); a background task's, a child the tasks plugin
    owns (`plugin.tasks`, "Task N" and its task, lesson 17), drawn as a
    helper's is; the memory session, which the facts plugin owns
    and which has no parent ("Memory", lesson 11); the graph session,
    which the graph plugin owns and which has no parent ("Graph"); the
    knowledge session, owned by `KNOWLEDGE_OWNER` with no parent
    ("Memory", kind `knowledge`, lesson 18); any other session of the
    program's own ("Session N"). The
    runtime tells the page a session's header in a `Session` trace, for
    every session but the chat's, from its waited listener of a turn's
    start: so before the first record of that session's first turn here,
    and it cannot fail the turn. A header never heard makes a session
    "another", not a helper. A new conversation (`startedOver`: Clear
    context, or a durable lesson's program naming another one) retires
    every other session with the old chat's, but the memory session's
    board, the graph session's and the knowledge session's, which are no
    conversation's and keep their records. A turn on either is three steps (opened, the fact's
    or the link's record, closed) and no model call; a fact's or a
    link's record is summed up with where it came from, and its row says
    what it is. A turn that stored many records at once (lesson 18's
    Load the world, 2,141 in one turn) is one step that counts them by
    kind ("Kept: 557 memories, 97 said again, 3 ended, 374 entities, 2
    other names, 554 sources, 554 curated"), not one step each. A turn of
    the knowledge session that stored a source is followed by a step for
    each curator call filed under it (`Board.curations`, from the `Prompt`
    traces with `purpose: "curation"` and `CuratorAnswered`): "Curator
    asked (extract)" with the prompt in the Prompt column as one message
    added by the code, "Curator answered" with the reply, "Curator failed",
    or "Curator cut short" after a `CurationCut`; then, while no curation
    kept the source, "Not curated yet" (or that its tries failed), read
    from the board's records with `knowledgeOf`: the program's next turn
    takes it up, nothing else does.
    The pane (`panes/trace.ts`) draws what these functions give; the DOM
    wiring itself is type-checked, not run by a test.
  - A turn has one context per model call, and one prompt per attempt: a
    call under a plan (lesson 14) may be tried again, and each try is a
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
    to 13 have none, and neither does Effect's plan alone. With no prompt
    marked, call `n` is prompt `n`. A call's `answeredBy` is the model its
    answer's record names, said only where the turn's answers name more
    than one model or one other than the model picked, so lessons 1 to 13
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
  - While a model streams, only the chat's answer row changes: the pane
    paints on a call's first piece and not on the later ones (`paintsOn`;
    the board still counts them), so the work of a turn does not grow with
    the answer's length, and the page's `refresh`, called after every
    trace, writes only what changed (the chip, the chat's controls, the
    model picker, the kit buttons). The streamed step is running until
    the answer is stored, and says its count only then. The step running
    is lit as it starts and left as it ends, with no animation.
  - Once a turn has closed, the Memory column of its last call lists the
    conversation's records stored after that context was built
    (`storedAfter`): the answer, so what the turn added shows as it ends,
    under a line that says memory reads the journal again for the next
    request. They are not that context, and memory.ts is not called for
    them.
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
  is given, by the row's id, and never reorders an element. A tool's row
  is worded from the call its result answers, paired by the kernel's rule
  (`paired`), never by id alone: inside one answer, the results of an id
  answer its calls of that id in the order asked, and a newer answer's
  calls of an id replace an older answer's that still wait. The task chips
  (`task-chips.ts`) and Echo (`paramsOfCall`) pair the same way, each with
  a test of both cases. Views are not rows: `views.ts` folds the same
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
  - A turn whose answer was cut after its first words (lesson 14,
    `AnswerCut`) keeps the words shown, a row with no `seq`, and its
    failure's row says the answer was cut (`failureLine`), read from the
    record of the turn's end, so a chat drawn from the journal says the
    same and has no words. The status line says each failed try and each
    later one from the live `plugin.model.attempt` events (`attemptLine`,
    wired in `playground.ts`); a first try says nothing.
- **Lesson 14's failures.ts** is one list after a read-only declaration
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
  - Lesson 15's branches. `Lesson.branch` is how a branch is made:
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
- **A workspace** (`Lesson.workspace`, lesson 16, ADR 0017): files the
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
- **Lesson 18's graph** (`Lesson.graph`, ADR 0019): a Graph tab beside
  Context, and a world the page loads into the knowledge session (ADR
  0022). The world's loader is the curated lesson's (below); what follows
  of the Graph tab describes the graph contract's walk, which lesson 18's
  program no longer makes, until the tab draws the knowledge session.
  - The world as kept memories (`load-world.ts`, `worldDrafts`): one
    `plugin.knowledge.source` per day the world says something (a host part
    listing that day's sentences, at noon UTC that day, `meta` naming Load
    the world) and a `plugin.knowledge.curated` of no model call closing
    each, so no program takes one up; an entity per name as `normalName`
    compares names, reused when the knowledge holds it by a name or another
    name, Lisboa and Lisbon one entity under Lisbon and Acme and Acme Labs
    one under Acme Labs (another name is a `plugin.knowledge.aliased`), a
    pet `pet` (one Rex), a place `place`, a company `organization`, a
    project `project`, anyone else `person`; one memory per first saying of
    a sentence (or a restatement of a memory that says it word for word and
    stands, or ended after the sentence's day: the fold does not count a
    restatement of an ended memory, so what the world said before a
    conversation changed it stays ended), a restatement for each saying
    after, and a later employer or home ending the earlier one when it is
    another entity. Over the world
    alone: 554 sources, 374 entities, 2 other names, 557 memories (44 said
    more than once), 97 restatements, 3 ended, 2,141 records; the graph
    page's "97 said again" counted sayings, a count of memories said more
    than once gives 44. A knowledge session that holds a source Load the
    world wrote refuses a second load (`LOADED_ALREADY`).
  - The world (`lessons/connected-memory/world.ts`) is data: 654 generated
    sentences, `[subject, relation, object, day]` in the order said, the
    same entries the ADR's numbers were measured on. `loadWorld`
    (`load-world.ts`) writes them into the graph session in one turn, with
    no tool call, as `linkThings` would store each: `plugin.graph.linked`
    the first time its normalised parts are seen (ids going on from the
    `plugin.graph.linked` records ever stored), `plugin.graph.restated`
    after, each with a `from` of its own (the session `world`, the
    sentence's place as the turn) so a repeat counts. The journal stamps a
    record with the clock of the fiber that appends it, so each append is
    given `clockAt(day, live)`, a `Clock` written out member by member (no
    cast). A graph session that holds the world refuses a second load in
    words (`LOADED_ALREADY`), before any turn opens.
  - `runtime.loadWorld()` runs it on the page's base `Sessions` and takes
    turns with the chat as a kit that runs alone does: refused while a turn
    runs (`TURN_RUNNING`), and `checking` true while it loads, so Send, the
    chips and the model picker are off; the `data-world` button is one of
    the buttons a turn turns off (`aloneButtons`). Core's hub holds 256
    events for a reader that is behind; a test pins that the page heard all
    2,143 records of the burst, in order.
  - The Graph tab (`data-file="graph"`, a step's `focus="graph"`) draws
    `graph-model.ts` (no DOM) through `panes/graph.ts`. It is built on the
    `Event` trace the page already hears: `heardRecall` folds each
    `plugin.graph.recalled` of the conversation shown, the n-th of a turn
    being its n-th model call, and the graph session's records (linked,
    restated, unlinked) from any session. `graphViewOf(recalled, records)`
    is pure: the things named and how, every link reached (at most
    `RECALL_SHOWN`) with its rank, the words its path met, its count and
    last day in the note's own words (the kernel's `saidText`, so the panel
    and the note never disagree about a day near midnight), its weight when the walk weighed (by count ln(1 + count); by
    a half-life against the heaviest link reached, which needs no clock),
    whether it was sent and why not; the note's tokens (`linksNote` over the
    sent links with the count and day the event gives, by `estimateTokens`)
    against those of every link standing (`linksNote` of `saidOf`);
    and the picture: each thing in a column by how many links from a named
    thing it is, each link an arrow from the thing it was reached from,
    thicker the more often said against the most said link reached. It
    draws no "now": dates and counts only. A walk is picked by turn and
    call ("Turn 3, model call 1 of 2"), the latest by default; Clear context
    drops the walks and keeps the records. A memory with no `withGraph`
    walks nothing, and the tab says so (`NO_WALK`).
  - Its controls (`config-edit.ts`, `CONTROLS`) each read and write one
    option line of memory.ts's `withGraph({ … })(flatMemory)` call: `hops`
    and `limit` as numbers, written as given so the kernel refuses a bad
    one in its words; `names` and `weights` as chips, a radio button each
    with its note under it (`NAMES_CHIPS`, `WEIGHTS_CHIPS`, each note's
    claim pinned in lesson.test.ts), a choice the kernel's default is
    written as no line. `syncControls` checks the radio whose value the
    line holds; a radio unchecked writes nothing.
  - `runtime.journal(session)` reads any session's journal, the
    conversation's by default (lesson 18's tests read the graph session's).
- **Background tasks** (lesson 17, ADR 0018): a helper works on a task in
  a session of its own while the chat goes on, and its report comes back
  into the chat's one queue.
  - The chat's queue is one queue of inputs (`ChatInput` in
    `page-chat.ts`): a message the person sent, or a task's report, in
    the order they came. `Chat.inputs` takes one at a time; `messages` is
    the same queue's messages alone (a report it takes is passed over),
    which every other lesson reads. `drain` takes the messages waiting and
    leaves the reports, in their order, in one step that does not wait
    (`takeExcept`: `Queue.takeUnsafe` until empty, then the reports offered
    back), so no send lands between the two: a message sent during a turn
    steers it, and a report never joins a turn that runs. Only a message
    taken is said (`Taken`): a report has no row waiting in the chat.
  - The page gives the program where a report goes as a value:
    `PageParts.reportsOn(pane)`, a `Layer<TaskReports>` whose `deliver`
    puts the report in that queue and traces `Reported { task, session }`.
    It is named by no import: said in a comment of `main`, and a parameter
    of the typed module's `run`. The lesson's `chat.ts`, derived from
    lesson 1's by named pieces, shows the same queue, the pane handing the
    chat a report as it hands it a message (`onReport`); lessons 12 and
    13 run lesson 1's text, unchanged.
  - The tasks run on the plugin's scope, which closes with the program:
    Stop, Rebuild and Clear context cut a task running short, and it
    reports nothing. A report still waiting in the queue then is dropped,
    on all three alike (`startNow`, after the program stopped:
    `ReportsDropped { sessions }`), since its task ids start again at t1
    with the next program; Rebuild keeps the messages that wait, as
    before. A task running is not a turn running: `busy` is the chat's
    turn alone, so the status chip reads "waiting for a message", Send is
    on, and `runKit` and `runAlone` do not refuse.
  - The chat draws a report as a row of kind `report` (`stored`): a
    `conversation.user.message` whose data has `from`, which takes no
    waiting message's place, its text `reportLine` (the task, how it ended,
    and its answer, read from the kernel's words by `reportIn`,
    `reports.ts`). A row of task chips (`Lesson.tasks`, `[data-tasks]`,
    `task-chips.ts`, no DOM) keys each task by its session: it starts from
    `startTask`'s stored result, ends as its own session's turn ends,
    waits (`Reported`), is reported (the stored report), cancelled
    (`cancelTask`'s result), stopped with the program, or dropped
    (`ReportsDropped`). A change heard before the chip's start (a fast
    helper) is kept and made when the chip is.
  - Two sessions call the model at once: each page model gives each
    request its own stop. A stream's finalizer (`modelStream`) cancels its
    own request, and nothing once that request is done: WebLLM skips a
    request still waiting by its own ticket, and calls `interruptGenerate`
    only when the request cancelled is the one generating; the CPU worker
    interrupts by the request's id; Echo has a flag per answer. The page's
    Stop (`LoadedModel.interrupt`) still stops every request.
  - helper.ts is the work of one task: lesson 4's helper agent as a small
    loop over tools.ts's tools (`modelAnswer`, `callTool`, three steps at
    most) in the task's own session, after its wait. main provides the
    task lines before `toolsLive`, so the helper's calls find the
    handlers: a module can use only the ones given after it.
  - Tests hold a helper on a signal, never on time: a page test edits
    helper.ts's wait (`WAIT`) into a wait on a function the test gives,
    and program.test.ts compiles a helper whose wait comes from a file it
    writes.
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
- **Lesson 13's evals** (`Lesson.evals`, "Run evals", a `data-evals`
  button with its `data-evals-results` table and a `data-evals="stop"`
  button). evals.ts, which the learner edits, is the eval in the
  package's own nouns: the `Dataset` (cases written by hand, each a
  message and its reference), the graders (`Evaluator`s over the turns
  and the reference), `repetitions` and the suite's `gates`. It is plain
  JavaScript; its typed module holds each name to the package's types
  (`TYPED`). The build runs it and guards what it made (`evalsMade`), so
  one that makes no dataset refuses the build in words that name it;
  what the package checks itself (a gate's grader, a case's split) it
  refuses at run time, in its words.
  - runnable.ts is read-only, and nothing of the eval is hidden in the
    page: it binds the program agent.ts exports as the runnable
    (`defineRunnable`: input the message, output the answer, evidence
    the turns read with `turnsOf`, as JSON), with an environment that
    opens no world; the projection hands each grader the turns and the
    task's reference; the candidates are the models the page gives; and
    it runs the suite once for each candidate, then compares every trial
    with Echo's (`compareDecisionTrials`), each trial made a row by the
    package's `decisionTrialOf` (runnable.ts's `rowOf`, one call; a trial
    still running is no row), and a trial passes when every gate's grader
    scored it yes. The page decodes the comparison with the package's
    `DecisionComparison`. The lines that run a
    trial are lesson 12's `turnsAfter` (`TURNS_AFTER`), derived by named
    pieces. The page runs the text with its types taken out by named
    pieces (`TYPES`, `runnableBodyOf`), as lesson 12's chat.ts; the two
    names the page gives, `models` and `hear`, are said in a comment and
    are the parameters of the typed module's `run`.
  - The candidates differ by their model alone: Echo, the reference
    solution, which passes every task (a test pins it); `echo-no-tools`,
    `loadEcho(callId, "echo-no-tools", "words")`, an Echo that calls no
    tool; and the model picked when it is not Echo, under its choice's id.
    Each as it was loaded, not as the page watches it, so the page hears
    no prompt of a trial.
  - `runtime.runAlone(start)` runs it: refused while a turn runs
    (`TURN_RUNNING`), `checking` true while it runs (the chat, the chips
    and the model picker are off, as for lesson 12's checks), on a fiber
    `runtime.stopAlone()` interrupts. `start` is `Lesson.evals.start`,
    which loads `lessons/evals/run.ts` and runs every file again on stacks
    of the kernel's own, as lesson 12's checks do (`madeOn`), so the page
    hears nothing of a run. Each trial is limited to two minutes
    (`timeoutMs` in runnable.ts), one at a time.
  - The table is `EvalsBoard` (`lessons/evals/board.ts`, no DOM, the
    tests' too), drawn by `panes/evals.ts`. The run store's `writeTrial`
    tells the page of each trial as it starts, ends and is graded; the
    board keeps the latest of each and counts, per candidate and task,
    the passes of N with their Wilson interval
    (`@xandreed/evals/stats`), each candidate's gates once its run is
    graded (each with the bounds its finding says it was held to, `heldTo`), the suite's verdict, and the comparison with Echo. A trial
    opens on demand to its grades' reasons and its transcript. A stopped
    run says so: every trial keeps the grades it was given (the package
    grades each trial as it ends; a grading cut short gives none), the candidates it finished keep their gates,
    and the one it cut short reads how many of its graded trials passed.
- **Lesson 19's check of the graders** (`Lesson.calibration`, "Check the
  graders", a `data-graders` button with its `data-graders-results` table
  and a `data-graders="stop"` button). labels.ts (answers a person
  labelled, each `{ id, question, reference, answer, label }`) and
  graders.ts (the package's `Evaluator`s, each giving one boolean metric,
  `correct`, and its reason) are plain JavaScript the learner edits;
  graders.ts's typed module holds each name to the package's types
  (`TYPED`). The build runs both and guards what they made (`labelsMade`,
  `gradersMade`), so one that makes no list refuses the build in words that
  name it. graders.ts imports `SemanticJudge` from the package, which the
  build does not load: it runs the file with `SemanticJudge` undefined, as
  a grader reads it only when it runs, and the press runs the file again
  with the package's own.
  - calibration.ts is read-only, and nothing of the check is hidden in the
    page: what a grader is handed (`Case`, never the label), each label as
    a calibration's case (reviewed, one boolean metric at tolerance 0), the
    table's row of each check (`rowOf`: the grader's observed verdict and
    reason, and the agreement, false pass and false fail of the package's
    agreement grade), the judge (`SemanticJevLive({ evaluate })`), one
    `defineGraderCalibration` per grader and `calibrateGrader` for each.
    The page runs it with its types taken out by named pieces (`TYPES`,
    `calibrationBodyOf`); `evaluate` and `hear` are the page's, said in a
    comment and the parameters of the typed module's `run`.
  - The judge: `run.ts`'s `judgeOf(keyOf, fetchFn)`, read when the button
    is pressed. With a gateway key kept, the real Jev: `jevTransport`
    (`jev.ts`) maps the package's `SemanticInput` to `decide`'s predicates
    and the answers back (`predicatesOf`, `answersOf`), yes-or-no
    questions alone, a score or a choice question refused in the page's
    words with nothing sent, and passes the package's signal on, so Stop
    and the judge's deadline abort the request. Without a key, the
    stand-in (`stand-in.ts`): one data value, `RECORDED`, Jev's answers to
    the starter's sixteen requests in each of five runs, recorded on 17
    November 2026, and one lookup, `recordedAnswers`, which answers with
    each median and is keyed on the whole request (the text and every
    question's name, kind and words, in order); a test pins the medians,
    that every verdict at the starter's bars held in all five runs, and
    case 4's spread of `commits`. Any other request is
    refused in its words (`NOT_RECORDED`), which the package's judge says
    after "Jev request failed: ". A check whose request failed leaves the
    grader's observation `error`: its cell reads "no grade", and the
    package counts it as a disagreement. The line under the table says who
    answered, and what a press with a key costs (16 requests, less than a
    tenth of a cent). No test reaches the gateway: the real path runs over
    a fake `fetch` shaped like `/v1/decisions`.
  - The table is `GradersBoard` (`lessons/grade-the-grader/board.ts`, no
    DOM, holding rows to its own `Row` schema), drawn by
    `panes/graders.ts`. It is run with `runtime.runAlone`, as lesson 13's
    evals, and needs no model.
- **A hosted model through the Vercel AI Gateway**, with the learner's
  own key (`models/gateway.ts`, the last card of the model list).
  - The wire is pure and holds no key (`gateway-wire.ts`: `wireMessages`,
    `wireTools`, `requestBody`, `readChunk`, `endReading`), so the kernel's
    model providers can reuse it. Calls are native tool calls; a call is
    handed on whole at the stream's end; the model's reasoning is left on
    (off, DeepSeek dropped words mid-answer) and not shown; the usage gives `cacheRead`, so the
    Context tab's usage line says what the provider read from its cache.
  - The key is kept in memory and the tab's `sessionStorage`
    (`efferent-gateway:key`, outside the lessons' prefix), never in
    `localStorage`, an address, a trace or the journal, and is read at each
    request, so Forget key stops the model in use. The address is fixed in
    code. A reload returns to Echo; the model list (the gateway's language
    models with tool use) loads when its search is first used.
  - `DEFAULT_GATEWAY_MODEL` is `deepseek/deepseek-v4.1-flash-1017`, asked of
    Baseten first (`order`; another provider answers when Baseten is busy).
    Requests of one conversation share a `prompt_cache_key`, a hash of its
    first two messages: opaque, and the same for each of its requests.
  - Failures are `AiError`s in words. The gateway sends its error replies
    (a wrong key, a key past its limit, an unknown model, a busy provider)
    without CORS headers, so in a browser each is a failed fetch: one
    failure, worth another try, whose words name all of them. Where the
    status can be read (tests, a host outside a browser) `failureOf` maps
    it: 401 and 403 (`AuthenticationError`) and 402 (`QuotaExhaustedError`)
    are not worth another try, 429 (`RateLimitError`) and 5xx
    (`InternalProviderError`) are, so lesson 14's plan retries them. A provider that fails part way, a connection
    that ends early and an answer cut before any word each fail too, so an
    empty or half answer is never stored as whole; an aborted request ends
    nothing by itself (the page's Stop stops the program), and fails after
    a second if nobody does.
  - Lesson 13 names a gateway candidate without its "/", which the eval
    package refuses in a name (`candidateName`).
  - Tests use a fake `fetch` shaped like the gateway's own stream
    (`gateway.test.ts`). A browser script talks to the gateway through a
    Playwright route that adds the key, so the page and the kept Chrome
    profile only ever hold a dummy, and replays recorded answers by a hash of
    the request body.
- **Echo** (`models/mock.ts`) answers by rule, so a lesson can rely on it: a
  sum to the calculator, "ask a helper" to `delegate`, "show a table of" to
  `show`, a summarizer's request summarized by count; it reads past every
  host note. A new rule gets a test in `models/models.test.ts` that fails
  without it. A sum is two numbers and an operator, neither number part of
  a longer one (a date, a phone number) and an x only between spaces; a
  table's size is the number after "to"; a message that starts with
  "remember" is `remember`'s, saved without its "to" or "that", before the
  rule that sends a message about notes to `recall` (a sum in it still
  comes first); a helper's answer is said as a sentence that ends, with the
  step's other results after it. Real models run in the browser (WebLLM on WebGPU, a CPU
  worker, Chrome's Prompt API). When the GPU stops running a WebLLM model (its
  driver reset the device), the chat says so in `gpuLostWords`
  (`models/gpu-lost.ts`): one request gave the model more new text to read
  at once than the GPU finishes in the time the driver allows, so it names
  the largest model on the processor (`cpuModel`), which no GPU driver
  stops, and Clear context, since the same model picked again would read
  the whole conversation again. Measured on one AMD integrated GPU: Qwen2.5
  0.5B (f16) lost at about 570 new tokens in one request, SmolLM2 360M on
  the GPU between 620 and 1,200, SmolLM2 360M on the CPU read 1,200 in 20
  seconds; WebLLM reads a prompt in chunks compiled into the model (1,024 tokens
  for every model the page offers), and setting a smaller context window
  changed nothing. A model in the page mints the ids of its
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
  - Lesson 16's rules, for the workspace, each asleep where its tool is
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
  - Lesson 17's rules, for background tasks. A report is known by the
    kernel's words (`reportText`, read with `reportIn`), and answered
    before every other rule, with no call: "Task t1 finished: " and its
    answer's first sentence, or "Task t1 failed: " and why, and a
    message of the person's that the same turn took quoted after it
    ("You also said: …"). A test fails without it: Echo reads past every
    host note, so in a report's turn it would read the last message the
    person typed. "In the background, X" and "start a task: X" call
    `startTask` with X, and "cancel task t1" calls `cancelTask`, each
    where its tool is offered and anchored at the message's start. The
    start rule sits ahead of every other rule (X may hold a sum, a topic
    to look up or a note to remember), with a test that fails when it is
    moved after the sum, lookup or remember rule; no other rule wakes on
    "cancel task", so the cancel rule's place decides nothing and has no
    such test. A `startTask` result is answered "Started
    task t1: its answer comes as a message of its own.", a `cancelTask`
    result in its own words, and a failure of either as the tool's. A
    report is never what the person said, and no note of condensed turns
    (`isReport`). The helper is offered tools.ts's tools and uses them by
    the same rules: a task that is a sum calls the calculator, and the
    report reads "The tool answered: calculator says 42.".
  - Lesson 18's curator's rules (`models/echo-curation.ts`), in
    `echoReply`, first after the summarizer's, so they answer a curator's
    call, which offers no tool, whatever path it takes; each asleep unless
    the request's first line is the kernel's, word for word
    (`CURATION_HEAD`, `REVIEW_HEAD`): the kernel's prompt is never changed
    for Echo. A review prompt is answered with the proposal unchanged. A
    curation prompt is answered from its `<this-turn>` block's `User:` lines
    alone, so Echo never rests a memory on the assistant's words: each
    sentence "<thing> <relation> <thing>." with a relation of
    `MEMORY_RELATIONS` (the links' list) is a memory about the two, the
    subject first in `about`, quoting the sentence ("My friend Ana Silva" is
    Ana Silva); a thing `<stored-entities>` holds by a name or another name
    is that entity, any other a new one under a key of its own, its kind
    from its place in the relation ("works at": a person and an
    organization; "lives in" and "is in": the object a place; "is the sister
    of": two people; "sells": an organization; anything else a thing, never
    from capitals); "I …" sentences are about `n1`; "X now <relation> Y."
    also ends the standing memory about X with that relation, from
    `<stored-memories>`, as `changed`; "Forget X." lists the standing
    memories about X in `forget`; a sentence a standing memory says word for
    word is a restatement. A question says nothing. Echo streams a curator's
    reply in one piece, at once. With no call to make, one question sent with
    the kernel's note of memories (`knowledgeNote`: its first line, word for
    word, then the frame) is answered from the note's first two lines, each
    without when it was said, a line of what a memory replaced read as
    "Before that: <sentence>" ("From what I know: Ana Silva works at Globex.
    Before that: Ana Silva works at Acme."); the note is read past as the
    links' is (`isAdded`).
  - Lesson 18's rules, for links, each asleep where its tool is not
    offered, placed after lesson 11's rules and before lesson 16's. In a
    message that does not end with a question mark, each sentence
    "<thing> <relation> <thing>." whose relation is one of
    `LINK_RELATIONS` (works at, is in, lives in, likes, drives, sells, is
    the sister of) is one `linkThings` call, all in one answer; "I work at
    X." and "I live in X." have the subject "user". Where `rememberFact`
    is offered too, lesson 11's rule comes first ("I live in Lisbon." is a
    fact), with a test that fails when the link rule is moved before it.
    "Follow X." and "What is X linked to?" call `followThings` with X;
    "Unlink e2." calls `unlinkThings`. The ids `linkThings` answered in one
    step are answered in one sentence ("The links' ids: e1, e2."), which
    says nothing of what was stored, since a link said again is answered
    with the id it has; a `followThings` result with "Following X: " and
    its first two links; an `unlinkThings` result, and any failure, as the
    tool's. With no call to make, one question sent with the kernel's note
    of links (`linksNote`: its first line, word for word, then the frame)
    is answered from the note's first two lines, whatever it asks ("From
    what I know: Ana works at Acme. Acme is in Lisbon."), each without the
    bracket the note writes after its sentence (how often and when it was
    said, `saidText`: a test fails without the strip). The follow rule
    is a call, so it comes before that reading, with a test that fails
    when the reading is moved before the calls: "What is Acme linked to?"
    names Acme and is sent a note too. The note of links is read past as
    the facts' is (`isAdded`). The world's questions need no rule of their
    own: each is answered from the note's first two lines, so the order the
    walk gives is what Echo says.
  - Lesson 13's rule, in `echoReply`, after every other rule but the
    last: one message that says what something is and then asks about it
    under the same name ("The meeting is on Tuesday. When is the
    meeting?") is answered with its first sentence ("The meeting is on
    Tuesday."). Without it Echo repeats the message, which holds the
    answer too; the eval's answer grader fails a copy of the message, so
    Echo would fail its own golden set. Another name, or the two
    sentences in another form, is repeated as any message is. A test
    fails without the rule. `loadEcho(…, …, "words")` is an Echo that
    calls no tool, even one it is offered, and answers every message as
    `echoReply` does.
  - A turn that failed leaves its message in the journal with no answer:
    Echo treats it as waiting, and the next turn answers it with the new
    one (two calls where one was expected).
- Skill `add-lesson` is the checklist for a new lesson.

## Rules

- Text a lesson shows is code the learner reads: plain, commented in full
  sentences, and the same text the tests compile and run.
- A lesson's words assume a reader who knows a little JavaScript and
  nothing else: no comparison with something outside the page, and every
  term said in plain words where the track first uses it (skill
  `add-lesson`, "The page").
- Draw what a model or a user wrote as text nodes, never as markup, unless it
  goes through `markdown.ts` (the agent's answers).
- A browser check runs Chrome with WebGPU (`--enable-unsafe-webgpu`), at
  desktop and phone widths, in light and dark.
