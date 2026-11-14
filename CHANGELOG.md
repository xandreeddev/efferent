# Changelog

Changes to the published `@xandreed/*` framework packages. All of them share
one version and are published together under npm's `latest` tag.

Every pull request adds its entry under **Unreleased**. A release turns that
section into the new version. Releases before 0.11.0 are not recorded here.

## Unreleased

### Added

- `@xandreed/core`, `@xandreed/sdk`: the kernel, a small core with
  every other part a plain Effect layer, as two new entries beside the
  existing engine, which neither imports nor is imported by it. It is a
  first cut, with journals kept in the process, and
  it will change as the parts it leaves out return. `docs/kernel.md` is its
  direction document.
  - `@xandreed/core/kernel` holds what every agent has, whatever its
    workflow: ids, `Message`, the event envelope, the `JournalStorage` and
    `Sessions` contracts with a conformance kit each, the session's two
    transitions and the fold of a journal to its state, reading a journal
    (`readJournal`, `readerFor`, `KERNEL_READER`), `inspectionOf` (a
    session's header, state and events), the conversation's records
    (`conversation.user.message` and `conversation.assistant.message`,
    written with `userMessage(text)` and `assistantMessage(text, meta?)`,
    whose meta is the model, the `Usage` the provider reported and the
    tool calls; `CONVERSATION_READER` reads them), and `Core`, which is
    events only: `publish`, `on` (named, in the background or with
    `{ wait: true }`) and `events`. `kernel({ capacity? })` is the layer
    that provides `Core` alone. It imports `effect` alone, and names no
    loop, memory, system text or request to a model.
  - `@xandreed/sdk/kernel` holds the workflow contracts, each in a contract
    folder with its entities, events, pure rules and kit: memory's
    (`Memory`, `memoryConformance`, `Tokens`, `estimateTokens`,
    `estimateContext`, `promptMessage`, and `memoryWrapperConformance`,
    the kit of a wrapper of memory: what it adds for one request comes
    after the context, whole and in its order, and is never stored,
    `docs/adr/0005-context-for-one-request.md`), what the UI shows
    (`View`: `Text`, `List`, `Table` and `Card`; the record
    `plugin.render.view`, tagged `ui`, which bears no message, so the model
    never sees a view, and a later one with the same id replaces it;
    `viewsOf`, the pure fold a client draws, live and after a reload; live
    progress, `plugin.render.progress`; no service: a tool appends its view
    through `CurrentTurn`, `docs/adr/0009-what-the-ui-shows-is-a-record.md`), the summary's
    (`Summarizer`, which a host provides over its model, failing with
    `SummaryFailed`), the tool call's
    (`CurrentTurn`: the open turn a call runs in, which the host's loop
    provides around `toolkit.handle` and a tool declares in its
    `dependencies`, `docs/adr/0007-a-tool-reaches-its-turn.md`) and the
    inbox's (`Inbox`, `InboxTurn`). A plugin imports contracts and core, never another
    plugin's folder, and a contract never imports a plugin: the boundaries
    gate refuses both. There is no loop contract and no stock loop: the
    loop is the host's program (`docs/adr/0003-journal-holds-the-conversation.md`).
  - An event is named by the owner of the contract that defines it: the
    session's are core's (`core.session.turn.started`,
    `core.session.turn.ended`), a plugin's `plugin.<name>.*`, and the
    conversation's `conversation.*`, which a turn's body writes. The set is
    open: a plugin defines its own with `storedEvent` and `liveEvent`, each
    with a schema for its data and the tags that say what it is for
    (`conversation`, `turn`, `memory`, `ui`, `trace`, or a plugin's own
    `<plugin>.<tag>`; `taggedWith` tells a record by them). Only a record
    tagged `conversation` is read as a message (`messageOf`); a memory
    may send the message of a record of its own, as the summary memory
    sends its summary (`docs/adr/0008-a-memory-keeps-its-summary.md`). Every stored
    record carries its tags and the turn it was stored in. A stored record
    says whether a reader that does not know it may skip it, and a reader
    of the conversation or of another plugin's records extends that reader
    (`readerFor(name, own, CONVERSATION_READER)`). A live event names its
    turn only when it happens inside one.
  - The stock plugins, each a layer whose type says what it needs:
    `inProcessJournal()`, `sessions()`, `flatMemory`,
    `windowMemory({ budgetTokens })` and `inbox(turn)`. A host provides
    them to its program with `Effect.provide`, or composes them with
    `Layer.provideMerge` over `kernel()`; a stack whose type is written out
    does not compile when a part is missing. The host's turn opens a turn
    with `sessions.open(id)`, which closes it with its scope's outcome,
    stores the user's message, asks memory for the context, calls Effect
    AI's `LanguageModel` with the system text first, and stores the
    answer: a turn stores four events (its start, the user's message, the
    assistant's message, its end). The system text is the program's code,
    never stored. `sessions.create` decodes its input (`InvalidSession`).
  - `Memory` is one function, `context(session)`: the messages that follow
    the system text, ready for a prompt. It keeps nothing, builds each
    context from the journal, and what it stores of its own is tagged
    `memory` and derived from the conversation. `flatMemory` sends every
    message; `windowMemory` drops whole turns oldest first, its budget
    covering the history, and publishes `plugin.window.pressure` as it
    builds a context near the budget. `summaryMemory({ budgetTokens,
    keepTurns? })`, over a `Summarizer` the host provides, folds the
    oldest closed turns, whole, with the summary so far, into a new
    summary when the conversation passes its budget, stores it once as
    `plugin.summary.summarized` (tagged `memory`), and starts every later
    context with it as a host note, so the cached prefix holds from one
    compaction to the next; it folds every closed turn but the latest,
    never the open one, frames the summary as data (`hostNote`,
    `framed`), and asks for one summary at most per context. A budget's errors, `OverBudget`, `isOverBudget` and
    `InvalidBudget`, are the memory contract's, shared by every memory
    with a budget, no longer the window plugin's.
  - Tools: a turn that uses them is a loop the host writes over Effect
    AI's `Toolkit`, and the kernel adds no tool service
    (`docs/adr/0004-tool-traffic-is-conversation.md`). The turn offers
    the toolkit to the model with `disableToolCallResolution: true` and
    `toolCallValidation: "deferred"`, runs each call through the toolkit's
    handlers, and stores the model's answer with its calls
    (`assistantMessage(text, { toolCalls })`, from the stream's
    `tool-call` parts) and each call's outcome as
    `conversation.tool.result` (`toolResult(call, result, isFailure)`, a
    new `Message` variant, `ToolResult`). A tool's failure, an unknown
    tool and bad parameters are stored as failed results, and the turn
    goes on. Tool definitions are code, never stored. `promptMessage`
    sends a call as a part of the model's message and a result as a tool
    message; `paired` keeps a call only with its result and a result only
    with its call, so a turn stopped while a tool ran never sends a call
    nothing answers. Both stock memories send through it, the memory
    kit's new `pairs` check holds a memory to it, and the estimate counts
    tool traffic (`messageText`). `scriptedModel` can ask for tools
    (`ModelAnswer` `Calls`). The window memory drops whole turns only, so
    one long tool turn can go over its budget and fails with `OverBudget`.
  - The inbox queues messages per session and answers each, in order, with
    the host's turn function (`inbox(turn)`, `inboxOf(turn, options)`),
    in a turn of its own: `enqueue(session, message)` returns at once with
    the message's ticket and its reply, whatever becomes of the message's
    `plugin.inbox.queued` announcement, which reaches the listeners its
    publisher waits for before the message's turn starts. A ticket is the
    inbox's own number, never given twice in one inbox. A failed turn fails
    only its own reply, a full queue refuses (`InboxRefused`), and every
    reply not given when the inbox's scope closes fails with `InboxClosed`.
    The inbox keeps nothing of a session it is not serving. Queued messages
    live in the process. Its contract, `Inbox`, is the plugin's own.
  - The journal holds the conversation and nothing derived from
    configuration: no request, no system text, no pointers to what was
    sent, so each message's text is stored once and a change to the system
    text leaves nothing stored stale.
  - A part is replaced by providing a different layer; a host that keeps
    sessions going across the change builds the kernel, the journal and
    the session plugin once and swaps the stack above them.
  - `api/core--kernel.api.txt` is core's kernel API: a later change that
    removes or changes a name there says in this file what a plugin must
    change.
  - The writes of one open turn are stored one at a time: appends made at
    once both succeed, and the end waits for an append still being stored.
    A write whose store did not report success (its caller interrupted
    while the store had not answered, or a store that failed after it kept
    the event) leaves the turn's place unknown, and the next write, the
    end's included, reads the last place from the store: the end is still
    stored after it, and the session takes its next turn. A turn stays open
    in the journal only when its end could not be stored, or when the store
    kept its start and reported a failure. A turn's body that appends a
    record named under `core.` is refused (`SessionRefused`, `ReservedName`)
    and nothing is stored: core's records are the session plugin's.
    A session's events appended one after another reach listeners in
    journal order. A session is
    busy until its turn's end was announced, for at most `closeWait` (5
    seconds) after it was stored, and is free by the time the end reaches
    a background listener or the stream. Every turn begins from what the
    journal holds, so two session plugins over one store take turns on a
    session. Session ids are version 4 UUIDs from the platform's
    cryptographic random source.
  - A limit on a wait for a listener holds whatever the listener does: a
    listener that cannot be interrupted does not keep a turn from
    returning or a session busy, nor a stack from closing. It is reported
    as `core.listener.failed`. A handler that ends with an interrupt it
    was not sent fails as any other (`ListenerFailed`): a background
    listener is reported and goes on listening, and a turn it is inside
    ends `Failed`, not `Interrupted`.
  - `Core.publish(event, { listenerFailures: "report" })` runs every
    waiting listener, whatever the others did, and reports each failure as
    `core.listener.failed` once the event was handed over; it cannot fail.
    The default is unchanged: the first failure stops the waiting listeners
    after it and fails the publisher. The end of a turn and the inbox's
    `plugin.inbox.queued` are announced this way, so a waiting listener
    placed after a failing one still hears them. A turn interrupted as it
    opened has its start announced before its end, within a `closeWait` of
    its own, so the session is busy for at most twice `closeWait` then.
  - The inbox's worker takes a message in one transition, then waits for
    that message's own announcement before its turn starts, and each
    announcement follows the session's announcement before it, whether
    that message waits, was taken or runs.
  - The memory kit checks that a memory refuses an unknown record of the
    conversation's that may not be skipped (`unknown-conversation-refused`):
    a memory reads the conversation's records with the conversation's
    reader, not its own prefix alone. It holds a memory to a budget only
    when the subject has one (`MemorySubject.budgetTokens`).
  - Core's event envelope holds no `replaces`, and `SeqRange` is gone: a
    plugin whose record stands for a run of the journal keeps that run in
    its record's own data. `listenerFailed` is no longer exported: a
    publisher that must report its listeners' failures publishes with
    `{ listenerFailures: "report" }`.
  - `scriptedModel(script)` is a `LanguageModel` that follows a
    `ModelScript` and calls no provider, recording the prompts it was
    sent: what a test runs an agent on.
  - `Sessions.open(id)` opens a turn in the caller's scope and closes it
    with the scope's outcome; `JournalStorage.append` takes the turn the
    record was stored in.
  - Nothing in either entry imports a `node:` or `bun:` module.

### Repository

- Docs site: Lesson 5, "Compaction", at `/learn/compaction`. Lesson 2's
  program over `summaryMemory`: `memory.ts` holds its options (the budget
  and `keepTurns`), and `summarizer.ts` the learner's `Summarizer` over the
  model they picked, its prompt framing the turns it folds as data. The
  page's runtime wraps the summarizer (`watchSummarizer`), so a model call
  made while it runs is stamped as the summarizer's and counted apart from
  the turn's; the Context tab shows a "Memory compacted" step, the summary
  row from its record and the folded turns left out. Echo summarizes by
  rule, reads past every host note (a summary's as well as the clock's)
  when it picks a tool, and quotes the summary when asked what was said
  earlier. Experiments compact on every turn, keep no finished turn and
  make the summarizer fail.
- Docs site: Lesson 4, "Sub-agents", at `/learn/sub-agents`. The chat's
  agent hands a task to a helper through a `delegate` tool; the helper is
  an agent of its own (its own system text, tools and quiet hooks) working
  in a session of its own, a child of the chat's, and returns `{ answer,
  session }`. `loop.ts` holds lesson 2's loop as `runAgent({ system,
  toolkit, hooks })`, so both agents run it; `tools.ts` declares the
  `Helper` contract `delegate` needs, and main provides it. The Context tab
  gets a row of sessions (the chat, and each helper with its task), one
  board each. Echo hands "Ask a helper: …" to `delegate` and passes the
  helper's answer on. Experiments run the helper in the chat's own session
  (refused as busy), make it slow while the chat is steered, and take
  `delegate` away. ADR 0006 records the shape; `sub-agent.test.ts` holds
  it and `docs/kernel.md` quotes it.
- Docs site: the learn pages' runtime keeps a turn open per session and
  stamps what memory built, each prompt and its usage with the session they
  are for, so a program that runs a turn in a second session inside the
  chat's (a sub-agent) no longer marks the chat idle when that turn ends,
  and the Context tab shows the chat's turns only. A test runs such a
  program and checks every trace's session.
- Docs site: Lesson 3, "A plugin of your own", at `/learn/your-own-plugin`.
  The learner writes two plugins in `plugin.ts`: `meter`, an event plugin
  that hooks each stored answer and each turn's end with `core.on` and
  shows what the turn cost on the status line, and `withClock`, a wrapper
  of memory (a higher-order plugin) that adds the time after the context
  for each request and stores none of it. The Context tab shows the note as
  code's, with no record behind it. Experiments store the clock the wrong
  way (every request then carries every earlier note), drop the first
  message (the wrapper kit's `starts-with-inner` fails on it), make the
  meter slow (the turn waits for a `wait: true` listener) and unplug it.
  A test compiles the five files with tsc and holds the learner's clock to
  `memoryWrapperConformance`; Echo skips the note and answers "What time is
  it?" from it. ADR 0005 records the rule, and lesson 2 now points here.
||||||| parent of 86cc89a9f4c (keep the learn page's turns per session, and show the chat's)
- Docs site: the learn pages' Context tab keeps each list at its bottom as
  the conversation grows, also when the tab was hidden while it grew, and a
  list scrolled up stays where it is. A row under the pointer no longer
  flashes while an answer streams: a paint keeps every row whose content is
  unchanged, and the step track and the model-call picker keep the room
  they took, so the columns do not move during a turn. The workbench's
  scrollbars are slim and in the theme's colours. No published package
  changes.
- Docs site: the learn pages' CPU models keep their downloads in IndexedDB
  where the browser has no Cache API (a page served over plain http from a
  LAN address is no secure context), so a second visit loads them from
  disk instead of downloading them again. No published package changes.
- `docs/adr/0001-kernel-plugin-composition.md` records how the kernel's
  plugins compose (replace, wrap, an event, or an entry in the journal; no
  hooks), `docs/adr/0002-core-owns-state-plugins-own-workflows.md`
  what core owns (sessions, their journal, events, the message vocabulary)
  and what it leaves to plugins' contracts, with the import graph and
  core's API, and `docs/adr/0003-journal-holds-the-conversation.md` that
  the journal holds the conversation, records carry tags, memory builds
  the context and the kernel has no loop. The skill `kernel-architecture`
  loads them before an architectural change of the kernel.
- The boundaries gate holds the kernel's import graph: the sdk's kernel
  contracts are a layer that imports core's kernel and no plugin, and
  each plugin folder a layer that imports the contracts and core's kernel
  and no other plugin's folder. Test code anywhere under the sdk's kernel
  (every test glob the build leaves out, inside a contract or a plugin
  folder too) is its test layer, not that folder's.
- The boundaries gate refuses a `restricted` subpath to the layer of the
  package's own entry too, unless that layer is granted it: a file of
  `core` can no longer reach `@xandreed/core/kernel` by its package name,
  nor one of the sdk `@xandreed/sdk/kernel`.
- `bun run verify:packages` runs the kernel from the packed packages, on
  Node and on Bun: the three contracts' kits (two of core's, memory's
  from the sdk) on the stock plugins, one turn of a host's own over a
  stack of layers on the scripted model, two messages queued with the
  inbox, and a consumer's own contract composed as a layer
  (`scripts/kernel-consumer.fixture.mjs`).
- Docs site: Lesson 2, "Tools", at `/learn/tools`. The learner's turn is a
  loop over steps: the model answers or asks for tools, which tools.ts
  declares with Effect AI's `Tool` and `Toolkit` and runs in the page; the
  turn runs each call with `toolkit.handle`, stores the call and its result
  (a failure as a failed result) and asks again, up to `MAX_STEPS`, and
  takes the messages sent while it works between steps (`chat.drain`). Its
  memory sends through `paired`. Echo calls the tools by rule; the browser's
  small models are offered them in the system text and their
  `<tool_call>` blocks are read back, held out of the chat. The Context tab
  builds a turn's steps from what happened, call by call (steers and tool
  runs included), links tool calls and results to their records by id, and
  shows each model call's context and prompt. A test compiles, type-checks
  and runs the four files on the scripted model. In both lessons a turn
  also takes every message waiting as it opens (`chat.drain`, now in
  lesson 1's chat.ts too), stores them all and answers them together, so
  messages sent while a turn runs are answered by the next one. Lesson 1's memory now
  passes every kit check but `pairs`, and its text says why. No published
  package changes.
- Docs site: in Lesson 1, "Your first agent", the learner's program is the
  agent, and it runs as written. agent.ts holds the system text, one
  `turn` (open a scoped turn with `sessions.open`, store the message, ask
  `memory.context`, stream the model's answer to the chat, store it), the
  `program` (a boot hook with `core.on`, then one turn per message from
  the chat), and `main`, which gives it its modules with `Effect.provide`.
  chat.ts (read-only) is the chat it takes messages from, and memory.ts is
  a flat memory the learner edits. A test compiles, type-checks and runs
  the three files on the scripted model, and the memory through the
  memory kit. The page runs `main` as one long-running fiber over a base
  and a chat queue built once, so a rebuild keeps the conversation and
  the waiting messages, and a turn it stops closes `Interrupted`. A
  module removed from `main` stops the program at its first message, in
  words. The Context tab replaces the editor: each turn's seven steps lit
  as they run, the journal with its tags, what memory took and left out,
  the prompt with each message's source, the part the prompt before
  shares, and the provider's usage, linked by record, with an events log
  under them. It reads the journal and what the page saw the model
  receive; nothing derived is stored. Rebuild, Reset and Format say what
  they did, and the model bar wraps on a phone. No published package
  changes.
- Docs site: the lesson workbench runs any lesson. A lesson's definition
  (`packages/website/src/learn/lessons/<slug>/`) holds its files, the
  names its code may use and how it is evaluated, its chips, its controls
  and experiments, and the page passes the lesson's slug to the workbench.
  The runtime, the editor and the playground name no lesson; Lesson 1 moved
  into its own folder unchanged, and a test runs a second definition
  through the same runtime. No published package changes.

## 0.22.0 — 2026-11-12

### Added

- `cutAtLineBreaks`, an option of `@xandreed/plugin-memory-window` and
  `@xandreed/plugin-memory-summary` (off by default): what a shortened
  result shows is cut at a line break. A cut by character count can fall
  inside a row of a result made of lines. The result then ends with half a
  row and the page read from its notice starts with the other half, so a
  model holds a row's identifier in two pieces, in two results. With the
  option, three cuts fall just after the last line break (`\n`) within their
  limit: the preview of a result bounded as it is written
  (`boundOnWriteChars`), the preview of a result the window strategy spills
  under pressure (`previewChars`), and every page `recall_context` returns,
  for results of the current turn and of earlier turns alike. The cut moves
  there only when that leaves the piece some text and gives up no more than
  a quarter of the piece asked for (4,000 characters of a bound of 16,000,
  150 of a preview of 600, 2,000 of a page of 8,000); otherwise it stays at
  the limit, as with the option off.
  - A result whose rows are shorter than that quarter is cut between two
    rows wherever the rule chooses the cut. A longer row can be cut inside
    its text, at the limit, past the identifier it starts with when that
    identifier is shorter than the quarter.
  - A view with no line break near the limit is cut exactly as before. A
    tool with no view of its own is shown as its result, text as it is and
    anything else as canonical JSON on one line: the option does nothing for
    a result on one line, so a tool shows its rows on separate lines (in
    the text it returns, or in its view) to gain from it.
  - The limits become upper bounds: at the defaults a bounded result shows
    12,000 to 16,000 characters, a pressure preview 450 to 600 and a page
    6,000 to 8,000, so a result is read in a few more pages. Each low end
    is one less (11,999, 449, 5,999) where the limit would split a
    surrogate pair: the quarter is counted back from the cut at the limit,
    which is then one unit before it.
  - Pages have no fixed size, so the only offset to read on from is the one
    a notice or a page's last line prints. A caller that adds 8,000 to the
    offset it last passed skips the text between the page's end and that
    offset, and nothing tells it so.
  - A result a little longer than the bound can be bounded where it was
    shown whole with the option off. A result is left whole when its
    preview would not be shorter than its view, and a preview cut at a line
    break is shorter: 12,000 characters, a line break and 4,049 more are
    shown whole at the default bound with the option off, and as 12,001
    characters and a notice with it on.
  - No text the model reads changes. The notice and a page's last lines are
    the same strings, and the offset each prints is where its cut fell, so
    the pages read from a notice join to the whole view. A piece that ends
    with its line break is followed by an empty line before them.
  - A page is still cut where a page the run already read in the turn
    starts, wherever that is, and a page starts at the offset its call
    names.
  - With the option off no cut, text, golden or stored record changes. One
    thing does: each plugin's defaults gained `cutAtLineBreaks: false`, and
    an agent's fingerprint (`Agent.fingerprint`) hashes its plugins' options
    with their defaults, so an agent that uses either memory plugin has a
    new fingerprint, whatever the option is.
- The window strategy says the option in its version, as it does
  `currentTurnFirst`: `4+cut-at-line-breaks`, or
  `4+current-turn-first+cut-at-line-breaks` with both, in every request's
  `strategyVersion` and in `context.built`. Its id stays `window`, so
  compactions recorded with or without the option keep applying. The summary
  strategy's version stays `2`: the option changes none of its summary
  decisions, and render checkpoints stored under that version keep applying.
  Under it, where a bound was cut is read from its preview.
- `@xandreed/core`: `MemoryPolicy.cutAtLineBreaks` is how a custom strategy
  asks for the bound's preview to be cut so, and `spillPreview` and
  `recallCapabilityOf` take the option as a last parameter
  (`spillPreview(entry, view, chars, { cutAtLineBreaks: true })`,
  `recallCapabilityOf(id, { cutAtLineBreaks: true })`) for a strategy's own
  spills and for the pages of the tool it contributes. A call without it
  behaves as before. A custom strategy gives all three the same value: the
  window plugin's exported `recallCapability` always pages at the character
  limit, so beside a policy that cuts at line breaks it gives heads that end
  after a whole line and pages that do not (the offsets stay right, and rows
  are split again). No journal kind, event or stored field is added, and the
  stored format stays 19.
- A session can hold both cuts. `recall_context` reads what a request shows
  back from the request, not from the option: a result shortened at the
  character limit (before the option was turned on, or by an earlier
  release) is still refused inside its shown head and read on from the
  offset its notice prints, and so is one cut at a line break after the
  option is turned off. A page already read counts for the text it holds,
  whichever way it was cut.

  The limits. A row longer than a quarter of the piece can be cut inside its
  text, and a row whose identifier is itself longer than that quarter inside
  the identifier. A `\r\n` stays whole when the cut falls after it, and a cut
  the rule leaves at the limit can still fall between the two. Turned on
  within a turn in which the window strategy already spilled a result at the
  character limit, the option can make that result a candidate once more.
  The rule is unchanged: a result is spilled again only when the new preview
  is shorter than the text it shows. A preview cut at a line break usually
  is, so a request still over its budget spills the result again, for the
  few characters the line break gives up, and then never again; where the
  count in the notice gains a digit the two previews are as long, and
  nothing is spilled. The step loop's breaker stops a model that steps
  forward inside a page it read up to a stride of 1,333 characters in a page
  of 8,000; a page cut at a line break holds 6,000 to 8,000 (5,999 where the
  limit would split a surrogate pair), so that stride is between 999 and
  1,333.

### Repository

- The release versioner accepts the Changesets plan again now that the docs
  site depends on framework packages (the Learn track runs the real agent in
  the page). The CLI lists such an ignored workspace with no release of its
  own, and the plan check had required the list to be exactly the 24
  distribution packages, so no release could be prepared. An ignored
  workspace listed that way is now left out of the check; listed with a
  release, with a version that moves, or under any other name, it is refused
  as before.
- Docs site: a new interactive "Learn" track at `/learn`. Lesson 1, "Your
  first agent", is a full-screen, paged workbench that runs the real
  `Agent.define` and `agent.turn` in the page over a model on the learner's
  own machine (an instant offline stand-in, small CPU models, WebLLM models
  including Phi-3.5 mini, or Chrome's built-in model). It has a code editor
  with read-only sections, a chat, a live diagram of the step loop, and a
  context inspector that shows the stack a model was sent beside the journal
  that holds everything, the memory window's drops and the prefix a provider
  could cache; its last step has the learner write a small memory-strategy
  plugin and swap it in. The chat renders replies as markdown, the code pane
  has a Format button (Prettier, loaded only when used), every event opens to
  its payload, and WebLLM downloads retry, switch to IndexedDB after a failed
  Cache API write and recover from a lost GPU device. No published package
  changes.

### Changes

- `cutAtLineBreaks`, an option of both memory strategies (off by default), cuts what a shortened result shows at a line break: the preview of a result bounded as it is written, the preview of a result the window strategy spills under pressure and every `recall_context` page end just after the last line break within their limit, when that gives up no more than a quarter of the piece asked for, so a result whose rows are shorter than that is cut between two rows wherever the rule chooses the cut (a page still stops where a page already read starts, and starts at the offset its call names). The notice and a page's last lines are the same texts with the cut's offsets, the limits become upper bounds (pages have no fixed size: read on from the offset a notice or a page prints), and a session can hold results cut either way. A view with no line break near a limit is cut as before, so a tool shows its rows on separate lines to gain from it. The window strategy's version takes the suffix `+cut-at-line-breaks`; the summary strategy's stays `2`. `MemoryPolicy.cutAtLineBreaks`, and a last parameter of `spillPreview` and `recallCapabilityOf` in `@xandreed/core`, carry the option for a custom strategy. Each plugin's defaults gained `cutAtLineBreaks: false`, so `Agent.fingerprint` changes for an agent that uses either, whatever the option is.

## 0.21.2 — 2026-11-11

### Migration

- `@xandreed/core`: a host that reads the last line of a `recall_context`
  page (a test that pins a page, a parser of the offset it names, a reader
  of the transcript) handles two more lines, and pages shorter than 8,000
  characters. A page with unread text right after it ends as before, byte
  for byte: `[… N more characters; call recall_context with locator "…" and
  offset E]`. A page that stops where text the run already read in the turn
  starts ends `[… the next N characters are in text you already read, shown
  above; M more characters after them; call recall_context with locator "…"
  and offset R]`, R the first offset past that text, or, when that text runs
  to the result's end, `[… the remaining N characters are in text you
  already read, shown above]`, which names no offset. The tool's
  description, its `request.part` hash and the tokens it reserves are
  unchanged.
- `@xandreed/core`: a host that answers a `recall_context` call itself (a
  `ToolInterceptor` that responds for the call or replaces its result), or
  whose registry shows the tool's results as other text than the tool
  returns (a view of its own for it), no longer has that result counted as
  a page read. 0.21.1 took any result of the tool that was not an error for
  8,000 characters from its call's offset and refused later calls inside
  them with `AlreadyRecalled`; only a result the request shows as the page
  the tool writes counts now, and those calls are served.
- `@xandreed/core`: a host that pins or parses an `AlreadyRecalled` message
  finds a later offset in it, and one more message. `To read on, pass
  offset N.` named the end of the page that held the offset asked for; N is
  now the first offset past that page whose text no page already read
  holds, so where pages already read follow on from it N is the end of the
  last of them. `That page ends the result.` is still said of the last page
  only. Where pages read after the page hold the text up to the result's
  end, the message is `The text from that offset to the result's end is in
  pages you already read, shown above.` The `error` name is unchanged.

### Fixed

- `@xandreed/core`: a page `recall_context` serves never holds text of a
  page the same run already read in the turn. 0.21.1 refused a call by
  where its page would start and then served 8,000 characters from there,
  so an offset a little below a page already read returned that page again:
  a model that stepped downward through a result (60000, 59000, 58000, and
  so on) was served 8,000 characters a call, all but 1,000 of them text the
  request held, and ended at the step limit under the summary strategy or
  failed with `context.budget` under the window strategy, which the 0.21.1
  notes below state as a limit. A page now ends where the next page already
  read starts, when that is sooner than 8,000 characters on, wherever the
  call starts: below a page already read, or in a gap between two. Every
  character a call returns is new to the request, in whatever order the
  model asks, and the pages of one result together never hold more than the
  result does. That model is now served 1,000 characters a call and ends at
  the step limit within the budget, the request holding each character once.
  - The line a page ends with names the first offset past it whose text the
    request does not hold. With unread text right after the page that is
    the page's own end, in the line it always had. Where a page already
    read holds the text there, the line says how far the text already read
    runs and names the offset past it, across every page that follows on,
    so the model spends no call on a refusal: `[… the next 8000 characters
    are in text you already read, shown above; 32000 more characters after
    them; call recall_context with locator "run-1:2" and offset 28000]`.
    When that text runs to the result's end it names none: `[… the remaining
    8000 characters are in text you already read, shown above]`.
  - A page already read is known by what the request shows for its call's
    result, not by its call's offset and the page size: the guard reads
    where a page ended from that text, and counts it only when it is the
    result's text from the call's offset followed by the line the tool
    writes. A cut page so counts for the text it holds, and two pages
    that calls run at once were each served whole overlap as they did.
  - An `AlreadyRecalled` reply names the first offset the request holds no
    text of, as a page's last line does: the end of the page that holds the
    offset asked for, or, where pages already read follow on from it, the
    end of the last of them. 0.21.1 named that page's own end, so after
    pages read in order a model that asked from inside the first was
    refused once for each page on the way. The pages a cut leaves follow on
    from one another by construction, so under that rule a model that had
    stepped down ten times would have met a refusal for each of them. One
    reply now leads to a call that is served. When pages read after the
    page hold the rest of the result, the reply says so and names no offset
    (see Migration).
  - That text is the result's view, not the value the call returned: a
    page a registry or a host presents as other text is not counted as
    read, since the request does not show its text. Nor is a result the
    tool never writes that reads like a page: the tool's line with no text
    before it, or text that ends inside a surrogate pair. A locator that
    holds the characters a page's last line starts with (a run id is any
    string) is read back all the same: every place the line could start is
    tried.
  - No page is empty for the cut: a call is served only from an offset
    outside every page already read, so the next such page starts past it.
    A call from a page's start or from inside one is refused with
    `AlreadyRecalled`, as before.
  - The scope is the guard's: the current turn, the asking run's own pages,
    pages still shown whole, under both memory strategies. A result of an
    earlier turn is served whole pages from any offset, as before; a page
    another run of the turn read is not cut for, and one read by a call
    that ran at once with this one (`limits.toolConcurrency` above 1) is
    cut for only when its result was recorded before this call was
    checked. Where that call came later in the response, the line the cut
    page ends with, or the refusal, calls `shown above` a page the request
    shows after it.
  - The step loop's breaker is unchanged, and so is its bound on forward
    steps inside one page already read (a stride of up to 1,333
    characters). Pages that follow on from one another now get one reply
    for every offset inside them, so a model that steps forward through
    them repeats one signature and is stopped at the sixth refusal, where
    each refusal named another offset before and the run went on.
    A model that steps downward returns new text with every call, so the
    breaker counts no repeat: such a run costs steps, not context, and ends
    at the step limit or once it has read down to the result's shown start.

### Changes

- A page `recall_context` serves never holds text of a page the same run already read in the turn: it ends where the next such page starts, wherever the call starts, so every character a call returns is new to the request and the pages of one result never hold more than the result does. A model that steps downward through a result, each call a little below the last page it read, is served only the text between, where 0.21.1 served a whole page each time and the run ended at the step limit or failed with `context.budget`. A page that stops at text already read ends with a line that says how far that text runs and names the offset past it (`[… the next N characters are in text you already read, shown above; M more characters after them; call recall_context with locator "…" and offset R]`), or `[… the remaining N characters are in text you already read, shown above]` when it runs to the result's end; the line of a page with unread text after it is unchanged, and so is the tool's description. An `AlreadyRecalled` reply names the first offset the request holds no text of, as a page's last line does, where 0.21.1 named the end of the page that held the offset asked for and so led to one more refusal for each page read after it; when pages read after that page hold the rest of the result it says `The text from that offset to the result's end is in pages you already read, shown above.` A page already read is known by what the request shows for its call's result, so a result of the tool that is not a page it writes (a host's own answer to the call) is no longer counted as read.

- `recall_context` reads a page already read from what the request shows for its call's result, not from the value the call returned: a page a registry or a host presents as other text is not counted as read, so a call for its text is served. A result the tool never writes is no page either: its last line with no text before it, or text that ends inside a surrogate pair.

## 0.21.1 — 2026-11-11

### Migration

- `@xandreed/core`: a host that pins the description of `recall_context` (a
  request or a journal pinned byte for byte) re-records the pin. The
  description's last sentence changed, so the tool's `request.part` has a new
  hash and `context.built`'s `reservedTokens` is 38 higher than under 0.21.0
  for a host on `memoryWindowPlugin` or `memorySummaryPlugin`: the tool's
  declaration reserves 240 estimated tokens, where 0.21.0's reserved 202. A
  provider's cached prefix from 0.21.0 no longer matches.
- `@xandreed/core`: a host that matches the message of a `recall_context`
  refusal (a test, a prompt that quotes it, a reader of the transcript)
  updates it. All four messages changed: a `ResultShown` message no longer
  names an offset, and an `AlreadyRecalled` message no longer names the
  turn. The `error` names, `ResultShown` and `AlreadyRecalled`, are
  unchanged. A prompt that told the model to pass the offset a `ResultShown`
  reply names tells it to pass the offset the result's notice shows.
- `@xandreed/core`: a host whose agent read on in a result of the same turn
  from an offset inside a page it had already read changes what it asks for.
  Such a call now returns an `AlreadyRecalled` failure that names that
  page's end, where 0.21.0 returned up to 8,000 characters, most of them
  text the request held. A prompt that tells the model to step through a
  result tells it to pass the offset each page ends with.
- A host that pins a request header, `context.built` or its journal byte for
  byte re-records the pin: `@xandreed/plugin-memory-window` writes
  `strategyVersion` `4` (`4+current-turn-first` with `currentTurnFirst`)
  where it wrote `3`, and `4` as the version of each compaction it records.
  Compactions recorded under earlier versions replay as recorded.
- `@xandreed/core`: `compacts` is a required key of `ContextReportTurn`. The
  report stores nothing, so a host that only calls `contextReportOf` changes
  nothing. A host that kept a report it built under 0.21.0 and decodes it
  with `ContextReport` or `ContextReportTurn` finds that it no longer
  decodes, since its turns have no `compacts`: it builds the report again
  from the session's events, or decodes what it kept with a schema of its
  own.

### Fixed

- `@xandreed/core`: a `recall_context` refusal stays true after memory
  shortens the result it is about. In 0.21.0 a call from inside a result's
  shown start was answered `The first 16000 characters of this result are
  shown above. To read on, pass offset 16000.` That reply is the call's
  recorded result, so the model read it again in every later request, also
  after the window strategy had spilled the result to its 600-character
  preview under pressure, or given it its tool's compact view (at the next
  turn's start, which is the default, or under pressure with
  `compactPreviousTurn: false`). A model that followed the reply then read
  on from 16,000 and skipped text its request no longer held. The replies
  now say what the result showed when the call was made and hold no offset:
  `That offset was inside the text this result showed when you asked, so
  nothing was returned. To read on, pass the offset its shortened form shows
  now, or offset 0 if it shows none.` for a result shown through a bound's or
  a spill's preview, and `This result was shown in full when you asked:
  nothing of it was left out. If it is shown shortened now, pass the offset
  its shortened form shows, or offset 0 if it shows none.` for one shown
  whole. Followed in any later request, each leads to where the result's
  shown form ends then: the offset of the notice the result shows, or the
  result's start once only a compact view is shown. Where the turn had
  already read a page from there, the call that follows the reply is refused
  with `AlreadyRecalled` in the same turn, which names where to go on, and
  is served that page again in a later turn, which the guard does not cover.
  The summary strategy never shortens a result again, so there the notice's
  offset is the one 0.21.0 named.
- `@xandreed/core`: `recall_context` refuses an offset inside a page the
  turn already read. 0.21.0 refused a page again only from the very offset
  it was read from, so a model that read on from the notice and then
  stepped inside that page (16000, 16001, and so on, or 17000, 18000) got a
  page of its own each step, nearly all of it text the request held. The run
  ended at the step limit under the summary strategy and failed with
  `context.budget` under the window strategy: the two endings the guard was
  added to remove. An offset inside a page of the same turn that is still
  shown whole, its start included, now fails with `AlreadyRecalled`:
  `The text from that offset is in a page you already read, shown above. To
  read on, pass offset 24000.` (where that page ended; of several pages that
  hold the offset, the one that ends last), or `The text from that offset is
  in a page you already read, shown above. That page ends the result.`
  Neither names the turn, as 0.21.0's `You already read this page in this
  turn` did: the reply is read again in later turns, where its page is still
  above it, since the two are recorded in the same turn and a turn leaves a
  request only as a whole. Every offset inside one page gets the same reply,
  so a model that steps forward inside a page it read repeats one progress
  signature and the step loop's breaker stops it after six refused calls
  (`partial`, `degenerate-loop`), while those six fall inside that page: a
  stride of up to 1,333 characters, as the limits below derive. Forward
  steps inside a page already read are the stepping this fix stops. An
  offset past the shown text and outside every page already read is a page,
  as before, also when it lies below a page already read: a model that
  steps downward still reaches both endings (see the limits below).
- `@xandreed/core`: a page counts as read only for the run that read it. A
  request leaves out another run's exchange of the same turn while one of
  its calls has no result, and 0.21.0 counted the page such an exchange
  held: a second run that asked for that page was told `You already read
  this page in this turn and it is shown above`, of a page its request did
  not hold, with an offset that skipped it. The guard now reads the run a
  call is made in (`CurrentAgentRun`, which the step loop sets) and counts a
  page only when its result names that run; a call made outside a loop
  counts only pages recorded with no run. A page another run read is served.
- `@xandreed/core`: the last sentence of `recall_context`'s description is
  now `For a result of this turn, a call for text still shown above (an
  offset inside its shown part, or inside a page already read) can return
  no text: the reply then says where to read on, or that nothing is left.`
  0.21.0's sentence, `Text still shown in this turn is not returned again:
  the reply names the offset to read from.`, promised more than the tool
  does: two replies name no offset, and the guard serves whatever it cannot
  tell is shown. The rest of the description is unchanged.
- `@xandreed/core`: the guard reads the inputs of the turn's earlier
  `recall_context` calls once per call. 0.21.0 indexed the whole log again
  for each page the turn had read, so a call's cost grew with the pages
  read times the log's length: measured on a log of 4,000 entries, tens of
  milliseconds after 25 pages and more than 150 after 100, where it now
  takes under 10. What the tool answers is unchanged by this.
- `@xandreed/core`: the documentation of the guard says what the code keeps.
  The 0.21.0 entry below and the guides said that `recall_context` returns
  no text the turn still shows, that a new offset past the shown text is
  never a repeat, and that a model that keeps asking is stopped by the
  breaker. The first two did not hold inside a page already read, which this
  release fixes for an offset inside such a page; the limits that remain are
  these.
  - The guard covers the current turn only, as before: a result of an
    earlier turn is served from any offset, as often as asked.
  - The guard refuses only what it can tell is shown, so a call it serves
    can still return shown text: a page another run of the same turn read
    (also once the request shows that run's exchange), a result with a
    recorded digest under a policy that shows no digests, and, as before, a
    result shown through a compact view, a digest or a custom strategy's own
    preview. The description therefore says a call for shown text can return
    no text.
  - A call is refused by where its page would start, not by what the page
    would hold. An offset below a page already read, outside the shown text
    and every other page, is served a whole page, although that page's part
    from the other one's start on is shown: asked 1,000 characters below a
    page already read, the call returns 8,000 characters of which 7,000 are
    in the request. Each such page is a new result, so the breaker counts no
    repeat, and a model that steps downward, each call a little below the
    last page it read, still ends at the step limit, or under the window
    strategy fails with `context.budget` once those pages pass the budget,
    as it did in 0.21.0.
  - Two calls for the same page made together in one response are both
    served when they run at once (`limits.toolConcurrency` above 1), as
    before.
  - The step loop's breaker stops a model only when its steps repeat: it
    counts steps in a row whose results it has all seen before, and a step's
    signature is every result of that step. A step that pairs a refused
    call with a call whose result is new, or that makes more refused calls
    than any step before it, counts as progress, and such a run ends at the
    step limit. A model that steps forward inside a page it read is stopped
    only while six refused calls in a row fall inside that page: the first,
    then the five repeats the breaker stops at by default (`breakAfter` of
    `limits.degenerate`; `REPEAT_BREAK_AT` in
    `packages/plugin-agent-loop/src/loop.ts`). A page holds 8,000 characters
    (`RECALL_PAGE_CHARS` in
    `packages/core/src/memory/recall.entity.functions.ts`), so those six fit
    in the 7,999 characters past the page's start up to a stride of 1,333.
    With a longer stride the model reaches the next page first, which is new
    text and starts the count again: such a run costs steps, not context,
    and ends at the step limit or at the result's end. The breaker is
    unchanged.
  - A custom strategy that shortens a recalled page makes an earlier
    `AlreadyRecalled` reply untrue of later requests. The memory plugins
    never shorten one.
- `@xandreed/plugin-memory-window`: a decision that drops turns records no
  compact view of a result in a turn it drops. When all compact views
  together did not fit, the window recorded every one of them and then
  dropped turns, so the journal kept compact texts of results that no request
  showed (a `CompactViews` and a `DropTurns` where the `DropTurns` alone left
  the same request). The requests are unchanged. A turn's start also stops
  asking for the compact view of a result in a turn already dropped.
- `@xandreed/plugin-memory-window`: over budget, a result takes its compact
  view only when the request's estimate falls with it. The window compared
  the characters of the compact view with those of the text shown, while the
  budget is counted in the estimate, which reads each message as its JSON: a
  compact view one character shorter but full of quotes or newlines raised
  the estimate, and the window then spilled and dropped more than it would
  have with no compact view at all. The compact view must now be shorter
  than the text shown and take at least one estimated token less of the
  request (three characters of the message's JSON, where a quote, a
  backslash or a newline takes two), and the compact views are ordered by
  that saving. A compact view that takes one or two characters fewer is
  left alone too, though at some lengths of the message's JSON it would
  lower the estimate by a token: a request that fit exactly under 0.21.0 by
  such a view can now spill a result or drop a turn. For a result that
  holds images the rule reads its text alone: it does not count the label
  lines the request adds or which images are sent as images, and a line
  memory wrote with the result for an image it never sends is shown again
  after the compact view, so such a result can still take a compact view
  that does not lower the estimate. The rule at a turn's start is unchanged.
- `@xandreed/plugin-memory-window`: `WINDOW_STRATEGY.version` is `4`
  (`4+current-turn-first` with `currentTurnFirst`), since the two fixes
  above change what the window decides for the same log.
- `@xandreed/plugin-memory-window`: three statements of the 0.21.0 notes and
  of the documentation said more than the window does, and the documentation
  now says what it does.
  - "Only as many are compacted as the budget needs" holds while compact
    views can make the request fit. When all of them together do not fit,
    all are taken before anything is spilled or dropped, and the decision
    records the compact views of the results in the turns that stay, none
    for a turn it drops.
  - "Nothing is recorded" for requests that fit their budget meant that
    nothing is rewritten. The bounds of results as they are written
    (`boundOnWriteChars`) are recorded whatever the budget, and each result
    shows its bound from its first request.
  - With `compactPreviousTurn: false`, each request that fits its budget
    extends the one before it within a turn. Across a turn's start that
    holds only while everything the previous request showed is still shown:
    with the default `turnContext: "current"`, a turn context recorded in
    the previous turn (a turn-tier prompt section, as
    `@xandreed/plugin-memory` records with `recallSection: "turn"`, its
    default, and `@xandreed/plugin-rag` with `recall: true`, or a host's
    `turn.context`) leaves the next turn's requests, and the shared prefix
    ends at that message. With `turnContext: "all"` it stays.
- `@xandreed/core`: the turn summaries of `contextReportOf` count the
  compact views memory recorded during the turn, as `compacts`: one for each
  result a `CompactViews` compaction names, at the turn's start or once a
  request passed its budget. Since 0.21.0 a request over its budget gives
  earlier turns' results their compact views, and a turn's summary had no
  count for them: a turn whose first request showed a result whole and whose
  later request showed it compact listed the result `whole` with every count
  at 0. `ContextReportTurn` gains the field, a required key (see Migration).
  It counts every compact view recorded in the turn, whatever strategy
  recorded it and whether or not a request showed the result through it, as
  `bounds`, `spills`, `drops`, `summaries` and `digests` count what the
  journal holds. The list of a turn's largest results is unchanged: each
  result is listed at the largest size a request of the turn showed it,
  labelled as that request showed it, so such a result is still listed
  `whole` in that turn, now with `compacts` at 1, and `compact` in a turn
  whose requests never showed it larger.

### Changes

- The turn summaries of `contextReportOf` count the compact views memory recorded during the turn, as `compacts`: one for each result a `CompactViews` compaction names, at the turn's start or once a request passed its budget. A turn that compacted an earlier result under pressure listed it `whole`, as its first request had shown it, with every count at 0; it now counts the compact view. `compacts` is a required key of `ContextReportTurn`, so a report a host kept from 0.21.0 no longer decodes with the schema, and it counts every compact view recorded in the turn, whatever strategy recorded it and whether or not a request showed the result through it. A result is still listed at the largest size a request of the turn showed it, labelled as that request showed it: `whole` in the turn that compacted it after showing it whole, `compact` in a turn whose requests never showed it larger.

- `recall_context`'s guard keeps what it says. A `ResultShown` refusal no longer names an offset: it says what the result showed when the call was made and sends the model to the offset the result's shortened form shows when the reply is read, so it still leads to where the result's shown form ends after the window strategy spills the result again or gives it its compact view. An offset inside a page the turn already read is refused with that page's end, where only the page's own start was, in a reply that names no turn and so stays true when it is read in a later one. A model that steps forward inside a page it read repeats one progress signature, and the step loop's breaker stops it while six refused calls in a row fall inside that page (a stride of up to 1,333 characters). An offset below a page already read is still served a whole page, most of it shown, so a model that steps downward still ends at the step limit or fails with `context.budget`. A page counts as read only for the run that read it. The last sentence of the tool's description says a call for shown text can return no text, and the tool's declaration reserves 240 estimated tokens (202 in 0.21.0). The guard reads the turn's earlier recall inputs once per call.

- Over budget, the window takes a compact view only when the request's estimate falls with it: it must be shorter than the text shown and take at least one estimated token less of the request's JSON, so a shorter compact view full of quotes or newlines no longer raises the estimate and costs extra spills and dropped turns. A compact view that saves fewer than three characters of that JSON is left alone, so a request that fit exactly under 0.21.0 by such a view can now spill a result or drop a turn; and the rule reads a result's text alone, so a result that holds images can still take a compact view that does not lower the estimate. A decision that drops turns records no compact view of a result in a turn it drops, and a turn's start asks for none in a turn already dropped; the requests are unchanged. Both change what the window decides, so `WINDOW_STRATEGY.version` is `4` (`4+current-turn-first` with `currentTurnFirst`): a host that pins a request header, `context.built` or its journal re-records the pin. The documentation says what is recorded when all compact views together do not fit, that requests within budget are not rewritten while bounds are still recorded, and that the request prefix holds across a turn's start only while everything the previous request showed is still shown, which a turn context of the previous turn is not under the default `turnContext: "current"`.

## 0.21.0 — 2026-11-10

### Migration

- A host that wants its agent's model to be shown results as before sets
  `boundOnWriteChars: 0` in the options of `memoryWindowPlugin` or
  `memorySummaryPlugin`: nothing is bounded as it is written.
- A host on `memorySummaryPlugin` now sends one more tool declaration in
  every request, `recall_context`, whatever `boundOnWriteChars` is. A host
  that pins its requests or its journal byte for byte sees the tool list
  change and 202 more estimated tokens in `context.built`'s
  `reservedTokens`; a session's journal gains one `memory.skills` record
  where the always-on skill `memory.recall` is first activated (the memory
  entry ids of that turn after it move by one) and one `request.part` for
  the tool. Re-record those pins. A provider's cached prefix from an earlier
  release no longer matches. No option keeps the tool away, because a bound
  is a fact of the session's log: a session bounded under the default and
  continued at `0` still shows those results with their notice, and the
  notice names the tool.
- A host tool that ends its result with its own continuation (an offset to
  read on from, a next-page token, an exit status) sets the annotation
  `boundOnWriteChars: 0`, so a memory strategy never cuts that last line off:
  `defineTool({ tool, handler, annotations: { boundOnWriteChars: 0 } })`.
- A host that builds its own `ConversationMemory` from `windowPolicy` or
  `summaryPolicy` with the plugin's defaults now gets a bounding policy: it
  contributes the tool the notice names (`recallCapabilityOf(id)` from
  `@xandreed/core`; the window plugin's `recallCapability`), or sets
  `boundOnWriteChars: 0`. A config written without the key bounds nothing.
- A host that stacks typed layers itself stacks `MemorySummaryLive` below
  `ToolDiscoveryLive`, as it does `MemoryWindowLive`: the layer now
  contributes `recall_context`, which a registry built before it would not
  hold.
- A graph that holds both memory plugins now registers `recall_context`
  twice and fails with `tools.duplicate`: list only the memory plugin the
  graph binds `ConversationMemory` to.
- Code that called `rewrittenBy(entries, id)` reads the same entry ids as
  the keys of `shownViewsOf(entries, { strategy: id, digests: false })`.
- A host that set `compactPreviousTurn: false` on `memoryWindowPlugin` so
  that tools' compact views never ran now sees them once a request passes
  its budget: earlier turns' results take their compact views before
  anything is spilled or dropped. Requests that fit their budget are
  unchanged. To keep a tool's results out of this stage, give that tool no
  `compact` view: its results then go from whole to spilled or dropped, as
  before. No option turns the stage off.
- A host that pins the description of `recall_context` (a request or a
  journal pinned byte for byte) re-records the pin: the description changed,
  so the tool's `request.part` has a new hash and `context.built`'s
  `reservedTokens` is 29 higher for a host on `memoryWindowPlugin`, where
  the tool was already active (a host on `memorySummaryPlugin` sees the 202
  above). A provider's cached prefix from an earlier release no longer
  matches.
- A host whose agent relied on reading text again that the turn still shows
  changes what it asks for. A `recall_context` call from an offset inside a
  result's shown text, or for a page the same turn already read, now returns
  a `ResultShown` or `AlreadyRecalled` failure that names the offset to pass
  next, where it returned up to 8,000 characters. A prompt that tells the
  model to read a bounded result of the same turn from offset 0 tells it to
  pass the offset the notice shows. A result of an earlier turn is served as
  before.

### Breaking

- `@xandreed/plugin-memory-window` and `@xandreed/plugin-memory-summary`: a
  graph that holds both memory plugins fails with `tools.duplicate`, where it
  built before. Each now contributes `recall_context`, so the tool is
  registered twice. List only the memory plugin the graph binds
  `ConversationMemory` to.

- `@xandreed/core`: `rewrittenBy` is removed. Its replacement is
  `shownViewsOf(entries, { strategy, digests })`, whose keys with
  `digests: false` are the entry ids `rewrittenBy` returned, each with the
  text the result shows and what wrote it.

### Added

- `boundOnWriteChars`, an option of `@xandreed/plugin-memory-window` and
  `@xandreed/plugin-memory-summary` (16,000 by default; `0` is off): a tool
  result whose view is longer than it is bounded as it is written. Every
  request that includes the result, the first one too, shows its first
  `boundOnWriteChars` characters and the notice a spill ends with
  (`[… N more characters kept out of context; call recall_context with
  locator "<id>" and offset <n> to read them]`, unchanged). The stored result
  and its view stay whole, `recall_context` reads the rest, and the request
  prefix that holds the result stays the same from step to step unless the
  window strategy spills it again under pressure, so a provider's cached
  prefix holds. A pinned result, a `recall_context` page, a result that
  holds images and a result whose write-time digest is shown and is no
  longer than the bound are never bounded; a failed call's result is bounded
  like any other.
- `@xandreed/core`: the tool annotation `boundOnWriteChars`
  (`ToolAnnotations`, `defineTool`'s `annotations`): a tool's own bound,
  which replaces the strategy's for that tool; `0` keeps its results whole.
  It is an annotation, so a tool with no view sets it too. It is a whole
  number of characters, 0 or more: `defineTool` throws on any other value.
  `ToolView.boundOnWriteChars` carries it to memory with every view of the
  tool, and `MemoryPolicy.boundOnWriteChars` is the bound a custom strategy
  sets (absent or `0`: nothing is bounded, whatever a tool asks). The bound
  is recorded as the strategy's own `Spill` compaction: no journal kind, event
  or stored field is added, and the stored format stays 19.
- `@xandreed/core`: `shownViewsOf(entries, { strategy, digests })`, the text
  each result shows in place of its view when a strategy renders (a compact
  view, a spill's or a bound's preview, a digest) and what wrote it (`by`,
  and `source`, the compaction or digest entry that holds the text), in the
  render's own precedence. It replaces `rewrittenBy`.
- `@xandreed/core`: `contextReportOf(events, { largest })`, a report of what
  filled each model request of a session, read from its journal alone (the
  events `Sessions.read` returns), with no model call and no service. It
  gives a row per `request.prepared` (`ContextReportRow`), a request prepared
  again in the same step included (`resend`): the characters and tokens of
  the system text and of the tool declarations with the largest declarations
  by tool, counted as the turn reserves them so they sum to the
  `reservedTokens` of the request's `context.built`; that record's estimate,
  reserve, budget and compactions; the tool results the request showed and
  their characters; a request hook's note and the step policy's step context
  in separate fields, each none when the request showed none of it (0 is an
  empty text); and the usage of the `Loop` call that completed for it
  (`model.called`), else of the response its step accepted (`step.usage`).
  It also gives a summary per turn (`ContextReportTurn`): its steps and its
  requests as two counts, the bounds, spills, drops, summaries and digests
  recorded in it, and the largest tool results its requests showed
  (`ContextReportResult`), each with its tool, its characters, how it was
  shown (`whole`, `compact`, `digest`, `bounded` or `spilled`) and whether
  the tool's own view or the raw canonical JSON wrote the text (`view`). The
  messages as a whole are reported as the strategy's token estimate: the
  journal holds no character count of them. Nothing is added to the journal
  and the stored format stays 19.
- `@xandreed/core/conformance`: `memoryConformance` checks `bound-on-write`:
  a result is shortened as it is written, or not by a later write. One a
  strategy shows shortened from its first build still resolves to its whole
  view and shows the same text after a later write and a reopen; one its
  first build shows whole is still whole after the next write.

### Changed

- `@xandreed/plugin-memory-window` and `@xandreed/plugin-memory-summary`
  bound results as they are written by default (`boundOnWriteChars: 16_000`).
  An agent whose tools return results longer than 16,000 characters sends
  different requests than before: each such result is shown as its first
  16,000 characters and a locator. `context.built`'s `compactions` counts
  each bound, as it counts every compaction applied, and the journal stores
  each bound as a `memory.compaction` record holding its preview: the
  result's first characters a second time, beside the whole result.
- `@xandreed/plugin-memory-window`: `WINDOW_STRATEGY.version` is `3`
  (`3+current-turn-first` with `currentTurnFirst`), in every request header
  and `context.built`. Under pressure the window spills the result that
  shows the most text first, where it took the longest view first, and a
  result already bounded or digested is spilled only when the pressure
  preview (`previewChars`) is shorter than what it shows. At a turn's start,
  an earlier turn's result shown through a preview takes its tool's compact
  view when that is shorter; it kept its preview for good before.
  Compactions recorded by earlier versions replay as recorded.
- `@xandreed/plugin-memory-window`: a request over its budget shows earlier
  turns' results through their tools' compact views before the window spills
  a result or drops a turn, also with `compactPreviousTurn: false`, which
  now means never at a turn's start. Before, a host that set it to `false`
  to keep its provider's cached prefix never got compact views: over budget
  the window went straight to 600-character previews and dropped turns.
  Under pressure the order is: compact earlier turns, spill the current
  turn's largest results, drop the oldest turns; with `currentTurnFirst`,
  compact earlier turns, drop the oldest turns, then spill. Only results of
  turns before the current one are compacted, a result takes its compact
  view only when that is shorter than the text it shows (its view, a
  bound's or a spill's preview, a digest), and a tool with no compact view
  and a pinned result are left as they are. Only as many are compacted as
  the budget needs, the one that frees the most characters first, so a
  later request over budget can compact more. Requests that fit their
  budget are byte for byte what they were, and nothing is recorded for
  them. With `compactPreviousTurn: true` a turn's start compacts as before;
  a step over budget now also compacts an earlier result that no turn start
  compacted. This is part of strategy version `3`.
- `@xandreed/plugin-memory-summary` contributes `recall_context` (capability
  `@xandreed/plugin-memory-summary/recall`), whatever `boundOnWriteChars`
  is, so an agent on the summary strategy sends one more tool schema.
  `SUMMARY_STRATEGY.version` stays `2`: its summary decisions are unchanged,
  and the render checkpoints stored under that version keep applying.
- `@xandreed/plugin-workspace`: `read`, `ls`, `find`, `grep` and `bash` set
  `boundOnWriteChars: 0`. Each ends its result with its own continuation and
  is bounded by its own limits, so their results are shown as before.
  `@xandreed/plugin-rag`'s `read_knowledge` and `@xandreed/plugin-memory`'s
  `read_memory`, which end a page with the offset to continue at, set it too.
- Known limits of the bound. The raw result is stored first, and its bound
  is recorded after the result's view and, when the strategy digests on
  write, after that digest returns. A request that another run of the same
  turn builds in between shows the result whole, once. A write that stops in
  between leaves the result without a bound, and nothing records one later:
  an interruption (a cancelled turn, a sibling call that fails), a view or
  an append that fails, or a process that dies. The result is shown whole
  from then on, and only the window strategy's pressure can still shorten
  it. Under the summary strategy nothing reduces the current turn: results
  that are each bounded can still pass the budget together (twelve at the
  default bound fill the default 64,000-token budget), and the request is
  then sent as it is.

- `@xandreed/core`: `recall_context` returns no text the turn still shows.
  Both memory plugins contribute the tool from core, so both get the guard.
  Within the turn that wrote a result, a call from an offset inside the text
  the result still shows fails with `ResultShown`: `The first 16000
  characters of this result are shown above. To read on, pass offset 16000.`
  for a result shown through a bound's or a spill's preview (both numbers
  are the shown length, the offset its notice prints), and `This result is
  shown in full above; nothing of it was left out.` for one shown whole. A
  call for a page the same turn already read, while that page is still
  shown, fails with `AlreadyRecalled`: `You already read this page in this
  turn and it is shown above. To read on, pass offset 24000.` (where that
  page ended), or `You already read this page in this turn and it is shown
  above. It ends the result.` Both are returned failures, like
  `UnknownLocator`. A new offset past the shown text is a page, never a
  repeat, and once the window strategy spills a result under pressure, the
  text that left the request is served again. Before, each such call
  returned up to 8,000 characters the context already held and cost a step,
  and a model that asked from a new offset each step ran to the step limit,
  or past the window strategy's budget (`context.budget`). Every offset
  inside one shown text now gets the same reply, so that model repeats one
  progress signature and the step loop's breaker stops it after six calls
  (`partial`, `degenerate-loop`). What is shown is derived from the run's
  memory alone; nothing is stored for the guard, and the stored format, the
  journal kinds and the events are unchanged. No strategy version changes.
- `@xandreed/core`: the description of `recall_context` is now `Read on in a
  tool result that is shown shortened, by the locator its shortened form
  shows. Returns at most 8000 characters from offset (0 by default); when
  more remains, the reply ends with the offset to pass next. Text still
  shown in this turn is not returned again: the reply names the offset to
  read from.` Its schema reserves 202 estimated tokens, 29 more than before.
- Known limits of the guard. It covers the current turn only: a result of an
  earlier turn is served from any offset and as often as asked, whatever the
  request still shows of it, because the memory a tool reads names no
  strategy and so cannot say what a later turn's render shows. Two calls for
  the same page made together in one response are both served when they run
  at once (`limits.toolConcurrency` above 1): neither has a result when the
  other is checked. A turn runs a response's calls one after another by
  default, and the second is then refused. A result shown through a compact
  view, a digest or a custom strategy's own preview is served from its
  start, as before.

- `@xandreed/core`: `recall_context`, its paging and the spill preview now
  live in core, where every memory plugin can reach them.
  `recallCapabilityOf(id)` builds the recall capability under the id of the
  plugin that contributes it, `spillPreview` writes the notice a spilled
  result ends with, and `RECALL_TOOL` is the tool's name.
  `@xandreed/plugin-memory-window`'s `recallCapability` is that capability
  under its unchanged id, `@xandreed/plugin-memory-window/recall`. The move
  changes no text the model reads: the parameters' descriptions, the spill
  preview, the page continuation and the `UnknownLocator` and
  `OffsetOutOfRange` failures are as they were, and the tool's description
  changes only with the guard above. The move changes nothing for a host.

### Fixed

- `@xandreed/core`: the spill preview and a `recall_context` page never end
  inside a surrogate pair. A cut that would split one falls one unit
  earlier, and the offset the notice or the page prints is where the cut
  fell, so the pages still join to the whole view. Before, a result cut
  inside such a character was shown with half of it, which is not valid
  text to send; a result bounded as it is written would have met that at
  the bound.

### Repository

- Git worktrees of the repository go under `.worktrees/`, which git now
  ignores. `AGENTS.md` and `CONTRIBUTING.md` say how to create one and that
  each needs its own `bun install`.
- `@xandreed/plugin-render`: the tests that read a compressed SSE response
  over `node:http` no longer fail on bytes the peer did send. They read the
  response through `node:http`'s client, and Bun 1.3.0's can read part of a
  body off the socket and never give it, or the end, to the response's
  listeners. The test that a frame reaches the client while the response
  stays open then failed with `did not decode to the expected frame within 3
  seconds`, only the preamble decoded, and the test of a response that ends
  ran into the test runner's 5 s timeout. Both now read the response off a
  `node:net` socket, and a new test checks at the server, with no client or
  deadline, that when a write of a compressing `sseNodePeer` completes, a
  response that takes bytes already has the frame. Test change only:
  `sseNodePeer` flushed every frame all along.
- `verify:packages` ends the packed Node proxy check after 120 seconds and
  says so. The check has no deadline of its own and was awaited without one,
  so a consumer that stopped answering held the whole verification instead
  of failing it.

### Changes

- Both memory strategies bound a tool result as it is written (`boundOnWriteChars`, 16,000 characters by default, `0` off): a longer result is shown from its first request as its first characters and a `recall_context` locator, while the stored result stays whole. A tool sets its own bound with the `boundOnWriteChars` annotation (`0` keeps its results whole, as the workspace tools `read`, `ls`, `find`, `grep` and `bash`, `read_knowledge` and `read_memory` do). The window strategy is version 3 and spills a bounded result again only under pressure, largest shown first; the summary plugin contributes `recall_context`, whatever its bound is. The preview and a `recall_context` page never end inside a surrogate pair, `defineTool` checks the annotation, and `rewrittenBy` is removed from `@xandreed/core` in favour of `shownViewsOf`.

- A request over its budget shows earlier turns' results through their tools' compact views before the window spills a result or drops a turn, also with `compactPreviousTurn: false`, which now means never at a turn's start: the fewest results that fit, the one that frees the most first, and only when the compact view is shorter than what the result shows. Requests that fit their budget are unchanged. The order under pressure is compact, spill, drop; with `currentTurnFirst`, compact, drop, spill.

- `contextReportOf(events, { largest })` reports what filled each model request of a session from its journal alone: a row per `request.prepared` (a resend is its own row) with the characters and tokens of the system text and of the tool declarations, which sum to the request's reserved tokens, the strategy's estimate, the budget, the tool results shown, a request hook's note and the step policy's step context in separate fields, and the usage the provider reported; and per turn the largest tool results with how each was shown (`whole`, `compact`, `digest`, `bounded` or `spilled`) and whether the tool's own view or the raw JSON wrote the text.

- `recall_context` returns no text the turn still shows. Within the turn that wrote a result, a call from an offset inside the text the result still shows fails with `ResultShown`, and a call for a page the same turn already read fails with `AlreadyRecalled`; each reply names the offset to pass next, and a new offset is always a page. A model that keeps asking repeats one progress signature, so the step loop's breaker stops it before the step limit. A result of an earlier turn is served as before. The tool's description changes, nothing is stored for the guard, and no strategy version changes.

- `recall_context`, its paging and the spill preview live in `@xandreed/core` (`recallCapabilityOf`, `spillPreview`, `RECALL_TOOL`); the window plugin's `recallCapability` keeps its id, and the move itself changes no text the model reads.

## 0.20.1 — 2026-11-10

### Changed

- The files and SQLite session logs record the stored format a store was
  created for (`store.json`'s `format`; SQLite's `PRAGMA application_id`) and
  refuse a store of another format when it opens, with `store.version`
  naming both formats, before any session is read and without changing the
  store. A release that bumps `STORED_FORMAT` therefore refuses old stores at
  open instead of failing each of their sessions as it is used. Stores
  created by 0.20.0 record no format and open as format 19
  (`UNRECORDED_FORMAT`); they are not rewritten.
- `storedFormatRefusal(recorded, current?)` in `@xandreed/core` is the same
  check for a custom `SessionLog` that records its store's format.

### Migration

- Nothing for stores created by 0.20.0. A store created by this release
  records its format, which 0.20.0 ignores; opening it with 0.20.0 after a
  later format bump is not supported.

### Changes

- Record the stored format in the files and SQLite session stores and refuse a store of another format when it opens; add `storedFormatRefusal` for custom session logs.

## 0.20.0 — 2026-11-10

### Migration

- Session stores must be fresh. Point `SessionLogFilesLive`,
  `SessionLogSqliteLive` and their plugins' `path` at a new empty directory
  or file: a store an earlier release wrote is refused at open with
  `store.version`. A custom `SessionLog` backend needs a fresh namespace
  too: every session stored in format 18 or earlier fails every `Sessions`
  operation, reads and `list` included, with `session.version`. There is no
  conversion. Read or export the conversations you need with 0.19.2 before
  upgrading; old stores are never modified or deleted, so remove them
  yourself when you no longer need them.
- A custom `SessionLog` implements the new port: `create({ header, state })`;
  `read`, `commit` and `remove` take a `SessionRef` (`sessionRef(head)`)
  instead of a `ConversationId`; a fork's parent and `list({ parent })`
  name the parent by its `SessionRef`; and `remove` fails with
  `SessionMissing` for a missing, removed, stale or other owner's reference.
  It must pass `sessionLogConformance`, `sessionLogRecoveryConformance` and
  `sessionsConformance` as they now are.
- Code that calls `SessionLog.remove` itself and relied on removing twice
  doing nothing handles `SessionMissing`. A file-log removal that stopped
  after its tombstone (a crash, an unreachable mount) is finished by
  removing the same reference again (`SessionLog.remove`, or
  `Sessions.remove` given the session's `SessionRef`), which then reports
  `SessionMissing`, or by the next open.
- Code that reads `TurnToAdmit.session`, `AdmittedTurn.session` or
  `CommittedTurn.session` receives a `SessionRef` (id, owner and
  incarnation). A stream from `Sessions.changes` can now fail
  (`SessionMissing`, `SessionLogError`): handle it where it is run.
- Standalone loops and custom registries wrap their Effect toolkit with
  `prepareToolkit` (`RunTools.toolkit` is a `PreparedToolkit`); `runLoop`
  fails with `config.options` when its toolkit was not prepared.
- The `capacity` of a background `TurnEvents.subscribe` must be a positive
  safe integer; replace `Infinity` with a finite size. A background handler
  that publishes into its own subscription's full queue while it runs gets
  `events.capacity` instead of growing the queue. Two background handlers
  that publish into each other's subscriptions can now wait for each other
  when both queues are full, until the turn is interrupted (a time limit,
  a shutdown): give one side a larger `capacity`, make one side an inline
  subscription, or break the mutual publication.
- `AuthStoreConformanceOptions` and `SettingsStoreConformanceOptions` are
  replaced by `AuthStoreSubject` and `SettingsStoreSubject`: give the kits a
  subject that opens fresh scoped fixtures for each check, never a host's
  real store.
- A Sessions kit subject's `newerFormat` probe returns an effect that reads a
  snapshot of the stored head (it may stamp any format but the current one).
- A model on the OpenAI-compatible route that streams more than 128 tool
  calls in one reply, more than 1,048,576 characters of arguments for one
  call, or a line longer than 8,388,608 characters now fails with
  `model.invalid-response`; the bounds are not configurable.

### Breaking

- `@xandreed/core`: the `SessionLog` port. `create(header)` becomes
  `create({ header, state })`, which creates the header and initial state
  atomically. `read`, `commit` and `remove` take a `SessionRef`
  (`{ id, owner, incarnation }`); `SessionCommit.incarnation` is removed,
  the reference carries it. `SessionListQuery.parent` is a `SessionRef`
  instead of a `ConversationId`, and `SessionLineage` (a header's `parent`)
  gains `owner` and `incarnation`. `head(id)` remains a trusted bootstrap
  lookup; hosts must authorize its returned owner before use.
  `SessionLog.remove` is no longer idempotent: a missing, removed, stale or
  wrong-owner reference fails with `SessionMissing` (the file log first
  finishes what a removal stopped part way left of a removed reference).
- `@xandreed/core`: `AdmittedTurn.session`, `CommittedTurn.session` and
  `TurnToAdmit.session` carry the full reference (`SessionRef` instead of
  `SessionAddress`), and `SessionView` shows the session's `incarnation`: a
  `Sessions` call given an address with one is fenced to that life of the
  session (`SessionMissing` once it is removed and created again), and a
  drain keeps the session it resolved first for all its turns.
  `Sessions.changes` follows only the owner's session: its stream fails with
  `SessionMissing` for another owner's address or a missing session, and
  with `SessionLogError` for a store failure. It checks the address once, on
  its first pull: a follower is then woken by every commit under that id and
  owner, a session created again under the id included.
- `@xandreed/plugin-sessions`: sessions are stored in format 19 only
  (`STORED_FORMAT`). A session in any other format, older, newer or
  unmarked, is refused for every operation, `get`, `list`, `read` and
  `remove` included, with `session.version`, and one such session fails its
  owner's whole `list`.
- `@xandreed/plugin-session-files` and `@xandreed/plugin-session-sqlite`:
  only file layout 2 and SQLite schema 3 open. Older or newer stores and
  unmarked nonempty ones are refused with `store.version` without
  migration or deletion (a file store's `staging/` may hold names the store
  writes, which another handle opening the same new directory staged there;
  any other name in it counts as content).
- `@xandreed/plugin-session-files`: file layout 2 keeps, for every
  generation ever created under an id, a permanent claim
  (`sessions/<id>/claims/<generation>.json`: the id, the incarnation and
  when it was claimed) and, once it is removed, a permanent tombstone
  (`sessions/<id>/removed/<incarnation>`). 0.19.2 deleted a removed
  session's whole folder; now `sessions/` gains an entry for every id ever
  created, and removal deletes only the payload under `lives/` and the
  bytes set aside under `quarantine/<id>.<incarnation>/`. Removing a
  reference whose removal finished does nothing (`SessionMissing`, no
  listing and no write).
- `@xandreed/core`: the Sessions kit. Its subjects expose an
  unsupported-format probe (`newerFormat`: any format but the current one,
  refused for reads and for `remove` too) that returns a snapshot of the
  stored head. The kit
  also requires another owner's cancel of an open turn, and of a turn
  sealed on the cancelling instance, to fail with `SessionMissing` and
  change nothing.
- `@xandreed/core`: `RunTools.toolkit` is a `PreparedToolkit`: standalone
  loops and custom registries use `prepareToolkit` around their Effect
  toolkit. Parameters decode once before any handler runs; immutable raw
  input remains the durable evidence. Input is read as JSON text would
  carry it: host-planned params may leave optional fields `undefined` (left
  out) and hold `toJSON` values such as a `Date` (their JSON form). Tool and
  schema objects are unchanged. `@xandreed/sdk`: `toolRegistryConformance`
  calls tools through that boundary, preparing and running each inside the
  run's step with a tool call id as the loop does, and checks it
  (`prepare-decode-once`, `prepare-raw-input`, `prepare-before-run`). `@xandreed/plugin-agent-loop`:
  `runLoop` fails with `config.options` when its toolkit has no
  `execution`.
- `@xandreed/plugin-models`: `AuthStoreConformanceOptions` and
  `SettingsStoreConformanceOptions` are replaced by `AuthStoreSubject` and
  `SettingsStoreSubject`. The auth/settings kits take subjects that open
  fresh scoped fixtures per check, including probes for every backing tier;
  the checks restore nothing, so a fixture must never be a host's real
  store. A fixture that supplies probes for a capability its subject does
  not declare (`refresh`, `corrupt`) fails every check, and the AuthStore
  kit's `corrupt` check also requires that a `set` refused on damaged data
  wrote nothing.
- `@xandreed/core`: a background turn-event handler publishing into its own
  subscription's full queue while it runs (or a task it forked, while it
  still runs) fails with `events.capacity`; into another subscription's full
  queue it waits for room, and so does a task it forked once it returned.
  0.19.2 queued every background handler's publication past capacity, so
  two background handlers publishing into each other's full queues now wait
  for each other until the turn is interrupted. A background `capacity` must
  be a positive safe integer: `Infinity` (previously an unbounded lane) and
  other values die with `config.limits` at subscribe.
- `@xandreed/plugin-models`: provider SSE permits at most 128 tool calls,
  1,048,576 characters (UTF-16 code units) of accumulated arguments per call
  and lines of at most 8,388,608 characters; a longer line fails the stream
  with `InvalidResponseError` before it is decoded. A tool-call index the
  stream sends must be a nonnegative safe integer; one it leaves out or sends
  as `null` is call 0, as before.
- `@xandreed/core`: `journalSchemaOf("context.built")` requires
  `budgetTokens`; a record without it (written before 0.14.0) no longer
  decodes, since only the current stored format is read.

### Added

- `@xandreed/core`: `SessionRef`, `sessionRef` (the reference of a head)
  and `sameSession`; `prepareToolkit` with `PreparedToolkit`,
  `PreparedToolCall`, `PreparedToolHandler` and `PreparedToolExecution`;
  the `events.capacity` harness code; `SessionView.incarnation`.
- `@xandreed/core`: the knowledge kit's `knowledge.supersede-support`
  check: a stage that supersedes the support of an active inferred memory
  publishes and closes that memory.

### Fixed

- Fence session operations against replacement owners and incarnations, and
  check sealed-turn cancellation ownership.
- `@xandreed/plugin-session-files`: another session's damaged header no
  longer fails a listing or a removal, and a reference whose id or
  incarnation is not a UUID is `SessionMissing` before any path is built
  from it. A read after a position finds its first commit by a binary search
  over the commits' first lines, so the commits before it are not read.
- `@xandreed/core`: the in-memory `SessionLog` refuses a fork parent of
  another owner with `SessionMissing`, as the file and SQLite logs do, and
  its removal follows only children that name the removed session whole.
  The log kit's `lineage` check requires that refusal and reads, commits to
  and removes the captured references of removed sessions and their children
  directly, so a store that still serves them fails it.
- `@xandreed/plugin-session-sqlite`: the log reads an existing file's schema
  on a read-only connection before it opens it for writing: an unsupported
  database is refused with `store.version` and keeps its mode, its WAL and
  its main file.
- `@xandreed/plugin-sessions`: on one `Sessions` instance, a turn still held
  in a session that was removed and created again under its id no longer
  hides the new session's turn of the same number: `TurnActivity` lists the
  live turn, and `TurnShutdown` closes it with `turn.shutdown`.
  `Sessions.remove` can be interrupted while the store removes the session
  (a slow mount, many forks); once the session is gone, the instance still
  closes its turns of it, and keeps nothing of a turn it held there.
- Settle model-attempt acknowledgements on ledger defects, close resources
  outside registry admission, bound event reentry and a provider stream's
  line length, tool-call count and per-call arguments (a chunk packed with
  fragments of one call is merged in linear time), and cancel scripted hooks,
  regex workers, workspace temporaries and implementors.
- `@xandreed/plugin-workspace`: builtin regex `grep` runs an inline worker
  program (no module file beside the adapter, so bundled and compiled hosts
  keep it), started at the first file it searches, and none once the
  deadline has passed. `grepTimeoutMs` bounds the builtin engine as well as
  ripgrep, with partial results and `timedOut`, and does not count the
  worker's start. A worker that fails to load or dies between files fails the
  call with `SearchFailed` and its own reason (its cause logged) instead of
  crashing the host process or waiting out the deadline, and a search over
  many files no longer adds worker listeners per file. The grep description
  the model reads says the search stops after `grepTimeoutMs` whichever
  engine runs (it said so only for ripgrep). At most four regex workers run
  in a process at once, however many hosts and sessions grep there; a grep
  waits for a free one (up to 10 s, then `SearchFailed`) without spending
  its deadline on the wait.
- `@xandreed/core`: a turn-event subscription made inside another
  subscription's handler no longer keeps that handler's reaction depth, so a
  reaction cycle through it fails with `events.depth` instead of running
  until interrupted; a background one is its own lane, so its handler
  publishing into its own full queue fails with `events.capacity`.
- `@xandreed/core`: the in-memory file system treats a trailing separator as
  the native one does in `stat` without following links, `rename`, `write`
  and `append`; a refused write no longer leaves a directory at its target.
- `@xandreed/core`: tool views, compaction and digests decode detached copies
  of a call's stored input and result, so an authored codec that rewrites its
  input no longer changes what later requests send. A tool whose success
  schema encodes to a value JSON cannot carry unchanged (a `Date`, a
  `Uint8Array`, an `Option`, a `Redacted`) now gets its raw view, compaction
  and digest in a live session too, as a session reopened from its journal
  already did.
- `@xandreed/plugin-models`: create credential files privately (0600 from
  their first byte; a missing `.efferent` directory is created 0700, while
  `config.json` keeps the permissions the umask gives), reject corrupt
  fallback tiers before writes. `AuthError`
  and `SettingsError` keep the file system's error as their `cause`, and a
  failed write names its step and the error code
  (`config.json write failed: open failed (EACCES)`).
- `@xandreed/plugin-render`: a feed event name holding CR, LF or NUL is
  refused, so it cannot break an SSE frame.
- `@xandreed/plugin-agent-loop`: the no-progress breaker tells results apart
  by their whole canonical JSON, `toJSON` applied and a `Map`'s entries or a
  `Set`'s members kept: a tool whose results differ only past their first
  300 characters, in a `Date`, or in a map's or set's contents no longer
  stops the run as `degenerate-loop`.
- Remove quadratic replay/history/media/trace batching, exponential graph
  validation (a stage that supersedes the support of an active inference still
  publishes and closes it), lossy progress identities, dead eval helpers and
  unused assets and dependencies. Correct provenance comparison and CLI
  command ownership.

### Repository

- Blanket `no-let` and `no-loop-statements` gates are removed. Confined
  builders are allowed; resource ownership, typed errors and architectural
  boundaries remain enforced. No service keys are renamed.
- Fail gates closed on construction/rule/baseline IO errors; strengthen tests,
  schema fingerprints, immutable fixture recording and release confirmation.
- Each package's model-text inventory cites the tests that pin a row by
  title (`path.test.ts#<title>`) instead of a fixed `#exact-assertions`
  suffix, and the inventory check resolves each citation to exactly one test
  of its file that must hold an exact assertion, so deleting a cited test's
  pin or renaming it fails the check. The judge's response schema is pinned
  exactly, and the workspace tool descriptions in a test of their own.
- Foundry's claude implementor leads a process group of its own; when its
  attempt ends (exit, deadline or interruption) the group gets SIGTERM, up to
  three seconds until every process in it has stopped, then SIGKILL for what
  is left at that deadline (a group found empty is not signalled again), so
  its tool processes no longer outlive it in the workspace. `foundry` turns
  the first SIGINT, SIGTERM or SIGHUP (the terminal closed) into an
  interruption of its program, so the implementor's group stops too instead
  of running on; a second signal, or any exit before the program's end,
  kills every implementor group still running and ends the process at once.
  A foundry process killed outright (SIGKILL) cannot stop them.
- `foundry check --baseline` never grandfathers a gate crash: a crash finding
  fails the check whatever the baseline holds, and `--update-baseline`
  refuses to write while a gate crashed, even with `--allow-grow`.
- `architecture/no-raw-promise-core` also flags an `Effect.run*` runner
  passed as a value (`pipe(Effect.runFork)`) or imported by name from
  `effect/Effect`, in the library and the vendored pack.
- Release confirmation stops at once only on release metadata that names
  another package, version or commit (or none); a provenance read the
  registry does not answer (a 404 after the version was found, a refusal
  status, a network error, an unreadable or invalid body) is asked again until
  the confirmation deadline, as a presence read is.
- Reconcile agent guidance and current docs with the implemented contracts;
  retain historical audit and release artifacts as historical evidence. Docs
  tests tie the stored format, file layout, SQLite schema and provider stream
  bounds the guides state to the constants the code enforces, the memory and
  rag pages' extraction-version history to `KNOWLEDGE_EXTRACTION_VERSION`,
  and the rules and spans guidance names to the ones that exist.

### Changes

- Session stores must be fresh (file layout 2, SQLite schema 3, stored format 19; older stores are refused, never migrated), session log calls and turn records take owner- and incarnation-qualified `SessionRef`s, and standalone loops and custom registries wrap their toolkit with `prepareToolkit`.

## 0.19.2 — 2026-11-08

### Fixed

- Evaluation JSON reads and writes use bounded text buffers within individual
  trials, run metadata and event lines, removing the previous whole-trial
  string allocation ceiling. Existing JSON bytes, schemas, atomic file writes
  and incomplete-trial evidence are preserved. Decoded scalar values and the
  full evaluation object graph still need runtime memory.

- Native memory and document extraction can use their configured review to
  repair malformed JSON or an invalid output shape. A bounded, framed raw
  proposal is reviewed against the original evidence; the final schema and
  source checks remain strict. Each window uses at most one review, and review
  off never repairs a reply. Provider failures and cancellation start no repair.

### Migration

- Knowledge extraction is version 10: new jobs use `memory:10/…` and `rag:10/…`.
  Drain version 9 jobs with their existing worker before upgrading. A failed
  job can be explicitly retried under the new engine; existing published
  records and missing memories are not rewritten or reconstructed.

### Changes

- Encode and parse evaluation JSON in bounded text chunks within runs, trials and event lines. Preserve native JSON bytes, atomic writes, strict decoding and incomplete-trial evidence; decoded scalar values and the complete object graph still require runtime memory.

- Use one configured review per extraction window to repair malformed JSON or output shape, with bounded untrusted proposals and unchanged schema and source validation. Keep review off strict and version the shared extraction protocol and engine ids at 10; drain older queued jobs before upgrading.

## 0.19.1 — 2026-11-08

### Fixed

- A settled model request whose pending headers time out is explicitly final,
  even when the wall clock still reads just before its deadline. Neither a retry
  nor a fallback can start a second generation. Streamed header timeouts and
  transport-proven connection failures retain their bounded retries.
- Conversational extraction preserves durable user statements independently of
  an unrelated assistant answer. Evidence review now checks for supported
  omissions as well as unsupported claims; source-span validation is unchanged.

### Migration

- Native knowledge extraction is at version 9 (`KNOWLEDGE_EXTRACTION_VERSION`),
  so new memory and document jobs use `memory:9/…` and `rag:9/…` engine ids.
  Drain queued version 8 jobs with their existing worker before upgrading;
  failed jobs can be retried under the new engine. Existing published records
  are unchanged and missing memories are not reconstructed automatically.

### Changes

- Prevent duplicate settled generations when the header timeout fires before the wall-clock deadline, including configured fallback sends.

- Preserve durable user statements independently of an unrelated reply, and review supported omissions with exact source evidence.

## 0.19.0 — 2026-11-07

### Migration

- Native knowledge extraction is at version 2 (`KNOWLEDGE_EXTRACTION_VERSION`),
  so the memory and document engines record their jobs under new engine ids
  (`memory:2/…`, `rag:2/…`). A job still queued under version 1 waits for a
  worker of that version: let one drain the queue before upgrading, as for a
  change of embedding space. A job failed under version 1 is started over
  under version 2 by `LongTermMemory.retry` or `Knowledge.retry`; jobs version
  1 failed with `Invalid` for one record's sake (among them "A world change
  needs an evidenced effective date") now stage, so a host lists them with
  `KnowledgeIndex.failed({ namespace, reasons: ["Invalid"] })` and retries
  them, although `isRetryableKnowledgeFailure` calls `Invalid` final.
- `KnowledgeStageNote` is a union of `GraphOmitted` and the new
  `RecordDropped`: code that reads a note's `reason` and `message` is
  unchanged, and code that matches its `_tag` exhaustively adds the new case.
  A host's own `KnowledgeIndex` that stores stages keeps their notes whole, as
  `knowledgeStoreConformance`'s new `knowledge.stage-notes` check requires.
  A host's own `LongTermMemory` or `Knowledge` passes the facade kits' new
  `dropped-record` check by publishing a source whose extraction proposed
  evidence; giving the subject `droppingExtraction` also checks the note.

- `@xandreed/plugin-memory`: `MemoryConfig` gains the required keys
  `recallDates` and `recallToday`. Options merged over `memoryDefaults` (the
  plugin's options, or `{ ...memoryDefaults, … }`) need no change; a host
  that builds a whole `MemoryConfig` by hand adds both. The default recall
  text now carries dates: a host that pins it, or wants the earlier text, sets
  `recallDates: false`.

- Native knowledge extraction is at version 3: the engines record their jobs
  under `memory:3/…` and `rag:3/…`; drain or `retry` version 2 jobs as above.
  `KnowledgeExtractedMemory` gains the required `supersession` (`"change"` or
  `"correction"`), so a scripted or host-written extraction adds it to each
  memory, as assertions already have it.
- `KnowledgeRecallResult` gains `history` (decoded as empty from results
  encoded before it): a host's own `LongTermMemory`, `Knowledge` or code that
  builds a result adds `history: []`, and `budgetKnowledgeRecall` reads it.
  `@xandreed/plugin-memory`'s `MemoryConfig` gains the required keys
  `recallHistory` and `recallHistoryShare`; options merged over
  `memoryDefaults` need no change. Memory recall now returns earlier states by
  default: a host that pins the recall text, or wants the earlier behaviour,
  sets `recallHistory: "none"` (or passes `history: "none"` to `recall`).
- `@xandreed/plugin-memory`'s `MemoryConfig` gains the required key
  `supportWeight` (default `0.15`); options merged over `memoryDefaults` need
  no change, and a host that builds a whole `MemoryConfig` adds it. Recall
  now ranks by support and the default text counts repeated memories: a host
  that pins the recall text or its order, or wants the earlier behaviour,
  sets `supportWeight: 0`. A host's own `KnowledgeIndex` keeps a memory's new
  `mentions` whole and refuses a stage whose memory mentions a revision its
  provenance does not cite, as `validateKnowledgeStage` does and
  `knowledgeStoreConformance`'s new `knowledge.mentions` check requires.
- Native knowledge extraction is at version 4: the engines record their jobs
  under `memory:4/…` and `rag:4/…`; drain or `retry` version 3 jobs as above.
  `KnowledgeStage` gains the optional `corroborations`: a host's own
  `KnowledgeIndex` applies them at publication (appending each one's spans and
  mention to the active memory it names, refusing with `Conflict` when that
  memory is no longer active once the publication has retired what it
  replaces) and, when a source's later revision publishes, strips that
  source's earlier spans and mentions from the active memories another source
  published instead of retiring them, as `knowledgeStoreConformance`'s new
  `knowledge.corroboration`, `knowledge.corroboration-conflict` and
  `knowledge.corroboration-revision` checks require; `corroborateKnowledgeMemory`
  and `stripKnowledgeRevisions` do the payload work. Its narrowed search
  admits a memory by its own evidence alone and leaves out the spans and
  mentions of the revisions that restated it later where the narrowing does
  not admit them (`narrowKnowledgeMemory`), as the new
  `knowledge.corroboration-reach` check requires; the new
  `knowledge.corroboration-superseded` check publishes a stage an extraction
  that supersedes a memory and restates it in another record makes. A memory that cites an
  earlier revision only through an entity that revision defined is now
  stripped the same way rather than retired. `longTermMemoryConformance` gains
  `restated-source`; a host's own `LongTermMemory` passes it by publishing
  both sources, and giving the subject `restatingExtraction` also checks the
  merge. `@xandreed/plugin-memory`'s `MemoryConfig` gains the required key
  `restatementSimilarity` (default `0.92`); options merged over
  `memoryDefaults` need no change, and `false` keeps every memory the
  extraction writes but those it names as restatements.
- Native knowledge extraction is at version 5: the engines record their jobs
  under `memory:5/…` and `rag:5/…`; drain or `retry` version 4 jobs as above.
  `KnowledgeMemory` gains the optional `eventAt` (`KnowledgeEventTime`): a
  host's own `KnowledgeIndex` keeps it whole through staging, publication,
  search and reads and decodes a memory stored without it unchanged, as
  `knowledgeStoreConformance`'s new `knowledge.event-time` check requires.
  `longTermMemoryConformance` gains `past-event`; a host's own
  `LongTermMemory` passes it on plain extraction by never marking a memory
  without an event `past`, and giving the subject `pastEventExtraction` also
  checks that its profile leaves a passed preference out and its recall
  returns it marked `past`. `@xandreed/plugin-memory`'s `MemoryConfig` gains
  the required key `pastEventWeight` (default `0.5`); options merged over
  `memoryDefaults` need no change, and `1` ranks past records as before.
- `LongTermMemory.profile` returns `KnowledgeProfileMemory` (a
  `KnowledgeMemory` with an optional `support`), so code that reads the
  profile as memories is unchanged and a host's own `LongTermMemory` that
  returns plain memories still compiles. `longTermMemoryConformance` gains
  `profile-order`: a host's own `LongTermMemory` passes it by giving each
  profile memory the support `knowledgeMemorySupport` counts from the
  revisions it mentions and returning the profile in `knowledgeProfileOrder`.
  A host that pins the memory section's text or its profile records' order
  re-records it: the order and the counts change, and the section is
  version 6.
- `knowledgeStoreConformance` gains `knowledge.similarity-floor`: a host's own
  `KnowledgeIndex` scores a semantic candidate by the cosine similarity of its
  embedding with the query vector and honours `KnowledgeSearch.minSimilarity`
  on the semantic arm alone, before its limit. `@xandreed/plugin-memory`'s
  `MemoryConfig` gains the required key `recallCollapseSimilarity` (default
  `0.95`); options merged over `memoryDefaults` need no change, and a host that
  pins the recall text or its records, or wants the earlier behaviour, sets
  `false`. Code that reads a recalled memory's provenance or mentions sees the
  folded memories' evidence on the kept one (see Changed). A host that pins
  the memory section's text re-records it: the section is version 7. The facade kit's
  `restated-source` check no longer counts a memory recall folded (`alike`)
  as a stored restatement.
- Native knowledge extraction is at version 6: the engines record their jobs
  under `memory:6/…` and `rag:6/…`; drain version 5 jobs, or `retry` them
  (which requeues each under the new id through `KnowledgeIndex.requeue`).
  A memory job whose review failed under version 5 with `Invalid` ("The
  extraction model returned an invalid knowledge object") is worth that
  retry, although `isRetryableKnowledgeFailure` calls `Invalid` final: list
  it with `KnowledgeIndex.failed({ namespace, reasons: ["Invalid"] })`. A
  document whose graph was omitted that way is extracted again by ingesting
  its next revision. A host that pins `knowledgeReviewPrompt` updates the pin.
- Native knowledge extraction is at version 7: the engines record their jobs
  under `memory:7/…` and `rag:7/…`; drain version 6 jobs, or `retry` them
  (which requeues each under the new id through `KnowledgeIndex.requeue`).
  A memory job that failed under version 6 with `Invalid` ("The extraction
  model returned an invalid knowledge object") because a record that
  supersedes nothing gave `"supersession": null` or no `supersession` now
  stages; list it with `KnowledgeIndex.failed({ namespace, reasons: ["Invalid"] })`
  and `retry` it. A document whose graph was omitted that way is extracted
  again by ingesting its next revision. `KnowledgeExtractedMemory` and
  `KnowledgeExtractedAssertion` now type `supersession` as optional and
  nullable (`supersession?: KnowledgeSupersession | null`): code that reads
  it from a decoded extraction handles `null` and absence, and reads it only
  when `supersedes` is non-empty. A host that pins the extraction, document,
  part or review prompt updates the pin.
- Native knowledge extraction is at version 8: the engines record their jobs
  under `memory:8/…` and `rag:8/…`; drain version 7 jobs, or `retry` them
  (which requeues each under the new id through `KnowledgeIndex.requeue`).
  A memory job that failed under version 7 with `Invalid` ("The extraction
  refers to an undefined entity key") because every record it proposed named
  the conversation's user without defining it is worth that retry, although
  `isRetryableKnowledgeFailure` calls `Invalid` final: list it with
  `KnowledgeIndex.failed({ namespace, reasons: ["Invalid"] })`. A completed
  job keeps what it published. A host that pins the extraction, document,
  part or review prompt updates the pin.

- `extractKnowledge`'s `complete` returns the helper's `UtilityCompletion`
  instead of a decoded `KnowledgeExtraction`: `extractKnowledge` now decodes
  each reply itself, so it can record where and how one failed. A host that
  runs its own engine over it passes its `UtilityLlm.complete` result through
  and drops its own decode; a reply that does not decode fails `Invalid` with
  "The extraction model returned an invalid knowledge object" in memory mode
  and "The document model returned an invalid graph extraction" in document
  mode, the messages the native engines used. A host's own `KnowledgeIndex`
  keeps a failure's new `diagnostic` whole on the job and in its failed
  listing, as `knowledgeStoreConformance`'s `knowledge.failure-reason` check
  now requires.
- `extractKnowledge` takes `review` as a `KnowledgeReviewPolicy` (`"always"`,
  `"on-failure"` or `"off"`; `true` was `"always"`, `false` `"off"`) and a
  `stage` function, and returns what `stage` returns: a host that ran its own
  engine over it moves its staging into `stage` (usually
  `(extraction) => stageKnowledgeExtraction(source, snapshot, extraction, now)`,
  after any change of its own), or passes `Effect.succeed` to keep the merged
  extraction. `MemoryConfig.review` and `RagConfig.review` are the policy too:
  options given to the plugins still decode `true` and `false`, but the
  config's type takes only the words, so TypeScript that builds a
  `MemoryConfig` or `RagConfig` itself (`{ ...memoryDefaults, review: false }`
  passed to `MemoryLive` or `RagLive`) no longer compiles until it writes
  `"off"` for `false` and `"always"` for `true`.

### Changed

- `@xandreed/core`, `@xandreed/plugin-memory`, `@xandreed/plugin-rag`: one
  bad extracted record no longer loses a whole turn or document graph.
  `stageKnowledgeExtraction` leaves out a record that fails a check of its own
  (a span that is not the exact source text after quote repair, an `existing`
  entity identity that is not a supplied candidate, an undefined entity key, a
  `supersedes` entry naming an unknown or inactive record, an unknown
  supporting memory, an inferred routine with fewer than three supporting
  episodes, a validity interval that ends before it starts), and every record
  that refers to a dropped entity's key, and stages the rest; each record left
  out adds a `RecordDropped` note (`record`, its local `key`, reason
  `Invalid`, `message`) to `KnowledgeStage.notes`, read through `status`. An
  entity that only dropped records referred to is left out with them. The
  job still fails with `Invalid` when the extraction repeats an entity key,
  does not encode, or proposed memories or relations and kept none of them,
  its entities alone not counting (with the first drop's message, so
  `KnowledgeIndex.failed` keeps listing extractions broken throughout);
  publication's checks are unchanged. Over several extraction
  windows, a record naming a key no part defines is dropped at staging rather
  than refusing the source; a part that repeats a key still refuses it. The
  document engine keeps a graph whose records were partly dropped (its chunks
  publish with the rest and the notes) and records `GraphOmitted` only when
  the whole graph fails.
- `@xandreed/core`: a world change that supersedes a record without a stated
  date (`supersession: "change"`, `validFrom: null`) is dated at the source's
  occurrence time instead of failing the job with "A world change needs an
  evidenced effective date": the latest time the source shows the new state
  held. `KnowledgeAssertion.validFromBasis` (optional, stored in the
  assertion's payload) records `"observed"` for such a date and `"stated"`
  for one the extraction gave; assertions stored without it read as stated.
  The superseded relation's history copy ends at that time as before, and now
  never before its own `validFrom`. An assertion that supersedes nothing keeps
  an unknown start unknown.
- `@xandreed/core`: the extraction prompt (version 2) shows the source's
  occurrence time as ISO 8601 in UTC with its epoch milliseconds
  (`Source occurrence time: 2026-11-06T09:30:00.000Z (epoch milliseconds
  1793957400000)`), asks for relative dates to be resolved against it, never
  the current time, and to set `validFrom` to it for a present change stated
  without a date, keeping null for an unknown start that supersedes nothing.
  The pinned extraction, document, part and review prompts change
  accordingly; the query and rerank prompts do not.
- `@xandreed/plugin-memory`: recalled memory shows the model when each
  record was said. `renderMemoryRecall(result, maxChars, options?)` takes the
  result's `sources` (optional) and `{ dates?, now? }`; given sources, it
  states one reading rule above the evidence ("Each record is dated by when
  its source was said or written; a validity range bounds when a relationship
  held.") and labels a memory `[YYYY-MM-DD · <kind> · stated|inferred]`, a
  passage `[YYYY-MM-DD]` and a relation `[YYYY-MM-DD · valid
  <from>–<to|present>]` (or `valid until <to>`), adding `(start taken from
  when it was said)` for an observed start. With `now` it adds "Today is
  YYYY-MM-DD." and marks a relation whose validity ended `(no longer current
  since <date>)`. Dates are UTC calendar dates of the revision each record's
  first span cites; a record whose revision is not in `sources` stays
  undated. Without sources, or with `dates: false`, the text is unchanged.
  The budget still bounds the records' text; labels add about 30 characters
  per record. The `memory.recalled` section (version 2), `memoryRecallNote`
  and `recall_memory` render this way: `MemoryConfig.recallDates` defaults to
  `true`, which changes their default text (a record's date never changes, so
  a recorded section stays stable across turns), and `recallToday` defaults
  to `false`, since today's date changes the text daily. The section dates
  profile records from the recall's sources and reads a profile record's
  dating revision once when the recall did not cite it; when that read fails
  the record is shown undated. Set `recallDates: false` for the earlier text.
- `@xandreed/core`: `knowledgeRecordDate(provenance, sources)`, the
  occurrence time of the source revision a record's first span cites. Staging
  puts a record's own spans first, before its entities' evidence and its
  supports, and a relation's history copy keeps the earlier relation's spans
  first; both are now documented and tested.
- `@xandreed/core`: `knowledgeStoreConformance` gains
  `knowledge.stage-notes` (graph and dropped-record notes kept through
  restaging and publication); `longTermMemoryConformance` and
  `knowledgeConformance` gain `dropped-record`, with an optional
  `droppingExtraction` subject. `@xandreed/plugin-knowledge-postgres` passes
  the new check with its layout unchanged: notes and the validity basis live
  in the job and assertion payloads, and rows an earlier release wrote decode
  unchanged.
- `@xandreed/core`: a successor links the earlier state it replaced.
  `KnowledgeMemory.replaces` and `KnowledgeAssertion.replaces` (optional,
  `{ id, supersession }`) are written on the successor at staging, only when
  it replaces something; nothing is written to the retired record but its
  `knownTo`. A memory links each memory it supersedes with the extracted
  memory's new `supersession`; a relation's change links the history copy
  (which carries the ended `validTo`), a relation's correction the retired
  relation. Records stored before links existed decode with none. The
  extraction prompt (version 3) adds: "When a new memory replaces an active
  candidate memory because the situation changed, list it in supersedes with
  supersession change; when the candidate was wrong, use correction. Write the
  new memory so it states the new situation and what it replaces." The pinned
  extraction, document, part and review prompts change accordingly (the
  output schema gains the memory's `supersession`). New names:
  `KnowledgeSupersession`, `KnowledgeMemoryReplacement`,
  `KnowledgeAssertionReplacement`.
- `@xandreed/core`: recall can return the earlier states its current records
  replaced. `KnowledgeRecall.history` (`"changes"`, the default, `"all"` or
  `"none"`; corrections only with `"all"`, since a correction says the earlier
  belief was wrong) and `historyShare` (0 to 0.5, default 0.2);
  `KnowledgeRecallResult.history` lists `KnowledgeRecallHistory` entries
  (`Memory` or `Assertion`, with the `record`, its `successor`'s key,
  `supersession` and `until`), and `sources` now also cites their revisions.
  `budgetKnowledgeRecall(result, maxChars, limit, historyShare?)` selects in
  three deterministic passes: current evidence within `(1 - historyShare) ×
  maxChars`; one hop back from the records it kept, in their rank order,
  within the share and at most `ceil(limit / 2)` earlier states; then further
  current evidence in what is left. With no earlier state followed, the
  budget is exactly as before. `knowledgeAssertionKey` names a relation as a
  successor (`assertion:<id>`). `knowledgeStoreConformance` gains
  `knowledge.supersession-links` (links kept on successors, a retired memory
  readable by id and otherwise unchanged, a link left dangling by
  forgetting); `@xandreed/plugin-knowledge-postgres` passes it with its
  layout unchanged, the links living in the successor's payload.
- `@xandreed/plugin-memory`: memory recall returns and shows earlier states.
  The engine follows each recalled memory's and relation's links of the
  requested supersessions one hop (a memory read by id, a relation from the
  snapshot recall already reads) and skips a link whose record was forgotten,
  is still current or lies outside the recall's `sources` or `metadata`;
  `until` is a relation change's ended validity, else the date its successor
  was said. `renderMemoryRecall` (new option `historyShare`) shows them after
  the current records, in the same frame, under "Earlier states, no longer
  current:", a change as `previously: <text> (until YYYY-MM-DD; replaced by
  <source> revision <n>)` and a correction as `previously: <text> (corrected
  YYYY-MM-DD; this was wrong)`, each with its citations. `MemoryConfig`
  gains `recallHistory` (default `"changes"`) and `recallHistoryShare`
  (default `0.2`), read by the `memory.recalled` section (now version 3),
  `memoryRecallNote` and `recall_memory`, whose new `history` parameter
  ("Which earlier states to show beside the current records that replaced
  them: changes for situations that changed, all to add beliefs later
  corrected as wrong, or none. Omit to use the default.") overrides it for one
  call. The default text changes only when a recalled record replaced
  something. `@xandreed/plugin-rag`'s `retrieve` returns no earlier states.
- `@xandreed/core`: a memory records the source revisions whose own text
  states it, `KnowledgeMemory.mentions` (optional; additive in the stored
  payload). `stageKnowledgeExtraction` writes the source for a stated memory,
  and for an inferred one the source and every revision that states one of
  its supports, never the revisions that only evidence its entities, which
  staging still appends to its provenance. `knowledgeMemoryMentions(memory)`
  reads them, falling back for a memory stored before them to the revision
  its first span cites when stated and every revision its provenance cites
  when inferred. `validateKnowledgeStage` refuses a memory that mentions a
  revision its provenance does not cite, so forgetting a mentioned source
  removes the memory through the existing source closure and requeues its
  other sources. `knowledgeMemorySupport(memory, infos)` returns a
  `KnowledgeSupport` (`episodes`, `sources`, `firstSeen`, `lastSeen`) over
  the live mentioned revisions: `episodes` counts distinct
  `metadata.episode` values, a revision without one counting as its own
  source, the rule the inferred-routine check in `validateKnowledgeStage`
  and `stageKnowledgeExtraction` now shares. `KnowledgeCandidate`'s `Memory`
  case gains an optional `support`, and `fuseKnowledgeCandidates` an
  optional `weight(candidate)` that multiplies each fused score before
  ranking and selection; without it fusion is unchanged.
  `knowledgeStoreConformance` gains `knowledge.mentions` (kept through
  staging, publication, search and reads; absent on a memory stored without
  them; refused outside the provenance; the memory removed when a mentioned
  source is forgotten), which `@xandreed/plugin-knowledge-postgres` passes
  with its layout unchanged, the mentions living in the memory's payload.
- `@xandreed/plugin-memory`: recall ranks a preference, routine, profile or
  fact said in several episodes a little higher and says how often. The
  engine fuses once, reads the info of the pool's (at most 100) mentioned
  revisions in one `sourceInfo` batch, and fuses again with the factor
  `1 + supportWeight × ln(min(episodes, 4))`; chunks and other kinds weigh
  1. With the new `MemoryConfig.supportWeight` (default `0.15`) the boost is
  at most ×1.21, so near the top of the lists a memory passes only records
  within about twelve places of it: a fact both arms rank first stays ahead
  of a preference said in four episodes they rank twentieth. Each recalled
  memory carries its `support`. `renderMemoryRecall` adds `said <n> times,
  last YYYY-MM-DD` to a dated memory's labels from two episodes on, and the
  `memory.recalled` section (now version 4) gives its profile records the
  support recall found for them. `supportWeight: 0` reads nothing, ranks as
  before and shows no count.
- `@xandreed/core`, `@xandreed/plugin-memory`,
  `@xandreed/plugin-knowledge-postgres`: a statement repeated in another
  source adds evidence to the memory it restates instead of a new memory with
  one mention, so recall counts it as said again. Memory ids are scoped to
  their source and published records are immutable, so before this every
  repeated mention became a memory of its own. `KnowledgeExtractedMemory`
  gains the optional `restates`, and the extraction prompt (version 4) asks
  the model to name the active candidate memory a source restates without
  changing it rather than writing a new record. `stageKnowledgeExtraction`
  turns such a proposal into a `KnowledgeCorroboration` (`memory`, the
  source revision as `mention`, the proposal's own spans as `provenance`) of
  each named memory that is active, stated, of the proposal's kind and
  published by another source, in the stage's new `corroborations`; a named
  memory that is unknown or no longer active drops the proposal with a
  `RecordDropped` note, and any other leaves it a new memory. A named memory
  another memory of the same extraction supersedes is never corroborated, as
  publication would refuse the stage and every retry of the job: a proposal
  that restates only such memories repeats the state its extraction replaces
  and is dropped with the note "The extraction restates a memory it also
  supersedes". After
  embedding, `mergeKnowledgeRestatements(stage, snapshot, source,
  minSimilarity)` takes a new stated memory with the kind and exactly the
  entities of an active stated memory from another source, and an
  embedding at least `minSimilarity` alike, as a corroboration of the most
  similar one; memories without entities never merge, so distinct facts
  about different things stay apart. The memory engine runs it with
  `MemoryConfig.restatementSimilarity` (default `0.92`, on because merging
  repeated statements is the point; `false` turns it off).
  `validateKnowledgeStage` refuses a corroboration whose spans cite another
  revision or whose memory is inferred (`Invalid`), or whose memory is
  missing, retired or retired by the stage (`Conflict`). Both stores append
  the evidence and its source links without retiring the memory, refuse with
  `Conflict` when the memory was retired after extraction, and, when a
  corroborating source's later revision publishes, strip its earlier spans
  and mention from a memory it did not publish (the identities say which)
  while the memories it published retire as before. Forgetting a
  corroborating source removes the memory through the source closure and
  requeues its other sources, which rebuild it with the mentions that
  survive. The PostgreSQL store does this in its publication transaction
  with its layout unchanged. A read narrowed by `sources` or `metadata`
  admits a memory when its own evidence is within the narrowing, as before;
  the revisions that restated it later (a stated memory's mentions after the
  first) are no part of that evidence, so a restatement from outside the
  reach (another episode, project or tenant) neither hides the memory from it
  nor shows there: `narrowKnowledgeMemory` leaves their spans and mentions
  out of the record the stores' search, the memory's profile and its earlier
  states return, and the support recall counts.
- `@xandreed/core`, `@xandreed/plugin-memory`: a plan, goal or interest tied
  to a dated event no longer stays current forever. Memories had only known
  time, so "I'd love to see the exhibition on 20 March" was shown in the
  profile in May as a current preference; the only expiry was an assertion's
  `validTo`, set at the extractor's discretion. The extraction prompt
  (version 5) asks for `eventAt` on a memory that concerns a dated event (an
  appointment, a trip, a deadline, a booking), resolved against the source
  occurrence time, and `KnowledgeExtractedMemory` gains the optional, nullable
  `eventAt` (`start`, and `end` only for an event that lasts beyond its
  start); staging keeps it on the memory (`KnowledgeMemory.eventAt`, written
  only when given) and drops a memory whose event ends before it starts with
  a `RecordDropped` note. A goal, decision, action or preference whose event
  ended before a time is past then (`knowledgeMemoryIsPast(memory, now)`);
  facts, routines and profiles never are. Nothing is deleted or filtered from
  search: memory recall marks a past candidate `past: true`
  (`KnowledgeCandidate`'s new optional key), judged at the recall's valid
  time, and under the new `KnowledgeRecall.temporal: "current"` (the default;
  `KnowledgeRecallTemporalMode`) multiplies its fused score by
  `MemoryConfig.pastEventWeight` (default `0.5`, so the default ranking
  changes, which is the point; `1` turns it off) after the support factor
  (`memoryPastFactor`), while `"all"` ranks it as any other.
  `LongTermMemory.profile` leaves past records out. `renderMemoryRecall`
  follows a memory's text with `(event on YYYY-MM-DD)`, a range for an event
  that ends on a later day, or `(event on YYYY-MM-DD, past)`, unless `dates`
  is false, and the `memory.recalled` section is version 5. `recall_memory`
  gains a `temporal` parameter. A restatement must have the event time of the
  memory it restates, named or found by similarity, so a later booking of the
  same kind is its own memory, and the extraction's candidates show each
  memory's `eventAt`.
- `@xandreed/core`, `@xandreed/plugin-memory`, `@xandreed/plugin-rag`,
  `@xandreed/plugin-knowledge-postgres`: near-identical memories no longer
  fill recall's places. Restatements that publication did not merge (without
  entities, with another entity set, from the same source, or stored before
  restatements were merged) are separate memories that rank side by side, so
  four wordings of one fact could take four of the default eight places and
  push other evidence out; and semantic search kept every positive cosine
  (in-memory) or every score (PostgreSQL), however weak. Memory recall now
  folds, after the support and event weights and before reranking and
  selection, each memory of the same kind and event time as a memory ranked
  above it and kept whose embedding cosine with it is at least
  `MemoryConfig.recallCollapseSimilarity` (default `0.95`, so the default
  recall changes, which is the point; `false` turns it off) into that
  memory: the folded memory frees its place and its
  share of the budget, and the kept candidate names it in `alike`
  (`KnowledgeCandidate`'s new optional list of `KnowledgeMemoryId`) and
  carries its spans and mentions as a corroboration would, so its `support`
  counts both and the result cites both sources. Passages never fold, the
  graph is still seeded from every memory found, and nothing changes in the
  store. The section shows a profile record recall folded into a kept memory
  once, as the profile's record with the profile's count (or, for a record
  without one, the kept memory's), and is version 7.
  `KnowledgeSearch.minSimilarity` (from -1 to 1, optional) is a floor on the
  semantic arm, applied before the limit by the in-memory store and in the
  PostgreSQL store's SQL; both keep every score at or above it, so a floor at
  or below 0 keeps the scores of 0 or less the in-memory store otherwise
  drops, and the kit's `knowledge.similarity-floor` checks a floor of 0 and
  of -1 too; `MemoryConfig.recallMinSimilarity` and
  `RagConfig.minSimilarity` pass one and are absent by default, so search is
  unchanged until a floor measured for the embedding model is set.

- `@xandreed/core`, `@xandreed/plugin-memory`, `@xandreed/plugin-rag`,
  `@xandreed/plugin-models`, `@xandreed/plugin-knowledge-postgres`: a failed
  extraction records where and how it failed on its job, without its content,
  so a host or a trace can tell a reply cut off at the output cap from one
  that drifted from the schema or one staging refused. `KnowledgeJobFailure`
  and `KnowledgeError` gain an optional `diagnostic`
  (`KnowledgeFailureDiagnostic`): the `stage` (`extract` or `review` when that
  call's reply did not decode, `stage` when staging refused the decoded
  extraction as a whole), the `path` of the first decode issue
  (`["assertions", 0, "supersession"]`, empty for the reply as a whole), the
  `finishReason` and `outputTokens` the helper completion reported and the
  source `window` (`{ part, parts }`) the call read. It never holds the
  model's text, a quote or the source, and failures that are not an
  extraction's have none. `UtilityCompletion` gains an optional
  `finishReason`, which the models plugin's `UtilityLlmLive` fills from the
  response's finish part. The memory and document engines copy the diagnostic
  into the failure they record (`knowledgeJobFailure`) and set it on the span
  that processed the job (`knowledgeFailureAttributes`:
  `efferent.knowledge.failure.stage`, `.path` as JSONPath, `.finish_reason`,
  `.output_tokens`, `.window`). The in-memory and PostgreSQL stores keep it in
  the job payload, layout unchanged, return it from `status` and `failed`,
  and decode a failure stored before it without one. No prompt or output
  schema changes, so `KNOWLEDGE_EXTRACTION_VERSION` stays 8.
- `@xandreed/core`, `@xandreed/plugin-memory`, `@xandreed/plugin-rag`: a host
  chooses when extraction is reviewed, since the review pass costs a second
  helper call per window, doubles extraction latency and does not help every
  helper model. The memory and document engines' `review` option is a
  `KnowledgeReviewPolicy`: `"always"` reviews every window's extraction, as
  `true` did; `"off"` never reviews, as `false` did; `"on-failure"` extracts
  every window without review and stages the merged extraction, and only when
  staging refuses it as a whole with `Invalid` (a repeated entity key, no
  record that survives its checks, a document extraction that proposes
  personal memories) reviews each window's extraction with
  `knowledgeReviewPrompt` and stages the reviewed merge. A record staging
  drops on its own is reported as a `RecordDropped` note and starts no
  review. A review reply that does not decode fails with diagnostic stage
  `review`, and a reviewed extraction staging still refuses fails at stage
  `stage`. `true` and `false` still decode from plugin options, so existing
  configurations keep their behaviour, and the default stays `"always"`; a
  typed `MemoryConfig` or `RagConfig` needs the word (see Migration). `extractKnowledge`
  takes the policy and the `stage` function its refusal is read from. No
  prompt or output schema changes, and `CurrentKnowledgeHelperCall`'s
  purposes are unchanged, so `KNOWLEDGE_EXTRACTION_VERSION` stays 8.

### Fixed

- Release preparation failed after the readme was shortened: the readme lost its
  `Workspace packages share version` line, which every release rewrites. The
  line is back, and a test now fails when any file the release rewrites lacks
  its version marker.
- `@xandreed/core`, `@xandreed/plugin-memory`: the memory profile is
  ordered by support and recency instead of the store's order. The profile
  kept the order of its store's snapshot, insertion order in memory and id
  order in PostgreSQL, where a memory's id begins with its source's and so
  with the host's session ids, and the `memory.recalled` section showed the
  first four: which preferences reached the model depended on the store and
  on how the host names sessions, and a preference said in many
  conversations could be left out for one said once. `LongTermMemory.profile`
  still returns the current preference and profile memories whose dated
  event has not passed, now each with its `support` (one `sourceInfo` read
  for all their mentioned revisions; `KnowledgeProfileMemory`) and ordered
  by the new `knowledgeProfileOrder`: more episodes first, then said more
  recently (`lastSeen`), then by id, a memory without support last. The
  section and `memoryRecallNote` keep that order, label each profile record
  with the profile's count, and take the first four the run's reach admits,
  so a refused record never displaces an admitted one (section version 6);
  a record the reach keeps without a restatement from outside it shows no
  count, as its support counted that restatement. `supportWeight: 0` reads
  nothing and orders the profile by id.

- `@xandreed/core`, `@xandreed/plugin-memory`, `@xandreed/plugin-rag`: the
  evidence review no longer fails on a proposal the reviewer keeps.
  `knowledgeReviewPrompt` wrote the decoded extraction with
  `JSON.stringify`, so an absent `existing` identity or `validFrom`/`validTo`
  date reached the reviewer as Effect's `Option` object
  (`{"_id":"Option","_tag":"None"}`, a present one with a `value`). A
  reviewer that copied the proposal back returned JSON the output schema
  refuses, and the memory job failed with `Invalid` or the document graph was
  omitted. The proposal is now the output schema's wire form, encoded by
  `KnowledgeExtraction`: an absent value is `null` and a present one its plain
  value, as in the extraction call's own answer, so returning it unchanged
  decodes to the same extraction. The review prompt's instructions are
  unchanged; extraction version 6 (`KNOWLEDGE_EXTRACTION_VERSION`) and the
  pinned review prompt record the new proposal, and the extraction, document
  and part prompts are unchanged. Review stays on by default on both engines.

- `@xandreed/plugin-memory`, `@xandreed/plugin-rag`, `@xandreed/core`:
  with `queryPlanning` on, recall and document search rank each planned
  query's lexical and semantic lists on their own. Both engines joined
  every query's lists into one lexical and one semantic list before
  reciprocal rank fusion, so a candidate only a planned query found was
  ranked after all of the question's candidates (`1 / (61 + n)` behind
  the question's `n`, rather than `1 / 61` at the first place of its own
  query) and lost its slot to the question's weaker matches, and a candidate several queries found scored only its
  first place in each joined list. A candidate now scores
  `1 / (61 + rank)` in every list that holds it, at its 0-based rank in
  that list alone, summed. `fuseKnowledgeCandidates` takes one
  `KnowledgeCandidates` pair or one pair per query; a single pair fuses as
  before, so a search without planning (the default) ranks exactly as it
  did. Ties still go by candidate key, `limit` and the character budget
  select after scoring, and fusion is one pass over the lists instead of a
  search of each list per candidate.

- `@xandreed/core`, `@xandreed/plugin-memory`, `@xandreed/plugin-rag`: an
  extraction whose records supersede nothing no longer fails for giving them
  no supersession. The output schema required `supersession` (`change` or
  `correction`) on every extracted memory and relation, so a reply with
  `"supersession": null` beside an empty `supersedes`, or without the key,
  the form extraction models commonly return, failed to decode: the memory
  job failed with `Invalid` or the document graph was omitted.
  `KnowledgeExtractedMemory.supersession` and
  `KnowledgeExtractedAssertion.supersession` are now
  `Schema.optionalKey(Schema.NullOr(KnowledgeSupersession))`, and the output
  schema describes the field as required only when `supersedes` is
  non-empty. `stageKnowledgeExtraction` reads a supersession only from a
  record that supersedes others: one given beside an empty `supersedes` is
  ignored, as it was. A record that supersedes others without one is left
  out with a `RecordDropped` note ("The extraction supersedes records
  without saying whether it is a change or a correction"), its superseded
  records stay active, and the rest stages; an extraction whose every record
  is dropped that way fails with `Invalid` and that message. The memory
  `replaces` link, an undated change's observed `validFrom`, a relation's
  history copies and its `replaces` links follow the same rule. An
  extraction with a supersession on every record, the earlier form, decodes
  and stages as before. Extraction version 7 (`KNOWLEDGE_EXTRACTION_VERSION`)
  and the pinned extraction, document, part and review prompts record the
  new output schema; the prompts' instructions are unchanged.

- `@xandreed/core`, `@xandreed/plugin-memory`: memory extraction says how to
  refer to the conversation's user. Extraction models commonly named an
  undefined `user` key, or another name for it such as `user:self`, in a
  memory's `entities` or as a relation's subject; staging drops each such
  record with a `RecordDropped` note ("The extraction refers to an undefined
  entity key"), so the memory was lost. `knowledgeExtractionPrompt` in memory
  mode now adds one rule after "Extract conversational memory and its
  relationships.": memories are already about the conversation's user, so a
  memory never lists the user in its `entities`; a relation whose subject or
  object is the user defines the user in `entities` like any other entity,
  with a span where the user speaks or refers to themselves; and every key a
  memory or relation names is defined in `entities`. The output schema, shared
  by both modes, describes `KnowledgeExtractedMemory.entities` and
  `KnowledgeExtractedAssertion.subject` and its entity object's `key` as keys
  defined in `entities`. The document prompt is otherwise unchanged, and
  staging is unchanged: a record naming an undefined key is still dropped
  alone. A memory's entities seed recall's graph traversal, so a memory that
  no longer lists the user no longer brings each of the user's relations into
  every recall that finds it. Extraction version 8
  (`KNOWLEDGE_EXTRACTION_VERSION`) and the pinned extraction, document, part
  and review prompts record the change.

- `@xandreed/core`, `@xandreed/plugin-memory`, `@xandreed/plugin-rag`: an
  extracted span whose quote differs from the source only in typography is
  anchored instead of dropped. Extraction models commonly quote a curly
  apostrophe or quote as a straight one (or the reverse), a dash as a hyphen
  or a no-break space as a space; staging found no such quote in the source
  and dropped the record with a `RecordDropped` note ("The extraction cites
  an invalid source span"), or failed the job when it was the only record.
  `stageKnowledgeExtraction`, and `extractKnowledge` within each window of a
  split source, still look for the exact quote first; when it is nowhere in
  the text, they compare again with `‘ ’ ‚ ‛ ′` read as `'`, `“ ” „ ‟ ″` as
  `"`, `‐ ‑ ‒ – — −` as `-`, and the no-break, narrow no-break and figure
  spaces as a space. Each is one UTF-16 unit read as one, so offsets stay the
  source's. The occurrence nearest the proposed offset wins, and the span's
  quote becomes the source's exact text there, which staging's checks and the
  stored provenance carry. A quote that matches neither way is still dropped
  with its note. Prompts and the output schema are unchanged, so
  `KNOWLEDGE_EXTRACTION_VERSION` stays 8; a job that failed with `Invalid`
  for this reason stages when retried.

### Changes

- Native knowledge extraction (version 2, so the engines' ids become `memory:2/…` and `rag:2/…`) dates a world change stated without a date at its source's occurrence time, recorded as `KnowledgeAssertion.validFromBasis: "observed"`, instead of failing the job, and leaves out only the extracted records that fail their own checks, each with a `RecordDropped` stage note, while the rest of the turn or document graph publishes. The extraction prompt shows the occurrence time as ISO 8601 with its epoch milliseconds. A job still fails with `Invalid` when the extraction repeats an entity key or keeps none of the memories and relations it proposed (its entities alone do not count). The knowledge kits gain `knowledge.stage-notes` and `dropped-record`.

- A failed knowledge extraction records where and how it failed on its job, without its content: `KnowledgeJobFailure` and `KnowledgeError` gain an optional `diagnostic` (`KnowledgeFailureDiagnostic`) with the stage (`extract`, `review` or `stage`), the path of the first decode issue, the finish reason and output tokens the helper completion reported, and the source window the call read, so a reply cut off at the output cap reads `finishReason: "length"` apart from a schema drift or a staging refusal. `UtilityCompletion` gains an optional `finishReason`, filled by the models plugin's `UtilityLlmLive`. `extractKnowledge`'s `complete` now returns the helper's `UtilityCompletion`, which it decodes. The memory and document engines record the diagnostic (`knowledgeJobFailure`) and set it on the processing span (`knowledgeFailureAttributes`); the in-memory and PostgreSQL stores keep it in the job payload and list it, and older failures decode without one. No prompt change, so the extraction version stays 8.

- With query planning on, memory recall and document search rank each planned query's lexical and semantic lists on their own: a candidate scores `1 / (61 + rank)` in every list that holds it, summed, so one only a planned query finds is no longer ranked after all of the question's candidates. `fuseKnowledgeCandidates` takes one `KnowledgeCandidates` pair or one per query; a single pair fuses exactly as before.

- Memory extraction now says how to refer to the conversation's user. Extraction models commonly named an undefined `user` key in a memory's entities or as a relation's subject, and staging dropped each such record with a `RecordDropped` note, losing the memory. In memory mode, `knowledgeExtractionPrompt` adds one rule: memories are already about the conversation's user, so a memory never lists the user in its entities; a relation whose subject or object is the user defines the user as an entity like any other; and every key a record names is defined in entities. The shared output schema describes a memory's `entities` and a relation's `subject` and entity object `key` as keys defined in entities. The document prompt is otherwise unchanged and staging is unchanged. Extraction version 8 moves the engine ids to `memory:8/…` and `rag:8/…`; `retry` requeues a failed version 7 job under the new id through `KnowledgeIndex.requeue`.

- Memory recall ranks and labels a memory by how many episodes state it. `KnowledgeMemory.mentions` (optional, additive) records the source revisions whose own text states a memory: staging writes the source for a stated memory and, for an inferred one, also every revision that states one of its supports, never the revisions that only evidence its entities; older memories fall back to their provenance (`knowledgeMemoryMentions`), and `validateKnowledgeStage` refuses a mention outside the provenance, so forgetting a mentioned source removes the memory. `knowledgeMemorySupport` returns a `KnowledgeSupport` (`episodes`, `sources`, `firstSeen`, `lastSeen`) over the live mentioned revisions, by the episode rule the inferred-routine check now shares. `fuseKnowledgeCandidates` takes an optional `weight`, and `KnowledgeCandidate`'s `Memory` case an optional `support`. The memory engine multiplies a preference, routine, profile or fact's fused score by `1 + supportWeight × ln(min(episodes, 4))` (`MemoryConfig.supportWeight`, default 0.15, at most ×1.21; 0 turns it off), and `renderMemoryRecall` adds `said <n> times, last YYYY-MM-DD` from two episodes on (`memory.recalled` version 4). `knowledgeStoreConformance` gains `knowledge.mentions`.

- The evidence review no longer fails on a proposal the reviewer keeps. `knowledgeReviewPrompt` wrote the decoded extraction with `JSON.stringify`, so an absent `existing` identity or `validFrom`/`validTo` date reached the reviewer as Effect's `Option` object, and a reviewer that copied it back returned JSON the output schema refuses: the memory job failed with `Invalid` or the document graph was omitted. The proposal is now the output schema's wire form, encoded by `KnowledgeExtraction` (an absent value is `null`), so returning it unchanged decodes to the same extraction. Extraction version 6 moves the engine ids to `memory:6/…` and `rag:6/…`; `retry` requeues a failed version 5 job under the new id through `KnowledgeIndex.requeue`.

- A host chooses when knowledge extraction is reviewed: the memory and document engines' `review` option is a `KnowledgeReviewPolicy`, `"always"` (the default, as `true` was), `"off"` (as `false` was) or `"on-failure"`, which stages the unreviewed extraction and reviews each window's extraction only when staging refuses it as a whole with `Invalid` (a repeated entity key, no record that survives its checks, a document extraction that proposes personal memories). A record dropped on its own with a `RecordDropped` note starts no review; a review reply that does not decode fails with diagnostic stage `review`. `true` and `false` still decode from plugin options, but a typed `MemoryConfig` or `RagConfig` built in TypeScript (for `MemoryLive` or `RagLive`) now needs `"always"` or `"off"` instead of a boolean. `extractKnowledge` takes the policy and a `stage` function, and returns what `stage` returns. No prompt or output schema change, so the extraction version stays 8.

- Extracted spans whose quote differs from the source only in typography are anchored instead of dropped. When a span's quote is nowhere in the source exactly, staging (and each window of a split source) compares it again with curly and straight quotes and apostrophes, primes, hyphens, dashes and the minus sign, and no-break, narrow no-break and figure spaces folded to their plain forms, one UTF-16 unit to one so offsets stay the source's. The nearest such occurrence to the proposed offset wins, and the span takes the source's exact text there as its quote, so staging's checks and the stored provenance carry the source's text. Exact matching still comes first, and a quote that matches neither way is still dropped with its `RecordDropped` note. No prompt or output schema changes, so the extraction version stays the same.

- An extraction whose records supersede nothing no longer fails for giving them no supersession. The output schema required `supersession` on every extracted memory and relation, so a reply with `"supersession": null` beside an empty `supersedes`, or without the key, failed to decode: the memory job failed with `Invalid` or the document graph was omitted. `KnowledgeExtractedMemory.supersession` and `KnowledgeExtractedAssertion.supersession` are now optional and nullable, and the output schema says they are required only when `supersedes` is non-empty. `stageKnowledgeExtraction` reads a supersession only from a record that supersedes others, and drops a record that supersedes others without one with a `RecordDropped` note, staging the rest. Extraction version 7 moves the engine ids to `memory:7/…` and `rag:7/…`; `retry` requeues a failed version 6 job under the new id through `KnowledgeIndex.requeue`.

- A plan, goal or interest tied to a dated event is past once the event has passed. The extraction prompt (version 5, engine ids `memory:5/…` and `rag:5/…`) asks for `eventAt` on a memory that concerns a dated event, resolved against the source occurrence time; `KnowledgeExtractedMemory.eventAt` is optional and nullable, staging keeps it as `KnowledgeMemory.eventAt` (`KnowledgeEventTime`, written only when given, so older memories decode unchanged) and drops a memory whose event ends before it starts with a `RecordDropped` note. A goal, decision, action or preference whose event has ended is past (`knowledgeMemoryIsPast`); facts, routines and profiles never are. Memory recall marks it `past: true` and, under `KnowledgeRecall.temporal: "current"` (the default; `"all"` does not), multiplies its score by `MemoryConfig.pastEventWeight` (default 0.5) after the support factor; `LongTermMemory.profile` leaves it out, nothing deletes it, and `renderMemoryRecall` labels a memory `(event on YYYY-MM-DD)` or `(event on YYYY-MM-DD, past)` (section version 5). `recall_memory` gains a `temporal` parameter. A restatement must share the event time of the memory it restates. `knowledgeStoreConformance` gains `knowledge.event-time` and `longTermMemoryConformance` gains `past-event`.

- Order the memory profile by support and recency instead of the store's order. `LongTermMemory.profile` returns `KnowledgeProfileMemory` (a `KnowledgeMemory` with an optional `support`), each current preference or profile memory counted from the revisions it mentions in one `sourceInfo` read, sorted by the new `knowledgeProfileOrder`: more episodes first, then said more recently, then by id. The `memory.recalled` section (version 6) and `memoryRecallNote` keep that order, label each profile record with its count, and cut at four only after the run's narrowing; a record shown without a restatement outside the reach shows no count. `supportWeight: 0` reads nothing and orders the profile by id. `longTermMemoryConformance` gains `profile-order`.

- Recalled memory shows the model when each record was said: `renderMemoryRecall` takes the recall's `sources` and labels a memory with its UTC date, kind and whether it was stated or inferred, a passage with its date, and a relation with its date and validity, under one reading rule; `now` adds today's date and marks ended relations. The `memory.recalled` section (version 2), `memoryRecallNote` and `recall_memory` render this way by default (`MemoryConfig.recallDates: true`); `recallToday` (default `false`) adds today's date. Without sources or with `dates: false` the text is unchanged. Core adds `knowledgeRecordDate`, the occurrence time of the revision a record's first span cites.

- Memory recall shows near-duplicate memories as one, and semantic search takes an optional similarity floor. After the support and event weights, a memory of the same kind and event time as a kept memory ranked above it, whose embedding cosine with it is at least `MemoryConfig.recallCollapseSimilarity` (default 0.95; `false` turns it off), is folded into it: it frees its place and budget, and the kept candidate names it in `KnowledgeCandidate.alike` and carries its spans and mentions, so its support counts both and both sources are cited. Passages never fold and nothing changes in the store; the `memory.recalled` section is version 7, and shows a profile record recall folded once, with the profile's count. `KnowledgeSearch.minSimilarity` leaves semantic candidates below a cosine floor out before the limit, and keeps every one at or above it (0 and below included), in the in-memory and PostgreSQL stores; `MemoryConfig.recallMinSimilarity` and `RagConfig.minSimilarity` pass one and are absent by default. `knowledgeStoreConformance` gains `knowledge.similarity-floor`.

- A record that replaces another now links it, and memory recall shows the earlier state it replaced within a labelled share of its budget. `KnowledgeMemory.replaces` and `KnowledgeAssertion.replaces` (`{ id, supersession }`) are written on the successor at staging, never on the retired record: a memory links the memories it supersedes with the extracted memory's new `supersession` (`change` or `correction`, extraction prompt version 3), a relation's change links its history copy and a correction the retired relation; older records decode with none. `KnowledgeRecall.history` (`"changes"` by default, `"all"`, `"none"`) and `historyShare` (default 0.2) select earlier states one hop back from the recalled records, in three deterministic passes (`budgetKnowledgeRecall`), into `KnowledgeRecallResult.history`. `renderMemoryRecall` shows them under "Earlier states, no longer current:" as `previously: … (until YYYY-MM-DD; replaced by …)` or `(corrected YYYY-MM-DD; this was wrong)`; `MemoryConfig.recallHistory` and `recallHistoryShare` set them for the `memory.recalled` section (version 3), `memoryRecallNote` and `recall_memory`, which gains a `history` parameter. `knowledgeStoreConformance` gains `knowledge.supersession-links`. Document retrieval returns no earlier states.

- A statement repeated in another source adds evidence to the memory it restates instead of a new memory. The extraction prompt (version 4, engine ids `memory:4/…` and `rag:4/…`) lets an extracted memory name the active candidate it restates (`KnowledgeExtractedMemory.restates`), and staging turns it into a `KnowledgeCorroboration` in the stage's new optional `corroborations`. After embedding, `mergeKnowledgeRestatements` treats a new stated memory with the kind and exactly the entities of an active one from another source, and an embedding at least `MemoryConfig.restatementSimilarity` alike (default 0.92, `false` turns it off), the same way; memories without entities never merge. A memory the same extraction supersedes is never corroborated, and a proposal that restates only such memories is dropped with a `RecordDropped` note, so the stage still publishes. A read narrowed by `sources` or `metadata` admits a memory by its own evidence and leaves out the spans and mentions of later restatements outside the narrowing (`narrowKnowledgeMemory`), so a restatement from another reach neither hides the memory nor shows there. The in-memory and PostgreSQL stores append a corroboration's spans and mention to the memory (`corroborateKnowledgeMemory`), refuse with `Conflict` when it is no longer active, and strip a corroborating source's earlier revision from a memory it did not publish instead of retiring it (`stripKnowledgeRevisions`). `knowledgeStoreConformance` gains `knowledge.corroboration`, `knowledge.corroboration-conflict`, `knowledge.corroboration-revision`, `knowledge.corroboration-reach` and `knowledge.corroboration-superseded`, and `longTermMemoryConformance` gains `restated-source`.

## 0.18.0 — 2026-11-06

### Migration



- A host's own `SessionLog` serves `SessionReadQuery.from: "end"`: the
  newest `limit` matching events, kinds filtered first, still ascending.
  A backend that ignores the key reads from the start and returns the
  oldest matches instead; rerun `sessionLogConformance` (new check
  `read-latest`), and `sessionsConformance` for a host's own `Sessions`.
- `@xandreed/evals`: a host's own `EvaluationServices` (not
  `EvaluationServicesLive`) adds `spend(budget)`, the run's spend ledger in
  the run's scope; a caller of `TrialExecution.execute` other than the
  runner provides a `ModelSpend`.
- A host that calls `KnowledgeIndex.claim` passes `engine`, the id its jobs
  were enqueued under. A host's own `KnowledgeIndex` claims only jobs of
  that engine; rerun `knowledgeStoreConformance` (new check
  `knowledge.engine-isolation`).
- Jobs that `plugin-rag` or `plugin-memory` queued under `rag:1` or
  `memory:1` and never completed (queued, failed, or processing under an
  expired lease) are no longer discovered or claimed, and `retry` keeps a
  job's engine id. Ingest or capture each such source again as its next
  revision (`expectedRevision: Option.some(<current revision>)`) under a new
  job id: the engine records it under its current id, and the new revision
  cancels the old job. Published knowledge is unaffected.
- `@xandreed/plugin-rag` and `@xandreed/plugin-memory`: `queryPlanning`
  and `rerank` default to `false` (`ragDefaults`, `memoryDefaults`). Both
  defaulted to `true`, so whenever a `UtilityLlm` was present every search
  and recall, automatic turn context included, spent two helper-model calls
  (a query plan before searching and a rerank of the fused evidence) that
  the host had never asked for, adding their cost and latency to each
  request. A search now runs lexical and vector retrieval, fusion and graph
  expansion with no helper call unless the host opts in; with either option
  on, it behaves exactly as before. A host that relies on planning or
  reranking sets `queryPlanning: true` and `rerank: true` in the plugin's
  options (or in `RagLive`/`MemoryLive` config). Extraction, review and
  graph options are unchanged.
- `@xandreed/core`: a host's own `KnowledgeIndex` (a `MemoryStore` or
  `KnowledgeStore` other than the in-memory and PostgreSQL ones) adds
  `sourceInfo(scope, refs)`, the batched read `knowledge.source-info`
  checks; a host's own `Knowledge` or `LongTermMemory` returns `sources` in
  each `KnowledgeRecallResult` it builds (`[]` when it cites nothing).
- A host's own `KnowledgeIndex` (a `MemoryStore` or `KnowledgeStore` other
  than the in-memory and PostgreSQL ones) takes a `KnowledgeJobFailure` in
  `fail(lease, failure)` and keeps its `reason`, `message` and `step` on the
  job's `Failed` phase; rerun `knowledgeStoreConformance` (new check
  `knowledge.failure-reason`). A caller of `fail` passes
  `{ reason, message, step }` instead of the message. A host that decided
  whether to retry a failed job by matching its message calls
  `isRetryableKnowledgeFailure(job.phase)` instead.
- A host's own `KnowledgeIndex` (a `MemoryStore` or `KnowledgeStore` other
  than the in-memory and PostgreSQL ones) adds `failed(query)` and
  `requeue({ scope, jobId, engine })`; rerun `knowledgeStoreConformance`
  (new checks `knowledge.failed-listing` and `knowledge.requeue`). A host's
  own `Knowledge` or `LongTermMemory` makes `retry` requeue the job under
  its engine id with the attempts reset (`requeue`). A host that kept every
  job id to find failures later can page through `failed` instead, and a
  failed job recorded under an engine's earlier id (`rag:1`, `memory:1` or
  an earlier embedding space) is retried with the service's `retry` rather
  than ingested again as a new revision. The PostgreSQL store creates the
  partial index `jobs_failed` on open when it is missing; its layout stays
  1, so an earlier release still opens the database. Creating the index
  blocks writes to the jobs table while it builds, once: on a large table,
  create it beforehand with `CREATE INDEX CONCURRENTLY IF NOT EXISTS
  jobs_failed ON efferent_knowledge.jobs (domain, namespace, ordinal) WHERE
  phase = 'Failed'`.



### Added

- `@xandreed/core`, `@xandreed/plugin-sessions`,
  `@xandreed/plugin-session-files`, `@xandreed/plugin-session-sqlite`: a
  session read can count its limit from the end. `SessionReadQuery` read
  only ascending from `after`, so a host that needed the newest record of a
  few kinds (the last turn's ending, the latest checkpoint or setting) read
  the whole session and kept its last match, a cost that grew with every
  turn. `SessionReadQuery.from: "end"` (and `from` on `Sessions.read`'s
  query) returns the newest `limit` events of the given kinds, at most
  `through` and after `after`, still in ascending order; without a limit,
  every match. The in-memory log and the media-store decorator serve it,
  the file log opens its commits newest first and stops once it holds the
  limit, and the SQLite log walks its sequence and kind indexes backwards.
  `sessionLogConformance` and `sessionsConformance` gain the `read-latest`
  check (the newest matches of the kinds, the ceiling, the kinds filtered
  before the limit, every match without a limit). Omitting `from` (or
  `from: "start"`) reads as before; nothing stored changes, and the stored
  format is unchanged.
- `@xandreed/core`: stored tool lifecycle and conversation message records
  decode with typed schemas. `StoredData` adds `tool.started`,
  `tool.completed`, `tool.refused` and `memory.message`, with their stored
  shapes exported as `ToolStartedData`, `ToolCompletedData` (without the
  call's input and result), `ToolRefusedData` (without the input) and
  `MemoryMessageData`, so `readStored` types them. A host that projects a
  journal one record at a time no longer needs the whole history or a copy
  of these shapes: `storedRecordOf(event)` decodes a record by its own kind
  into a `StoredRecord` told apart by `kind` (none for a kind outside
  `StoredData`), and `decodeStored(kind, event)` decodes one record as a
  given kind. A record of a typed kind that does not decode fails with its
  `SchemaError`. `journalSchemaOf` returns these same schemas, so the stored
  format is unchanged (still 18) and every older journal decodes as before.
- `@xandreed/plugin-models/testing`, a new entry: `scriptedChatCompletions`,
  an OpenAI-compatible chat-completions endpoint that answers from a script
  in the process, so a test or an evaluation runs the production compat
  client, alone or under the models plugin as its `ModelsTransport`, with
  no key and no network. Each request takes the first available step, in
  order, whose optional `when` accepts it (a `repeat` step keeps
  answering). A streamed request gets the reply as `data:` chunks, one per
  read: the text and each tool call's arguments split into fragments
  (`chunkSize` characters, or fragments given as they are sent), the call
  named in its first chunk, the usage on the final chunk, then `[DONE]`; a
  settled request gets the whole reply in one body. A reply without
  `usage` reports none, so it reads as unknown, never zero. A step's
  `beforeChunk` paces or holds its stream. A request no step answers is
  refused with HTTP 400 and an OpenAI error naming it and the steps left,
  which the client fails on at once without retrying. `requests` lists
  every request with the step that answered it and `remaining` the steps
  not yet used. `ScriptedReply` decodes a script kept as JSON.
- `@xandreed/plugin-render`: a render feed can start a cold client from a
  snapshot and read only the kinds its projection uses. `RenderFeed.frames`
  takes an options object after the projection, `{ live, kinds, snapshot }`.
  With `snapshot: { head, fold }`, a client at cursor 0, or past `head`,
  gets one `FeedRecord` with sequence `head` carrying `fold` of the records
  up to `head` (a `SnapshotFold<R>`, which may require services like the
  projection), then the records after `head`, instead of a replay of the
  whole journal; a client at a cursor in `1..head` resumes as before, and
  one that reconnects with the snapshot's sequence resumes after it. A
  head that is no journal sequence fails the feed with `invalid`. With
  `kinds`, the tail reads only those kinds: `JournalTail.read` takes an
  optional third argument, `kinds`, which `SessionsJournalTailLive` passes
  to `Sessions.read`, so records the client would never see (prompts, tool
  input, images) are not loaded; the feed also drops other kinds a tail
  returns and still moves the cursor past them. A call without `kinds`
  reads its tail with the feed and cursor alone, as before.
  `foldEqualsReplay({ records, kinds, project, fold, initial, apply })`
  checks a fold against its projection at 0 and every sequence of a sample
  journal: a client starting from the snapshot, fresh or holding a later
  state, must hold the state of one that applied every projected record.
  `renderFeedConformance` gains four checks (the snapshot then the tail, no
  snapshot for a cursor up to the head, the kinds filter, the cursor moving
  past other kinds), its services check covers the fold, and
  `makeMemoryJournal`'s tails read only the kinds asked for. New types:
  `FeedFramesOptions`, `FeedSnapshot`, `SnapshotFold`, `FoldReplaySubject`.
- A session's live channel: its transient events reach every follower of
  the session, not only the call that runs the turn. `assistant.delta` and
  `tool.progress` existed only on the turn's own bus, and `Sessions.changes`
  signals commits only, so a feed opened by another request (a second tab,
  a reconnecting client, the request that did not start a turn run in the
  background) saw a reply only once the journal had it, and each host built
  its own per-session hub. `@xandreed/core` adds the `SessionChannel` port
  (`@xandreed/core/SessionChannel`: `publish(address, payload)` and
  `subscribe(address)`, `SessionChannelPayload`, `SessionChannelError`),
  `shareTransient(address, options?)`, an opt-in turn subscription that
  publishes the chosen transient events (`TransientTurnEventName`; all by
  default) through a queue of its own, so it never fails or holds the turn
  (a full queue drops its oldest payload; a publish that fails or takes
  longer than `publishTimeoutMs` is logged and dropped), and
  `sessionChannelConformance` (`@xandreed/core/conformance`: order,
  isolation by id and owner, no replay, a bounded backlog, release).
  `@xandreed/plugin-sessions` adds `SessionChannelMemoryLive` and
  `makeMemorySessionChannel`, one process's channel (a sliding hub of
  `capacity` payloads, 256 by default, per followed session, released with
  its last follower), and `@xandreed/plugin-render` adds `sessionLive(feed)`,
  a session's channel as the `live` stream of `RenderFeed.frames` (passed
  in its options: `frames(scope, after, project, { live })`). Nothing
  is stored: the journal, the stored format and the event reference are
  unchanged, and a client that reconnects reads only journaled records.
- `@xandreed/core`, `@xandreed/plugin-models`, `@xandreed/sdk`: model
  spend caps. Nothing reserved or capped what model calls could cost: a host
  could only read the cost of a turn after it had been spent. Core's new
  `ModelSpend` port is a ledger that reserves a send's worst case
  (`reserve`, refused with `ModelSpendExceeded` past a turn's or the
  ledger's cap, atomically; callers run it uninterruptibly), settles it at
  what the send cost (`settle`) or releases it (`release`), reads a turn's or
  the whole ledger's `totals`, and drops what it keeps for an ended turn
  (`forget`, which the turn calls as its scope closes, so a ledger kept for
  a process does not grow with every turn); `ModelSpendMemoryLive` is the in-memory ledger and
  `modelSpendConformance` (`@xandreed/core/conformance`) the contract. The
  models plugin's new `spend` option (`ModelSpendOptions`: `prices` keyed
  by `"<provider>:<modelId>"`, `turnCap`, `totalCap`,
  `uncappedOutputTokens`, `inputBytesPerToken`) guards every physical send,
  retries, fallbacks and helper calls included, with the `ModelSpend` the
  host passes in `AgentConfig.services`: a send reserves its worst case from
  its body's size and output cap, and its attempt settles at `costOf` of its
  reported usage when its `model.called` fact is recorded; without usage, a
  request that went out (a timeout, a connection lost after the send, a
  gateway's timeout status, a stream cut before its usage) settles at its
  worst case, and one refused with an error status or never sent releases
  it. A refused send is
  never sent and fails the turn with a `HarnessError` of the new code
  `model.spend` (its cause found by `modelSpendExceededOf`; the tag
  `ModelSpendExceeded` stands for the same code), and a model the prices
  leave out with `model.unpriced`. `TurnResult.spend` reports the turn's
  settled and reserved spend whenever a ledger is among the turn's services,
  and the turn sets `CurrentTurnRunId` for every call it makes, helper calls
  included. Without the `spend` option nothing changes.
- `@xandreed/plugin-models`: a compat model the host builds itself
  settles each send's spend. A host that builds the OpenAI-compatible model
  with `makeCompatLanguageModel` (`@xandreed/plugin-models/compat`) instead
  of having the models plugin route its calls had no spend guard:
  `beforeRequest` could reserve before each send, but nothing could settle
  a send at its exact cost, since `aroundRequest` wraps the whole logical
  call and sees a streamed body before its usage. `CompatConfig.spend` (a
  `ModelSpendGuard`, exported from the same entry: a `ModelSpend` ledger and
  decoded `ModelSpendOptions`, priced by `"<moduleName>:<model>"`) guards
  every physical send of that model exactly as the plugin's `spend` option
  guards a routed one: after `beforeRequest`, each send, every retry
  included, reserves its worst case for the turn (`CurrentTurnRunId`), and
  its attempt settles at `costOf` of its reported usage (a streamed call's
  once its final chunk is read), at the hold or nothing without usage; a
  send past a cap or unpriced is never sent, and the call dies with the
  `HarnessError` (`model.spend`, `model.unpriced`), which the turn fails
  with, typed. `TurnResult.spend` reports the turn's spend when the same
  ledger is among the turn's services. The guard is the model's own: the
  plugin's `spend` option guards only the calls the plugin routes, and the
  plugin's built services no longer carry its guard, so a host model
  composed beside the plugin by `stackPlugins` (which keeps every service a
  plugin builds) is no longer reserved in the plugin's ledger at its prices
  (`model.unpriced` for a key they lack) or held to its caps; a host model
  without `spend` is not guarded. `Agent.define`, which keeps only a
  plugin's declared services, behaves as before.
- `@xandreed/evals`, `@xandreed/evals-cli`: an evaluation run's spend
  budget. Nothing capped what a run's trials could spend on models, and
  reports recorded no spend. `efferent-eval run` and `calibrate` take
  `--budget-usd <amount>` (`EvaluationSelection.spendBudget`; a value that
  is not a positive finite number is `invalid`). A run opens one
  `ModelSpend` ledger (`EvaluationServices.spend`, in memory in
  `EvaluationServicesLive`) and gives each trial its own account in it,
  which `RunnableExecution.execute` reads as `ModelSpend` and passes to the
  agents it defines (the models plugin's `spend` guard). Every reservation's
  total cap is at most the budget, shared by concurrent trials. Once a send
  is refused under it, or what was settled reaches it, the run starts no
  more trials: finished trials keep their results, and the trial whose send
  was refused and those never started are `skipped` with a reason starting
  `budget:`, never in `failures`, never graded and never a zero (a gate over
  them does not pass). The report records `Trial.spend` (`{ settled }`) for
  a trial that reserved anything and `EvaluationRun.spend` (`{ budget,
  settled }`) when the run had a budget or a trial reserved; both keys are
  optional, so earlier reports decode unchanged and a run that metered
  nothing writes the same report as before. The run's summary prints
  `skipped` and `spend` when it recorded spend. `positiveAmount` reads such
  a flag. `@xandreed/evals` now depends on `@xandreed/core`, for the ledger
  alone.
- `@xandreed/core`: `knowledgeEngineId(processor, space)`, the engine id of
  a processor and the embedding space it indexes with
  (`<processor>/<model>/<version>/<dimensions>`, a `/` or `%` in a part
  escaped); distinct spaces always give distinct ids.
- `@xandreed/core`: `knowledgeStoreConformance` checks
  `knowledge.engine-isolation`: two engines in one collection neither
  discover nor claim each other's jobs, a claim by job id included.
- `@xandreed/core`, `@xandreed/plugin-rag`, `@xandreed/plugin-memory`:
  knowledge extraction is bounded per call. The engines sent a whole source
  (up to `maxSourceChars`, 200,000 characters on the document engine) to one
  helper completion, and the review resent it. Both engines now take
  `maxExtractionChars` (48,000 by default, so a default memory source is
  still one call): `extractKnowledge` splits a longer source into windows at
  paragraph, line or word boundaries (`knowledgeExtractionWindows`), extracts
  and reviews each window in its own calls, one after another, and merges the
  results before staging, with every span repaired within its window and
  moved to its exact offset in the whole source; an entity repeated across
  windows under one key and agreeing identity becomes one entity, any other
  repeated key is renamed (`key~2`). `knowledgeExtractionPrompt` takes an
  optional `window` (`KnowledgeExtractionWindow`); over a window of a source
  in several parts its prompt frames that part and says which part it is. A
  source that fits one window makes exactly the calls and prompts it made
  before.
- `@xandreed/core`, `@xandreed/plugin-rag`, `@xandreed/plugin-memory`:
  `CurrentKnowledgeHelperCall`, a context reference the knowledge engines set
  around every `UtilityLlm.complete` they make (`KnowledgeHelperCall`: the
  purpose, `extract`, `review`, `plan` or `rerank`; the scope; the job and
  its attempt for extraction and review; and an output cap). A host's
  `UtilityLlm` adapter reads it to budget, attribute or refuse a call; the
  port's signature is unchanged and the reference is `Option.none()` for
  other helper calls. Both engines take an optional `maxHelperOutputTokens`,
  carried in that cap. The cap is advisory: it reaches only a `UtilityLlm`
  that reads the reference, and the models plugin's `UtilityLlmLive` does
  not apply it.
- `@xandreed/core`, `@xandreed/plugin-rag`, `@xandreed/plugin-memory`,
  `@xandreed/plugin-knowledge-postgres`: a host narrows retrieval per turn
  without replacing the tools. Retrieval read the run's session owner and
  the engine's one collection, and had no way to read only some sources, so
  a host keeping one owner's sources apart (each conversation's own
  attachments, say) turned the capabilities' tools and recall off and wrote
  its own. `KnowledgeSearch` and `KnowledgeRecall` take an optional
  `sources` filter (`KnowledgeSourceFilter`, source ids, at most 1000): a
  record is kept only when every span of its provenance cites a listed
  source, a graph entity keeps only its spans in them, a relation needs
  every span listed and both entities kept, and an empty list reads
  nothing. The in-memory store, the PostgreSQL store (in SQL) and both
  engines honour it; `narrowKnowledgeGraph` and `citesKnowledgeSources`
  state the rule. `KnowledgeNarrowing`, a reference a host provides among
  the agent's or a turn's services, returns the run's `KnowledgeReach`: the
  owner and, optionally, the sources that `search_knowledge`,
  `read_knowledge`, `recall_memory`, `read_memory` and both recall sections
  use (a read outside them is not found). It scopes reads only: saving and
  forgetting a memory stay on the session owner's memory, and
  `forget_memory` answers a source outside the listed ones as not found. Its default is the session owner's whole collection, so
  nothing changes for a host that provides none: tool and section text,
  versions and stored formats are unchanged. `knowledgeStoreConformance`
  gains `knowledge.source-filter`, and `knowledgeConformance` and
  `longTermMemoryConformance` gain `source-filter`.
- `@xandreed/core`, `@xandreed/plugin-rag`, `@xandreed/plugin-memory`,
  `@xandreed/plugin-knowledge-postgres`: a knowledge result names the
  sources it cites. `retrieve` and `recall` returned each citation as a
  source id, revision and character range only, so a host showing a title,
  link or date beside a hit read every source in full, one call per hit,
  though the store already held the metadata it was ingested with.
  `KnowledgeRecallResult` gains `sources`: a `KnowledgeSourceInfo` (`ref`,
  `occurredAt`, `recordedAt`, `metadata`, no text) per cited revision, once
  each, in order of first citation (candidates, relations, entities); a
  result encoded without it decodes with none. Both engines read them in one
  call to the new `KnowledgeIndex.sourceInfo(scope, refs)`, which the
  in-memory store and the PostgreSQL store (one query) implement and which
  leaves out absent and forgotten revisions; `citedKnowledgeSources` lists a
  result's cited references, and `budgetKnowledgeRecall` keeps only the
  info of revisions still cited. `knowledgeStoreConformance` gains
  `knowledge.source-info`, and `knowledgeConformance` and
  `longTermMemoryConformance` gain `cited-sources`.
- `@xandreed/plugin-rag`, `@xandreed/plugin-memory`: the text the knowledge
  tools give the model is exported, so a host's own tools render evidence
  the same way: `knowledgeEvidenceText` and `knowledgeSourcePage` (what
  `search_knowledge`, the `knowledge.evidence` section and `read_knowledge`
  show) and `renderMemoryRecall` and `memorySourcePage` (what
  `recall_memory`, the `memory.recalled` section and `read_memory` show).
  The evidence formatters take only a result's candidates and graph. Tool
  and section text, versions and stored formats are unchanged.
- `@xandreed/plugin-telemetry`: `OtlpTelemetryOptions` takes `spans`, an
  `OtlpSpanPolicy` that decides what the traces export sends, so a host
  with an export policy (an attribute allow-list, metadata-only traces for
  sensitive work) can use the OTLP layers. `keep(span)` drops a span: it is
  never sent, and its children are sent under its nearest kept ancestor.
  `attribute(span, key, value)` returns the value a span or span-event
  attribute is sent with, or `Option.none()` to leave it out; it runs as
  the attribute is set, so a value it leaves out never reaches the
  exporter. A hook that throws drops what it was asked about.
  `OtlpTelemetryFromEnv` and `OtlpTelemetryHttpFromEnv` apply
  `defaults.spans`. Without `spans`, the export is unchanged. A host that
  already runs its own OpenTelemetry provider bridges Effect's tracer into
  it instead and leaves these layers out.
- `@xandreed/plugin-memory-window`: `currentTurnFirst` (off by default)
  keeps the current turn's tool results whole under budget pressure. The
  window compacts earlier turns and drops the oldest ones for a ledger
  first, and spills the current turn's largest results only when the
  current turn alone does not fit (the fewest spills, then the fewest
  dropped turns); it fails with `context.budget` only when nothing fits.
  Without it, a turn that reads a large result and keeps using it over
  several steps saw that result spilled at the next step while older turns
  stayed, and spent steps reading it back with `recall_context`; a host
  had to wrap the policy to change the order. The strategy keeps its id
  `window`, so compactions recorded under either order keep applying, and
  its version becomes `2+current-turn-first`, which every request's
  `strategyVersion` and `context.built` carry. The default order, its
  version `2` and the stored format are unchanged.
- `@xandreed/plugin-memory`: a host screens each committed turn before
  conversation capture stores it. `MemoryCaptureAdmission`, a reference
  provided among the agent's or a turn's services (or around a host's own
  `MemoryCapture.sync` and `backfill`), is asked once per closed turn every
  sync reaches (the committed-turn observer's, the `memory.recalled`
  section's catch-up, `sync` and `backfill`) with a `MemoryCaptureTurn`: the
  session address, run id, turn number, the evidence text capture would
  store and the committed entries it comes from. It answers a
  `MemoryCaptureDecision`: `Admit`, optionally with replacement text stored
  in the evidence's place under the same source identities, or `Refuse`,
  which enqueues nothing while the checkpoint still moves past the turn, so
  no later sync reads it again. `MemorySyncResult.refused` lists the turns
  refused in a sync and `backfill` counts them. A failing hook, or a
  decision that does not decode (`Invalid`), fails the sync before that
  turn's checkpoint. Before, a host could only screen turns by wrapping
  `Sessions`, and a view that hid a turn also hid its closing record, so the
  checkpoint could never pass it. The default admits every turn as is:
  captured text, source identities and the checkpoint format are unchanged.
- `@xandreed/core`: a failed knowledge job records why it failed. Its
  `Failed` phase is a `KnowledgeJobFailure`: the `KnowledgeError` reason
  and message, and the `step` that failed (`KnowledgeFailureStep`: `Graph`
  for the optional graph extraction, `Required` for anything else), so a
  host reads `status` and no longer classifies a failure by its message
  text. `isRetryableKnowledgeFailure` is the one rule the RAG and memory
  engines retry a failed attempt by within `maxAttempts`, exported for hosts
  deciding whether to call `retry`: a failed graph step always is, `Invalid`,
  `Tombstoned` and `EmbeddingMismatch` are final, every other reason is
  transient; the engines retry exactly the failures they did before. A job
  stored before this change, its payload holding only a message, decodes
  with reason `Unavailable` at step `Required`. The PostgreSQL store keeps
  the failure in the job's payload; its layout and `phase` column are
  unchanged. `knowledgeStoreConformance` adds `knowledge.failure-reason`.
- `@xandreed/core`: hosts find failed knowledge jobs and start them over for
  the current engine. `KnowledgeIndex.failed(query)` lists failed jobs across
  owners in one namespace, oldest first, narrowed to an `engine`, a
  `collection` and the failure `reasons` when given, one page of at most
  `limit` jobs per call with a `next` cursor (`KnowledgeFailedQuery`,
  `KnowledgeFailedPage`, `KnowledgeJobCursor`), so a host no longer keeps
  every job id to find failures. `KnowledgeIndex.requeue({ scope, jobId,
  engine })` (`KnowledgeRequeue`) puts a failed job back in the queue under
  `engine` with its attempts reset: the engine's automatic retries apply
  again, and a job failed under an older engine id (a changed extraction
  version or embedding space), which that engine never claims and whose
  deterministic job id could not be enqueued again under the new one, is
  taken over by the current engine. The stage is kept under the same engine
  and discarded under another. A job whose source was forgotten is refused
  with `Tombstoned`, checked before its phase since forgetting cancels the
  source's jobs; a superseded source, a job that is not failed and a
  revision another job already holds under `engine` with `Conflict`. `retry` keeps its meaning (engine and attempts kept), the
  engines' bounded retries. The in-memory and PostgreSQL stores implement
  both; the PostgreSQL store reads the listing from the jobs table's phase,
  engine and collection columns over a new partial index `jobs_failed`,
  created on open when missing with the layout left at 1, so an earlier
  release still opens the database. `knowledgeStoreConformance` adds
  `knowledge.failed-listing` and `knowledge.requeue`.
- `@xandreed/core`, `@xandreed/plugin-rag`, `@xandreed/plugin-memory`,
  `@xandreed/plugin-knowledge-postgres`: knowledge search narrows by source
  metadata before its nearest-neighbour limit. A host that marked its
  sources at ingestion (a project, a kind, a visibility) could only filter
  the candidates a search returned, after the store had cut them to its N
  nearest, so a narrow scope lost its matches; or it resolved the marks to
  id lists itself. `KnowledgeSearch`, `KnowledgeRecall` and `KnowledgeReach`
  take an optional `metadata` filter (`KnowledgeMetadataFilter`): top-level
  keys of `KnowledgeSource.metadata`, each with a JSON scalar or a list of
  alternatives (`KnowledgeMetadataValue`), every key required, compared by
  exact value; at most 16 keys and 100 alternatives a key. A record is
  judged by the metadata of the revisions it cites, as for `sources`: a
  chunk by the revision it quotes, a memory or relation only when every
  revision it cites matches, a graph entity with only its matching spans;
  with `sources` too, both must hold. The in-memory store filters before
  ranking, the PostgreSQL store joins each candidate to its cited revision
  inside the lexical and semantic statements, before `ORDER BY` and
  `LIMIT` (by primary key: no layout change), and both engines pass the
  filter to `search` and narrow the graph with `sourceInfo`. Through
  `KnowledgeNarrowing`, the reach's filter reaches `search_knowledge`,
  `recall_memory` and both recall sections; `read_knowledge` and
  `read_memory` answer a revision outside it as not found, and the memory
  section's profile keeps only memories within it. `forget_memory` answers
  every source as not found while the reach has a metadata filter: it
  removes every revision of a source, which a filter on revisions cannot
  vouch for, so a turn isolated by metadata cannot delete outside it (a
  turn that should forget narrows by a source list, which it checks).
  `matchesKnowledgeMetadata`, `admitsKnowledgeSource`,
  `knowledgeNarrowingAdmits`, `citesAdmittedKnowledge` and
  `narrowKnowledgeGraphBy` state the rule. Without a filter nothing changes:
  tool and section text, versions, stored formats and SQL are unchanged.
  `knowledgeStoreConformance` gains `knowledge.metadata-filter`, which a
  store that filters after its limit fails.
- `@xandreed/plugin-memory`: hosts choose where automatic memory recall
  goes. `MemoryConfig.recallSection` is `"turn"` by default: the
  `memory.recalled` turn section, recorded as the turn's context after a
  capture catch-up of the session's committed turns, unchanged.
  `recallSection: "off"` contributes no section and runs no catch-up, for a
  host that wants recall only at the end of each step's request (resent each
  step and never recorded as turn context) or not at all; the tools are
  unchanged. `memoryRecallNote(config)` gives the section's text without the
  section or the catch-up (the same profile records and evidence, reach
  with its source list and metadata filter, character budget and deadline, rendered by `renderMemoryRecall`; none when
  nothing is recalled or recall fails), an effect requiring `RunContext` and
  `LongTermMemory`, which a host returns from its turn policy's `step` with
  `stepContext: "tail"` or from a `ModelRequestHook`. The section's text and
  version are unchanged. Plugin options and a config spread from
  `memoryDefaults` need no change; a `MemoryConfig` written out in full adds
  `recallSection`.

### Changed



- `@xandreed/sdk`: `Agent.define` keeps the type of the services it is given.
  `AgentConfig<S>.services` is a `Context.Context<S>`, which `Agent.define`
  infers and returns as an `Agent<S>`, so a host passes the context it built
  without a cast. Every turn runs with those services, so `agent.turn` no
  longer requires what `use` reads of them: a `use` that reads a host
  service given to `Agent.define` needs no second `Effect.provide`. Services
  that may be absent (an optional spread) make an `Agent` of none, and
  naming `S` without giving `services` does not compile. An `Agent<S>` is
  still an `Agent` and a `TurnRunner` (the new `AgentTurn` type has
  `TurnRunner.turn` as its second signature), so `agentTaskExecutor`,
  `agentInboxRunner` and the process host take it unchanged. Tools and prompt sections still check
  their `requires` by key when a turn opens them (`requires.missing`), since
  what plugins and each turn add is known only then. Nothing changes at run
  time; `AgentConfig` and `Agent` without a type argument are the same types
  as before.
- `@xandreed/plugin-rag` and `@xandreed/plugin-memory`: the services'
  `retry` (`Knowledge.retry`, `LongTermMemory.retry`) starts a failed job
  over under the engine's current id: the attempts reset, so the job gets
  `maxAttempts` again, and a job failed under the engine's earlier
  embedding options or extraction version is taken over instead of waiting
  for a worker of the old configuration. A job requeued for the same engine
  keeps its staged extraction. `retry` now refuses (`Invalid`) a scope
  outside the engine's namespace and collection, as `ingest`, `capture` and
  `process` do.



### Fixed







- `@xandreed/plugin-render`: a render feed follows its `live` stream
  before it folds a snapshot or reads the backlog. It subscribed only when
  the merged stream first pulled the live side, concurrently with the
  snapshot fold, so a payload published while a cold client's snapshot was
  folded (a turn's deltas for a client connecting mid-turn) could be lost
  before the subscription existed, and what waited for the ready frame was
  bounded only by the source's own buffering. The feed now starts `live`
  first, in its own scope, and holds its payloads in a bounded queue until
  the ready frame, so every payload published after `frames` starts
  reaches the client after `ready`, in order. The bound is the new
  `FeedFramesOptions.liveBuffer` (256 by default, an integer from 1 to
  65 536, else the feed fails with `invalid`), before the ready frame and
  after it. At the bound the feed pulls no more from `live` until the
  client takes some, as the lazily merged stream did: a pull-based or
  finite source (`Stream.fromIterable` of previews, a burst to a slow
  client) still loses nothing and waits, and a source that publishes on
  its own drops at its own capacity (a session channel's follower keeps
  the newest), as before. A live stream that fails
  sends the payloads it gave first, then fails the feed. `sessionLive`
  follows the session from the feed's start, its snapshot's fold
  included. `renderFeedConformance` adds the checks "live payloads
  published while a cold client's snapshot is folded follow the ready
  frame, in order" and "a finite live stream longer than liveBuffer
  reaches the client whole, in order": rerun it over a host's own
  `RenderFeed`.
- Releases wait up to about fifteen minutes (was three) for every package to
  appear on the registry before tagging. 0.17.0 and 0.17.1 each refused to tag
  with packages the registry's CDN showed a few minutes later, and needed a
  manual re-run. The check after an ambiguous upload failure stays at three
  minutes.
- `@xandreed/plugin-memory`, `@xandreed/plugin-rag`: the background worker
  scans for pending jobs untraced, so an idle worker records no spans. Each
  scan (every `pollMs`, 2 s by default) exported a root
  `knowledge_store.pending` trace, tens of thousands a day per process, and
  filled tracing quotas with empty traces. Each job a worker claims is traced
  as before.
- `@xandreed/plugin-knowledge-postgres`: the store tells its failures apart
  instead of reading every non-conflict error as an outage. A server without
  pgvector, a role that may not create the extension or the
  `efferent_knowledge` schema, a role missing a privilege on its tables and
  a database whose objects do not fit the layout now fail with
  `KnowledgeError` reason `Invalid` and a message naming the cause and the
  fix (never the connection string or a value), so a host stops retrying a
  setup problem. Migration first probes the catalogs for pgvector and refuses
  before `CREATE EXTENSION` when the server lacks it. Connection failures,
  statement and lock deadlines and every other error stay `Unavailable` with
  the same message; concurrent writes stay `Conflict`. The classification is
  one mapping by SQLSTATE and the step a statement runs in.
- `@xandreed/plugin-rag`, `@xandreed/plugin-memory`: a knowledge worker
  processes only the jobs of its own embedding space. Each engine recorded
  its jobs under a constant engine id (`rag:1`, `memory:1`) whatever its
  embedding options; discovery (`KnowledgeIndex.pending`) filtered only by
  that id, namespace and collection, and `claim` filtered by no engine at
  all. Two processes configured with different embedding models on one store
  therefore discovered, claimed and embedded each other's jobs in the wrong
  space. Each engine now enqueues, discovers and claims under
  `knowledgeEngineId("rag:1" | "memory:1", space)`, the space being its
  `embeddingModel`, `embeddingVersion` and `embeddingDimensions` (the
  defaults give `rag:1/host/1/1536`).
- `@xandreed/core`, `@xandreed/plugin-knowledge-postgres`: `KnowledgeClaim`
  has a required `engine`. The in-memory index and the PostgreSQL store
  claim only a job recorded under it, with or without `jobId` (the jobs
  table already held the engine; no migration).
- `@xandreed/core`: `knowledgeStoreConformance`'s
  `knowledge.pending-discovery` check passes against a store whose other
  checks share its namespace and collection. Discovery reads across owners
  and the check reads with a limit of one, so another check's job could
  answer it; it now records its jobs under an engine id derived from the
  fixture's whole scope. `KnowledgeIndexFixture` states the fixture
  contract: no two checks share owner, namespace and collection together.
- `@xandreed/evals-cli`: a list flag given more than once selects every
  value. `efferent-eval run --task a --task b` ran only task `a`: each flag
  was read at its first occurrence, so the rest were dropped without a word
  and a run measured less than was asked. `--task`, `--candidate`, `--grader`
  and `--exporter` now merge every occurrence (`--flag value` and
  `--flag=value`) and their comma lists, each value once in first-seen order.
  A single-valued flag of a built-in command (`--config`, `--directory`,
  `--split`, `--repetitions`, `--concurrency`, `--timeout-ms`,
  `--environment`, `--budget-usd`, `--report`, `--from`, `--import`,
  `--baseline`, `--candidate-report`) given twice with different values is a
  usage error (`invalid`) before anything runs, instead of its first value;
  the same value twice still runs. An app's own command receives its
  arguments as given. `cliArguments` adds `list` and `singleValued`.







### Breaking



- `@xandreed/plugin-render`: `RenderFeed.frames` takes `live` in its
  options instead of as the fourth argument: `frames(scope, after,
  project, live)` becomes `frames(scope, after, project, { live })`. A
  host's own `RenderFeed` (not `makeRenderFeed`) takes the options object,
  declares `frames` as `<R, RF>(feed, after, project: FeedProjection<R>,
  options?: FeedFramesOptions<RF>) => Stream<FeedFrame, RenderError, R |
  RF>`, and honours `kinds` and `snapshot` to pass `renderFeedConformance`.
- `@xandreed/core`: `KnowledgeIndex.fail(lease, message)` becomes
  `fail(lease, failure)`, where `failure` is a `KnowledgeJobFailure`
  (`{ reason, message, step }`); a job's `Failed` phase carries the same
  three fields. Migration above.
- `@xandreed/core`: `KnowledgeIndex` adds `failed` and `requeue`. Migration
  above.



### Repository








- `@xandreed/plugin-render`'s test that a compressed SSE frame reaches the
  client while the stream stays open reads each response through a streaming
  Brotli or gzip decoder and waits for the frame's decoded bytes, with a
  stated 3 s deadline that fails naming the encoding and what was decoded so
  far. It decompressed the whole body again on every chunk inside the
  response listener, where a partial chunk could throw, leave the wait
  unsettled and run into the test runner's 5 s timeout. Test change only.

### Changes

- `Agent.define` keeps the type of its `services`: `AgentConfig<S>.services` is a `Context.Context<S>`, inferred, and the agent is an `Agent<S>` whose `turn` does not require what `use` reads of them. A host passes the context it built without a cast; an `Agent<S>` is still a `TurnRunner` (`AgentTurn`). Tools still check their `requires` by key when a turn opens them.

- A compat model the host builds itself reserves and settles each send's spend: `CompatConfig.spend` (`ModelSpendGuard`, exported from `@xandreed/plugin-models/compat`: a `ModelSpend` ledger and decoded `ModelSpendOptions`) guards every physical send of a `makeCompatLanguageModel` model, retries included, as the models plugin's `spend` option guards a routed call: each send reserves its worst case for the turn before it goes out and settles at the cost of its reported usage, buffered or streamed; a send past a cap is never sent and fails with `model.spend`. The guard is the model's own: the plugin's `spend` option guards only the calls the plugin routes, and the plugin no longer leaves its guard among the services it builds, so a host model stacked beside it (`stackPlugins` over the plugin's built services) is never priced or capped by the plugin's guard; a host model without `spend` is not guarded.

- An evaluation run's spend budget: `--budget-usd` on `run` and `calibrate` (`EvaluationSelection.spendBudget`) caps every model send of every trial in one shared `ModelSpend` ledger, stops starting trials once the budget refuses a send or is reached (the rest `skipped`, never failures), and records each trial's and the run's settled spend in the report (`Trial.spend`, `EvaluationRun.spend`).

- Repeated list flags merge: `--task`, `--candidate`, `--grader` and `--exporter` given more than once (or as comma lists) select every value, each once in first-seen order, instead of only the first occurrence. A single-valued flag given twice with different values is a usage error (`invalid`) instead of silently using its first value. `cliArguments` adds `list` and `singleValued`.

- Decode stored tool lifecycle and conversation message records with typed schemas: `StoredData` adds `tool.started`, `tool.completed`, `tool.refused` and `memory.message` (`ToolStartedData`, `ToolCompletedData`, `ToolRefusedData`, `MemoryMessageData`), so `readStored` types them, and `decodeStored(kind, event)` and `storedRecordOf(event)` decode one record at a time.

- Knowledge workers process only the jobs of their own embedding space: `plugin-rag` and `plugin-memory` record, discover and claim jobs under `knowledgeEngineId(processor, space)`, derived from their embedding options, instead of the constant `rag:1` / `memory:1`. `KnowledgeClaim` gains a required `engine`, and the in-memory and PostgreSQL stores claim only jobs recorded under it, by job id too. `knowledgeStoreConformance` adds `knowledge.engine-isolation`, and its `knowledge.pending-discovery` check no longer depends on other checks' jobs in a shared namespace and collection. Jobs queued under the old ids and never completed must be ingested or captured again as the next source revision.

- Knowledge extraction is bounded per call: the memory and document engines take `maxExtractionChars` (48,000 by default) and extract a longer source window by window through core's `extractKnowledge`, merging the windows' results with exact whole-source offsets before staging. Every helper call the engines make runs with `CurrentKnowledgeHelperCall` set to its purpose (`extract`, `review`, `plan`, `rerank`), scope, job and attempt, and the optional, advisory `maxHelperOutputTokens` (applied only by a `UtilityLlm` that reads it, which the models plugin's does not), so a `UtilityLlm` adapter can budget or refuse it.

- Hosts find failed knowledge jobs and start them over for the current engine: `KnowledgeIndex.failed(query)` lists failed jobs across owners in a namespace (optionally by engine, collection and failure reasons), oldest first, with a cursor, and `KnowledgeIndex.requeue({ scope, jobId, engine })` requeues a failed job under `engine` with its attempts reset, keeping its stage only under the same engine. A job whose source was forgotten is refused with `Tombstoned` (checked before its phase, since forgetting cancels the source's jobs), a superseded or unfailed one with `Conflict`. `Knowledge.retry` and `LongTermMemory.retry` requeue under the engine's current id, so attempts reset and a job failed under an older extraction version or embedding space is taken over; they refuse a scope outside the engine's collection. The store's `retry` still keeps engine and attempts for the engines' own bounded retries. The PostgreSQL store creates the partial index `jobs_failed` on open when it is missing and leaves its layout at 1, so an earlier release still opens the database; building the index blocks writes to the jobs table once (on a large table, create it beforehand with `CREATE INDEX CONCURRENTLY`). `knowledgeStoreConformance` adds `knowledge.failed-listing` and `knowledge.requeue`; a host's own `KnowledgeIndex` implements both methods.

- A failed knowledge job records why it failed: `KnowledgeIndex.fail(lease, failure)` takes a `KnowledgeJobFailure` (`reason`, `message` and the `step` that failed, `Graph` or `Required`) instead of a message, and the job's `Failed` phase keeps it, so hosts read the reason from `status` instead of matching message text. `isRetryableKnowledgeFailure` is the rule the RAG and memory engines retry by, exported for hosts deciding whether to `retry`. A job stored with only a message decodes as `Unavailable` at step `Required`; the PostgreSQL store keeps the failure in the job payload with its layout unchanged. `knowledgeStoreConformance` adds `knowledge.failure-reason`; a host's own `KnowledgeIndex` adopts the new `fail`.

- The PostgreSQL knowledge store fails with reason `Invalid`, and a message naming the cause and the fix, when the server lacks pgvector, the role may not create the extension or the `efferent_knowledge` schema, the role lacks a privilege on its tables, or the database's objects do not fit the layout; connection failures and deadlines stay `Unavailable` and concurrent writes `Conflict`.

- `queryPlanning` and `rerank` default to `false` on the RAG and memory engines, so a search or recall makes no helper-model call unless the host opts in; set both to `true` to keep the previous query planning and evidence reranking, which behave as before when enabled.

- Knowledge search and recall take an optional `sources` filter, honoured by every store and engine, and `KnowledgeNarrowing` lets a host set each turn's retrieval owner and sources without replacing the document and memory tools or recall sections.

- Knowledge retrieval and recall results carry `sources`, the times and metadata of every source revision they cite, read in one call to the new `KnowledgeIndex.sourceInfo`; the RAG and memory plugins export the evidence and source-page formatters their tools use. A host's own `KnowledgeIndex` adds `sourceInfo`.

- Knowledge search, recall and a turn's reach take an optional `metadata` filter on the cited source revisions' metadata, applied by every store before its nearest-neighbour limit and honoured by both engines and the document and memory capabilities. While a reach has a metadata filter, `forget_memory` answers every source as not found, since forgetting removes every revision and the filter judges revisions.

- The memory and document workers scan for pending jobs untraced, so an idle worker records no spans; each job it claims is traced as before. Every scan (default every 2 s) used to export a root `knowledge_store.pending` trace, tens of thousands a day per process.

- `MemoryCaptureAdmission` lets a host admit, replace the evidence of, or refuse each committed turn before conversation capture stores it; a refused turn enqueues nothing while the capture checkpoint still moves past it, and `MemorySyncResult.refused` reports it.

- `recallSection: "off"` turns off the memory engine's `memory.recalled` turn section and its capture catch-up, and `memoryRecallNote(config)` gives that section's text for a host to place in its step context (a turn policy's `step` with `stepContext: "tail"`, or a `ModelRequestHook`). The default (`"turn"`) is unchanged.

- Window memory's `currentTurnFirst` option keeps the current turn's tool results whole under budget pressure: earlier turns are compacted and dropped first, and the current turn's results are spilled only when the current turn alone does not fit. The strategy keeps its id and records the order in its version (`2+current-turn-first`); the default order is unchanged.

- Model spend caps: core's `ModelSpend` ledger port (`ModelSpendMemoryLive`, `modelSpendConformance`; the turn forgets itself in the ledger as it ends), the models plugin's `spend` option that reserves each physical send's worst case and settles it at the cost of its reported usage within a per-turn and a total cap (`model.spend`, `model.unpriced`), `TurnResult.spend` and `CurrentTurnRunId`.

- The OTLP export layers take a `spans` policy (`OtlpSpanPolicy`): `keep` drops a span, its children reparented to its nearest kept ancestor, and `attribute` rewrites or leaves out span and span-event attributes before they reach the exporter.

- Optional graph extraction no longer keeps a document out of plain retrieval: a failed or invalid extraction or review is recorded on the job and retried within `maxAttempts`, and the last attempt publishes the source's chunks without the graph, its stage carrying a `GraphOmitted` note (`KnowledgeStage.notes`, `KnowledgeStageNote`). `knowledgeConformance` gains `failed-extraction`, with an optional `failingExtraction` subject, and `knowledgeStoreConformance`'s `stage-retry` requires a stage's notes to survive retry.

- A render feed can start a client at cursor 0 from a snapshot folded at a head sequence and read only the journal kinds its projection uses: `RenderFeed.frames` takes `{ live, kinds, snapshot }` after the projection (`live` moves there from the fourth argument), `JournalTail.read` takes `kinds`, which `SessionsJournalTailLive` passes to `Sessions.read`, and `foldEqualsReplay` checks a fold against its projection.

- A render feed follows its `live` stream before it folds a snapshot or reads the backlog and holds its payloads until the ready frame, so a payload published while a cold client catches up (a turn's deltas for a client connecting mid-turn) reaches it after `ready`, in order. `FeedFramesOptions.liveBuffer` (256 by default) bounds what waits: at the bound the feed pulls no more from `live` until the client takes some, so a pull-based or finite source still loses nothing and a session channel drops at its own capacity, as before; `renderFeedConformance` checks a live payload published during the snapshot's fold and a finite live stream longer than the bound.

- Add the `@xandreed/plugin-models/testing` entry: `scriptedChatCompletions`, a scripted OpenAI-compatible chat-completions endpoint that runs in the process, so tests and evaluations drive the production compat client and the models plugin with no key and no network. It matches requests to steps by order or a predicate, streams text and tool-call arguments in fragments with the usage on the final chunk, records every request, and refuses an unmatched one with an error naming it.

- A session read can take its limit from the end: `SessionReadQuery.from: "end"` (and `Sessions.read`'s `from`) returns the newest `limit` events of the given kinds, at most `through` and after `after`, still in ascending order, so a host that needs a session's latest records of a few kinds no longer reads and folds the whole journal. Every backend serves it (in memory, the media-store decorator, the file log newest commit first, SQLite along its indexes); `sessionLogConformance` and `sessionsConformance` check it (`read-latest`). Omitting `from` reads from the start, as before.

- A session's transient events reach every follower of the session: core's `SessionChannel` port with `shareTransient`, an opt-in turn subscription that publishes `assistant.delta` and `tool.progress` to it without ever holding the turn, and its kit `sessionChannelConformance`; plugin-sessions' in-memory `SessionChannelMemoryLive`; and plugin-render's `sessionLive`, a session's channel as a render feed's `live` stream. Nothing is stored or replayed.

## 0.17.1 — 2026-11-05

### Fixed

- `@xandreed/core`: knowledge extraction re-anchors a quote that occurs more
  than once in the source to its occurrence nearest the proposed offset.
  Only a unique quote could repair wrong offsets, and an ambiguous one
  rejected the whole extraction. Extraction models quote reliably but rarely
  count characters exactly, so any name repeated in a conversation (said by
  the user and echoed in the reply) failed every memory job that cited it.
  A quote that is not in the source is still rejected.

### Changes

- Knowledge extraction re-anchors a quote that occurs more than once in the source to its occurrence nearest the proposed offset, instead of rejecting the whole extraction. Extraction models quote reliably but rarely count characters exactly, so a name repeated in a conversation (said by the user and echoed in the reply) failed every memory job that cited it. A quote that is not in the source is still rejected.

## 0.17.0 — 2026-11-05

### Fixed

- `@xandreed/plugin-rag`: optional graph extraction no longer keeps a
  document out of plain retrieval. With `graph: true`, the engine computed
  the graph before the chunks, so a failed or invalid extraction or review
  failed the job and none of the source's chunks were published; and a
  failure with reason `Invalid` (an invalid model answer) was never retried,
  as if the source itself were invalid. A graph failure is now recorded on
  the job (`fail`, its message) and retried within `maxAttempts` whatever its
  reason; the last attempt stages and publishes the chunks without entities
  or assertions, and its stage carries a `GraphOmitted` note with the
  failure's reason and message. A source that is itself invalid or
  unavailable, a tombstoned source and an embedding mismatch still fail
  unretried. With `graph: false`, a stage is unchanged.
- `@xandreed/plugin-models`: an OpenAI-compatible endpoint's streamed tool
  calls now stream their arguments. The client folded each call's
  `function.arguments` fragments silently and emitted the whole call only
  when the stream ended, so on every compatible endpoint (gateways, local
  servers) `assistant.delta` never published on its `tool-params` channel,
  and a host could neither show a call while it streamed nor act on a
  complete argument prefix. The stream now emits `tool-params-start` once a
  call's wire index names its tool, under the provider's call id (or
  `call-<index>` when the provider sends none; the call itself still gets
  the loop's minted id), a `tool-params-delta` for each non-empty arguments
  fragment, and `tool-params-end` just before the completed `tool-call`,
  as the native providers do. A call's deltas, concatenated, are its
  arguments as sent; the completed call, its params and the cut-reply
  handling are unchanged. As with text, a stream that fails after a call
  has opened no longer falls back to a settled call.
- `@xandreed/plugin-render`: `decodeSse` decodes a block with an `id` as a
  record whatever its event, so a record a projection names `ready` no
  longer reads back as the ready frame.
- `@xandreed/plugin-tool-discovery`: an always-on skill's references are
  listed to the model. Such a skill is activated at every turn's start, so
  `read_skill_reference` served its references, but nothing named them: the
  catalogue listed only the loadable skills, and only a `load_skill` result
  listed references. The catalogue section (`catalogText`) now adds, after
  the loadable skills, `## References of always-on skills (their tools are
  already available; read one with read_skill_reference)` with a line per
  always-on skill that has references (`- <skill>: <id> — <title>; …`). It
  renders even when no skill is loadable, and stays absent when there is
  neither. The section's version is now `"2"` (`SystemPrepared` records
  it); its text, and so its fingerprint, is unchanged for an agent whose
  always-on skills have no references. The `read_skill_reference`
  description now reads "Read one reference document that a loaded skill or
  an always-on skill lists.", which changes the tool schema of every agent
  that registers it.
- `@xandreed/plugin-workspace`: the `workspace.skills.always` section
  (`alwaysSkillsText`) no longer lists an always-on file skill's references,
  which the catalogue now lists; its version follows its text.
- `@xandreed/core`: `defineSkill`, `SkillDefinition` and `docs/framework.md`
  describe always-on skills as the registry treats them: activated at each
  turn's start (source `always`), never loaded with `load_skill`, their
  references served by `read_skill_reference`.

### Added

- `@xandreed/core`: `KnowledgeStage` has an optional `notes`, a list of
  `KnowledgeStageNote` (`GraphOmitted`, with a `KnowledgeErrorReason` and a
  message): what an engine left out of a stage and why. It is written only
  when something was left out, so older stages decode unchanged, and it
  stays on the job through retry and publication.
- `@xandreed/core`: `knowledgeConformance` checks `failed-extraction`: a
  source whose optional graph extraction fails still completes and is found
  by plain retrieval (`graph: false`) at its exact revision. A subject's new
  optional `failingExtraction` opens a service whose extraction always
  fails, and the completed job must then record a `GraphOmitted` note;
  without it, the check runs on `open`. `knowledgeStoreConformance`'s
  `stage-retry` check also requires a stage's notes to survive retry.
- `@xandreed/core`: `stepLoopConformance` checks `tool-params`: a loop that
  publishes deltas publishes a streamed call's argument deltas on the
  `tool-params` channel under the call's id, opening with an empty one,
  and they concatenate to the input its `assistant.message` carries.
- `@xandreed/core`, `@xandreed/plugin-agent-loop`: `assistant.delta` has an
  optional `toolName`. The step loop sets it on the first delta of a
  streamed tool call's `tool-params` part (its start, with an empty
  `delta`), so a subscriber knows which tool the argument text that follows
  belongs to; the stream already named it, and the loop dropped it when it
  published the event. The event now also documents that a `tool-params`
  `id` is the call's `toolCallId`, as `assistant.message.toolCalls`,
  `tool.started` and `step.ended.results` carry it, so a host pairs a call
  it renders while it streams with the `invocationId` of its `tool.*`
  events. The event is transient: no stored format changes. Over
  `@xandreed/process-host`, full-content progress carries the new key too.
- `CompatConfig.extensions` (`@xandreed/plugin-models/compat`): endpoint
  body fields, such as a gateway's routing or retention options or a
  provider's own extensions, sent on every request after the gateway
  extensions, `standardOnly` included. They are request settings, so
  `beforeRequest` and `aroundRequest` see the body that is sent and the
  model's request descriptor and settings fingerprint record them; a host no
  longer rewrites the JSON body in `fetchImpl`, which stays transport only.
  A key naming a field the request is made of (`model`, `messages`,
  `stream`, `stream_options`, `response_format`, `tools`, `tool_choice`)
  fails each call as an invalid request before any send.
- `CompatConfig.maxOutputTokens`: a model's output cap, sent as
  `max_tokens` when the call policy sets none (the call policy's cap wins),
  and with `standardOnly` too. A value that is no positive integer fails each
  call as an invalid request. Without either field the body is unchanged.
- `@xandreed/plugin-render`: a feed can carry live frames the journal never
  stores (a reply as it streams, a preview, a build handshake) on the same
  connection. `RenderFeed.frames` takes an optional `live` stream of
  `FeedPayload`s; each goes out as a `FeedTransient` frame after the ready
  frame, and the feed still ends when its journal side does. Over SSE a
  transient frame is an `event:`/`data:` block with no `id`, so
  `Last-Event-ID` stays at the last record; over a WebSocket it is
  `{"type":"transient","event":…,"data":{…}}`. Transient frames never move
  the resume cursor. A live stream that ends stops only the live frames;
  one that fails, or a payload named `ready` (the feed's own frame), fails
  the feed. `encodeSse`, `decodeSse`, `encodeSocketFrame` and
  `decodeSocketFrame` read and write them, and the transport kit's sample
  includes them.
- `@xandreed/plugin-render`: `payloadOf(schema)(event, value)` encodes a
  host's value with its own schema into a `FeedPayload` (undefined fields
  dropped), so a projection no longer casts its encoded object to
  `JsonObject`; a value with no JSON form or an empty event fails with
  `RenderError` code `invalid`. `FeedProjection<R>` may now require
  services: `RenderFeed.frames` returns a stream that requires the
  projection's `R`, provided where the connection runs it, instead of a
  context captured per connection. `R` defaults to `never`, so existing
  projections and calls are unchanged. `renderFeedConformance` checks that
  a feed runs the projection with the stream's services.
- `@xandreed/plugin-render`: a Server-Sent Events feed ends its response
  when its frames end and can be compressed. `SseTransport.serve` runs the
  peer's `end` once when the frames end, at the feed's `maxDurationMs` or on
  a failed feed, and never after the client left; `renderTransportConformance`
  checks it ("ends the peer when the frames end"). `sseNodePeer` ends the
  Node response there, waiting up to its `timeout` for it to finish. Given
  `{ compress: <the request's Accept-Encoding> }` as a fourth argument, it
  sends Brotli when the client takes it, else gzip, else no coding, with
  `content-encoding` and `vary: accept-encoding`, over one compression
  window for the whole connection, flushed after every write so no frame
  waits for the next; `node:zlib` is loaded only then. Without `compress`
  it sends the same headers and bytes as before. `sseContentEncodingOf`
  (and its `SseContentEncoding`) is that negotiation, for a host's own peer.
- `Sessions.transact` takes an optional idempotency key:
  `transact(address, decide, { key, command })`. The commit that records
  the decision opens with a `transact.keyed` record of the key, its
  `command` (the key's fingerprint, compared as canonical JSON) and how many
  events follow. A later transact under the key, on any instance and beside
  an open turn, calls no `decide` and writes nothing: it fails with
  `TransactDuplicate` (`session.transact-duplicate`), carrying the events the
  first one recorded, or with `TransactConflict`
  (`session.transact-conflict`) when its command differs. Of transacts racing
  under one key exactly one commits; a decision that fails or is refused
  stores no key. Transact keys are apart from the keys turns begin with.
  The two refusals are in the error type only of a call given a key
  (`TransactRefusal`), so existing callers' types are unchanged.
  `sessionsConformance` gains the `transact-key`, `transact-key-conflict`
  and `transact-key-race` checks; a custom `Sessions` (or a wrapper of one)
  passes `options` through to keep them.
- Stored format 18 adds the `transact.keyed` journal kind
  (`TransactKeyedData`: `key`, `command`, `events`), a reserved kind a host
  record cannot use. As with every format, an earlier release refuses to
  write to a session this release has written to (`session.version`), and
  still reads it; sessions stored before read as they were.
- `@xandreed/core`: the object `defineHostEvent` returns gains
  `draft(data)`, an `Effect<TurnDraft, HarnessError>` that encodes the
  payload through the event's schema and JSON (`storedJson`) exactly as
  `make` does and gives the record the turn's writer stores for the
  published event: `name` as its kind, the same data. A host passes it in
  `Sessions.transact`'s decision (or a turn writer's `append` or
  `transact`) without re-encoding or casting, so a record written outside a
  turn is stored byte for byte like the published one and `select` reads
  either back. A payload that does not encode fails with `events.encode`;
  a reserved name is refused by the write with `ReservedKind`. The stored
  format is unchanged.

### Migration

- `@xandreed/core`: a host's own `KnowledgeStore` keeps a stage's `notes`
  with it (a store that saves the encoded `KnowledgeJob` already does) to
  pass `stage-retry`; a host's own `Knowledge` publishes a source's chunks
  when its optional extraction fails, to pass `failed-extraction`.
- `@xandreed/plugin-render`: `FeedFrame` has a fourth member,
  `FeedTransient`. A host that matches every frame exhaustively
  (`Match.valueTags`, `Match.exhaustive`) adds its case; a host's own
  `RenderFeed` honours the new optional `live` argument to pass
  `renderFeedConformance`'s two new checks.
- `@xandreed/plugin-render`: a host's own `RenderFeed` implementation
  (not `makeRenderFeed`) declares `frames` generic over the projection's
  services, `<R>(feed, after, project: FeedProjection<R>) =>
  Stream<FeedFrame, RenderError, R>`, and runs the projection inside that
  stream.
- `@xandreed/plugin-render`: `SsePeer` has a third member, `end`. A host
  that writes its own peer adds it, the effect that ends its response or
  stream (`end: Effect.void` keeps its current behaviour); a host that ended
  the response itself after `SseTransport.serve` may keep doing so, and with
  `sseNodePeer` no longer needs to.

### Repository

- Explain the native memory engine through one source, its extracted memories
  and graph, PostgreSQL records and indexes, rank fusion, graph traversal and
  reranking. Distinguish current weighting and indexing limits, model decisions,
  and automatic profile injection from query-ranked recall.

- Add an executable five-turn memory and filesystem walkthrough with an
  interactive docs playback, recorded model requests and journal changes,
  queued versus learned memory, compaction and a fresh-conversation recall.
- Add individual guides and navigation for every first-party plugin, with
  configuration generated from exported definitions and checked examples.
  Explain how conversation context, persistent memory, files and the session
  journal work together, and publish the expanded documentation site.
- Prepare bot-authored release PRs as previews, then hand their reviewed source
  to a new maintainer-owned PR before squashing, preserving the required author
  identity. Use its PR-event CI and remove redundant branch dispatch permissions.

### Changes

- Tool discovery's catalogue section lists the references of always-on skills, which no `load_skill` result shows, so the model can read them with `read_skill_reference`; the skills directory's always-on section no longer repeats them.

- A streamed tool call's first `assistant.delta` on the `tool-params` channel now carries `toolName`, the tool it calls, and the event documents that a `tool-params` `id` is the call's `toolCallId`.

- `CompatConfig` accepts `extensions`, extra request-body fields an OpenAI-compatible endpoint understands, and `maxOutputTokens`, an output cap for every call; both are part of the model's settings fingerprint.

- Stream OpenAI-compatible tool-call arguments as `tool-params` parts while the reply streams, so `assistant.delta` carries them on the `tool-params` channel.

- `payloadOf(schema)` builds a feed payload from a host's own schema without a cast, and a `FeedProjection<R>` may require services that `RenderFeed.frames` passes on to its stream.

- A host event's `draft(data)` gives the record the turn's writer stores for it, encoded through the event's schema and JSON exactly as `make` is, as a `TurnDraft` that `Sessions.transact` (or a turn writer's `append` or `transact`) takes without a cast, so a record written outside a turn reads back through `select` like one published in a turn.

- A render feed carries live, non-durable frames beside its journal records: `RenderFeed.frames` takes an optional `live` stream, sent as `FeedTransient` frames after the ready frame, with no SSE `id` and no sequence, so they never move the resume cursor.

- `SseTransport` ends its peer through the new `SsePeer.end` when the frames end, and `sseNodePeer` takes `{ compress }`, the request's `Accept-Encoding`, to send the feed in Brotli or gzip with a flush after every write.

- `Sessions.transact(address, decide, { key, command })` is idempotent by an optional key: the commit that records the decision stores the key and its command (`transact.keyed`, stored format 18), and a later transact under the key calls no `decide`, writes nothing and fails with `TransactDuplicate` (the first one's events) or, with another command, `TransactConflict`. Racing retries commit once; transact keys are apart from turn keys. `sessionsConformance` checks a retried key, a conflicting retry and racing retries.

## 0.16.2 — 2026-11-04

### Repository

- Restrict CI to this repository and same-repository PRs, preserving human
  and release-bot checks while skipping fork PRs. Document collaborator-only
  PR creation and external-contributor workflow approval settings.
- Document conditional approval of a reviewed bot PR's blocked workflow;
  a passing branch dispatch does not replace the required PR check.

### Changes

- Publish a coordinated framework patch and its documentation landing package through npm trusted publishing, preserving the verified release source and authentic workflow provenance.

## 0.16.1 — 2026-11-03

### Repository

- Request a shared patch release from the release-PR workflow and audit all
  25 npm packages after publication. Add a trusted-publishing skill covering
  activation, source verification and recovery from partial releases.
- Allow three minutes for registry propagation when confirming uploads,
  including the documentation package, before reporting a missing version.
- Verify the source commit of every existing framework package before
  accepting it during a resumed publication.
- Preserve the signed GitHub workflow identity in npm provenance when
  publishing a historical release checkout. Keep its verified source commit
  in package metadata and retain the source and archive integrity checks.
- Publish the unscoped `efferent` npm name as a documentation landing page
  with the release README, working source links and scoped-package install
  instructions. Keep its README current through the CI release workflow.
- Prepare shared-version release PRs from Changesets in GitHub Actions.
  After a merged release passes CI, publish its exact tested source, confirm
  all npm versions, create the immutable tag and GitHub release, and dispatch
  the docs deployment. Support token bootstrap and npm trusted publishing,
  including clean historical checkouts for the prepared 0.16.0 release.
- Keep plugin versions, compatibility fixtures, version markers, the central
  changelog and generated documentation synchronized when consuming changesets.

### Changes

- Publish a coordinated framework patch and its documentation landing package through npm trusted publishing, preserving the verified release source and authentic workflow provenance.

## 0.16.0 — 2026-11-03

Native memory and document retrieval compose through shared ports and separate
plugins, backed by PostgreSQL, pgvector and a temporal knowledge graph.
This release also keeps evaluation runs larger than one runtime string and
adds a checked publishing workflow for packages and the documentation site.

### Added

- `@xandreed/plugin-memory`: Efferent's native cross-conversation memory,
  evidence-backed facts, preferences, profiles and routine observations,
  temporal relationship extraction, conservative entity resolution and
  correction history. Durable source jobs, reviewed extraction, staged
  embeddings, query planning and evidence reranking run over host-supplied
  models. Recall and source-read tools derive their owner from the turn;
  explicit save/forget tools require `memory.write`.
- `@xandreed/plugin-memory/capture`: owner-checked synchronization and
  bounded backfill of committed conversation evidence, final host replies
  and tool execution outcomes, with replay-safe source identities and
  journal checkpoints. Recalled context and memory/RAG results are excluded.
- `@xandreed/plugin-rag`: source-grounded text/Markdown ingestion, exact
  source spans, revision replacement, lexical/vector fusion, cited reads,
  optional temporal GraphRAG, and bounded model-assisted retrieval. Tools
  and recorded turn evidence compose with existing conversation memory.
- `@xandreed/plugin-knowledge-postgres`: native PostgreSQL/pgvector stores,
  transactional publication, leases and durable processing stages, temporal
  graph traversal, source tombstones and evidence invalidation. Forgetting
  also clears unpublished stages and fences stale extraction writes. Shared
  core schemas, in-memory reference adapters and conformance kits prove
  scope isolation, concurrency, history and recovery behavior.
- Core and SDK: acknowledged-commit observers and multi-provider background
  worker activity/shutdown, preserving the original turn result when an
  optional observer fails. Typed plugin stacks concatenate these contributions.
  Existing framework journal formats are unchanged.
- Native extraction, review, query-planning, reranking, memory and RAG model
  text is versioned and pinned exactly. A controlled evaluation app supports
  cleaned LongMemEval/LoCoMo, graph ablations and evaluation-only reference
  deployments; measured parity requires explicitly configured real model runs.

### Fixed

- An evaluation run whose trials together outgrow the longest string the
  runtime builds (V8's is just under 512 MiB) is kept. `efferent-eval` wrote
  `execution.json` and `report.json` as one `JSON.stringify` string, so such
  a run failed `persistence` (`RangeError: Invalid string length`) at its
  last write, after every trial had run, and kept nothing but the trial
  files. `EvaluationRunStoreFsLive` now writes the same text a trial at a
  time, byte for byte what the one string held, through the same temporary
  file (mode `0600`) renamed into place. `readRun` reads a file larger than
  one string in parts, the run without its trials and then each trial, cut
  at the bounds that layout gives them, so `grade --from`, `compare`,
  `review`, `export` and `inspect --summary` read such a run too; a file
  that fits in one string is read whole, as before, and so is a larger one
  in any other layout. `fingerprint` (evals) hashes an array, and each array
  member of an object, an element at a time, so `executionFingerprint`,
  which grading records as `sourceExecution`, no longer fails on such a run;
  digests of JSON values are unchanged. One trial must still fit in one
  string, and `inspect` without `--summary` still prints the run as one.

### Repository

- `bun run release:publish` publishes a release in one command from a clean
  checkout of its merge commit, in an interactive terminal: it installs
  without lifecycle scripts (an optional dependency of the docs site can fail
  its native build and the install with it), builds, runs the publish dry run
  and the publish, then, once the registry has every package of the build,
  creates the `v<version>` tag on HEAD and pushes it. It refuses a working
  tree with changes, a tag that names another commit, and an existing core
  version without matching release commit metadata. Tag and provenance
  checks run before uploads; built manifests carry `gitHead` for safe resume.
  `--verify` adds `verify:packages`, which CI already runs on the merge
  commit; `--dry-run` stops before the upload.
- `bun run publish:packages --publish` no longer stops on an upload npm
  reports as failed but the registry has, as with E409 "Cannot publish over
  previously staged version" after npm retried a request that went through:
  it asks the registry for that version for up to about a minute, counts it
  as published when it is there, and stops as before when it is not.

- Verify the native knowledge packages on Bun and packed Node, with a
  pinned pgvector PostgreSQL service in CI. Add native memory/RAG setup,
  research rationale and evaluation documentation.

## 0.15.1 — 2026-11-02

A host decides what one bad tool call in a reply costs: with
`limits.invalidCalls: "answer"`, a call to a tool the step does not have, or
with parameters that do not decode, is answered alone and the reply's other
calls run. The tool contracts and skill text the model sees can be
fingerprinted again from the package roots.

### Added

- `LoopLimits.invalidCalls` (`InvalidCallPolicy`, core): what a whole
  reply's call to a tool the step does not have, or with parameters its
  schema does not decode, costs. `corrective`, the default, keeps today's
  behaviour: none of the reply's calls runs and the reply is answered as
  malformed. `answer` answers each such call alone, as its result, and runs
  the reply's other calls, so a host whose replies batch independent calls
  (a render next to a publish) does not lose the good ones to one bad call.
  The answers are recorded with the reply, in its record; the step ends
  `completed` with no corrective; the journal shows such a call `Completed`
  with no start. A reply that repeats a call id is malformed under both.
  Set it in `Agent.define`'s `limits` or a turn's `limits`; `LoopProtection`
  decodes it (`config.limits`, `turn.limits`), and `runLoop` takes it as
  `invalidCalls`. The new model-facing text is the answer,
  `rejectedCallFailure`: `{ error: "ToolNotFound", message }` (the step's
  tools and the name it wrote, framed as `tool-name`) or
  `{ error: "InvalidParameters", message }` (the decoder's report, framed as
  `parameter-errors`), clipped at 600 characters. `stepLoopConformance` adds
  the checks `invalid-calls` and `invalid-calls-record`: a host's own
  `StepLoop` that ignores `limits.invalidCalls`, or records an answered call
  apart from its reply, fails them.
- A host fingerprints the tool contracts and skill text the model sees, to
  version them: `@xandreed/core` exports `toolParametersSchema` (a tool's
  parameters as the model sees them) and `strictJsonSchema` (any schema in
  that model-facing JSON Schema form) from its root again, and
  `@xandreed/plugin-tool-discovery` exports `skillInstructions` (the exact
  text `load_skill` returns) and `catalogText` (the skill catalogue
  section's text).

## 0.15.0 — 2026-11-02

Agents that outlive their process and take direction while they work: a
durable session store in a plain directory on Node and Bun, explicit
takeover, a versioned stored format, shutdown deadlines and turn time limits,
tool calls stored before they run, durable steering and a self-draining input
queue, helpers that ask their parent and wait for the answer, and a versioned
stdio process host. Model calls gain Anthropic Messages gateways with
per-model thinking and cache controls, one HTTP retry policy with typed
failures, usage for every attempt, responses cut short that run no tool, and
compaction after the reply on reported usage. Hosts set the environment,
file roots, per-tool limits, a request hook and a tool interceptor; grep runs
on ripgrep and images fit through host converters; traces go to LangSmith.
21 packages: `@xandreed/process-host` and `@xandreed/plugin-session-files`
are new.

### Migration

- `SessionLog`: `SessionHead` gains a required `incarnation`
  (`SessionIncarnation`), which a store gives each session at its create,
  stable for that session's life to every handle; a session removed and
  created again under its id gets another. `SessionCommit` gains an optional
  `incarnation`: a commit naming one fails with `SessionMissing`, nothing
  written, unless the session is still that incarnation, checked in the same
  atomic step as the revision. A host's own `SessionLog` mints one at
  `create`, returns it in every head and checks it in `commit`; rerun
  `sessionLogConformance` (new check `incarnation`) and `sessionsConformance`
  (new check `recreate`). A decorator passes `incarnation` through. Commits
  that name none behave as before. `@xandreed/plugin-session-sqlite` moves
  its files to schema 2 when it opens them (`user_version` 2: an
  `incarnation` column, a random one for each session already there); a
  release that reads only schema 1 then refuses the file with
  `store.version`. The file store's incarnation is its header's existing
  nonce: no layout change, and no stored format change.

- A whole `ImageResizerConfig` adds `maxSourcePixels: 100_000_000` (or
  spreads `imageResizerDefaults`). `grepEngine: "auto"` now uses ripgrep only
  over `localSystemPlugin`'s own `FileSystem` and `Bash`; a host whose other
  pair shares one tree (a container's) sets `grepEngine: "ripgrep"`.
  `Agent.define` fails with the new code `config.limits`, and a run with
  `turn.limits`, when loop `limits` carry a `degenerate` policy or
  `malformedLimit` that does not decode (core's new `LoopProtection`). Custom
  registries rerun `toolRegistryConformance` for its `nested-other-open`
  check.

- `@xandreed/plugin-models` request policy: `requestTimeoutMs` now bounds a
  streamed request's pending headers only. A settled request's headers wait
  for `totalTimeoutMs`, and that timeout is final instead of a second
  generation; after handoff each body read has only `bodyIdleTimeoutMs`. A
  custom `ModelRequestSubject` reruns `modelRequestConformance`, which adds
  `settled-headers` and `lost-body`. Compat's `beforeRequest` runs before every
  physical send, retries included; `aroundRequest` still wraps the logical call
  once. On Bun the plugin now provides a managed transport that passes fetch's
  `timeout: false`; an explicit `FetchHttpClient.Fetch` still takes precedence.

- `BeginTurn.takeOver` also accepts a named turn, `{ turn, runId }`, which
  takes over only that open turn; a custom `Sessions` handles the object form
  and its drain passes `takeOver` to its first turn only (kit checks
  `takeover-named`, `drain-takeover`). `SessionsConfig.inbox` adds the
  required `recentSessions` (256 in `sessionsDefaults`; spread the defaults).
  `InboxDrainConfig` adds `attempts` (3). `Sessions.waiting` signals only
  commits that change an inbox or an open turn. The drainer's default resume
  message is now a host note.

- `TaskControlRefused.reason` adds `unknown-question`: `Tasks.answer` under an
  id no pending question has now fails with it instead of `question`, and
  exhaustive matches on the reason handle it. `harnessCodeOf` gives
  `TaskMissing` `task.missing`, `TaskConflict` `task.conflict` (`TAGGED_CODES`)
  and each `TaskControlRefused` reason its own code (`TAGGED_REASON_CODES`), so
  a process-host `answer` refusal carries a `frameworkCode`. Custom `Tasks`
  rerun the extended `answer` conformance check. The `ProcessPeer` kit's
  `writer-capacity` check now requires an excess writer to wait for a slot
  rather than fail at once; a custom peer that refuses immediately fails it.
  No stored shape changes.

- `toolCallIdOf` takes `(run, step, n)`: a minted tool-call id no longer
  holds the tool's name. Minted ids are `call_<turn>_<ordinal>_<step>_<n>`
  (`call_<turn>_<ordinal>_p<n>` for a planned batch, `call_<step>_<n>` and
  `call_p<n>` without a run). Ids are opaque; ids stored by earlier releases
  replay as stored. A custom `StepLoop` records a reply cut short together
  with its calls' `ReplyCut` answers in one `record` and reruns
  `stepLoopConformance` (new check `cut-record`); a custom memory strategy
  reruns `memoryConformance` (new checks `in-flight-exchange` and
  `call-order`).

- `SessionReadQuery` gains optional `media: "hydrate" | "references"`. A plain
  backend ignores it; `withMediaStore` returns references unread for
  `references`, which the sessions plugin uses for a begin's key-only turn
  lookups. Rerun `sessionLogConformance` (`read-references`). `MediaStore.get`
  now promises never to return bytes whose SHA-256 is not their key (damage is
  `Corrupt`), so `withMediaStore` no longer hashes them again; custom stores that
  cannot rule out damage verify before answering. A missing or corrupt blob no
  longer fails the read with `store.decode`: its occurrence keeps its metadata
  with `UNAVAILABLE_MEDIA_DATA` (`mediaAvailable`), renders as its label line and
  is never sent. `MediaStoreMemoryLive` is for in-memory logs only. The
  `memorySnapshotConformance` subject's `validate` takes no render options,
  `project` returns `mismatch`, and `MemoryProjection.Projected` carries
  `verified`; retained facts unlike this release's selection use the full
  archive instead of failing with `session.decode`.

- Stored format 17 adds the optional sealed reply of an open turn to the
  session's head state (`HeldTurn.sealed`: its ending and the reply's closing
  drafts). `TurnWriter.seal` is a new optional capability: it stores them
  before the turn's work after its reply, and every later close (a cancel, a
  time limit, a shutdown, an own end that fails, a reap, a takeover) ends the
  turn with that ending and stores that reply, never interrupted or failed,
  and not resumable. A begin refused while such a turn's holder is gone reaps
  it in a commit of its own, so a refused resume of it still stores it and
  the inbox drainer never retries resuming it. A custom writer without `seal` keeps
  working, its turns skipping the work after the reply; one with it reruns
  `sessionsConformance` (the new `sealed` check). Heads written before
  format 17 read as unsealed.

- Stored format 16 adds optional `TaskStarted.traceParent`. Task execution and
  queued follow-ups restore this recorded parent across runner contexts and
  process restarts. Identical start retries keep their first parent; old rows
  retain their previous ancestry. Custom Tasks rerun the extended conformance
  checks. Trace IDs use valid nonzero hexadecimal IDs; invalid or disabled
  tracing is omitted without failing task admission.

- Stored format 15 adds helper question and answer outboxes and the `waiting`
  turn outcome. Exhaustive outcome/status matches handle `waiting`; it consumes
  its admitted input and never produces a final `task.result`. Custom `Tasks`
  implement `ask`, `answer`, `steer` and borrowed-writer `execute`; custom task
  executors honor the optional sticky waiting control. Rerun the extended
  Tasks, Sessions, StepLoop and InboxRunner conformance kits. Compose
  `taskInboxRunner` around the ordinary inbox runner for child follow-ups.

- Stored format 14 adds `tool.intercepted`, the `intercepted` refusal reason,
  loop/direct audit provenance, and optional result-scoped invocation and
  rewritten-input metadata. Custom
  registries rerun the extended `toolRegistryConformance` kit. Hosts enabling
  `ToolInterceptor` use the registry's provided toolkit; rebuilding one over
  bare handlers bypasses the required argument capture and fails with
  `tool.intercept`. Existing calls without an interceptor keep their bytes.

- Stored format 13 adds an optional accepted `hook` patch to request headers.
  Hosts may provide `ModelRequestHook` to customize system text, append host
  context, or select tool choice before request preparation. Existing requests
  remain readable; replay uses recorded controls without invoking current
  hooks. The shipped `modelRequestHookConformance` kit checks application
  semantics, with SDK journeys covering persistence and frozen retries.

- Stored format 12 adds `memory.snapshot` render checkpoints and an optional
  head-state pointer. Custom writers may advertise `TurnWriter.memorySnapshot`
  when they atomically publish the pointer with each framework snapshot row;
  rerun `sessionsConformance`. Custom log handles may provide
  `checkpoint.load/save` with resolved entry IDs. Omission preserves full
  rendering. The summary strategy opts in; other strategies are unchanged.
  Archive readers, maintenance inputs and historical request replay remain full
  and keep their existing error channels.

- Stored format 11 adds optional physical media references. Compose
  `withMediaStore` over the session log and retain its `MediaStore` alongside
  physical journal backups; logical readers and replay still receive inline
  `Media`. Earlier inline history stays readable without rewriting it. Older
  unwrapped typed readers cannot decode physical attachment references, and
  the newer-format write/run fence remains in force. Custom session backends
  honor optional inclusive `SessionReadQuery.through` before decoding or
  hydrating payloads; rerun `sessionLogConformance` to protect fork visibility.

- Stored format 10 adds reusable `request.part` records and version 2 request
  headers referencing canonical system/tool hashes. Retention, export and
  redaction include these sensitive parts and preserve header dependencies.
  Readers still accept version 1; `ModelRequestHeader` remains the full
  materialized view, and public replay signatures are unchanged. Code reading
  raw `request.prepared` data handles both versions or calls
  `resolveRequestHeader` before using system text and tool declarations. Custom
  `TurnMemory` snapshots may supply ordered `requestEvents` for V2 headers;
  existing V1-only adapters can omit it. `requestHeaderConformance` verifies
  selected-prefix resolution and reference integrity.

- Custom step loops honor optional `StepRequest.onContextOverflow(step, evidence)`
  when supplied; rerun `stepLoopConformance`. The SDK compacts to a strictly
  smaller request and permits one context resend per step, with a shrinking
  run budget. Missing hooks, irreducible history and already visible streamed
  deltas retain the original failure. Optional neutral `ModelOverflowEvidence`
  carries the actual failed route and known limits; existing failure stamps
  still decode. Stored format 9 and selected usage remain unchanged.

- Memory strategies now use version 2 decisions. `MaintainSignal.phase` adds
  `turn-end`, after the turn's reply is final and sealed, and `overflow`. The
  summary strategy defaults to `summarizeAt: "turn-end"`, with each run's
  start as its safety net; choose `"step"` to consider one before each step's
  request instead. Maintenance accepts optional model-matched input
  observations and explicit run/render scope, with conservative `scaledTokens`.
  Custom loops forward optional `AcceptedModelInput` through the third argument
  of `StepRequest.record`; rerun the step-loop and memory kits. Manual SDK
  compositions use `stepRequestOf`, then `loop.run(request)`: the request
  hands its run's maintenance to the turn, which runs it after the sealed
  reply. A custom `TurnMemory` implements `deferAfterReply`, `afterReply` and
  `acceptedBefore`. A step's ceiling is lowered to the model's `ModelCatalog`
  window less its output cap when that is below the budget. Selected usage
  and stored format 9 remain unchanged, and version 1 requests still replay.

- Event kinds newly reserved since 0.14.0: `memory.tool-presentation`,
  `tool.intercepted`, `inbox.taken`, `model.called`, `request.part` and
  `memory.snapshot`. 0.14.0 let a host event (`defineHostEvent`) take one of
  these names, journaled under it as its kind. Its writes now fail with
  `ReservedKind` (`events.reserved`), and rows a 0.14.0 session stored under
  one are read as that framework kind, whose readers reject them (a
  `model.called` row fails `turnModelCallsOf` and billing for its turn).
  Rename such an event before upgrading; stored rows are not migrated.

- Restore the 0.14.0 journal fixture from its release tag and retain newer
  format 9 replay coverage in a separate unreleased fixture. The journal recorder
  now requires `--unreleased --force` to refresh development evidence and
  refuses to overwrite a release fixture.

- Stored format 9 adds `model.called` terminal facts for model attempts,
  including retries, helpers and discarded responses. `turnModelCallsOf`
  exposes actual selections and unknown/partial/final reported usage;
  `turnBilledUsageOf` sums reported subtotals plus the selected usage of each
  loop step no `Loop` call was recorded for (`ModelCallLegacyUsage` carries
  its run and step). Selected turn/run usage is unchanged.
  Custom model adapters can use `recordCompletion` with the turn's
  `CurrentModelCallRecorder`; durable recording failures stop dispatch and
  preserve their original `TurnError`. `UtilityCompletion.model` is optional
  and names the actual selection. Telemetry prices helper and late-finalizer
  calls without counting selected response usage twice.

- Model HTTP retries now use the full `CurrentModelRetryPolicy` Reference
  (`ModelRetryPolicy`, `modelRetryDefaults`) at call execution. The default
  four attempts include the initial send and a distinct configured fallback's
  reserved final slot. Long `Retry-After` hints are capped and slept. Empty
  200 responses, decoding failures and SSE failures no longer replay their
  transport request. The loop's pre-content stream fallback keeps its frozen
  request/header and gets a fresh logical budget. Tools and callbacks stay
  outside model retry/timeout wrappers. HTTP refusals created at the shared
  request boundary use `AiError.module: "Models"` and method `request`, with
  bounded provider descriptions and raw HTTP evidence. Stored format remains 8.

- Model request failures now expose typed `model.*` codes instead of the
  generic `loop.failed`; read a returned turn error's code with
  `harnessCodeOf`. Adapters classify native errors or response parts/content
  with `modelFailureOf` and map the kind with `modelFailureCodeOf`;
  `modelFailureOf` does not unwrap a `HarnessError` cause. Concrete provider
  error/reason classes and diagnostic evidence remain in the cause. A custom `StepLoop` reruns
  `stepLoopConformance`, including `model-failures`, and handles semantic
  failures before tool admission, malformed correction or output-cut
  recovery. Writer `TurnError` failures keep their tags and codes;
  unrelated unclassified failures still use `loop.failed`.

- A custom memory strategy supplies `BuiltContext.stableMessages`, the
  rendered prefix before its volatile step-context tail, and reruns the
  memory conformance kit. Stored format 8 adds optional frozen prefix counts
  to request headers; earlier headers still replay without the marker.
  Messages caller cache controls now fail locally when their count or
  lifetime order is invalid, or their object can serialize a different value.

- Messages models now resolve output caps from the call policy, then
  `modelSettings`, then a documented model profile. Unknown/deployment IDs
  need an explicit output cap. Per-model Messages controls own thinking,
  effort and output caps; use them instead of ambient SDK control overrides.
  `thinkingPrefixMismatch` now defaults to `drop_block` for eligible adaptive
  thinking. Set `provider-default` to omit it; Off and BetweenTools remain
  honored without binding fields. Existing chat endpoints remain compatible.

- Tool discovery adds per-tool host concurrency, loop-run call caps and
  consecutive-failure breakers. The existing top-level and annotation
  `maxCallsPerRun` budgets keep their per-turn scope. Writers now exclude
  readers fairly within a turn; nested calls refuse occupied permits rather
  than deadlock. New `ToolTripped`, `ToolConcurrency` and per-run
  `ToolCallLimit` wording is pinned. Stored format 7 adds `run-call-limit`,
  `tripped` and `concurrency` refusal reasons; earlier journals still decode.
  `LoopLimits` adds configurable degenerate protection and `malformedLimit`,
  retaining the defaults. Custom loops provide `CurrentAgentRun`; rerun the
  step-loop and tool-registry conformance kits.

- A custom `Sessions` supplies the bounded broadcast `waiting` stream;
  rerun `sessionsConformance`. Kit instances add `waitingInput` (an optional
  `WaitingInput` probe). `ProcessActivity` adds `waiting`, `queuedInput`
  and `inFlight`; `busy` includes queued input. `processActivity`,
  `Agent.activity` and default `awaitIdle` preserve `SessionLogError` from
  queue reads. `awaitIdle({ queued: false })` and shutdown stay infallible
  and wait only for running work, retaining cached backlog for restart.

- A whole `WorkspaceToolsConfig` adds `imageMaxSide: 8000` (or spreads its
  defaults). It applies when an optional `ImageResizer` is present. The
  `read` result view advances to version 3; fitted images may carry scalar
  `original` metadata, while earlier image results still decode.

- A custom `TurnWriter` supplies fresh `steers` and an atomic `take` that
  stores user messages, `inbox.taken` receipts and queue removal together.
  A custom `MemorySession.record` honors its optional commit callback:
  `false` leaves entries and ids unchanged; a failed uncertain write
  reconciles from storage. `TurnMemory` and `StepRequest` add
  `pendingSteers` and `steer`. Rerun the Sessions, memory and step loop
  conformance kits. Stored format 6 adds steering receipts and the optional
  `memory.message` inbox id; earlier journals still decode.
- A custom `Sessions` implements `enqueue`, `BeginTurn.Queued` and
  `drain({ take })`, and reruns `sessionsConformance`. A queued input runs
  as its own user turn; `AdmittedTurn.input` holds its provenance while
  `claimed` remains notice-only. Reaction-only drains use `take: "notices"`;
  the default `"all"` also runs queued inputs. Queued input survives failed,
  interrupted and partial turns without an attempt limit; completed or
  explicitly cancelled turns acknowledge it. Stored format 5 adds optional
  input provenance and delivery fields; earlier journals still decode.
- A custom `StepLoop` persists each assistant response before running its
  calls, then each final result as it returns, and reruns
  `stepLoopConformance` (`assistant-first`, `incremental-results`,
  `record-failure`, `recorded-results`). `StepRequest.record` stores durably before returning;
  its `recorded(step)` reads fresh durable entries, including raw results
  whose presentation did not finish, so failed steps still name them.
  `runLoop.onTail` now receives the response and individual results as
  separate batches, with concurrent results in completion order. A custom
  `ToolRegistry` flushes `tool.started` before entering a handler and
  reruns its kit (`started-durable`).
- A custom `MemorySession.recordTail` accepts the run ordinal and stores
  it on messages and raw results. Raw results are committed before views
  and digests; view metadata follows in `memory.tool-presentation`.
  `LogHandle.snapshot` can supply a fresh durable read after an uncertain
  append, so memory can recover allocated ids without acknowledging a
  failed write as successful. Rerun `memoryConformance`.
- A whole `WorkspaceToolsConfig` adds `grepEngine: "auto"`,
  `grepTimeoutMs: 30_000` and `grepIgnoreFiles: false` (or spreads defaults).
  Auto uses ripgrep syntax when rg is available; select `"builtin"` to retain
  JavaScript matching. `GrepResult.timedOut` decodes as false for older results.

- A host writing a whole `LocalSystemConfig` adds `parentEnv: null` (or
  spreads `localSystemDefaults`). A whole `WorkspaceToolsConfig` adds
  `workspaceAccess: "write"` and `roots: []` (or spreads its defaults).
- A custom `ToolRegistry` carries the toolkit handler context's optional
  `toolCallId` onto `CurrentToolInvocation` and every `tool.*` event, and
  reruns `toolRegistryConformance` (new check `provider-call-id`).
- A `match` on `StepStatus` (`step.ended.status`, `onStepSettled`) adds
  `truncated`; a host building an `AssistantMessageEvent` (a custom
  `StepLoop`) gives its `finishReason`, and reruns `stepLoopConformance`.
  Releases before stored format 2 cannot read `truncated` records.
- A call to a tool the step does not have now gets the corrective for a
  tool the model does not have (its name framed in `<tool-name>`), not the
  one for a reply that does not decode.
- A response cut short no longer completes the run, nor runs its tool
  calls: a reply cut at the output limit is corrected at most twice in a
  row, and any other cut (`content-filter`, `error`, `other`, and `unknown`
  for a response that holds tool calls the loop would run) fails the run
  with `loop.truncated`. A provider adapter or a scripted model ends each
  response that calls tools with a finish part: a response without one is
  `unknown`. A reply holding no tool call the loop would run (text alone,
  or an empty one) without a finish part still completes the run. A reply
  cut while a call's arguments were still being written is a cut only where
  the adapter keeps the unfinished call (the models plugin's chat
  completions client); effect/ai's Anthropic and OpenAI adapters fail it
  with `ToolParameterValidationError`, which the loop answers as malformed.
- A host calling `runLoop` directly handles its wider failure:
  `E | AiError | HarnessError`, the `HarnessError` of code `loop.truncated`
  (`harnessCodeOf`) for a reply cut short that the loop does not correct.
  Through the step loop, `loop.truncated` reaches the turn as it is.
- An endpoint on the models plugin's chat completions route whose
  `finish_reason` is a word outside the client's list (under Fixed) now
  ends its replies `other`, a cut that fails the run with `loop.truncated`,
  where they read `stop` or `tool-calls`.
- A turn now runs at most 6 hours by default: past it,
  `@xandreed/plugin-sessions` closes it as interrupted with
  `turn.time-limit`. A host whose turns run longer sets
  `turns.timeLimitMs` (at most a week) or the begin's `timeLimitMs`. A host that writes a whole `SessionsConfig` adds `turns`
  (or spreads `sessionsDefaults`).
- `TurnClosed`'s `reason` gains `timed-out`: an exhaustive match on it adds
  the case. `ProcessActivity` gains `stopping` and `TurnShutdown` its
  `stopping` effect: a host building either, or comparing an activity
  whole, adds it.
- The kits' fixtures name a shutdown: a `SessionsInstance` built for
  `sessionsConformance` gives `shutdown` (its `TurnShutdown`, as
  `Context.getOption(context, TurnShutdown)`; `Option.none()` for a
  `Sessions` without one, whose shutdown check then passes unchecked), and
  so does a `TasksFixture` for `tasksConformance` (the `TurnShutdown` of the
  `Sessions` its tasks run over).
- A host whose own `TurnAdmission` refused turns to drain may keep it, or
  call `agent.shutdown()` instead (or give `AgentConfig.shutdown`). A turn
  refused because the process is stopping is a `TurnRefused` of reason
  `shutdown` (`isShutdownRefusal`), the same code `turn.refused` as before.
- A custom `Sessions` implements `takeOver` on `begin` and `drain` and
  reruns `sessionsConformance`, which checks it.
- A host `Sessions` over `@xandreed/plugin-sessions`' state, or tooling that
  reads the head's `sessions` state, accepts its new optional `format` key.
  A session a newer release wrote is refused for writes and turns with
  `SessionLogError` code `session.version` (its `harnessCodeOf` is
  `session.log`): run it with that release or a later one.
- `@xandreed/plugin-render`: a host `RenderStore` keeps records under thread,
  principal and surface, scopes `commit` idempotency the same way, accepts a
  `SurfaceFrozen` without a version (and refuses `plan` after it), and reruns
  `renderSurfaceConformance`. Code calling `decodeSse` reads its `Result`;
  code building `SurfaceFrozen` passes `versionId: Option.some(...)`.
- `@xandreed/evals`: rename ids containing "/" or "@" and re-run reports
  that hold them; give every gate a `minimum` or a `maximum`; `yield*` the
  result of `positiveInt`.
- Replaying a model request built from a summary recorded before this
  release fails with `request.diverged` (`context`), and a summarized
  session's cached prompt prefix changes once, because the summary handoff
  renders with new wording.
- `makeSession` (`@xandreed/core`) is deprecated and will be removed in a
  later release: use `Agent.define`/`Agent.turn` (`@xandreed/sdk`) over
  `Sessions` (`@xandreed/plugin-sessions`). Its ledger is in memory only,
  and its live `subscribe` tail drops the oldest events for a subscriber
  more than 512 events behind; it never delivered "exactly once".
- A custom `StepLoop` provides `request.cacheKey` as `CurrentPromptCacheKey`
  to its dispatch checks and model calls; `stepLoopConformance` checks it.
  On a loop that does not, a turn with a cache key fails the step with
  `request.diverged` (`cacheKey`).
- Install `effect` beside the packages: they declare it as a peer
  (`^4.0.7`) and depend on each other with caret ranges, so other patch
  versions install one copy of `effect` and of `@xandreed/core`.
- `yield*` the result of `defineGraderCalibration` and `endpointOwnKey`; pass
  the time (`Clock.currentTimeMillis`) to `classifyLlmError` and
  `openAiCodexUuidV7`.
- Add a `turnBeginCodes.SessionContended` entry to tables that cover every
  begin code, handle `SessionContended` where `Sessions` or `Tasks` errors
  are matched exhaustively, and raise a tagged error or a `HarnessError`
  where a stored code used to be read from an untagged error.
- Handle `SessionContended` (503, retry later) where you matched
  `SessionLogError` code `session.contended`, and treat `SessionLogError`
  as a store failure only.
- Read a failure's code with `harnessCodeOf(error)`, not `error.code` (the
  same code for a `HarnessError` and for the tag it stands for), and widen
  `HarnessError` annotations on a turn's `use`, or on code calling these
  ports, to `TurnError`; implementations returning `HarnessError` still
  satisfy the ports.
- Match a turn writer's failures by tag (`Effect.catchTag("TurnClosed" |
  "ReservedKind" | "SessionContended" | "SessionLogError", …)`) instead of
  `code === "turn.closed"`, and handle `TurnClosed.reason` `"ended"` where
  reasons are matched exhaustively. A custom `Sessions` writer raises these
  tags and reruns `sessionsConformance`; a `SessionLog` is unaffected.
- Match a begin refusal by tag (`Effect.catchTag("SessionBusy", …)`) and
  read what it names from its fields, not its message; read its code with
  `harnessCodeOf(error)` or `turnEndingOf(exit)`. Widen annotations on
  `Agent.turn`'s error to `TurnBeginError | TurnError`. A hand-composed
  `TurnRunner` lets the `Sessions.begin` refusal through and reruns
  `turnConformance`. The events guide's turn route answers a busy session
  with `{ code: "session.busy", turn }`.
- Narrow `unknown` values before putting them in JSON fields, or pass the
  object through `storedJson`, which takes any object and returns the
  `JsonObject` a store gives back. A host event whose data JSON cannot hold
  fails the turn with `events.encode` when published. A `SessionLog` backend
  writes data as JSON text (`storedJson`), never through
  `fromJsonString(JsonObject)`.
- `@xandreed/plugin-models`: an `auth.json` entry with a field of the wrong
  type (a numeric `accountId`, say) is no longer read with that field
  dropped: it is not used, and is written back as it is. Fix the field, or
  log in again.
- Call `parseEvaluationApp` instead of `validateEvaluationApp`, tell
  refusals apart by `violations[].rule` rather than message text, and put
  only JSON values in `metadata`.
- `yield*` the result of `catalogOf`; a host `McpClient` gives every
  `McpToolDescriptor` an `inputSchema` that is JSON; narrow completion
  `facts` and the `data` of host events you publish directly to JSON, or
  publish through `defineHostEvent`.
- Read stored records through `readStored` and `readStoredKeys` rather than
  `event.data.<field>`.
- Streamed sessions now replay their reasoning: the request bytes and
  cached prompt prefixes of Anthropic sessions with thinking and OpenAI
  Responses sessions with reasoning change once (messages stored earlier
  still decode, without metadata). Code comparing `foldStreamParts` output
  with plain `{ type, text }` objects compares with `Response.makePart(...)`,
  and a custom `StepLoop` that streams reruns `stepLoopConformance`.
- Narrow options typed `unknown` to `{ prompt }` before passing them to
  `prependClaudeCode`, `withAnthropicCacheBreakpoints` or `generateWith`.
- Pass effect/ai parts (`GenerateTextResponse.content`,
  `Response.makePart(...)`) to `responseToAgentMessages`, `responseText`,
  `responseReasoning`, `responseToolCalls`, `responseToolResults`,
  `withToolCallIds`, `extractUsage` and `extractModel`, and a stream of them
  to `foldStreamParts`; `Prompt.make(toPromptMessages(messages))` needs no
  cast.
- Put only JSON in `providerOptions`, and handle `tool-result` parts in code
  that walks an assistant message's parts.
- Read a response's model with `responseModelOf`; a model that wraps others
  stamps its finish part with `stampResponseModel` (`stampPartModel` on a
  stream), not under a key of its own.
- Build `describeModel` settings as JSON; pass settings with optional
  fields through `storedJson` first.
- Read `efferent.task.id`/`efferent.session.id` on `task.run`, and read
  those log annotations instead of grepping the tasks plugin's log text for
  ids.
- A turn that cannot begin leaves an `agent.turn.begin` span carrying the
  refusal's code: a trace check that expects every span under the caller's
  to sit under `agent.turn` excludes the begin's subtree.
- A trace query that expects an inline `turn.ended` subscriber's spans
  directly under `agent.turn` finds them under `turn.persist_reply`.
- Read `efferent.session.id`, `efferent.run.id` and `efferent.turn` from the
  sessions plugin's log annotations instead of its log text.
- Read the `llm.model` and `llm.fallback_model` log annotations instead of
  the models plugin's retry and fallback warning text.
- Mint ids where they are created: `RunId.make(crypto.randomUUID())` for a
  turn's run, `InboxItemId.make(...)` for `deliver`, `ConversationId.make(...)`
  (or a decode) for a task id. `replayModelRequest`, `modelRequestHeaderOf`,
  `entryId` and `stepContextOf` take a `RunId`.
- Host render stores: add both checks inside the write's transaction and
  rerun `renderSurfaceConformance`; records are unchanged. Mint scope and
  feed ids with `.make` (`ThreadId.make(…)`, `RunId.make(…)`, …), and give
  each newer writer of a message a higher `fence`.
- Stored records without `run` read as run 0, so nothing needs migrating:
  pass the run ordinal where the APIs below now take one, add `run` to the
  step events you publish, and rerun the step-loop, turn and memory kits.
- A `StepLoop` publishes `step.ended` once per step, before evaluating
  completion, with `malformed` for an undecodable response, and records
  nothing under a step after its `step.ended`; rerun `stepLoopConformance`.
- `runLoop` callers publish step ends from `onStepSettled`, not
  `isComplete`, and record under the `step` that `onTail` passes. Code that
  builds a `RunResult` returns one of the two shapes; a `match` on step
  status adds `malformed`.
- Add `closing` to a hand-written `TurnWriter`: hold the drafts and store
  them in the end's commit before `turn.ended`; then rerun
  `sessionsConformance` and `turnConformance`, which both gain a `closing`
  check.
- Match `"task"` wherever you match `TurnOrigin` or `NotResumable` reasons.
- Read the starting run from `task.started.startedBy`; older records keep
  it in `meta.runId`, and older task turns read as `origin: user` with
  `command.task`.
- Build `Tasks` beside the agent:
  `TasksLive(cfg).pipe(Layer.provide(agentTaskExecutor(agent, { services })))`.
- A custom `StepLoop` records nothing under a step it never starts: at the
  step cap or after a complete verdict, it drops the corrective or nudge it
  would have sent. Rerun `stepLoopConformance`.
- Mint ids with `.make` where they are created: a tool view's `subjects`
  (`SubjectId.make(...)`), a hand-written `HarnessConfig`
  (`PluginInstanceId.make(...)`), a `CredentialInput` value
  (`AccountId.make(...)`), and evals inputs. `defineSkill` and
  `defineCapability` still take strings and brand them; an empty or
  untrimmed skill or reference id, or an empty plugin instance id given to
  `Agent.define`, now throws. A `RetrievalJudge` may still answer with
  plain-string ids.
- An evaluation export that runs longer than 5 minutes now fails as
  `provider`: pass a larger `timeoutMs` to the exporter.
- Hosts tuning routed-call bounds provide the full `CurrentModelRetryPolicy`
  Reference; the total deadline defaults to 600 s.
- `Sessions.changes` merges the signals a follower has not taken into one:
  a follower that counted signals to count commits reads from its cursor
  after each signal instead.
- List every service a plugin's layer needs in `requires`, and read an
  `optional` service with `Effect.serviceOption`. A host calling
  `activateGraph` must pass any service it named `external` that a plugin
  requires.
- A custom `ToolRegistry` returns the context its toolkit's `toHandlers`
  gives (for no tools, `toolkit.toHandlers({})` on a toolkit typed
  `Toolkit<Record<string, Tool.Any>>`). A host building a `StepRequest`
  merges its services into the registry's handlers
  (`Context.merge(services, tools.handlers)`), and a custom `StepLoop` drops
  its cast: `request.tools.toolkit.pipe(Effect.provide(request.handlers))`
  type-checks as is.
- List what a tool handler reads, `RunContext` included:
  `defineTool({ tool, requires: [RunContext, Tasks], handler })`. A custom
  `ToolRegistry` checks each tool's `requires` when it opens a run's tools;
  `toolRegistryConformance` checks it.
- A host that calls a `TaskExecutor` itself, for example draining a parent
  with `sessions.drain(address, executor.react)`, provides its `Tasks`:
  `.pipe(Effect.provideService(Tasks, tasks))`. Custom executors need no
  change.
- Rebuild a prompt section that reads services (for example
  `SessionEnvironment`) with `definePromptSection` and list those services
  in `requires`; a section that reads none can stay a plain `PromptSection`
  value.
- A custom `StepLoop` provides `request.callPolicy` as
  `CurrentModelCallPolicy` next to `request.cacheKey`; a hand-built
  `StepRequest` adds `callPolicy` (`Option.none()` when there is no
  policy).
- If you compose `LanguageModelLive`, `LanguageModelSelectionLive` or
  `UtilityLlmLive` yourself, provide `CurrentModelEndpoints` and
  `ModelsTransport` to the layer, not around its calls. Hosts using
  `modelsPlugin` need no change.
- Code naming `RunLoopOptions<Tools, R>` writes `RunLoopOptions<Tools, E,
  R>` (`never` for callbacks that cannot fail); a `runLoop<Tools>(…)` call
  whose callbacks fail names the error, `runLoop<Tools, E>(…)`, or lets it
  be inferred. Callbacks no longer need `Effect.orDie`.
- Foundry profiles: drop workspace packages from `externals` and name them
  in `canImport`; a test that imports another package's testing module
  needs a `<name>-tests` layer.
- List `@xandreed/core` beside `effect` in your dependencies: every package
  that uses core declares it a peer dependency (`^<version>`), like
  `effect`, so a host installs exactly one copy, and dependencies that cannot
  share one fail the install with a peer conflict instead of loading a
  second copy. npm 7+, pnpm and Bun install a missing peer themselves.
- Import the kits from `@xandreed/core/conformance`, the credential and
  settings stores from `@xandreed/core/models`, and `TurnLive` and the
  turn's lifecycle functions from `@xandreed/core/engine`; your editor marks
  each root import that has moved. `@xandreed/core/internal` is for the
  framework's own packages: it carries no semver.
- Import `AuthStore`, `SettingsStore` and the rest of the models storage
  from `@xandreed/plugin-models` rather than `@xandreed/core`.
- `@xandreed/evals-cli` has no subpath imports: import from the package
  root, which exports the same names. `@xandreed/evals-cli/cli.adapter`
  becomes `@xandreed/evals-cli`, and so do `/run-main.adapter`,
  `/config-loader.adapter` and `/adapters/evaluation-store.fs.adapter` (with
  or without `.js`). The `efferent-eval` bin is unchanged.
- Nothing to do for SQLite session databases: a 0.14 file, which has no
  schema version, opens as it was and is stamped schema 1 the first time it
  opens.
- Credential secrets are `Redacted`: wrap them with `Redacted.make`, read
  them with `Redacted.value`, and compare them with `Equal.equals`, never
  `===`. The file format is unchanged. A custom `AuthStore` that persists
  credentials encodes them with `Schema.encodeEffect(Credential)` before
  writing (`JSON.stringify` writes `"<redacted>"`) and reruns
  `authStoreConformance`. Drop calls to `toCredential`.
- Pass a sign-in's tokens to `AuthStore.set` as they are (no
  `Redacted.make`); wrap a refresh token with `Redacted.make` before passing
  it to a refresh function, and read a token with `Redacted.value`.
- Calibration runs graded from this release carry
  `comparison: "calibration-agreement:2"`, so `compare` against an earlier
  calibration run reports that the grader definitions differ; stored
  reports still decode unchanged. To compare an old run, regrade its saved
  observations first with `efferent-eval grade --from <execution.json>`
  (no grader calls).
- `@xandreed/evals`: a custom `EvaluationRunStore` adds
  `appendTranscript(trial, event)`; a store that keeps only whole trials
  can return `Effect.void`, since the settled trial still carries every
  event.
- `@xandreed/evals`: put each evaluator behind a grader with
  `graderFromEvaluator`, list it in the app's `graders`, and bind it to
  tasks as `<id>@<version>`; the grader's `metrics` replace a binding's
  `select`, and the judge Layer is the second argument instead of an
  `Effect.provide`. Regrade saved work with `gradeEvaluation`
  (`efferent-eval grade --from`). Reports on disk are unchanged.
- A custom `StepLoop` provides `request.handlers` outermost and its
  `StepLoopReferences` (the request's `cacheKey` as `CurrentPromptCacheKey`,
  its `callPolicy` as `CurrentModelCallPolicy`, and the others) inside them.
- Replace `assessAll(bindings, input)` with one grader per evaluator:
  `graderFromEvaluator({ definition, input, evaluator, timeoutMs }, services)`.
  The grader's `metrics` replace a binding's `select`, `input` is the codec
  the projection encoded the grading context's input with, `services`
  provides what the evaluator requires (a `SemanticJudge` layer), and
  `timeoutMs` keeps its 90 s default. Read the outcome from the run's
  `Grade`: `status`, `metrics`, `usage`, `metadata` (an assessment's
  `references` under `metadata.references`) and `reason`, a string where
  `EvaluationResult.reason` was an `Option`.
- To grade one input outside a run, provide the grader's `layer` and call
  `GraderAssessment`'s `assess(context, candidate)`. A failure is an
  `EvaluationError` (`code` `unavailable` for a missing measurement) where
  `assess` returned an `error` or `unavailable` result.
- An exporter that sent `evaluationScores(result)` sends
  `exportableScores(encodedRun)`: each score carries its trial, `key`, a
  stable `seed` for the remote id, a numeric `value` and the grade's
  reason as `comment` (a metric's own `comment` is not sent).
- Call `parseEvaluationApp` where you called `validateEvaluationApp`.
- Saved reports are unaffected: no stored run holds an `EvaluationResult`
  or an `EvaluationScore`.
- Move each import named above to its subpath; `tsc` names every one that
  no longer resolves. `@xandreed/core/internal` carries no semver.
- A model that sends each call on to another and stamped the resolved model
  under its own `router` key on the finish part stamps it with
  `stampResponseModel` (`stampPartModel` for a stream); otherwise the
  stored assistant message and the telemetry plugin's metrics carry no
  model.
- A custom `SettingsStore` drops its `sandbox` and `viMode` cases and reruns
  `settingsStoreConformance`. An exhaustive match over `LoopEvent` drops its
  `error` case.
- Import `LoopEvent` from `@xandreed/plugin-agent-loop`:
  `import type { LoopEvent } from "@xandreed/plugin-agent-loop"`.
- Replace each import from `@xandreed/core/models` with one from
  `@xandreed/plugin-models` (the stores and their types) or from
  `@xandreed/plugin-models/conformance` (the two kits and their options),
  and move a kit imported from `@xandreed/plugin-models` to
  `@xandreed/plugin-models/conformance`; `tsc` names every import that no
  longer resolves.
- Replace `toCredential(input)` with `input`.
- Replace `from "@xandreed/core/engine"` with `from "@xandreed/sdk"`
  (`makeTurnEvents` and `makeTurnTasks`: `from "@xandreed/core"`). A package
  that composed its turns on core alone adds `@xandreed/sdk` as a dependency.
- Import `toolRegistryConformance` from `@xandreed/sdk/conformance` and run it
  over your registry as before.
- An import from `@xandreed/sdk` of a name the list above leaves out fails to
  compile: import that name from `@xandreed/core` instead (installed beside
  the sdk already, as its peer). The values are the same, so code may take a
  name from either package.
- A host or eval that matched a tool result's `error` on an old name
  matches the new one; to tell refusals apart, match `tool.refused`'s
  `reason`, and for a failed activation, `RunTools.activate`'s
  `HarnessError` code. A third-party `ToolRegistry` returns its refusals
  and `load_skill`'s under PascalCase names to pass the kit.
- Code that read the label off a `loop.failed`, `request.model`,
  `plugin.activation` or `plugin.defect` message (`AiError: …`) reads the
  error's tag from the `HarnessError`'s `cause` instead.
- A host that matched a background task's notice on its status word
  (`partial`) reads the task's status from `Tasks.status`.

### Breaking

- `@xandreed/plugin-render` operation ids name the surface and the
  generation: `<runId>:render:<surfaceId>:<generation>:<nodeId>`, and fills
  `...:<generation>:fill:<placeholder>` (a `:` or `%` inside a part is
  percent-encoded). `operationIdOf` and `fillOperationIdOf` take the surface
  id, and the fill takes the generation. Stored records still read: a
  version partly committed under the old ids commits only its missing nodes.
- `SurfaceFrozen.versionId` is an `Option` (`null` when encoded), so a
  freeze before the first publish holds. Stored freezes still decode.
- `decodeSse` returns a `Result`: a malformed record fails with
  `RenderError` code `invalid` instead of throwing.
- A damaged or unreadable `auth.json` or `config.json` fails with an
  `AuthError` of code `auth.corrupt` (or a `SettingsError` of code
  `settings.corrupt`) naming the file, instead of reading as empty and being
  overwritten on the next write. A corrupt `config.json` used to be ignored
  with a warning: fix or remove the file.
- Skill-selection decisions and seeded `load_skill` calls are numbered per
  run: `<runId>:skill-selection:<n>` and `<runId>:matcher:<n>`. Older
  journals still decode.
- `@xandreed/evals` ids (`EvalId`) can no longer contain "/" or "@":
  `EvalId.make` refuses them and saved reports holding them no longer
  decode. Trial, transcript-event and review trial ids are the new
  `EvalPath`. A run id that is not an `EvalId` fails the run with `invalid`.
- A `Gate` needs a `minimum` or a `maximum`; validation refuses one with
  neither (it used to pass any value).
- `GateFinding.mode` is `"blocking" | "diagnostic"`; a report with another
  mode (such as "Blocking", once read as diagnostic) no longer decodes.
- `positiveInt` returns an `Effect` failing with `invalid` instead of
  silently using the fallback. `EvaluationError` has a new code, `missing`.
- `@xandreed/plugin-models`: the routed models fail a credential they
  cannot get (none stored, a failed refresh, a proxy the runtime cannot
  tunnel) with an `AiError` whose reason is `AuthenticationError`, not a raw
  `AuthError`; it is still not retried and goes to no fallback.
- `makeOpenAiCodexWebSocketHttpClient(proxy, sessions?)` and
  `OpenAiCodexWebSocketHttpClient` share no process-wide session map: pass
  `makeOpenAiCodexSessions()` to keep a conversation's session id (without
  one, each request gets a fresh id). The routed models keep one cache per
  layer, up to 1024 conversations.
- `defineSkill` rejects `instructions` with `always: true` (an always-on
  skill's instructions never reached the model).
- `DigestTask` has `preserve`; `MemorySummaryConfig` has `summaryTimeoutMs`
  and `MemoryDigestConfig` has `digestTimeoutMs` (add them if you build
  these configs without the defaults).
- `draftOfTurnEvent` returns an `Effect` that fails with the `SchemaError`
  instead of throwing. A bus event that does not encode fails the turn with
  `events.encode`, not `turn.defect`.
- `toAgentFailure` classifies an `AiError` by its reason: the `code` is the
  reason's tag (for example `RateLimitError:429`) instead of `AiError`, and
  `retryable` is the reason's own (rate limits are retryable, exhausted
  quotas are not).
- `toFailure` names tagged values by their `_tag` and never produces
  `[object Object]`.
- A plugin's layer no longer sees services provided around `Agent.define`,
  `Agent.turn` or `activateGraph` that it does not declare in `requires` or
  `optional`. It keeps the fiber's settings: logging, tracing and the
  current span, clock and metrics.
- `Agent.define` fails with `config.graph`, naming the missing service, when
  the agent's turns would have no `ConversationMemory`, `ToolRegistry` or
  `StepLoop`; before, the first turn failed with `service.missing`.
- `resolveGraph` refuses `profile`/`profiles` (`config.profile`) instead of
  ignoring them.
- Agent fingerprints change once: they now hash canonical JSON.
- `Sessions.begin` refuses a run id that an earlier turn of the session, or
  of history a fork inherits, was begun with: `RunIdReused`, or
  `turn.run-reused` (409) from `Agent.turn`. Every turn and every retry
  needs a new run id.
- `Tasks.start` fails with `TaskConflict` for a known task id with other
  instructions or mode, and with `SessionExists` for an id naming a session
  that is not the parent's task child.
- A turn's writer refuses framework kinds from hosts and plugins
  (`events.reserved`); only drafts made with `frameworkDraft` are accepted.
- `endpointOwnKey` (`@xandreed/plugin-models`) returns an `Effect`;
  `apiKeyEnv` and `EFFERENT_TRACE_CONTENT` are read with `Config` from the
  current `ConfigProvider`. Under the default environment provider an empty
  `apiKeyEnv` variable is unset, so the stored key is used;
  `ConfigProvider.fromEnv({ preserveEmptyStrings: true })` keeps the old
  behaviour.
- `classifyLlmError(error, now)` and `openAiCodexUuidV7(now)` take the time
  explicitly.
- `defineGraderCalibration` (`@xandreed/evals`) returns an `Effect` that
  fails with `invalid` when a case's input does not encode.
- `foldStreamParts` (`@xandreed/core`) leaves `usage` off the result when no
  finish part carried one.
- `Sessions.begin` fails with `TurnBeginError`; `Sessions.transact`,
  `cancel`, `deliver`, `drain` and `Tasks.start`, `cancel`, `reconcile` may
  fail with `SessionContended`.
- A stored `turn.ended` takes its code from `harnessCodeOf`: begin
  refusals, `TurnClosed` and `ReservedKind` store their own codes instead
  of `turn.failed`, a `SessionLogError` stores `session.log`, and an
  untagged value with a `code` stores `turn.failed`.
- `@xandreed/plugin-sessions`: writes that keep conflicting fail with
  `SessionContended` instead of `SessionLogError` `session.contended`, and
  `Tasks` passes it on. A log answer its contract rules out
  (`session.expired`, `session.begin`, `session.create`), or a value of the
  plugin's own that does not encode (`session.encode`), is a defect.
- `@xandreed/plugin-tasks`: `tasks.encode`, `tasks.kind` and `tasks.lost`
  are defects, no longer `SessionLogError`s.
- The turn's writer and the ports on the turn's path fail with `TurnError`
  (`HarnessError | TurnClosed | ReservedKind | SessionContended |
  SessionLogError`) instead of `HarnessError`: `TurnWriter`, `RunContext`,
  `TurnEvents`/`TurnTasks` and subscription handlers, memory's log and
  session writes, `TurnMemory`, `TurnToolbox`, `TurnPrompt`, `StepRequest`
  and `StepLoop.run`, `RunTools` and `ToolRegistry.open`, `TaskExecutor`,
  `Turn`, `TurnRunner.turn` and `Agent.turn` (which fails with
  `TurnError | E`). Types only: what is raised and stored is unchanged.
- The turn writer, `Agent.turn` and task turns fail with `TurnClosed`
  (`cancelled`, `interrupted`, `removed`, `ended`), `ReservedKind`,
  `SessionContended` or the store's `SessionLogError` instead of
  `HarnessError` codes; stored codes are unchanged. Reading a removed
  session through the writer fails with `TurnClosed` (`removed`).
- `PLUGIN_API_VERSION` is 3 (API 1 and 2 plugins still load), and
  `sessionsConformance` asserts the tags.
- `harnessDefectsAsFailures` restores any `TurnError` carried as a defect
  (`E | TurnError`), and `runSteps` and the tool registry pass `TurnError`s
  through.
- `Agent.turn` and `TurnRunner.turn` fail a turn that cannot begin with the
  refusal itself (`TurnBeginError`: `SessionBusy`, `TurnDuplicate`,
  `KeyConflict`, `RunIdReused`, `NothingPending`, `NotResumable`,
  `TurnRefused`, `SessionMissing`, `SessionContended`, `SessionLogError`,
  `AttachmentRejected`) instead of a `HarnessError` with its code; their
  error type is `TurnBeginError | TurnError | E`. The refusal keeps its
  fields, and its code is unchanged. `turnConformance` checks that a turn
  begun while another is open fails with that `SessionBusy` and runs and
  stores nothing.
- `@xandreed/core`: `JsonObject` is `Schema.JsonObject`. A session's `meta`
  and `state`, event and draft `data`, a turn's `command` and `meta`, and an
  inbox item's `source` are typed and decoded as JSON; stored bytes do not
  change. `asJsonRecord`, `parseJsonWarn`, `parseJsonOption` and
  `decodeJsonLines` are deprecated, and `asJsonRecord` reads an array as
  `{}`.
- `@xandreed/plugin-render`: a snapshot's `spec`, node and proposal `props`,
  and journal record and feed payload `data` are `Schema.JsonObject`; a
  value JSON cannot hold is refused. The `render_component` tool's schema is
  unchanged.
- `sessionLogConformance` checks that data with an `undefined` field commits
  and reads back without it.
- `@xandreed/plugin-models`: `toOpenAiCodexRequestBody` returns a readonly
  JSON object (`Schema.JsonObject`), and reads a body that is not a
  Responses request object as an empty one.
- `@xandreed/evals`: `parseEvaluationApp(value)` decodes an evaluation app
  (its shape, then its cross-references) and replaces `validateEvaluationApp`
  (kept as a deprecated alias). A refusal is still `invalid`, with a message
  naming the first five problems; `EvaluationError` gains `violations`
  (`{ rule, path, message }`), and `evaluationAppViolations(app)` lists the
  cross-reference ones. Runs, gradings, `efferent-eval validate` and
  `loadEvaluationApp` decode the app, so a configuration whose default
  export is not an app is refused up front.
- `@xandreed/evals`: `metadata` on `Grade`, `EvaluationResult`,
  `SemanticResult`, `Assessment`, `SemanticLlmOptions` and
  `SemanticJevOptions` is a `Schema.JsonObject`; saved reports still decode.
- `@xandreed/core`: a `CompletionVerdict`'s `facts` and a `host` event's
  `data` are `JsonObject`. `defineHostEvent` publishes its encoded payload as
  JSON, so an `undefined` field is dropped, and a payload JSON cannot hold (a
  BigInt) fails `make`/`publish` with `events.encode` instead of failing the
  turn when it is stored.
- `McpToolDescriptor.inputSchema` and the capability catalogue's
  `inputSchema`/`outputSchema` are `Schema.JsonObject`, and `catalogOf`
  returns `Effect<CapabilityCatalog>`.
- A stored record that does not decode now fails instead of reading as "no
  match" or an empty value: in plugin-sessions, lookup, begin, delivery and
  inbox turns fail with `SessionLogError` `session.decode` (an
  `inbox.queued` row whose `source` is not an object no longer reads as
  `{}`); in plugin-tasks, `list` and `status` fail with `session.decode`;
  in core, `modelRequestHeaderOf` and `replayModelRequest` fail with
  `request.decode` where they used to report `request.missing`.
- `foldStreamParts` emits each text and reasoning chunk as an effect/ai part
  (`Response.makePart`, with `metadata`), and keeps a chunk that has
  metadata but no text (a redacted thinking block, an OpenAI reasoning item
  without a summary).
- `@xandreed/plugin-models`: `prependClaudeCode` and
  `withAnthropicCacheBreakpoints` take call options with a `prompt` and
  return them with the prompt as a `Prompt` (other options kept), instead of
  `unknown`; `generateWith` takes options with a `prompt`.
- `@xandreed/core`: every `providerOptions` is `ProviderOptions` (a JSON
  record, optional key).
- `@xandreed/core`: `AssistantMessage.content` may hold the result of a tool
  the provider ran (`ToolResultPart.providerExecuted`). Only sessions with
  provider-defined tools write one, and an older release cannot read such a
  message.
- `@xandreed/core`: the response helpers and `FoldedTurn` use effect/ai
  types, `toPromptMessages` returns `Prompt.MessageEncoded`s, `extractUsage`
  decodes its usage as effect/ai's `Usage` (no longer reading Gemini's raw
  usage metadata), and `responseToolResults` leaves out preliminary results.
- `@xandreed/plugin-models`: `fromChatCompletion` returns
  `Response.PartEncoded`s, and `thinkingParams` returns a JSON object.
- `@xandreed/core`: `ModelRequestDescriptor.settings` is
  `Schema.JsonObject`; settings holding a value JSON cannot hold (an
  `undefined` field included) fail each dispatch with `request.descriptor`.
  Stored request headers decode as before.
- `@xandreed/plugin-models`: the router stamps the resolved model on the
  finish part as `metadata.engine.model`, not `metadata.router.model` (the
  stamp was never stored).
- `@xandreed/plugin-tasks`: the `task.run` span carries `efferent.task.id`
  and `efferent.session.id` in place of `task.id` and `session.id`, and the
  plugin's log lines no longer name the task or the parent session in their
  text; the ids are log annotations under those keys.
- `@xandreed/plugin-sessions`: the plugin's log messages no longer contain
  session, run or turn ids (for example "the turn's end was not stored when
  its scope closed" and "an inbox turn ended failed"); the ids are log
  annotations.
- `@xandreed/plugin-models`: the retry and fallback warnings no longer name
  the model in their text (`<model>: transient failure exhausted retries…`,
  `<model> exhausted retries … falling back to <model>`); the fallback
  warning carries `llm.model` and `llm.fallback_model` annotations.
- `@xandreed/core`: turn identities are branded: `RunId` (`NewTurn`,
  `BeginTurn`, `AdmittedTurn`, `Turn`, `RunContext`, `TurnToAdmit`, the
  `turn.*` events, `LogEntry`, request headers), `InvocationId` (the
  `tool.*` events, `CurrentToolInvocation`), `InboxItemId` (`InboxItem.id`,
  `inbox.queued`/`inbox.dropped`), and `Tasks.status`/`cancel`,
  `TaskConflict` and `TaskMissing` take a `ConversationId`. Brands are
  type-only: stored data is unchanged and every journal still decodes.
- `@xandreed/plugin-render`: the `RenderStore` contract's `plan` checks the
  generation, and `plan`/`commit`/`complete`/`freeze` check the fence;
  `renderSurfaceConformance` has three new checks.
- `@xandreed/plugin-render`: render ids are branded (`ThreadId`,
  `PrincipalId`, `RenderMessageId`, `SurfaceId`, `VersionId`, `NodeId`,
  `OperationId`, `RevisionId`), `UiOutputScope.runId` is core's `RunId`,
  and `SseRecordFields` decodes `id` as `sequence` (the wire is unchanged).
- `@xandreed/core`: `StepRequest.run` (`RunRef`) is required; a custom
  `StepLoop` puts `run` on `step.*`, `assistant.message`,
  `completion.evaluated` and `stream.fallback` and mints ids with
  `toolCallIdOf`/`plannedCallIdOf` (`stepLoopConformance` checks this).
- `@xandreed/core`: `MemorySession.renderRecipe(stepContext, run)`,
  `build({ stepContext, run })`, `RenderOptions.run`,
  `stepContextOf(entries, runId, run)`, `modelRequestHeaderOf(…, step, run)`
  and `TurnMemory.startRun` change their types; `startRun` after the reply
  is refused with `turn.closed`.
- A step loop ends each step exactly once, when the step's own call, tools
  and tail are done; a completion that fails afterwards fails the run and
  leaves the step `completed`.
- `step.ended` has a new status, `malformed`, for a response the model
  could not form; such a step gets no `completion.evaluated`. 0.14 and
  older cannot read records with this status.
- `@xandreed/plugin-agent-loop`: `runLoop` takes `onTail(messages, step)`, a
  new `onStepSettled(step, status)` and `isComplete(step)`; the loop's
  corrective, nudges and steers are recorded under the next step.
- `@xandreed/core`: `RunResult` is a union: `completed`/`completed`, or
  `partial` with `step-cap` or `degenerate-loop`.
- `@xandreed/core`: `TurnWriter` gains `closing(drafts)`: drafts held for
  the turn's end and stored only in the end's commit, right before
  `turn.ended`. A later call replaces them, `flush` does not store them, and
  a cancel, reap or removal drops them.
- A turn's `turn.reply` (and what memory records after it) is stored with
  its `turn.ended`, not before: journal readers see no reply until the turn
  ends, and a cancelled or reaped turn stores none.
- A background task's child turn begins as a task's turn: origin `task`,
  with a `task` (`TaskRef`: the task's and the parent's ids) on
  `BeginTurn.Task`, `AdmittedTurn`, `TurnToAdmit` and the stored
  `turn.started`, no longer as a user's turn with `command.task`.
  `TurnOrigin` and `NotResumable`'s reasons gain `task`. A session that has
  stored a task turn cannot be read by 0.14 or earlier.
- `start_task` no longer adds `runId` to the task's `meta`; the starting
  turn is recorded as `task.started`'s `startedBy`.
- Only a task's own session (origin `task`) is refused from starting tasks;
  a host's fork of a conversation may now start them.
- `@xandreed/core`: the remaining ids are branded: `SubjectId`,
  `ArtifactId`, `SectionId`, `CandidateId`, `ProviderToolId`, `ToolCallId`
  on `assistant.message` tool calls, `StreamPartId`, `SkillId`,
  `SkillReferenceId`, `CapabilityToolId`, `CapabilityId` (`Capability.id`)
  and `PluginInstanceId` (`PluginEntry.id`).
- `@xandreed/plugin-models`: `AccountId` and `InstallationId` on
  `CredentialInput`; the chat wire's tool-call ids are `ToolCallId`.
- `@xandreed/evals`: `ActionId`, `ToolInvocationId`, `TraceStepId`,
  `DecisionCaseId`, `RetrievalDocumentId`, `RetrievalItemId`.
- Brands are type-only: stored data is unchanged, and every journal and
  report still decodes.
- `@xandreed/plugin-models`: retries move to the HTTP boundary. One logical
  call's attempt cap and deadline include its configured fallback; model
  methods, body decoding and toolkit callbacks have no outer retry ladder.
- `@xandreed/core`: `definePlugin`'s `requires` and `optional` take service
  keys (service classes or References), and a plugin's layer may need only
  the services `requires` lists; a layer needing another one no longer
  compiles.
- Activating a plugin without a service its `requires` lists fails with
  `requires.missing`, naming the plugin and the service, before its layer is
  built (it used to die mid-activation as `plugin.defect`).
- `@xandreed/core`: `RunTools.handlers`, `StepRequest.handlers` and
  `McpBridge.handlers` are typed `Context<ToolHandlers>` (new export)
  instead of `Context<never>`.
- `@xandreed/core`: `defineTool` takes `requires`, the services its handler
  reads (a Reference needs no entry); a handler reading an unlisted service
  no longer compiles. `RegisteredTool.handler` requires nothing, and
  `RegisteredTool.requires` lists the declared keys.
- A run lacking a service one of its tools declares fails to open its tools
  with `requires.missing`, naming the tool and the service, before its
  first step (it used to fail that call mid-turn as a `ToolDefect`).
- `@xandreed/core`: `TaskExecutor.turn` and `react` require `Tasks`; the
  tasks plugin provides its own around the turns it hands over, and
  `agentTaskExecutor` adds it to the turn's services. `tasksConformance`
  checks it (`executor-tasks`).
- `@xandreed/core`: a prompt section's `render` can no longer read services
  it does not declare: `PromptSection.render` needs no services, and a
  section that reads services is built with the new
  `definePromptSection({ id, version, tier, order, requires, render })`. A
  render missing a declared service fails with `requires.missing`, naming
  the section and the service, instead of dying mid-turn. `inCaller` is
  removed.
- `@xandreed/core`: `StepRequest` gains a required `callPolicy`
  (`Option<ModelCallPolicy>`): the `CurrentModelCallPolicy` where the run
  was prepared, which the step loop provides to its dispatch checks and
  model calls.
- A custom `StepLoop` must provide all of `StepLoopReferences`
  (prompt-cache key, call policy, trace content, empty-response tolerance,
  current step), whatever its caller's; `stepLoopConformance` checks each.
- `@xandreed/plugin-models`: `LanguageModelLive`,
  `LanguageModelSelectionLive` and `UtilityLlmLive` read
  `CurrentModelEndpoints` and `ModelsTransport` once, when they are built;
  values provided only around a call are ignored.
- `@xandreed/plugin-agent-loop`: `RunLoopOptions` takes `<Tools, E, R>`, and
  `runLoop`'s callbacks fail with `E`: a callback's failure fails its step,
  or the run once the step settled, as that failure, typed. The run fails
  with `E`, a provider's `AiError` or a `HarnessError` (`loop.truncated`,
  a reply cut short).
- `@xandreed/evals-cli` drops its `./*` export: a subpath import such as
  `@xandreed/evals-cli/cli.adapter` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
  The root exports every name those modules published.
- `@xandreed/plugin-session-sqlite` records the session database's schema
  version (`PRAGMA user_version`) and applies the migrations a file lacks
  when it opens it, under the write lock. A database written by a newer
  release fails to open with `SessionLogError` code `store.version`, its
  tables neither read nor written; before, it was opened and could be
  damaged.
- `@xandreed/core`: a `Credential`'s secrets (`key`, `access`, `refresh`)
  are `Redacted`; `AuthStore.set` takes them `Redacted`, and `get` and `all`
  return them that way. `accountId`, `installationId` and `baseUrl` are
  left out when unset, never `undefined`. `auth.json` is unchanged, legacy
  flat-string keys included.
- `@xandreed/core`: `authStoreConformance` compares credentials by value
  through the schema and adds the `redacted` check (`get` and `all` hand
  out every secret `Redacted`).
- `@xandreed/plugin-models`: both auth stores refuse a credential whose
  secret is not `Redacted` with an `AuthError` that names the provider,
  never the value, and write nothing.
- `@xandreed/plugin-models`: the OAuth sign-in and refresh helpers keep
  tokens `Redacted` from the token endpoint's answer on:
  `exchangeAnthropicCode` and `exchangeOpenAiCodexCode` return `Redacted`
  access and refresh tokens (`RefreshedTokens`, `OpenAiCodexTokens`), and
  `refreshAnthropicToken` and `refreshOpenAiCodexToken` take the refresh
  token `Redacted`. Types only; requests and `auth.json` are unchanged.
- `@xandreed/evals`: calibration compares a metric with its label by one
  rule, `compareMetric` (new export). A probability grade against a boolean
  label agrees when `p >= 0.5` equals the label, and counts as a false pass
  at `p >= 0.5` against `false` and a false fail under 0.5 against `true`;
  before, it always disagreed, so a model judge calibrated against
  pass/fail labels could not pass. `summarizeCalibration` and
  `compareCalibrationMetric` measure two probabilities (exact equality)
  instead of reporting them unavailable.
- `@xandreed/evals`: `EvaluationRunStore` gains `appendTranscript`. The
  runner appends each transcript event through it and calls `writeTrial`
  only when a trial starts, settles and is graded, no longer once per
  event.
- `@xandreed/evals`: `Evaluator.run` may fail with `EvaluationError` as well
  as `AssessmentError`, and so may `projectEvaluatorInput`'s projection;
  code that handles only `AssessmentError` handles `EvaluationError` too.
- `@xandreed/core`: `stepLoopConformance` puts the caller's values of
  `StepLoopReferences` in the request's `handlers` too, as a turn's services
  carry them, and checks that the loop's own values still win there. A
  custom `StepLoop` that provides `request.handlers` inside its own
  references now fails the cache-key and call-policy checks.
`@xandreed/evals` removes the exports it had deprecated:

- `assess`, `assessAll`, `EvaluatorBinding`, `EvaluationResult` and
  `summarizeAssessments` (and `validateBindings`, never exported from the
  root): an evaluator grades only behind a grader, `graderFromEvaluator`.
  Its verdict is a `Grade` in the run, `gradeEvaluation` regrades saved
  work, and the run's grades and `runGates` are the summary.
- `evaluatorRegistry` and `EvaluatorRegistration`: register each evaluator
  as a grader in the app's `graders`, which `parseEvaluationApp` checks for
  duplicates; a task binds it as `<id>@<version>`.
- `evaluationScores` and `EvaluationScore`: `exportableScores` and
  `ExportedScore`.
- `validateEvaluationApp`: `parseEvaluationApp`, the same check.
- `@xandreed/core`, and `@xandreed/sdk`, which re-exports it, no longer
  name what core's subpaths hold. Import:
  - from `@xandreed/core/conformance`: `ConformanceCheck`,
    `ConformanceFailure`, `bashConformance` (`BashFixture`, `BashSubject`),
    `fileSystemConformance` (`FileSystemFixture`, `FileSystemSubject`),
    `inMemoryLog`, `memoryConformance`, `modelCatalogConformance`,
    `probeCall`, `sessionLogConformance`, `sessionLogRecoveryConformance`
    (`SessionLogSubject`), `sessionsConformance` (`SessionsInstance`,
    `SessionsProcess`, `SessionsSubject`), `stepLoopConformance`,
    `taskRunnerConformance`, `tasksConformance` (`TaskRunnerFixture`,
    `TasksDependencies`, `TasksFixture`), `textReply`,
    `toolRegistryConformance` (`ToolRegistryLimits`), `turnConformance`;
  - from `@xandreed/core/models` (or `@xandreed/plugin-models`, which
    re-exports them): `AuthError`, `AuthStore`, `Credential`,
    `EngineSettings`, `SETTINGS_KEYS`, `SettingsError`, `SettingsStore`,
    `ModelRole`, `SettingsKey`, `authStoreConformance`
    (`AuthStoreConformanceOptions`, `AuthStoreRefreshProbe`),
    `settingsStoreConformance` (`SettingsStoreConformanceOptions`);
  - from `@xandreed/core/engine`: `TurnLive`, `cacheKeyOf`, `runTurnLoop`,
    `stepRequestOf` (`TurnRunServices`), `finishTurn`, `guardTurn`,
    `openTurnTools`, `settleTurn`, `traceTurn`, `traceTurnBegin`
    (`TurnBeginTrace`, `TurnTraceOptions`), `turnOf`, `turnTools`,
    `makeTurnEvents`, `makeTurnTasks`;
  - from `@xandreed/core/internal`, the framework's own packages only:
    `extractUsage`, `foldStreamParts`, `handoffToMessage`,
    `responseReasoning`, `responseText`, `responseToAgentMessages`,
    `responseToolCalls`, `responseToolResults`, `strictJsonSchema`,
    `toolParametersSchema`, `toPromptMessages`, `withToolCallIds`,
    `withUsageOnAssistant`.
- Removed from `@xandreed/core`, with what to use instead:
  - the session chassis (`makeSession`, `Session`, `SeqEvent`): compose with
    `Agent.define` and run each turn with `Agent.turn` over `Sessions`;
  - the spec pipeline's vocabulary (`SpecDoc`, `SpecSlug`, `SpecStatus`,
    `SpecCheck`, `SpecLimits`, `SpecGates`, `DEFAULT_SPEC_LIMITS`,
    `renderSpecSection`, `SpecDocParseError`, `decodeSpecDocText`,
    `encodeSpecDocText`, `specSlug`, `uniqueSlug`, `parseFrontmatter`), with
    nothing in its place;
  - the MCP bridge (`McpClient`, `McpError`, `McpToolDescriptor`,
    `McpCallOutcome`, `McpCall`, `McpDescribe`, `McpBridge`,
    `McpBridgedTool`, `buildMcpBridge`, `emptyMcpBridge`), with nothing in
    its place;
  - `AgentFailure`, `AgentFailureCategory` (and their `AgentFailureType`,
    `AgentFailureCategoryType` aliases), `toAgentFailure` and
    `toolResultFailure`: tell a failure apart with `harnessCodeOf` and
    describe it with `reasonOf`;
  - `LoopEvent`'s `error` variant, which only the session chassis published;
  - `Checkpoint` and `DecisionOutcome`, with nothing in their place
    (`DecisionRecord` and `recordDecision` stay);
  - `defineAgent`, `defineConfig` and `AgentDefinition`: compose an agent
    with `Agent.define`, and write a config `satisfies HarnessConfig`;
  - `HarnessConfig`'s `profile` and `profiles`, and `Profile`: fold the
    selected profile's plugins, bindings and system into the config.
    `resolveGraph` still refuses a config that carries either key
    (`config.profile`); decoding a config with the `HarnessConfig` schema
    drops them, as it drops any key the schema does not name;
  - `EngineSettings`' `sandbox` and `viMode`, and their `SETTINGS_KEYS` and
    `SettingsKey` entries. A settings file that holds them still decodes,
    the keys unread, and the local store keeps them when it writes another
    key. `settingsStoreConformance` checks `budgetMillis` where it checked
    `sandbox`;
  - the JSON helpers `asJsonRecord`, `decodeJsonLines`, `parseJsonOption`
    and `parseJsonWarn`: decode the shape that is read with
    `Schema.fromJsonString(S)` (`Schema.Json` or `Schema.JsonObject` when it
    stays open);
  - `extractModel`: use `responseModelOf`. The agent loop reads a
    response's model from the engine's stamp only (`ENGINE_KEY`), no longer
    from a `router` key on the finish part;
  - root helpers no package used: `artifactLines`, `base64Length`,
    `buildContext`, `checkModelRequest`, `ComparedModelRequest`,
    `currentTurnOf`, `defaultAnnotations`, `draftOfEntry`,
    `draftOfTurnEvent`, `draftsOfEntries`, `entriesSendingMedia`,
    `entryOfEvent`, `estimateTokens`, `ImageSize`, `imageSizeOf`,
    `isFrameworkDraft`, `latestRunOf`, `mediaAt`, `mediaFingerprintOf`,
    `modelRequestHeaderOf`, `modelRequestTools`, `normalizeMedia`,
    `orderSections`, `rawTranscript`, `readerOf`, `reconstructModelRequest`,
    `referenceTranscript`, `renderSections`, `subjectsOf`, `schemaTokens`,
    `FoldedTurn`, `StreamDelta` and `ToolResultSummary`, with nothing in
    their place; `globMatcher` (use `compileGlob(pattern)` and its
    `matches`), `toFailure` (a defect's text is `reasonOf(Cause.die(defect))`),
    `safeKeepFrom` and `stepContextOf`, with nothing in their place.
- `LoopEvent`, the events `runLoop` hands its `onEvent` sink, moves from
  `@xandreed/core` to `@xandreed/plugin-agent-loop`, the package that emits
  them. `@xandreed/core`, and `@xandreed/sdk`, which re-exports it, no
  longer name it. The type is unchanged, and no journal kind or stored
  payload changes. `ToolCallSummary`, the shape of an `assistant_message`
  event's tool calls, stays in `@xandreed/core`.
- `@xandreed/core/models` is gone: the credential and settings stores are
  `@xandreed/plugin-models`' own ports. Import:
  - from `@xandreed/plugin-models`: `AuthStore`, `Credential`, `AuthError`,
    `SettingsStore`, `EngineSettings`, `SETTINGS_KEYS`, `SettingsError`,
    `ModelRole`, `SettingsKey`;
  - from `@xandreed/plugin-models/conformance`, and no longer from
    `@xandreed/plugin-models`: `authStoreConformance`
    (`AuthStoreConformanceOptions`, `AuthStoreRefreshProbe`) and
    `settingsStoreConformance` (`SettingsStoreConformanceOptions`).

  The service keys stay `@xandreed/core/AuthStore` and
  `@xandreed/core/SettingsStore`, so a plugin's `provides` and `requires`
  and a host's bindings are unchanged. `auth.json`, the settings files and
  the kits' checks are unchanged too. `modelCatalogConformance` stays in
  `@xandreed/core/conformance`.
- `toCredential` is removed from `@xandreed/plugin-models`: a
  `CredentialInput` is a `Credential` as it is.
- `@xandreed/core/engine` is gone: the turn engine is `@xandreed/sdk`'s.
  Import `TurnLive`, `cacheKeyOf`, `runTurnLoop`, `stepRequestOf`
  (`TurnRunServices`), `finishTurn`, `guardTurn`, `openTurnTools`,
  `settleTurn`, `traceTurn`, `traceTurnBegin` (`TurnBeginTrace`,
  `TurnTraceOptions`), `turnOf` and `turnTools` from `@xandreed/sdk`. The
  turn's event bus and tasks stay in core, as root API: `makeTurnEvents` and
  `makeTurnTasks` come from `@xandreed/core` (and `@xandreed/sdk`, which
  re-exports it), beside `harnessDefectsAsFailures`.
- `toolRegistryConformance` and its `ToolRegistryLimits` move from
  `@xandreed/core/conformance` to the new `@xandreed/sdk/conformance`: the kit
  runs each check in a turn over the sdk's `TurnLive`. Its checks are
  unchanged. `stepLoopConformance` (with `probeCall` and `textReply`) and
  `turnConformance` stay in `@xandreed/core/conformance`.
- `@xandreed/sdk` no longer re-exports all of `@xandreed/core`: its root names
  each export. It exports its own `Agent` (`AgentConfig`, `AgentPluginEntry`),
  `agentTaskExecutor` and the turn engine (`TurnLive`, `cacheKeyOf`,
  `runTurnLoop`, `stepRequestOf`, `TurnRunServices`, `finishTurn`,
  `guardTurn`, `openTurnTools`, `settleTurn`, `traceTurn`, `traceTurnBegin`,
  `TurnBeginTrace`, `TurnTraceOptions`, `turnOf`, `turnTools`), and
  re-exports from core what a host writes beside `Agent`:
  - a turn's input: `UserMessage`, `mediaFromBytes`, `mediaFromBase64`,
    `RunId`, `ConversationId`, `SessionAddress`, `TurnInput`, `NewTurn`;
  - the turn and its result: `Turn`, `TurnPolicy`, `TurnOutcome`,
    `TurnResult`;
  - the sessions: `Sessions`, `SessionLog`, `SessionLogMemoryLive`,
    `TurnAdmission`, `TurnAdmissionOpen`, `TurnRefused`;
  - the host's capabilities and plugins: `defineTool`, `defineSkill`,
    `definePromptSection`, `defineCapability`, `Capability`, `definePlugin`,
    `publishToolProgress`, `Failure`, `Media`, `SessionEnvironment`,
    `ActionPolicy`, `PermissionGrants`;
  - the turn's events and their records: `TurnEvent`, `TurnEventOf`,
    `TurnEvents`, `TurnEventsService`, `onEvent`, `onTool`, `subscribeAll`,
    `defineHostEvent`, `AssistantMessage`, `TurnEndedData`, `turnEndedOf`;
  - what a turn fails with: `HarnessError`, `isHarnessError`,
    `harnessCodeOf`, `TurnBeginError`, `turnBeginCodes`, `TurnError`,
    `isTurnError`, `turnEndingOf`;
  - the process's activity: `awaitIdle`, `processActivity`.

  Every other name of core (the ports to implement and their entities,
  memory, model requests, stored payloads and journal kinds, References,
  the in-memory file system) is imported from `@xandreed/core`, and its kits
  from `@xandreed/core/conformance`.
The plugin packages export their host API only: the plugins, their layers,
configs and defaults, ports, adapters, errors and kits. What no host needs
stays inside its package, with nothing deprecated first:

- `@xandreed/plugin-models`: the OpenAI-compatible client is imported from
  `@xandreed/plugin-models/compat` only (`makeCompatLanguageModel`,
  `CompatConfig`, `toChatMessages`, `ChatMessageOptions`,
  `promptWithImageLabels`); `./compat` no longer exports `fromChatCompletion`,
  `toChatTools` or `thinkingParams`. The root drops what routes and sends a
  call: the provider builders (`buildProvider`, `chatCompletionsUrl`,
  `endpointOwnKey`, `prependClaudeCode`, `withAnthropicCacheBreakpoints`,
  `usesOpenCodeResponses`, `OPENCODE_CHAT_URL`,
  `OPENCODE_RESPONSES_API_URL`), retries and budgets (`classifyLlmError`,
  `ErrorClass`, `retryableLlm`, `rejectEmptyResponse`, `makeCallBudget`,
  `CallBudget`, `MAX_HONORED_RETRY_AFTER_MS`), `generateWith`,
  `configuredModelCatalog` (the `ModelCatalog` of
  `ConfiguredModelCatalogLive` lists the same models), `UsageReading`, the
  subscription's wire (`makeOpenAiCodexLanguageModel`,
  `toOpenAiCodexRequestBody`, `OPENAI_CODEX_API_URL`,
  `makeOpenAiCodexSessions`, `OpenAiCodexSessions`,
  `normalizeOpenAiCodexWebSocketEvent`, `openAiCodexRefusal`,
  `openAiCodexUuidV7`, `OPENAI_CODEX_SESSION_CAPACITY`, `OpenAiErrorBody`,
  and `OpenAiCodexWebSocketHttpClient`: build one with
  `makeOpenAiCodexWebSocketHttpClient(Option.none())`), the proxy's
  resolution (`resolveProxy`, `proxyFor`, `parseNoProxy`, `bypassesProxy`,
  `isLoopback`, `redactCredentials`, `ProxyConfig`, `ProxyEnvironment`,
  `NoProxyRule`, `PROXY_VARIABLES`, `BUN_WEBSOCKET_PROXY_VERSION`,
  `NODE_WEBSOCKET_PROXY_VERSION`) and `transportFetch`, the OAuth protocol's
  constants and helpers (`ANTHROPIC_OAUTH_BETA`, `CLAUDE_CODE_SYSTEM`,
  `generatePkce`, `Pkce`, `OPENAI_CODEX_CLIENT_ID`,
  `OPENAI_CODEX_CALLBACK_PORT`, `OPENAI_CODEX_CALLBACK_PATH`,
  `OPENAI_CODEX_REDIRECT_URI`, `openAiCodexAccountId`: a sign-in's
  `beginAnthropicOAuth` or `beginOpenAiCodexOAuth` result carries its
  callback port and path), and the credential helpers `authPaths`,
  `credentialsOf` and `toCredentialInput`.
- `@xandreed/plugin-memory-digest`: `digestPrompt`, `keysOf`, `outcomeOf`.
- `@xandreed/plugin-tool-discovery`: `catalogText`, `skillInstructions`.
- `@xandreed/plugin-sessions`: `SessionsState`, `HeldTurn`, `InboxSlot`, the
  state the plugin keeps in a session's head.
- `@xandreed/plugin-tasks`: `noticeOf`.
- `@xandreed/plugin-telemetry`: `tokenCounts`, `TokenKind`.
- `@xandreed/plugin-workspace`: `applyTextEdits`, `normalizeLine`.

### Added

- A connected durable-agent guide and updated framework roadmap cover storage,
  takeover, queues, steering, helper answers, shutdown and the process host.
  Framework and website examples now leave waiting turns without a final
  reply and skip normal end maintenance while a helper awaits an answer.

- `@xandreed/process-host` binds a host-supplied agent and services to protocol
  version 1 over bounded stdio NDJSON. It supports begin, durable send/steer,
  helper answers, exact-turn cancellation, activity and graceful shutdown;
  journal acknowledgments supply lifecycle events. Progress is projected by
  default, with explicit full export. The native entry handles signals and
  an independent hard deadline. Peer conformance, real child-process restart
  journeys and a retained protocol fixture cover Node and Bun.

- `LangSmithTelemetryLive` and `LangSmithTelemetryHttpLive` export traces over
  Effect's OTLP exporter to one project or registered agent/environment, with
  redacted credentials and one shared flusher. Native model operations own
  inference usage; framework wrappers remain chains and planned tool batches
  add no billed model run. Existing content-capture controls remain in force.
  Local collector and fresh-process tests verify emitted protocol and ancestry;
  live LangSmith ingestion has not been verified.

- Helpers can ask their parent without keeping a turn or worker open.
  `ask_parent` yields a waiting turn; `answer_task` stores an immutable answer
  and delivers it through the child's durable inbox for a later turn.
  `steer_task`, `cancel_task` and question-aware `task_status` complete version
  2 of the task tools. Question notices and answers use bounded data frames.
  Reconciliation repairs interrupted delivery; a full inbox defers an accepted
  answer. Explicit startup takeover can close an abandoned asking turn without
  replaying its executor. An optional InboxRunner post-end hook runs only after
  the end acknowledgment and lets the task bridge repair delivery and schedule
  parent notice reactions.

- Optional `ToolInterceptor` supplies `Allow`, `Deny`, `Rewrite` or `Respond`
  before a call and `Keep` or `Replace` after an actual handler outcome.
  Callbacks receive detached encoded JSON; rewritten inputs are reauthorized,
  synthetic responses still obey admission, and actual handler lifecycle and
  breaker evidence remain intact. One final result is acknowledged before
  presentation or digestion, with rewritten typed inputs available after reopen.

- Optional per-request `ModelRequestHook.prepare` runs in the actual run and
  step context before reserves, memory maintenance and durable request writes.
  It records one combined policy and hook StepContext and the normalized patch
  in `header.hook`. A prepared decision reuses its patch across transport,
  stream fallback, media and overflow retries; invalid output fails with
  `request.hook` before dispatch, while original turn errors remain intact.

- Add durable render snapshots anchored at the first kept turn's actual journal
  position, retaining raw render dependencies and original compaction facts in
  order. Cold opens verify and reuse the projection; late old pins and incompatible
  dependencies fall back to the full archive. The shipped `memorySnapshotConformance`
  kit and properties verify complete context equality. Selected invalid snapshots
  fail with `session.decode`; the pointed-record reader reports "The stored memory
  snapshot is invalid." Malformed overall head state retains `session.state`. Snapshots
  accelerate repeated rendering while the full archive stays eagerly loaded.

- Add the content-addressed `MediaStore` port, memory adapter, shipped kit and
  `MediaStoreDirectoryLive` in the files plugin. `withMediaStore` durably stores
  canonical image bytes before journal commits, deduplicates them across
  occurrences, and hydrates supported framework event payloads through a cache
  bounded by entries and bytes. Attachments, nested encoded results, command
  JSON, provider-executed results and media-bearing request parts retain exact
  logical values, occurrence labels and opaque JSON fields.

- `@xandreed/plugin-models`: per-call model request policy for finite shared
  attempts, header waits, pending body reads, total deadlines and capped
  Retry-After sleeps across native, compatible and subscription routes.
  `modelRequestConformance` and `ModelRequestSubject` ship through the existing
  conformance entry. Key-free Agent and packed Node/Bun fixtures cover mixed
  failures, fallback reservation, cancellation, read progress and one durable
  tool execution.

- Provider-neutral `ModelFailureKind`, failure stamps and helpers, with nine
  published codes for context, authentication, invalid requests, rate limits,
  quota, availability, invalid responses, timeouts and unknown failures.
  Native HTTP 200 overflow stops and raw SSE failures retain their meaning
  before SDK normalization; known permanent failures cause no duplicate
  request, fallback or tool handler. Their causes preserve raw diagnostics
  and known usage without request credentials. Ordinary output-limit cuts
  retain bounded correctives. Local Agent and packed Node/Bun fixtures
  verify failure codes, request replay and zero tool admission.

- Per-model Messages prompt-cache policies: Auto and TopLevel with five-minute
  or one-hour lifetimes, and Off. Automatic breakpoints share the four slots
  with caller controls and avoid the volatile tail. Gateway `cacheControl`
  can disable cache fields, including SDK nulls, while preserving application
  JSON. Settled, streamed, object and helper calls share the prepared-payload
  guard; packed Node and Bun journeys cover all policies and signed replay.

- Configured Anthropic Messages endpoints with opaque x-api-key or bearer
  authentication, version headers and merged beta flags. Static per-model
  thinking, effort and limits honor request-policy precedence and validate
  model-specific combinations before calls. Profiles include Fable 5.1,
  Opus 5.5, Sonnet 5.5 and Haiku 5.5; neutral model catalog limits expose
  documented metadata without inventing unknown model capacities. Routed
  request headers retain public Messages controls for replay without keys.

- Scoped automatic inbox execution with `InboxDrainLive`, explicit owner
  scopes, fixed workers, startup/local/periodic discovery, bounded backoff,
  interrupted-root resumption before queued work, and startup-only takeover.
  SDK's `agentInboxRunner` executes prebegun turns through the agent without
  owning their ends; the core `InboxRunner` kit checks its contract.
  `WaitingInput` and `DrainActivity` make queued and running work observable.

- Optional workspace image fitting through the new `ImageResizer` port and
  `imageResizerPlugin`, backed by installed ImageMagick, libvips or sips.
  Larger reads fit provider byte/pixel limits and an optional host side
  limit, preserve source files and expose scalar original-image metadata.
  The CLI has bounded attempts, scoped cleanup and `images.unavailable`
  activation failures; the portable conformance kit includes valid PNG
  fixtures and careless-adapter checks.

- Durable in-turn steering: each pending `delivery: "steer"` input is
  taken as its own normalized user message at a started step, before
  planning its request. A final reply or a host completion verdict still
  checks for new input; hard limits leave untaken input queued. An empty
  final probe leaves later arrivals for the next turn. Taken inputs are
  acknowledged by their durable message and receipt, so interruption
  replays them without redelivery. Attachments follow normal image budgets
  and omission, and steering intent survives transcripts, ledgers and
  digests. Child task turns receive the same writer steering;
  `agentTaskExecutor` also forwards optional in-memory `steering` to child
  and reaction turns.
- `QueuedInput` and `Sessions.enqueue` persist normalized user messages,
  attachments, source metadata and delivery (`steer` or `next`) once per
  input id. A changed payload under that id fails with `InputConflict`
  (`inbox.input-conflict`). `BeginTurn.Queued` atomically claims one input
  with an initial `input:<id>` key; later attempts use distinct keys. A
  manual resume reclaims the original pending input, so completing it
  prevents a second queued execution. `drain` can select inputs, notices
  or both. Task reactions drain notices only.
- Tool-call durability: the assistant's calls and each admitted call's
  `tool.started` are stored before handlers run, and final results are
  stored individually as they return, before host views and optional digest-on-write
  work. A process stopped mid-step keeps the pending calls and results
  already returned. `toolCallStatesOf` and `ToolCallState` in
  `@xandreed/core` report what the journal proves: requested, started,
  returned without a stored result, completed, or refused. Resumed memory
  answers a call lacking a result with `ToolInterrupted`: it may have run,
  so check the current state before calling it again. That repair is
  rendered only. `assistant.message` and its usage now precede handlers.
  Presentation metadata is appended as `memory.tool-presentation` after
  the raw result, without copying its encoded value or image bytes. The
  renderer keeps interleaved runs' results with their own requests, and
  `toolInputOf` gives views, digests and compact views the matching input
  when a provider call id is reused. The
  goldens reflect the new event and journal order; stored format is 4.
- Workspace grep probes once for ripgrep through the Bash port, with a
  bounded search, patterns on stdin, optional ignore-file handling and the
  builtin fallback. Its description states the chosen syntax and line-width
  behavior; grep view 4 reports partial timeout results and the environment
  section states when ignore files are honoured.

- `@xandreed/plugin-workspace`: `localSystemPlugin.parentEnv` sets the
  host's base environment for shell lookup and per-command inheritance.
  `workspaceToolsPlugin` gains `workspaceAccess` and extra `roots`, each
  readable or writable; the most specific real root decides writes,
  including paths through symbolic links. Read-only writes return
  `ReadOnly`. The `workspace.environment` section (version 2) describes the
  configured roots and access, and says shell commands are unconfined.
  These file-tool guards apply with `confine`;
  bash remains unconfined. `protect` and path-shaped `exclude` globs stay
  relative to the workspace; bare excluded names apply at every search
  root. Defaults preserve the existing environment and workspace access.
- `@xandreed/core`, `@xandreed/plugin-tool-discovery`: the provider's call
  id reaches tool handlers as `CurrentToolInvocation.toolCallId`, every
  `tool.*` event and `onTool` subscribers. Direct toolkit calls may omit
  it. The journal keeps the optional id on `tool.started`, `tool.refused`
  and `tool.completed`; stored format is now 3, and older records still
  decode.
- A step is as honest as its response. `assistant.message` carries the
  response's `finishReason` (`FinishReason` in `@xandreed/core`, effect/ai's
  list: `stop`, `length`, `content-filter`, `tool-calls`, `error`, `pause`,
  `other`, `unknown`), and `step.usage` stores it (optional, stored format
  2). `@xandreed/plugin-agent-loop` resolves tool calls itself: the model
  call returns them unrun and unchecked, and the loop runs them, through
  the step's toolkit, only once the response is whole and every call names
  a tool the step has with parameters that decode; otherwise none of them
  runs. A response is whole when it ends `stop`, `tool-calls` or `pause`,
  or `unknown` (no finish reason given) with no tool call the loop would
  run, so a reply of text alone without a finish reason completes as
  before. A response cut short runs no call: each is answered with the
  failure `ReplyCut`, whose message says how the reply ended (for a reply
  cut at the output limit, "Your reply reached the output limit, so this
  call was not run. Call it again if you still need it."), and the step
  ends with the new status `truncated`, with no completion evaluated. A
  reply cut at the output limit gets a corrective under the next step, at
  most twice in a row (`engine.corrections` kind `reply-cut`): a reply
  holding tool calls the loop would run is told the calls it made were not
  run, and to call the tools it still needs again, fewer in one reply; any
  other, to continue from where it stopped. The next step's input is
  compacted and steered as after any step the run goes on from. A third
  cut in a row, or any other cut, fails the run with the new code
  `loop.truncated`. A `pause` continues the run. The text of a reply the
  run continues (a paused one, or one cut at the output limit holding no
  tool call the loop would run) is carried: the run's text
  (`RunResult.text`) is the carried text followed by the reply that
  finishes it, and holds the carried text when the step cap ends the run
  first. `stepLoopConformance` checks the finish reasons, the cuts, their
  count in a row and the carried text (`cut`, `cut-stream`, `cut-fail`,
  `cut-reset`, `cut-text`, `cut-unknown`, `pause`, `finish`).
- A turn time limit: `timeLimitMs` on `BeginTurn` (`User`, `Inbox`, `Task`),
  `NewTurn` and the `drain` options, else the sessions plugin's new
  `turns.timeLimitMs` (6 hours by default). Past it, the instance holding
  the turn stores its end as interrupted with the new code
  `turn.time-limit` (resumable, an inbox attempt counted) and closes its
  writer with `TurnClosed` of the new reason `timed-out`, so `Agent.turn`
  interrupts the turn's body. `sessionsConformance` checks it
  (`time-limit`).
- `ProcessActivity.stopping`: whether this process's shutdown began
  (`TurnShutdown.stopping`), so a `/ping` can answer 503 and a load
  balancer send it no more turns; the events guide's ping does.
- A shutdown within a deadline: `shutdownGracefully({ deadline, reserve })`
  in `@xandreed/core` refuses every new begin, waits until idle for the
  deadline less its reserve (`DEFAULT_SHUTDOWN_RESERVE`, 2 s), then closes
  the turns still running and waits out the reserve, returning a
  `ShutdownReport` (`idle`, `interrupted`, `left`). `agent.shutdown(options?)`
  runs it over the agent's runtime services (a deadline of
  `DEFAULT_SHUTDOWN_DEADLINE`, 25 s, unless `AgentConfig.shutdown` gives
  one), and with `AgentConfig.shutdown` closing the agent's scope runs it
  before the agent's plugins close. The new port `TurnShutdown`
  (`@xandreed/core/TurnShutdown`), provided by `SessionsLive`: `refuse` fails
  every begin with `TurnRefused` of reason `shutdown` (`isShutdownRefusal`),
  deliveries still stored; `interrupt` stores each held turn's end while the
  log is open, as interrupted with the new code `turn.shutdown` (resumable,
  no inbox attempt counted), and closes its writer, so `Agent.turn`
  interrupts the turn. A background task refused by a shutdown now stays
  pending for the next process's `reconcile` instead of failing with
  `task.refused`. `sessionsConformance` (`shutdown`) and `tasksConformance`
  (`shutdown`) check it. `Sessions.cancel` and the shutdown close a turn
  through one commit (`closeOpen`).
- `@xandreed/plugin-session-files`: crash tests against real processes,
  on Bun and, in `verify:packages`, on Node: a writer SIGKILLed while it
  commits leaves whole commits, one killed between writing and linking a
  commit committed nothing, one killed after the link committed, and two
  processes racing by compare-and-swap lose no update
  (`EFFERENT_SESSION_FILES_MOUNT` runs them on a mount). The first commit a
  handle makes to a session now removes the temporary files a stopped
  writer left for revisions taken since.
- `@xandreed/plugin-session-files`: the session log as files in a
  directory, on Node 24 and Bun, local or on a network mount
  (`SessionLogFilesLive(path)`, `makeSessionLogFiles(path, options)`,
  `sessionFilesPlugin`, `sessionLogFilesPlugin`). One immutable file per
  commit, published by an exclusive hard link: no locks, and a stopped
  process blocks nobody. A torn commit at a session's tail is set aside in
  `quarantine/` and the commit before it is the head; a file system call
  that does not answer within `stallMs` fails with the new code
  `store.stalled`. It passes `sessionLogConformance`,
  `sessionLogRecoveryConformance` (on Bun and, in `verify:packages`, on
  Node) and `sessionsConformance`.
- `takeOver` on `BeginTurn` (`User`, `Inbox`, `Task`), on `NewTurn`
  (`agent.turn`) and on `Sessions.drain`: the host's word that the holder of
  the session's open turn is gone (a restarted process). The opening commit
  closes a turn still held at once, whatever its lease, as `interrupted`
  with the new code `turn.takeover` (resumable, its inbox items waiting
  again with no attempt counted), and the same begin may resume it. A
  holder still running is fenced at its next write. `sessionsConformance`
  checks it (`takeover`).
- `STORED_FORMAT` in `@xandreed/core`: the version of every shape the
  framework stores in a session log (journal payloads, `SessionHeader` and
  `SessionLogEvent`, the tasks plugin's records, the sessions plugin's head
  state), format 2 as of this release (format 1 before the finish reasons
  and the `truncated` status above). `bun run docs:generate` fingerprints
  the shapes into `docs/stored-format.json` and fails on a change that does
  not bump it. `@xandreed/plugin-sessions` stamps every session it writes
  with the format, and refuses a session a newer release stamped for
  `begin`, `deliver`, `drain`, `cancel`, `transact` and `fork` with a
  `SessionLogError` of code `session.version`, writing nothing; `get`,
  `list` and `read` still read it. `sessionsConformance` checks the refusal
  for a subject that gives `newerFormat`. Journal fixtures record their
  `storedFormat`.
- `@xandreed/plugin-models`: the `thinkingPrefixMismatch` option
  (`provider-default`, `drop_block`, `error`; default `drop_block` for
  eligible adaptive thinking). `provider-default` sends no binding field.
  For a Claude model that binds thinking to the conversation (Fable 5.1,
  Opus, Sonnet and Haiku 5.5 and later), effective Adaptive thinking sends
  the selected `drop_block` or `error` behavior with its
  beta, and the thinking blocks the provider then drops are counted as
  `llm.thinking.dropped` (by reason), put on the call's span and logged.
- `reasonOf(cause)` in `@xandreed/core`: a cause as one line of text that is
  safe for reports, stored records and model-facing failures (`code:
  message`, `interrupted`, or the defect's message; never a stack).
- `authStoreConformance(store, { refresh?, corrupt? })` and
  `settingsStoreConformance(store, { writable, corrupt? })` check
  single-flight refresh, a logout during a refresh, and damaged backing
  data (`AuthStoreConformanceOptions`, `AuthStoreRefreshProbe`,
  `SettingsStoreConformanceOptions`). `AuthError` and `SettingsError` have
  an optional `code`.
- `TurnResult.pending`: the inbox items the end of a turn `Agent.turn`
  began left waiting (a background task's result delivered while it ran,
  for example). Drain them with `Sessions.drain`.
- `runCliMain` (with `CliProcess` and `nodeProcess`), `readJson` and
  `readText` in `@xandreed/evals-cli`; `EvalPath` in `@xandreed/evals`.
- The routed model's `generateObject`; `makeOpenAiCodexSessions`,
  `OpenAiCodexSessions`, `OPENAI_CODEX_SESSION_CAPACITY` and
  `OpenAiErrorBody` in `@xandreed/plugin-models`.
- `hostNote`, `framed`, `escapeFrame`, `clipTo` and `clippedMarker` in
  `@xandreed/core` for model-facing text; `recall_context` takes an
  `offset`; `summaryTimeoutMs` (60 s) and `digestTimeoutMs` (30 s).
- `isHarnessError(value)` in `@xandreed/core`: matches a `HarnessError` from
  any installed copy of core. The framework uses it, so a code from another
  copy no longer becomes `loop.failed`, `task.turn` or a defect.
- `mergeOptions` and `PartialOptions` in `@xandreed/core`.
- `frameworkDraft`, `isFrameworkDraft`, `unmarkedReservedDraft`,
  `RunIdReused`, `TaskConflict` and `turnBeginCodes.RunIdReused`.
- `retrievalItems`, `RetrievalItem`, `RetrievalJudge` and
  `semanticRetrievalGraders(judge, { rubric })` in `@xandreed/evals`, whose
  rubric fingerprint follows the prompt; `GrepResult.unreadable` and
  `GrepUnreadable` in `@xandreed/plugin-workspace`; the bash kit's
  `backpressure` check, with `BashSubject.holdsBack`.
- `isFrozenRefusal(error)` in `@xandreed/plugin-render`: whether a
  `RenderStore` refused a write because the surface is frozen.
- `assessmentOfAiError` in `@xandreed/evals` turns a failed model call into
  an `AssessmentError`: `unavailable` when the provider may answer on a
  retry, `provider` otherwise, with the reason first in the message
  (`RateLimitError: …`) and the `AiError` as the `cause`.
  `EvaluationError` and `AssessmentError` take an optional `cause`.
- `harnessCodeOf(error)` in `@xandreed/core`: a failure's framework code,
  whichever copy of core made it. `HARNESS_CODES`/`HarnessCode` publish
  every code the packages raise or store, and
  `harnessError(code, message, cause?)` builds a `HarnessError` of one.
- `HarnessError`, `SessionLogError` and `UtilityError` take an optional
  `cause` (encoded as name and message, never the stack). New:
  `SessionContended`, the `TurnBeginError` union, the `TurnError` type,
  `isStoreBusy` and `errorCodeOf`.
- `turnBeginCodes` comes from `@xandreed/core` (still exported by
  `@xandreed/sdk`) and gains `SessionContended: "session.contended"`.
- `reasonOf` is exported from `@xandreed/evals`: a failure's cause as
  report text (`code: message`), never a stack.
- `isTurnError` in `@xandreed/core`.
- `readStored(kind, events)` in `@xandreed/core` decodes a session's
  `turn.started`, `turn.ended`, `inbox.queued`, `inbox.dropped`,
  `step.usage` and `request.prepared` records (`StoredData`, `Stored`), and
  `readStoredKeys` decodes only a turn's `runId`, `key` and `entry`, or a
  request's `runId` and `step`, never a user's message or its images.
- `buildProvider`'s result names its route: `anthropic`,
  `openai-responses`, `openai-codex` or `compat`.
- `@xandreed/plugin-session-sqlite`: every `SessionLog` call is a span
  (`session_log.create`, `head`, `list`, `read`, `commit`, `remove`) that
  ends with the call's failure; calls that name a session carry
  `efferent.session.id`, and opening the SQLite file is a
  `session_log.open` span.
- Spans at three more boundaries: the local `Bash`'s `exec` opens
  `bash.exec`, the `render_component` tool's output `render.emit`, and the
  skills directory `skills.settle` when an agent is built; each records its
  failure.
- `foundry check` runs as one `foundry.check` span above
  `foundry.pipeline`.
- `@xandreed/evals`: evaluations are traced. `runEvaluation` opens
  `eval.run`, each trial `eval.trial` (`eval.run.id`, `eval.trial.id`,
  `eval.suite.id`, `eval.task.id`, `eval.candidate.id`, `eval.sample`),
  `gradeEvaluation` `eval.regrade` and each trial's grading `eval.grade`;
  `calibrateGrader` opens `eval.calibrate`. Logs under a trial or a grade
  carry the same ids. The semantic evaluator, the retrieval graders and the
  pairwise check open `eval.semantic.run`, `eval.retrieval.assess` and
  `eval.pairwise`; the judges' spans keep their names.
- `@xandreed/evals-langfuse` and `@xandreed/evals-langsmith`: an export is
  one `eval.export` span carrying `eval.exporter` and `eval.run.id`.
- Traces show memory and background tasks: `memory.open` for each memory
  session a turn opens (window and summary), `memory.summarize` and
  `memory.digest` for each summarizer and digester call (failed when the
  call fails or times out), and `tasks.start`, `tasks.status`, `tasks.list`,
  `tasks.cancel` and `tasks.reconcile` with `efferent.session.id` and, for
  one task, `efferent.task.id`.
- `@xandreed/core`: `traceTurnBegin({ session, runId, origin })` opens an
  `agent.turn.begin` span around a turn's begin, beside `agent.turn` under
  the caller's span (`efferent.session.id`, `efferent.run.id`,
  `efferent.origin`, then `efferent.turn` or the refusal's
  `efferent.failure.code`); `turnAttributes` and `sessionAttributes` give
  the id keys spans and logs share.
- `@xandreed/sdk`: `Agent.turn` begins a turn it begins itself under
  `agent.turn.begin`, and every log line inside a turn carries
  `efferent.session.id`, `efferent.run.id` and `efferent.turn` as
  annotations.
- `@xandreed/evals`: `EvaluationApp.observability`, a `Layer` with no error
  that `efferent-eval` provides around each command that loads the app
  (for example `Layer.orDie(OtlpTelemetryFromEnv())`). Such a command is one
  `eval.cli` span carrying `eval.command`, over `eval.run`, its trials, its
  grading and its exports; the layer closes with the command, so its spans
  are flushed when the command ends or is interrupted. `parseEvaluationApp`
  keeps the field and refuses a value that is not a Layer.
- `@xandreed/core`: `TurnLive` records a turn's reply under
  `turn.persist_reply` (a child of `agent.turn` carrying the turn's ids),
  `collectSkillFiles` runs as `skills.collect`, and each
  `SessionLogMemoryLive` operation is a `session_log.<op>` span with
  `efferent.session.id` when it names a session.
- Traces show sessions: every `Sessions` call but `changes` is a
  `sessions.<op>` span with `efferent.session.id`, and `sessions.begin`
  sits under `agent.turn.begin` when `Agent.turn` begins the turn.
- Traces show a turn's writer: each commit is a `turn_writer.commit` span
  under the span of the call that asked for it, plus `turn_writer.flush` and
  `turn_writer.end`, all with the turn's ids; the store's own spans under a
  commit carry them too.
- `@xandreed/core` exports the turn's vocabulary from one place:
  `TurnOrigin`, `TurnOutcomeKind`, `TurnFailure` and `StepStatus`, and
  `TurnEvent` carries the tagged-union helpers (`cases`, `guards`,
  `isAnyOf`, `match`).
- `@xandreed/core` exports `TurnContextBody`, the `LogBody` member for a
  TurnContext entry.
- `@xandreed/sdk`: `agentTaskExecutor(agent, { services, child?, react? })`,
  a `TaskExecutor` that runs a task's turns through an agent.
- `Tasks.start` accepts `startedBy`.
- Sessions kit check `task`; the Tasks kit checks a task's origin and that a
  host's fork may start tasks.
- `@xandreed/evals-langfuse` and `@xandreed/evals-langsmith`: an optional
  `timeoutMs` (default 300 000) bounds a whole export, `flush` included;
  past it the export fails as `provider`.
- `@xandreed/plugin-models` exports `LLM_CALL_BUDGET_MS` as the default total
  request bound; `CurrentModelRetryPolicy` configures each call's bounds.
- `@xandreed/core` exports `provideDeclared` and `ServiceKeys`, and the
  published codes include `requires.missing`.
- `toolRegistryConformance` checks the open's `requires.missing`, and that
  a handler sees its declared services as they were where the tools were
  opened.
- `@xandreed/core`: `foldStreamParts`' `onDelta` may fail; the fold fails
  with its error.
- `@xandreed/core` has four more entries. `@xandreed/core/conformance` holds
  every port kit, `ConformanceCheck`, `ConformanceFailure` and `check`, the
  helper a kit's checks are built with; it is semver like the root.
  `@xandreed/core/models` holds the credential and settings stores
  (`AuthStore`, `Credential`, `AuthError`, `SettingsStore`,
  `EngineSettings`, `SETTINGS_KEYS`, `SettingsError`) and their kits; it
  moves into `@xandreed/plugin-models` in the next minor release.
  `@xandreed/core/engine` holds the turn engine (`TurnLive` and the turn's
  run, lifecycle and bus); it moves into `@xandreed/sdk` in the next minor
  release. `@xandreed/core/internal` holds the provider mapping, stream fold
  and tool schemas the first-party packages share, with no semver.
- `@xandreed/plugin-models` re-exports the credential and settings stores'
  contracts and kits (`AuthStore`, `Credential`, `AuthError`,
  `SettingsStore`, `EngineSettings`, `SETTINGS_KEYS`, `SettingsError`,
  `ModelRole`, `SettingsKey`, `authStoreConformance`,
  `settingsStoreConformance` and their option types), which move there in the
  next minor release.
- `@xandreed/evals` exports `errorCodeOf(error)`: a foreign error's string
  `code` (`ENOENT`) as an `Option`, the evals packages' copy of core's
  reader. The evals CLI's file reads use it; a missing file is still
  `missing`, any other failure `persistence`.
- `store.version` in `HARNESS_CODES` and the event reference.
- `@xandreed/evals`: `exportableScores(encodedRun)` and `ExportedScore`, the
  scores a run's exporters send (each boolean, probability and score metric
  of a scored grade, with its key and remote-id seed), so a custom exporter
  can send the same list.
- `@xandreed/evals`: `graderFromEvaluator({ definition, input, evaluator,
  timeoutMs }, services)` puts an `Evaluator` behind a grader: each grade
  decodes the grading context's input with `input` and runs the evaluator
  with `services` within `timeoutMs` (default 90 s), keeping the grader's
  metrics; an input that does not decode is an `invalid` grade.
- `@xandreed/core`: `isRevisionConflict` tells a `RevisionConflict` by its
  tag, from any copy of core: retry a compare-and-swap over a `SessionLog`
  with `Effect.retry({ times, while: isRevisionConflict })`.
- `@xandreed/core`: `LogBody`, `CompactionAction` and `BashEvent` carry the
  tagged-union helpers (`match`, `matchOrElse`, `guards`, `isAnyOf`,
  `cases`).
- `@xandreed/core`: `messagesOf(cause)`, a cause as text the model reads:
  each error's and defect's message alone, without the code, tag or class
  name `reasonOf` puts before it for logs and reports.

### Changed

- `@xandreed/plugin-models`: managed Node HTTP now always uses scoped undici
  agents with header/body timeouts disabled, direct and through proxy target
  and CONNECT pools. Effect owns request bounds; the global dispatcher stays
  unchanged. An explicit Fetch Reference remains authoritative on the managed
  direct route; proxies and explicit `ModelsTransport` retain precedence.
  Router watchdog, in-flight handler counting and tool-handoff retry machinery
  are removed.

- `@xandreed/plugin-agent-loop`: each tool call the loop runs is its own
  `loop.tool_call` span under its step's `engine.turn` (attributes
  `engine.tool`, the tool's name, and `engine.tool.call_id`), and the tool
  registry's `tool.<name>` nests under it, no longer under effect/ai's
  `LanguageModel.*` span of the model call. effect/ai's toolkit writes the
  call's `tool` and `parameters` on that span, where it wrote them on the
  model call's span before, one call's over another's. A cut response's
  calls, answered without running, have none.
- `@xandreed/core`: `extractModel` is deprecated in favour of
  `responseModelOf`; it still reads `router.model` until the next minor
  release.
- `@xandreed/plugin-models`: a routed call's `providers.generate` span
  encloses its credential (a new `models.credentials` span: an endpoint's
  own key, or the AuthStore's, a token refresh included) and the provider's
  build; the `llm.*` counters and `llm.request.duration` still count the
  request alone. A `UtilityLlm` completion is a `models.utility` span, and
  logs written during a routed call carry the model as `llm.model`.
- `TurnPrompt.turnSections` fails with `turn.unstarted` before
  `persistMessage`, even when the turn has no turn-tier sections, and does
  nothing after the reply.
- `@xandreed/foundry`: rule checks receive the workspace (its root and the
  program's source files) as `RuleContext.workspace`, beside the file and
  the checker.
- Core's source is laid out by role, with no change to its API: the
  provider mapping, the stream fold, tool schemas and the JSON, glob and id
  helpers are in `src/internal/`, and the turn engine (`TurnLive`, a turn's
  run, lifecycle and bus) is in `src/engine/`. `@xandreed/core` and
  `@xandreed/sdk` export the same names as before (`api/` is unchanged).
  The boundaries gate now layers core by role (model, ports, logic, core,
  engine, kits, tests; `packages/core/AGENTS.md` has the table), so a port,
  an entity or a helper that imports the engine fails `bun run typecheck`.
- `@xandreed/plugin-models`: `toCredential` is deprecated (a stored
  `Credential` is used as it is); `toCredentialInput` keeps a credential's
  `Redacted` secrets and brands its ids (`AccountId`, `InstallationId`).
- The Langfuse and LangSmith exporters share the `exportableScores`
  mapping; payloads, score names and remote ids are unchanged, so exporting
  a saved report again still updates the records earlier exports made.
- An evals export receipt's `at` comes from Effect's `Clock`.
- `@xandreed/evals`: `evaluationScores` and `EvaluationScore` are deprecated
  in favour of `exportableScores` and `ExportedScore`.
- `@xandreed/evals`: `assess`, `assessAll`, `validateBindings`,
  `EvaluatorBinding`, `EvaluationResult`, `summarizeAssessments`,
  `evaluatorRegistry` and `EvaluatorRegistration` are deprecated, to be
  removed one minor release later.
- Requests send tool-call params, tool results and provider options with
  their keys sorted at every depth (the canonical JSON order fingerprints
  use), including the request right after a call. Stored data and
  fingerprints are unchanged; existing sessions send what they sent before.

Model-visible text (exact pins and the compaction golden updated):

- Workspace tools: with nothing in `exclude`, `find` and `grep` describe
  only the symbolic links they skip (no "nothing"), and the environment
  section leaves the exclude line out. No-match lines name the workspace
  root in words (`No matches for x in the workspace root.`, no `..`).
  Counts agree with their noun (`1 entry`, `1 path`, `1 more line`,
  `1 file`, `1 matching line`); the `ls`, `find` and `grep` views are
  version 2. A refused directory says to give a file's path (`write`,
  `edit` and the file-system refusal); `edit`'s file-too-large refusal
  says to change the file with bash. A file-system refusal is in words for
  every reason, and `WorkspaceMissing` names the reason and that no
  workspace tool can run, never the backend's message (which held host
  paths). A regular expression that does not compile reads `… is not a
  valid regular expression; the engine says: …. Pass literal: true …`
  (no nested parentheses), and a refused `grep` glob is named as given,
  not as rewritten (`**/<glob>`).
- Background tasks: a failed task's notice says what went wrong in words
  (`the task's session was too busy: …`, `… could not be read or stored`,
  `… was cancelled`), never a tag name; a long reply is clipped by
  `clipTo` with a counted marker (`[… N characters clipped]`) in place of
  `(cut at N characters)`; `TasksUnavailable` no longer names the failed
  tag and says to try later.
- Tool discovery: `ToolCallLimit` reads `at most once`/`N times per turn`
  and says to use the earlier results; `SkillLoadLimit` and unknown skills
  say what to do next (`Unknown skill: x; load_skill takes the skills the
  catalogue lists`); core's `capability.forbidden` names each tool and the
  permissions it needs.
- Agent loop: the default correctives and the degenerate-loop nudge are
  host notes. The malformed corrective says why the reply could not be
  used (a tool it does not have, parameters that do not match, a reply
  that does not decode) and lists the step's tools; a parameter report is
  framed (`<parameter-errors>`) and clipped, and a decoder's schema dump is
  never quoted. The incomplete corrective no longer names an action the
  step may not offer. A host's own `correctives` are sent as they are.
- Memory: a dropped-turns ledger clips each request and reply with a
  counted marker and lists the subjects the tools reported framed as data
  (`<known-subjects>`); the summarizer's transcript leaves out a reply
  that repeats its turn's last assistant text. Ledgers already stored
  render as before.
- Model-visible text: `render_component`'s parameters each carry a
  description, and its release hashes reach the model with their
  `^[a-f0-9]{64}$` pattern (it was dropped from the JSON Schema);
  `recall_context`'s `UnknownLocator` refusal ends with what to do:
  `; pass a locator exactly as a shortened result shows it`.
- Every failure a first-party tool returns to the model is named in
  PascalCase for what is wrong; a host's code is mapped to such a name
  where the tool builds its `Failure`. The model now reads:
  - every tool, refused by tool discovery: `Forbidden` → `PermissionDenied`
    (a permission the turn lacks), `Denied` → `PolicyDenied` (the host's
    `ActionPolicy`);
  - `load_skill`: `skills.unknown` → `UnknownSkill`, `capability.forbidden`
    → `PermissionDenied`;
  - `render_component`: `invalid` → `InvalidComponent`, `forbidden` →
    `ComponentNotAllowed`, `unavailable` → `RendererUnavailable`,
    `conflict` → `OperationIdReused`, `storage` → `StorageUnavailable`;
  - the workspace tools, for a file-system failure: `Exists` →
    `AlreadyExists`, `NotEmpty` → `DirectoryNotEmpty`, `Permission` →
    `AccessDenied`, `Invalid` → `InvalidPath`, `Io` → `FileSystemError`, and
    `Invalid` → `BrokenSymlink` for a link to nothing;
  - `edit`: `Ambiguous` → `AmbiguousMatch`, `Overlap` → `OverlappingEdits`,
    `Binary` → `BinaryFile`.
- Model-facing text no longer shows a tag, code, enum value or reason name;
  it says what happened in words:
  - `grep`'s note on files it could not read: "a file-system error: q", "no
    longer there: …", not "a file-system error (Io): q" (view version 3);
  - `read`'s compact form of an image it could not send: "too large to
    send", "more pixels a side than the limit", not "TooLarge" (view
    version 2);
  - `bash`'s compact form: "killed at its timeout", "killed by SIGTERM",
    "stopped before it finished", not "timeout", "signal", "interrupted"
    (view version 2);
  - `WorkspaceMissing`: "the workspace directory does not exist, so …", not
    "cannot be opened (NotFound), so …";
  - a background task's notice: "[Background task t-1 stopped before it
    finished]", "was cancelled", "was interrupted", not "partial",
    "cancelled", "interrupted";
  - `ToolDefect`: the defect's message alone, "x is not a function", not
    "TypeError: x is not a function" or a tagged error's tag.
- The messages of `loop.failed` (the agent loop), `request.model` (the
  models plugin's router), `plugin.activation` and `plugin.defect`
  (`definePlugin`) hold the failure's messages without its tag or class
  name (`messagesOf`): "Test.generateText: the provider was down", not
  "AiError: Test.generateText: …". The failure is still their `cause`. A
  background task's notice shows these messages to the model.
- Host codes are unchanged: `RunTools.activate` still fails with
  `skills.unknown` and `capability.forbidden` (and `HARNESS_CODES` keeps
  them), `FsError.reason`, `UiOutputError.code`, `TaskStatus`,
  `BashTermination` and the `tool.refused` reasons are as they were, and
  results store them. Stored tool results keep the names they were recorded
  with.
- `toolRegistryConformance` (`@xandreed/sdk/conformance`) checks that a
  refused call's result, and `load_skill`'s refusal of an unknown skill and
  of an ungranted one (the new `load-refusal` check), carry a PascalCase
  `error`, never a host's code.

### Fixed

- A turn's writer on one instance no longer writes into a session another
  instance removed and created again under the same id. Its commits matched
  the new session's revision and landed there, its turn's events and its
  state over the new session's. The sessions plugin now names the session's
  incarnation in every commit, and the stale writer's next write fails
  `TurnClosed` (`removed`). The file store also reads the session's header
  again right before it links a commit, so a session replaced while the
  commit wrote its file gets nothing.

- Host policy for tools and the workspace. Tool discovery keys its
  nested-call marker to the gates a running handler can hold (its registry's
  per-tool permits, its turn's lanes), so a run of another agent or turn
  inside a tool handler waits on its own lanes and permits instead of
  refusing parallel calls with `ToolConcurrency`; recursive calls into held
  gates still refuse rather than deadlock. Workspace `grep` refuses a pattern
  with a line break (`InvalidPattern`) in both engines, where ripgrep read
  each line as a separate pattern and returned false matches; the builtin
  engine caps each file at a quarter of the limit whenever it searches a
  directory, as ripgrep does, a one-file directory included; and
  `grepEngine: "auto"` no longer runs `rg` over a FileSystem and Bash that
  may not share a tree (an in-memory FileSystem beside a machine shell
  searched the machine's disk). Writes are refused when a read root or a
  `protect` glob matches them without regard to letter case, so a
  case-insensitive file system that keeps spellings cannot reach a read-only
  root or `.GIT/config` through another spelling. The image CLI creates its
  conversion directory `0700` and files `0600` (`umask 077`) rather than
  leaving a workspace image readable to other local users, and refuses a
  source declaring more than `maxSourcePixels` before any converter decodes
  it. Loop protection limits are decoded at `Agent.define` and per run, so an
  invalid policy fails before any provider call instead of inside the loop.

- `@xandreed/plugin-models` model calls:
  - A successful body that loses its connection (a reset, a socket that breaks
    off) is a Transient failure (`model.unavailable`), not a permanent
    `model.invalid-response`. A stalled stream on a model that binds thinking
    reports `model.timeout`; its body is no longer re-wrapped and decoded as
    an SDK failure.
  - A settled request whose headers take longer than `requestTimeoutMs` is no
    longer cut and sent again (a second generation). A response that keeps
    arriving is no longer cut at the call's total deadline.
  - A call policy's effort, including the persisted `reasoningEffort`, is
    clamped to the nearest level a documented Messages model supports (xhigh
    becomes high on Opus 4.6) instead of failing every call. An explicit
    per-model `effort` the model refuses still fails before I/O.
  - A configured fallback sends at once instead of waiting out the primary
    provider's backoff and `Retry-After`. `retry-after-ms` and decimal
    `retry-after` seconds are honoured, as the provider SDKs read them.
  - Helper completions (`UtilityLlm`) place no automatic prompt-cache
    breakpoint, so a one-shot helper prompt no longer pays the cache-write
    premium.
  - Bun's fetch no longer cuts managed calls at its own 300 s header and idle
    timeouts.
  - Claude Mythos 5 and 5.1 have profiles with their Fable counterparts'
    controls; Mythos 5.1 binds thinking and gets `drop_block` by default.

- `@xandreed/plugin-session-files`: a native call that never answers no
  longer fails healthy calls. Its slot stays held until it settles (the
  handle's capacity lowered by one meanwhile), and healthy calls queue for
  the slot left within their admission deadline instead of failing with
  `store.stalled`; a cooldown probe still never waits.
- `@xandreed/plugin-session-files`: removing a session moves it away before
  listing its children, so a child created meanwhile never outlives its
  parent; a session removed while a `head`, `read`, `list` or `commit` reads
  it is `SessionMissing` (left out of a listing), not `store.io`; a handle
  that read a torn tail puts back a whole commit it moved by name (another
  writer published that revision again after another handle set the torn one
  aside); a commit's `notAfter` is checked again right before its link; an
  open sweeps what stopped creates and link probes left in `staging/` (names
  now carry their storage time; an earlier release's names are left alone);
  and a handle caches at most 1,024 sessions and 65,536 commit first lines,
  a read storing what it read once.
- `@xandreed/plugin-sessions`: a begin whose opening commit fails with a
  store error (a stalled write that may land later) lets the turn it planned
  go, by its number and run id, so if it did land the next begin, delivery or
  drain on the instance reaps it, instead of the session staying busy (until
  the process exits, under process ownership). A turn's time limit stops when
  the turn ends or is closed from elsewhere, not only when its scope closes.
- `@xandreed/core`: `shutdownGracefully` counts closing the turns in the
  reserve: a store that does not answer no longer holds the report past the
  deadline (the turns still closing are reported as interrupted and counted
  in `left`, and their closing goes on).

- The inbox drainer no longer retries one failing input forever ahead of the
  rest: after `attempts` failed or partial runs, or a run stopped by its time
  limit or the host, it parks the input (still queued, never dropped) and runs
  later input. It resumes an interrupted turn only when its holder was gone or
  an earlier process left it, never after a time limit or an in-process
  interruption, and its startup takeover names the turn the sweep saw, never
  one begun since or held by this instance. A runner that interrupts itself
  counts an attempt. A turn's own writes no longer wake a full rescan, and a
  rescan reads only sessions that changed. `WaitingInput` keeps a bounded set
  of quiet sessions in a persistent map instead of copying every session ever
  observed on each read. `Agent.activity` and `Agent.shutdown` count the
  caller's `DrainActivity`, and `Sessions.drain`'s takeover no longer closes a
  turn begun between its own turns.

- `answer_task` under a wrong or stale question id told the parent model to
  "ask one question per turn"; it now gets its own pinned refusal pointing it
  at `task_status`. `@xandreed/process-host` no longer stops on a burst of more
  than `maxPendingWrites` concurrent events (a writer waits for a free slot for
  at most `writeTimeoutMs`) or, in full event mode, on one event that is not
  JSON (it is sent as its labelled projection with a warning); peer disposal
  reports `Closed` to interrupted writers. The protocol reference states that
  Bun reports writes to a closed stdout as successful (exit 0) where Node exits
  1, and the real subprocess journey pins both runtimes and checks that a steer
  reaches the running turn's next model call. LangSmith export can select a
  workspace for a multi-workspace key (`workspaceId`, LangSmith's
  `X-Tenant-Id`), and LLM runs carry `langsmith.metadata.ls_model_name` so
  LangSmith can price them. Package `AGENTS.md` model-text tables cite the
  lines that hold each text and its pin again.

- A concurrent run of a turn is no longer told that another run's call is
  interrupted while that call is still running: a request leaves out an
  exchange of another run of the open turn until each of its calls has a
  result. The run that made the call, and every request after the turn
  ended, still answer a missing result with `ToolInterrupted`.
- A request shows a tool request's results in the order of its calls,
  whatever order the concurrent calls returned in (the journal still
  records them as they return), so a request no longer depends on tool
  timing and a provider that pairs results by position pairs them right.
- Rendering memory is linear in the log's length: the passes that copied an
  accumulated list or map per entry or per result (pairing results with
  their requests, presentations, compactions, interrupted-call repair,
  merging tool messages, replies) made a long session's every build
  quadratic, about ten seconds for 25,600 entries; it now takes about a
  tenth of a second, with byte-identical output.
- `@xandreed/plugin-agent-loop`: a reply cut short is recorded together
  with its calls' `ReplyCut` answers, so a process stopped between the two
  no longer leaves cut calls that render as `ToolInterrupted` ("it may have
  run") though they never could. `runLoop`'s `tool_start` and `tool_end`
  events carry the call's id, the one its `assistant_message` and the tail
  carry, instead of an execution id.
- `@xandreed/plugin-models`: a streamed chat completion whose body ended
  with neither a finish reason nor `[DONE]` (a dropped connection, a
  gateway that gave up) finishes `unknown` instead of `stop` or
  `tool-calls`: the loop runs none of its calls and fails the run with
  `loop.truncated`, and a call whose arguments end mid-JSON is kept with
  `{}`. A reply of text alone completes as before; `[DONE]` or a whole
  completion without a finish reason still settles.
- Minted tool-call ids hold only letters, digits and `_` and stay short, so
  a session whose history holds them can move to a provider that checks its
  pairing keys (Anthropic's `^[a-zA-Z0-9_-]+$`). An id-less provider result
  pairs with the id-less call of its own tool, in order.

- Media storage no longer slows or blocks a session as its images accumulate.
  Core's pure SHA-256 updates typed arrays in place (about nine times faster),
  the directory store hashes with the platform's SHA-256, the decorator no longer
  hashes fetched bytes a second time, and a begin's turn lookups read no image.
  One lost or damaged blob no longer makes every later begin of its session fail:
  that image becomes its label line. The decorator returns rows without an
  envelope untouched, so a newer release's or an unreferenced damaged row no
  longer fails the whole read. The directory store sweeps abandoned temporary
  files, repairs a damaged blob when its bytes are put again (keeping the damaged
  copy in `quarantine/`), and its start reads continue after short reads.
- Render snapshots no longer fail every open when their retained facts differ
  from this release's selection (they use the full archive), copy replaced
  summaries, out-of-view compaction text or cut runs' step contexts, or render
  the archive four times at open: each step-context placement is checked once by
  its first build, and the checkpoint bridge decodes its history once.

- Memory maintenance after a run can no longer cost its reply. Summaries ran
  after a run's loop and before the turn's end, so a cancel, a time limit, a
  shutdown (whose default deadline is shorter than the summary timeout) or a
  process death during a slow summary stored the turn interrupted with no
  reply, and the resume asked the model again; a failing maintenance failed
  the completed turn. The run's maintenance now runs after the turn's reply is
  recorded and sealed, still inside the turn and billed by it, on the run's
  reported input: an ordinary failure is logged and skipped, and a cancel, a
  time limit or a shutdown stops the maintenance only, the turn ending
  `completed` with its reply. A process death meanwhile ends the turn
  `completed` with its reply when it is reaped or taken over (the seal keeps
  the reply in the session's state), and it is not resumed. A run's start maintains what a cut
  or skipped maintenance left, calibrated by the last stored selected
  response, and hosts composing with `stepRequestOf` get their summaries
  again. Billed usage keeps a loop model outside the ledger beside recorded
  helpers (any call used to hide every selected response), the call recorder
  reads only its own turn's rows instead of the whole session at every turn,
  and a `budgetTokens` above a catalogued model window no longer overflows
  every run's first request.

- Retain each files adapter's physical IO slot until the original native
  promise settles, including after caller timeout or cancellation. Bound queued
  admission separately, prevent repeated cooldown probes from accumulating
  pending operations, and abandon only a cancelled call's own health probe.
  Existing commit nonce and uncertain-acknowledgment behavior is preserved.

- `@xandreed/plugin-models`: streamed chat completions without tool-call
  ids keep them empty until the loop assigns deterministic ids, distinct
  across steps, runs and turns. The SSE client no longer invents repeating
  `call_0` ids that collide in memory's tool-input and pinned-result maps.
- `@xandreed/plugin-models`: the chat completions client, settled and
  streamed, decides a response's finish reason from the wire's
  `finish_reason` before it decodes its tool calls' arguments, whatever the
  word's case: `stop`, `tool_calls`, `function_call`, `tool_use`,
  `tool_call`, `end_turn`, `stop_sequence`, `eos` and none at all (`null`,
  or a stream the server ended with `[DONE]`) are `tool-calls` when the
  response holds tool calls, else `stop` (a stream that ended with neither
  is `unknown`); `length` and `max_tokens` are `length`; `content_filter` is
  `content-filter`; `error` and `insufficient_system_resource` are
  `error`; any other word is `other`. A reply cut at `length` or by
  `content_filter` is no longer reported as `tool-calls` when it holds
  calls, and in a cut reply a tool call whose arguments do not parse is
  kept with `{}` as its parameters (the loop runs none of a cut reply's
  calls) instead of failing the response with `InvalidOutputError`; in a
  whole reply it still fails.
- `@xandreed/plugin-models`: an Anthropic subscription request no longer
  replaces the client's `anthropic-beta` header with the subscription's
  betas: they are added to it, so a document or a structured output keeps
  its own beta.
- `@xandreed/plugin-models`: a stream whose reply is signed thinking alone
  (a signature delta, a redacted block) is no longer read as empty, and a
  failure after it is final, never retried: the stream fold keeps that
  thinking as content.
- Failure text no longer carries stack traces or the local paths in them. A
  failed trial, grade or assessment records `code: message`, `interrupted`,
  or the defect's message, so `report.json`, CLI output and the Langfuse and
  LangSmith exports change wording. A tool handler that dies returns
  `ToolDefect` with the first line of its message only; the full cause is
  logged at error level with `tool` and `invocationId`.
- A background event handler that dies with a defect now fails the turn with
  that defect (`turn.defect` in `turn.ended`) instead of `events.background`
  carrying the stack. `events.background` now means a background handler was
  interrupted.
- A render publish retried after a failed commit commits the nodes the
  failed attempt left out before it completes, also after reopening; before,
  it was marked complete with a node missing.
- Two surfaces of one message no longer collide, filling a placeholder again
  in a later version no longer fails with `conflict`, a second surface's
  freeze is no longer dropped, and a frozen republish of a completed version
  records no partial completion.
- `MemoryRenderStoreLive` no longer returns other threads' or principals'
  records or receipts.
- SSE and WebSocket feed failures are logged. `sseNodePeer` drops a client
  that has not taken a write within its new `timeout` parameter (2 seconds),
  and no longer leaks its close listener.
- The file credential store refreshes an expiring OAuth token once, however
  many calls need it at the same moment; a login or logout made during the
  refresh wins; writes no longer share one temp file. Entries the plugin
  cannot read are kept on write.
- A refresh whose response leaves out the refresh token keeps the stored one
  (it used to sign the user out silently). Malformed Anthropic and OpenAI
  Codex token responses fail with an `AuthError` that never quotes the
  response, and the token request and its commit cannot be interrupted
  apart.
- Skills loaded by `load_skill` calls running at once (`toolConcurrency`
  above 1) all keep their tools active. Before, one call could drop the
  other's tools after the model was told they were available.
- A store failure while activating skills is no longer reported as a
  refusal. From `load_skill` it fails the turn; from `apply` it fails the
  call and records no "rejected" decision. Only an unknown skill or a
  missing permission rejects an activation.
- `Sessions.drain` stops at the end of a turn that leaves nothing waiting,
  instead of trying one more begin.
- A turn's reply is recorded, and its journal flushed, even when the turn is
  interrupted after its body returned.
- A cancelled turn no longer waits for the background reactions to its
  failed reply, and a failed turn waits for them for 10 seconds at most.
- A background event handler that publishes events a background
  subscription takes (its own or another) no longer deadlocks on a full
  queue, and a publisher waiting for room can always be interrupted.
- A turn is judged by how it was taken, not by the reader's ownership
  setting: changing ownership no longer holds a turn forever or reaps a live
  one.
- A turn end or lease write the store refuses is logged, and the instance
  lets the turn go instead of answering `SessionBusy` until the process
  exits.
- Ctrl-C or SIGTERM during `efferent-eval` settles running trials as
  `cancelled`, closes their worlds and exits 130; a blocking gate still
  exits 2.
- A timed-out or cancelled trial keeps the outcome its environment showed.
- `compare` no longer reports a coverage difference (exit 2) when trials ran
  in another order. Fingerprints and system-prompt section ties use
  code-unit order on every machine; a fingerprint over keys that differ only
  in case or punctuation can change once.
- `efferent-eval` accepts `--flag=value`, names its default directory after
  the run id, refuses bad counts, reports a missing file as `missing`, and
  removes temp files after a failed write.
- The LangSmith export sends encoded values (`null`, not Option objects),
  and exporting again updates the runs and feedback the first export
  created.
- An exhausted balance or quota (a 402, `CreditsError`,
  `insufficient_quota`) is a `QuotaExhaustedError`: no retries, no fallback.
  A plain 429 whose message says "quota" is a retried `RateLimitError`.
- A provider body or stream chunk that is not JSON, is `null` or has the
  wrong shape is an `InvalidResponseError`; the agent loop no longer answers
  it with corrective turns.
- `openai-codex`: a normal socket close ends the stream instead of hanging
  the call, and an `error` event before any other is answered with its
  status (a server error is retried) instead of a decode failure.
- `openai` sends the configured reasoning effort and output cap to models
  that take an effort; OpenCode chat models get `xhigh`/`max` as `high` and
  `none` as `low`; utility calls use `fastReasoningEffort`.
- The model sees an earlier summary as a `[Host note: …]` with the summary
  inside `<conversation-summary>` tags, as a record, not instructions. The
  summarizer and the digester get their input tagged as data and capped,
  with counted clips, so text planted in a tool result no longer comes back
  as authority.
- The summary transcript cap always holds. A summarizer or digester that
  fails or times out is logged and the turn goes on without the new summary
  (before, a stalled utility model hung every turn).
- Digest replies keep keys that start with digits, and summarize digests
  list the ids they must keep.
- `recall_context` returns 8,000-character pages and a recalled page is
  never spilled again; the spill preview gives the offset to read on from.
- The `start_task` description says what a fork sees, task notices cannot
  be closed by a tag in any case, and task turns are admitted with the
  starter's `meta`.
- The dispatch check compares the cache key and call policy with what the
  model call reads, instead of comparing the turn's own inputs with
  themselves.
- Completion verdicts' `awaiting` tags are trimmed and empty ones dropped;
  an untrimmed tag no longer ends the turn as `turn.defect`.
- A plugin layer that dies with a `HarnessError` keeps its code, and
  `stackPlugins` shares one memo map across its levels without leaking it to
  the layers built over it.
- `makeSession`: a turn interrupted together with its sender records its
  interrupt once, and a later `interrupt` or `shutdown` adds no stale event.
- Nested plugin options keep their sibling defaults:
  `{ inbox: { maxPending: 50 } }` no longer fails with `config.options`. An
  object of another union variant still replaces its default.
- `makeLiveLayer`: uses keep running while a replacement builds, and a
  registry closed mid-replacement no longer leaks the staged generation.
- The agent fingerprint no longer depends on the key order of options or
  bindings.
- An end the store refused no longer lets writes in after a later end.
- A store write that dies with a defect fails later writes with
  `session.defect` and is logged, instead of leaving them waiting.
- `cancel` reaps a turn nobody holds, the same way a reap does, whichever
  comes first.
- A task's child session is created only after `task.started` is stored, a
  retried start finishes a half-done one, and task store failures are
  logged as warnings.
- `BashLive` no longer gathers a command's output without bound: on Node a
  slow reader holds the command back on a full pipe (Bun reads child pipes
  ahead regardless). An error reading stdout or stderr fails the stream with
  `SpawnFailed`.
- The SQLite session log no longer blocks the JavaScript thread waiting for
  another connection's lock: it retries for up to 5 s, then fails with
  `store.busy`. It runs WAL with `synchronous = NORMAL`, and a damaged row
  fails with `SessionLogError` code `store.decode` instead of a defect
  (`list` and `read` used to say `store.io`).
- `grep` names the files it could not read (permission denied) instead of
  counting them as binary or too large. `read`, `ls`, `find` and `grep` show
  their real `limit` maximum, and a larger value is refused rather than
  quietly lowered.
- Retrieval judges get the ids they must return.
- The session logs fail a commit holding data JSON cannot represent with
  `SessionLogError` `store.encode` instead of dying, and the in-memory log
  drops `undefined` fields, as SQLite does.
- Failures the framework drops on purpose are logged: lost writes and
  cleanups at Warn, expected misses at Debug.
- Evals keep provider reasons: a rate limit, network or server failure, or
  unparseable judge output is `unavailable` instead of `error`, and every
  provider failure names the provider's reason instead of a generic class.
- Evals errors that wrap a schema, transport or provider failure keep it as
  `cause` and say what failed (`Dataset case bad does not decode: …`).
  Reasons in reports still carry no stacks or causes.
- Foundry's errors keep the failure they wrap: `GateCrash`,
  `ImplementorError`, `WorkspaceError`, `ConfigError` and `ProjectLoadError`
  gain an optional `cause` (encoded as the error's name and message, never
  its stack), set by the config loader, the baseline writer, the run sink,
  the temporary workspace, the claude implementor and the registration and
  private-text gates. `foundry check`, `foundry demo` and a crashed gate's
  finding still show the wrapped error's message.
- The evals CLI and the Langfuse and LangSmith exporters keep the failure
  they wrap as the error's `cause` and say what failed (`Cannot read
  <path>: …`, `Run <id> does not encode: …`, `LangSmith export: …`). Error
  codes are unchanged, and export receipts still hold the message only.
- `definePlugin` keeps what failed: `plugin.activation`, `plugin.defect` and
  `config.options` errors carry the original failure as `cause`, and a
  `HarnessError` a plugin's layer fails or dies with keeps its own `cause`
  when the plugin is named. Messages name the plugin and the failure's text
  (`<id> failed to activate: <reason>`), never a stack; `config.options`
  messages are the schema's message without the `SchemaError(...)` wrapper.
- `SpecDocParseError` keeps the schema's failure as `cause`; its message is
  the schema's message.
- A provider failure that ends a run (`loop.failed`), a model that cannot
  be resolved (`request.model`) and a failed utility call (`UtilityError`)
  keep the provider's `AiError` as their `cause`, and their message is its
  text (`AiError: <module>.<method>: …`).
- Plugin options that do not decode in the plugin graph (`config.options`)
  keep the schema error as their `cause`, and the message is the schema
  error's own text.
- `@xandreed/plugin-models` describes a request or response stream that
  fails with a value that is not an `Error` by its code and message instead
  of `[object Object]`, with proxy credentials redacted.
- A begin through `Agent.turn` that loses to other writers fails with
  `session.contended`, not `session.log`, and a turn that fails on it
  stores `session.contended`.
- SQLite store errors keep SQLite's error as `cause`, and `isStoreBusy`
  recognises `store.busy`.
- A task whose turn fails with `SessionContended`, `ReservedKind` or
  `SessionLogError` stores that tag's code instead of `task.turn`.
- A streamed step stores the provider metadata of its text and reasoning,
  as a non-streamed step does: Anthropic thinking keeps its signature,
  redacted thinking is no longer dropped, and the OpenAI Responses routes
  (openai, openai-codex, OpenCode `gpt-*`) keep a reasoning item's `itemId`
  and `encryptedContent`. Later requests send that reasoning back.
- The model catalog no longer throws on a credential stored under a name
  such as `toString`.
- A provider-run tool's result is stored after its call in the assistant
  message and replayed to that provider as its own, instead of as a
  `providerExecuted: false` tool message.
- A chat-completions model is no longer sent a provider-run tool as a plain
  `tool_call`.
- A pinned tool exchange survives a cut when its message also holds a
  provider-run tool.
- `replayableContext` also drops the log annotations, log spans and stack
  frame of where a context was captured, so annotations a host set there no
  longer replace the turn's ids on its logs.
- `TurnMemory.persistMessage` can be called again after memory failed to
  record the user's message, and the context entries given before it are
  kept; `TurnToolbox.open` (`openTurnTools`) can be called again after a
  failed open. Both used to refuse with `turn.persisted` / `tools.opened`.
- Render: two writers of one message no longer plan the same version: a
  store refuses a plan whose generation is not the next (`conflict`), and a
  publish re-reads the surface once and resumes or plans the next version.
- Render: `scope.fence` is enforced; a write under a fence lower than one
  the store accepted for the surface and message is `forbidden`.
- A turn's later run no longer sends an earlier run's step context, and each
  run's requests replay from their own header
  (`replayModelRequest(events, runId, step, run)`).
- A provider that sends tool calls without ids gets ids distinct across a
  session's runs and turns: `call_<turn>_<ordinal>_<step>_<n>`, and
  `call_<turn>_<ordinal>_p<n>` for a planned batch. Earlier sessions keep
  their stored ids.
- A process that stops between a turn's reply and its end no longer leaves
  an interrupted turn holding a completed reply.
- A turn whose reactions to its reply fail, or whose drain is cut, stores
  its reply as failed (text kept), not completed beside a failed end.
- A writer whose scope closes holding a completed or partial reply ends the
  turn with that outcome instead of `turn.unended`.
- A run that ends at the step cap, or that a complete verdict ends, no
  longer stores a corrective or a degenerate-loop nudge under a step that
  never runs; that leftover user message used to stay in the stored
  conversation and reach the next turn's history. `runLoop`'s `newTail` no
  longer carries it, and a run's `engine.corrections` counts only
  correctives the model was sent.
- `@xandreed/evals-langfuse`: interrupting an export aborts its ingestion
  requests, and each request has a 30 s limit and at most 2 retries.
- `@xandreed/evals-langsmith`: each request has a 30 s limit (was 90 s),
  and an interrupted export returns at once without waiting for its
  requests.
- A handed-off model response cannot trigger a transport retry or configured
  fallback, including when a direct SDK toolkit handler fails. Model timeout
  wrappers no longer enclose tool/callback work.
- Header waits and pending streamed or settled body reads obey finite policy
  bounds and the shared logical deadline (600 s by default). Owned cuts
  retain the typed `model.timeout` failure; a progressing stream can outlast
  the header timeout without being mistaken for idle network work.
- `@xandreed/plugin-sessions`: `Sessions.changes` wakes only the followers
  of the session that was committed to, not every follower of every
  session, and a follower that stops reading holds one signal instead of
  one per commit. A session's signal hub exists only while someone follows
  it, and follower streams end when the Sessions layer closes.
- The summary memory declares the `UtilityLlm` it reads each turn as
  `optional`.
- `start_task`, `task_status`, `recall_context` and the workspace tools
  declare the services they read.
- A background task's turns, run by `agentTaskExecutor`, carry the `Tasks`
  that started them: a task's own `start_task` is refused for depth, and the
  parent's reaction to a result may start another task. Before, the turns
  had no `Tasks`, so a call to a task tool died mid-turn.
- A step loop run under a caller's `CurrentAgentStep` (a run inside a tool)
  published its step events with the caller's step; the loop's callbacks
  now read its own step and empty-response tolerance.
- The models plugin's routed `LanguageModel` and `UtilityLlm` no longer
  apply settings from where they were built to their calls: a call uses its
  own call policy, prompt cache key, log annotations and `ConfigProvider`.
- `@xandreed/core`'s published declarations no longer import
  `@xandreed/sdk`, which core does not depend on: a host that installs core
  without the sdk gets every type.
- `@xandreed/evals-cli`: a running trial's events are appended to
  `trials/<id>.events.jsonl` (one JSON line each, mode 0600) instead of
  rewriting the trial file per event, whose bytes grew with the square of
  the transcript. The file is removed once the trial settles, so one left
  behind holds the events of a trial whose process died.
  `execution.json`, `report.json` and `trials/<id>.json` keep their format.
- The evals guide's examples use `Prompt.concat` (there is no
  `Prompt.merge`) and no longer call the unexported `llmEvaluator`.
- A past tool call is sent with the same bytes in every later request,
  whatever key order the session store keeps: its params, a provider-run
  tool's result and provider options were sent in the provider's order by
  the turn that made the call and sorted afterwards, which broke the
  provider's prompt-cache prefix.
- `@xandreed/plugin-agent-loop`: a `CurrentPromptCacheKey` or
  `CurrentModelCallPolicy` that a host provides around `Agent.turn` no
  longer replaces the turn's own for its model calls. The turn's services
  carried the host's value, which won over the request's, and the dispatch
  check failed the turn with `request.diverged`.
- `@xandreed/plugin-models`: a token endpoint's refusal quoted up to 200
  characters of its body, which could echo the refresh token, code or PKCE
  verifier the request sent; each is replaced by `<redacted>` before the
  body is quoted (`tokenRefusalText`).
- `@xandreed/plugin-workspace`: a file-system failure no longer passes the
  backend's message to the model, so host paths outside the workspace do
  not reach it.

### Repository

- The contributor guidance (`AGENTS.md` and the `commit-style` skill) states
  its commit and publishing rules directly, and the duplicate copy of the
  skill under `.efferent/skills` is removed. The ChatGPT subscription
  adapter keeps its OAuth originator in one constant,
  `OPENAI_CODEX_ORIGINATOR`.
- `toolRegistryConformance` adds a `concurrent-load` check, and its writer
  yields before each write, as storage does.
- The turn kit adds `pending`, `stuck-reaction` and `self-publication`
  checks, and the sessions kit adds `tenure` (it needs `processOwned`).
- `stepLoopConformance` adds a `cache-key` check.
- The sessions kit adds `run-id` and `cancel-unheld` and extends its
  `transact` checks; the tasks kit adds `task-id` and extends `start-once`.
- `bun run typecheck` fails when a package under `packages/` is missing
  from a list the gates or the build read: `CHECKED`, a boundaries layer,
  the build's `names`, the base tsconfig's `paths`, or, for a plugin, the
  plugin reference's `firstParty`. The message names the package and the
  list, and CONTRIBUTING.md lists the steps for adding a package.
- The foundry baseline must stay empty: `bun run typecheck` fails while
  `.foundry/baseline.json` holds a fingerprint, and the baseline no longer
  excuses any finding. `foundry check --update-baseline --allow-grow` warns
  that CI will refuse the grown file. A foundry config can declare
  `registration` (the lists every package must appear in) and
  `baseline: "empty"`.
- Package builds leave out test code. `verify:packages` refuses a build of
  another commit, a build from a tree with changes (`--allow-dirty` checks a
  local build) and built packages holding test code.
- The root `AGENTS.md` is rules only: a task map to the skills, a table of
  every gate rule with what it bans and how to fix it, which gates see each
  file role, how ports, adapters and plugins compose, naming rules for new
  code (`Effect.fn("area.op")` at service boundaries,
  `@xandreed/<package>/<Name>` service keys, `<thing>Plugin` exports) and a
  definition of done identical to CI. A test keeps the rule table and the CI
  commands in step with `foundry.config.ts` and `ci.yml`.
- `CONTRIBUTING.md` covers process only: Node 24.5 and the pre-commit hook,
  changelog headings, re-recording the sdk golden, when to run
  `docs:generate`, and tags resuming at `v0.14.0`. The foundry and core
  notes are brought up to date.
- The `commit-style` skill covers squash-merged PR titles and bodies as well
  as commits, with current examples and no title prefix.
- New contributor skills in `.agents/skills`: `add-plugin`, `add-port`,
  `write-model-text`, `effect-idioms`, `domain-entity`, `change-event`,
  `journey-test` and `release`. They cover registering a package or plugin,
  ports with their conformance kits, text the model reads, Effect 4 idioms
  (including `Effect.fn` spans at service boundaries), domain schemas,
  events and stored payloads, key-free journey tests, and the release order.
- Every published package has an `AGENTS.md` (with a `CLAUDE.md` link):
  what it provides and its layer, its rules, its public surface and
  plugins, the text it sends to a model with the test or golden that pins
  each (or "unpinned"), its type-erasure files, its layout and how to run
  its tests. The plugin-workspace notes take the same shape.
- Eleven new gate rules (`no-json-parse`, `no-sync-codec`,
  `no-cause-pretty-data`, `no-effect-promise`, `no-promise-all`,
  `callback-buffer-size`, `no-process-env`, `no-ambient-time-random`,
  `no-locale-compare`, `require-sort-comparator`,
  `no-instanceof-tagged-error`) and the `quality/no-private-text` gate (home
  paths, plus an optional gitignored local denylist,
  `.foundry/private-terms.txt`); `effect/no-as-never` rejects `as never as
  T` everywhere. Every violation is fixed and the baseline stays empty.
- New gate rules: `no-silent-ignore`, `no-option-unwrap`,
  `no-stringified-cause`, `no-error-code-compare`, `prefer-effect-fn`,
  `require-concurrency-option` and `architecture/role-suffix-required`;
  `match-over-tag-switch` also refuses ternary chains and
  `type`/`role`/`mode` discriminants. Rules with findings enter one package
  at a time through `include` lists, and a rule's `allow` list can only
  shrink.
- `effect/match-over-tag-switch` refuses ternary chains and
  `type`/`role`/`mode` branching in every package, and
  `effect/require-concurrency-option` runs in every package: every
  `Effect.forEach` and `Effect.all` states its concurrency (sequential where
  order, a shared resource or the first failure matters).
- `foundry check` reads the source files behind findings and the run
  history eight at a time instead of one by one.
- The render surface recognises a frozen refusal through that guard instead
  of comparing the error code, and `plugin-render` passes
  `effect/no-error-code-compare`.
- `@xandreed/evals` passes `effect/no-stringified-cause` and
  `effect/no-error-code-compare`.
- `effect/no-stringified-cause` runs over `packages/foundry`.
- `@xandreed/evals-cli`, `@xandreed/evals-langfuse` and
  `@xandreed/evals-langsmith` pass `effect/no-stringified-cause`.
- `effect/no-stringified-cause` runs over `packages/core`, and
  `effect/no-instanceof-tagged-error` runs over test code too.
- The event reference's "Error codes" section (formerly "Common turn error
  codes", now at `#error-codes`) lists every code in `HARNESS_CODES` with
  where it comes from and what it means, the store, storage, auth,
  settings, skills, capability, memory and module codes included.
  `bun run docs:generate` fails when a package raises a code that is not
  published (in any namespace but the kits' `conformance.*`), or when a
  published code has no entry.
- `runtime`, `plugin-agent-loop` and `plugin-models` pass
  `effect/no-stringified-cause`, and `plugin-models` and `plugin-workspace`
  read a foreign error's code with core's `errorCodeOf`.
- `plugin-session-sqlite` passes `effect/no-stringified-cause` and
  `effect/no-error-code-compare`.
- `effect/no-stringified-cause` and `effect/no-error-code-compare` run in
  every package. The agent guidance (`AGENTS.md`, the `effect-idioms` skill)
  covers the error model: tagged errors keep a `cause`, first-party codes
  come from `HARNESS_CODES` through `harnessError`, `Agent.turn` fails with
  `TurnBeginError` or `TurnError`, codes are read with `harnessCodeOf`
  (`errorCodeOf` for a Node or SQLite code), and errors are recognised by
  tag and fields rather than `Schema.is` of a class, which fails for an
  error from another copy of core.
- Two gate rules make boundary data decoded rather than trusted:
  `effect/no-unknown-json` (`Schema.Record(Schema.String, Schema.Unknown)`
  and `Schema.fromJsonString(Schema.Unknown)`, except as what a
  `Schema.encode*` call writes) and `effect/no-record-cast`
  (`as Record<string, unknown>`, `as { … }`). Each runs in the packages
  already clean of it and grows one package at a time;
  `effect/no-json-parse` recommends `Schema.Json` for open JSON. Foundry
  decodes a config's plugged rule packs with Schema.
- `effect/no-unknown-json` runs in plugin-render.
- `plugin-models` passes `effect/no-unknown-json` and
  `effect/no-record-cast`; its provider layer's casts (`compat.ts`,
  `providers.ts`, `router.ts`, `utilityLlm.ts`) sit on `RECORD_CAST_EDGES`
  until those files are typed.
- `effect/no-unknown-json` covers `@xandreed/evals`.
- `effect/no-unknown-json` runs in core; four files are exempt for now
  (`UNKNOWN_JSON_EDGES`: the MCP bridge, plugin entry options, the model
  request descriptor and the deprecated JSON helpers).
- `effect/no-record-cast` runs in plugin-sessions.
- `effect/no-unknown-json` runs in every package (with its shrinking
  `UNKNOWN_JSON_EDGES` allow list); its per-package list is gone.
- A streamed golden, `packages/sdk/golden/agent-stream.model.json`, pins
  every request of a streamed two-turn conversation.
- The built-in providers are one profile table in `@xandreed/plugin-models`;
  the catalog, the image and effort flags and `buildProvider` read it, with
  one builder per route, and a pin test holds every built-in selection's
  catalog entry, flags and descriptor settings to their earlier values.
- `effect/no-record-cast` runs in every package, with its shrinking
  `RECORD_CAST_EDGES`; its per-package list is gone.
- The `effect/no-provider-namespace` gate rule bans `anthropic`, `openai`,
  `google` and `router` keys in core and the agent loop, tests and kits
  aside.
- `effect/prefer-effect-fn` runs in `plugin-session-sqlite`.
- `effect/prefer-effect-fn` runs on `plugin-workspace`, `plugin-render` and
  `plugin-telemetry`.
- `effect/prefer-effect-fn` checks `runtime`, `plugin-agent-loop`,
  `plugin-tool-discovery` and `foundry`. Plugin graph resolution, the
  replaceable-module layer, the step loop, the tool registry and foundry's
  gates and rule registry are `Effect.fnUntraced`, so traces keep their
  shape.
- `effect/prefer-effect-fn` runs in `evals`, `evals-langfuse` and
  `evals-langsmith`.
- `effect/prefer-effect-fn` runs in `plugin-memory-summary` and
  `plugin-tasks`.
- `effect/prefer-effect-fn` covers `evals-cli`.
- `effect/prefer-effect-fn` covers `@xandreed/core`: service methods and
  exported effectful functions are `Effect.fn` spans, or
  `Effect.fnUntraced` for entity functions, constructors, per-event helpers
  and kits.
- `effect/prefer-effect-fn` runs in `plugin-sessions`.
- `effect/prefer-effect-fn` runs in `plugin-models`.
- `effect/prefer-effect-fn` runs in every package and its per-package list
  is gone. The effect-idioms skill states the span policy (`Effect.fn` at a
  port's boundary, `Effect.fnUntraced` for the rest), the shared span and
  log-annotation keys and every span name; the span trees show
  `models.credentials` under `providers.generate`.
- The turn's origin, outcome, end reason, failure, ending and step status
  are declared once in core and imported everywhere; `TURN_EVENT_NAMES` is
  derived from the `TurnEvent` union, and `@xandreed/plugin-render`
  re-exports core's `ConformanceFailure`. Stored data and existing exports
  are unchanged.
- `effect/branded-id-fields` sees an unbranded id inside `.check(…)` and
  `.annotate(…)` chains, inside `optionalKey`, `optional`,
  `OptionFromNullOr`, `OptionFromOptionalKey`, `NullOr`, `Array` and
  `withDecodingDefaultKey`, and behind a const declared in the same file; a
  pipe on a branded schema is no longer reported. It runs one package at a
  time over `*.entity.ts` files (`BRANDED_IDS_CLEAN`), in every package
  already clean of it, and in core's `src/domain` and `src/spec`.
- `effect/branded-id-fields` covers `@xandreed/plugin-sessions`.
- `TurnLive` keeps the turn's state as one tagged `TurnPhase`, moved by pure
  transitions in `turn-phase.entity.functions.ts`.
- The sessions plugin's turn writer keeps its state as one tagged phase
  (`WriterPhase`: open, ending, failed, closed, ended), moved by pure,
  table-tested transitions with `Ref.modify` instead of nine separate
  references; its writes, refusals and spans are unchanged. The
  `domain-entity` skill gains an "Aggregates" section that names it as the
  reference.
- `effect/branded-id-fields` runs over every package's `*.entity.ts` files
  (and core's `src/spec`); the per-package list is gone, and a test checks
  that the rule covers every checked package.
- New gate rule `effect/bounded-pubsub`, also in the vendored `effect`
  pack: `PubSub.unbounded`, or a `bounded`, `sliding` or `dropping` PubSub
  with an infinite capacity, fails outside test code.
- The sessions kit adds a `changes` check; plugin-render's
  `makeMemoryJournal` signals through `PubSub.sliding(1)`.
- A new gate rule, `effect/no-unknown-requirements`, fails an `Effect`,
  `Stream` or `Layer` type whose requirements are `unknown` (or an alias of
  it), under which a service nothing provides compiles unseen. It runs in
  every package, test code aside; the seven files that erase requirements
  today sit on a frozen `UNKNOWN_REQUIREMENT_EDGES` allow list that only
  shrinks. The vendored `effect` pack carries the rule too.
- A rule's `boundary` globs only shrink, like its `allow` list: a glob that
  names no file the rule checks, or whose files hold no match the rule
  tolerates there, fails the gate.
- The tool registry and the MCP bridge build their handlers without type
  erasure and leave the declared erasure boundary.
- `effect/no-unknown-requirements`' allow list keeps only the turn's host
  layer (`turn.port.ts`) and the sdk code that provides it: tools and
  prompt sections no longer erase their requirements.
- The boundaries gate checks cross-package imports by package name:
  `@xandreed/<pkg>[/<sub>]` must reach a layer `canImport` names, through a
  subpath the package's `exports` lists (`-tests` layers may also reach
  `testing` modules). A layer can mark subpaths `restricted`, reachable only
  when `canImport` names `<layer>/<subpath>`. A relative import that leaves
  its package fails, and `externals` lists third-party modules only.
- `tsconfig.base.json` maps each subpath the repo imports explicitly; the
  wildcard aliases are gone, so in-repo code can no longer deep-import what
  the published packages refuse.
- New gate rule `quality/exports-have-consumers`: every export of a package
  entry needs a first-party consumer (another package, a script or a
  documentation code block) or a `@public` tag; an entry may not use
  `export *`, and first-party code may not import an export marked
  `@deprecated`. It ships enabled for no entry; entries join
  `CURATED_ENTRIES` in `foundry.config.ts` as their surface is curated.
- `api/` records what each published entry exports (`kind name` lines);
  `bun run api:update` rewrites it from a fresh build. `verify:packages`
  fails when it differs from the build, or when a package's root exports a
  name declared under `src/internal/` or `src/engine/`.
- `verify:packages` checks that the packed consumer installed exactly one
  copy of `@xandreed/core` and of `effect`.
- `verify:packages` fails when a package's built declarations import
  anything but the package itself, its dependencies and peers and the
  runtime's modules, naming the file and the import; the packed consumer
  imports every published entry on Node and checks a deep import of core is
  refused.
- The boundaries gate restricts `@xandreed/core/internal` to the agent loop,
  the models plugin and the sdk, `@xandreed/core/engine` to the sdk and
  `@xandreed/core/models` to the models plugin.
- `@xandreed/plugin-render` imports and re-exports `ConformanceFailure` from
  `@xandreed/core/conformance` instead of core's deprecated root name.
- `@xandreed/plugin-session-sqlite`'s tests import the session-log and
  sessions kits from `@xandreed/core/conformance`.
- `@xandreed/plugin-tasks`'s tests import the task kits from
  `@xandreed/core/conformance`.
- `@xandreed/plugin-sessions`'s tests import the sessions kit from
  `@xandreed/core/conformance` and `traceTurnBegin` from
  `@xandreed/core/engine`, which a `plugin-sessions-tests` boundaries layer
  grants to its tests only.
- `@xandreed/plugin-tool-discovery`'s tests import the registry kit from
  `@xandreed/core/conformance` and `TurnLive` from `@xandreed/core/engine`,
  which a `plugin-tool-discovery-tests` boundaries layer grants to its tests
  only.
- `@xandreed/plugin-memory-window`'s tests read a tool's model-facing schema
  with `toolParametersSchema` from `@xandreed/core/internal`, which a
  `plugin-memory-window-tests` boundaries layer grants to its tests only.
- `@xandreed/plugin-workspace`'s tests import the file-system and shell kits
  from `@xandreed/core/conformance` and `toolParametersSchema` from
  `@xandreed/core/internal`, granted to its tests only.
- `@xandreed/plugin-telemetry`'s tests build their bus with `makeTurnEvents`
  from `@xandreed/core/engine`, granted to its tests only.
- `@xandreed/plugin-agent-loop` imports the provider mapping and stream fold
  from `@xandreed/core/internal`; its tests import the step-loop kit from
  `@xandreed/core/conformance` and the turn's bus and tasks from
  `@xandreed/core/engine`, which a `plugin-agent-loop-tests` boundaries layer
  grants to its tests only.
- `@xandreed/sdk` runs `Agent.turn` on `@xandreed/core/engine`; its tests
  import the kits from `@xandreed/core/conformance` and the tool schema from
  `@xandreed/core/internal`.
- `quality/exports-have-consumers` runs on core's five entries: every export
  is imported by another package, a script or a doc code block, tagged
  `@public` as host API, or deprecated and unused. `@public` marks what the
  docs describe for hosts and what a plugin, a port's adapter or a kit needs.
- The agent loop reads a response's model with `responseModelOrLegacyOf`
  (`@xandreed/core/internal`), which keeps reading the router's old stamp
  until the next minor release; `extractModel` is its deprecated root alias.
- The framework guide documents `provideDeclared` (with `ServiceKeys`) and the
  types of the turn's trace and run functions, and the conformance page
  documents `check`, `textReply` and `probeCall`.
- `@xandreed/runtime` names each export of its root instead of `export *`,
  and `quality/exports-have-consumers` checks it (`CURATED_ENTRIES`):
  `makeLiveLayer` is tagged `@public`. Its API is unchanged.
- `@xandreed/evals-langfuse` names each export of its root instead of
  `export *`, and `quality/exports-have-consumers` checks it
  (`CURATED_ENTRIES`): `EvaluationExportLangfuseLive` and
  `LangfuseExportOptions` are tagged `@public`. Its API is unchanged.
- `@xandreed/evals-langsmith` names each export of its root instead of
  `export *`, and `quality/exports-have-consumers` checks it
  (`CURATED_ENTRIES`): `EvaluationExportLangSmithLive` and
  `LangSmithExportOptions` are tagged `@public`. Its API is unchanged.
- `@xandreed/evals` names each export of its root instead of `export *`,
  and `quality/exports-have-consumers` checks the root and `./stats`
  (`CURATED_ENTRIES`): the exports no first-party code imports are tagged
  `@public`. Its API is unchanged.
- `@xandreed/evals-cli` names each export of its root instead of
  `export *`, and `quality/exports-have-consumers` checks it
  (`CURATED_ENTRIES`); the exports no first-party code imports are tagged
  `@public`.
- `@xandreed/plugin-render` names each export of its root and `./output`
  instead of `export *`, and `quality/exports-have-consumers` checks both
  (`CURATED_ENTRIES`): the exports no first-party code imports are tagged
  `@public`. Its API is unchanged.
- `@xandreed/plugin-agent-loop` names each export of its root instead of
  `export *`, and `quality/exports-have-consumers` checks it
  (`CURATED_ENTRIES`): the exports no first-party code imports are tagged
  `@public`. Its API is unchanged.
- New gate rule `effect/no-code-property-guard`: `Predicate.hasProperty(x,
  "code")` and `"code" in x` are refused outside test code; read a code
  with `errorCodeOf` (Node or SQLite) or `harnessCodeOf` (the framework's
  codes). Mirrored in the vendored effect pack.
- `effect/match-over-tag-switch` also refuses if-return ladders: adjacent
  `if (x._tag === …) return …` statements on one subject (and on `type`,
  `role` or `mode`), in every package.
- `effect/no-ambient-time-random` reads adapters too: an `*.adapter.ts`
  file takes the time from `Clock` like any other file (`Date.now` and an
  argless `new Date()` fail there), and may still draw from the platform
  generator (`Math.random`, `randomUUID`). The vendored `effect` pack makes
  the same distinction by file name, so a profile no longer excludes
  adapters from the rule.
- `packages/evals/fixtures/run-0.14.0.json`, recorded by
  `scripts/record-run-fixture.ts`, and `run-compat.test.ts` keep stored
  evaluation runs readable; the release checklist records one per release.
- Core's model-facing text is listed in a table in `packages/core/AGENTS.md`,
  and exact tests pin the text that had none or only a partial check: the
  dropped-turns preamble and ledger, a result's artifact lines, the agent
  loop's correctives, nudge and stop reply, the recall failures, the
  summarizer's default instructions, and the inbox turn's joined message.
- The workspace tools' model text is pinned word for word: the seven tool
  descriptions, the `workspace.environment` section, the skills' catalogue
  summaries, every result and compact view, and every refusal message.
- The Anthropic subscription's Claude Code system block and the
  `[file omitted: <type>, <name>]` label (models plugin), and the evals
  judges' structured-output names (`semantic_assessment`, an LLM
  evaluator's object name), are pinned by exact tests.
- A compaction golden, `packages/sdk/golden/agent-compaction.model.json`,
  pins what an agent sends once its memory compacts: the window strategy's
  spill preview, the `recall_context` page that reads it back, and the host
  note and ledger of dropped turns; the summary strategy's summarizer
  prompts (two summaries in consecutive turns, the second folding the
  first) and the handoff the next request carries. The journal rebuilds the
  last request of each conversation byte for byte.
- The sessions plugin's guarded commits and its turn writer, and the
  session log recovery kit, retry revision conflicts with `Effect.retry`
  instead of hand-written recursion: still immediate, the same number of
  attempts (`retries`, then `SessionContended`), the same spans, and every
  conflict in a turn's writer still reads the head again, the last one
  included.
- The model text of tool discovery, background tasks and the render tool is
  pinned by exact tests beside its source: the registry's own tool
  descriptions and every refusal and `load_skill` message, the tasks'
  failures and every no-reply notice, and `render_component`'s description,
  parameters and failures.
- `scripts/model-text-pins.test.ts` checks every package's "Model-facing
  text" table: a "Pinned by" cell that says `unpinned`, `contains`,
  `codes only` or `by reference only`, or that cites a test file or line
  that does not exist, fails the test suite. Every row pins its text
  exactly.
- Core branches over log bodies, compaction actions, provider parts and
  messages, stream parts and turn events with `Match` or the union's own
  `match` instead of if-return ladders; each renderer names every log body,
  so a new one fails to compile until it is placed. No behaviour or
  model-text change: the goldens are byte-identical.
- The step loop's event translation, the chat-completions mapping, the turn
  writer's queue, the bash tool, the render feed and the semantic answer
  check branch with `Match` (exhaustive where every case is known), and so
  do two tests. No behaviour change.
- The gate lists lose the deleted files: `UNKNOWN_JSON_EDGES`,
  `RECORD_CAST_EDGES` and `ROLELESS_FILES` shrink, `effect/branded-id-fields`
  no longer names `src/spec`, and `PROVIDER_NAMESPACE_EDGES`, now empty, is
  deleted: no file of core or the agent loop reads a provider's namespace.
- The engine's sources and tests are in `packages/sdk/src/turn/`, with
  `TurnLive`'s phase (`TurnPhase` and its transitions) and the test writer
  `recordingTurnWriter`, which only the engine used. `@xandreed/core/internal`
  gains what the engine reads of core (`entriesSendingMedia`,
  `estimateTokens`, `readerOf`, `draftOfTurnEvent`, `draftsOfEntries`,
  `renderSections`, `checkModelRequest`, `modelRequestHeaderOf`,
  `modelRequestTools`, `reconstructModelRequest`).
- The tests that need the engine moved into the sdk, which already lists
  the plugins as devDependencies: the `ToolRegistry` kit's run over the tool
  discovery plugin's registry and its self-tests
  (`tool-registry.conformance.test.ts`), that registry's tests inside turns
  (`tool-discovery-turn.test.ts`, where the plugin's model-facing texts are
  now pinned) and the sessions plugin's spans under `traceTurnBegin`
  (`sessions-begin-trace.test.ts`). No plugin depends on the sdk.
- Boundaries: the `core-engine` layer, the `core/engine` grants and the
  `plugin-agent-loop-tests`, `plugin-tool-discovery-tests` and
  `plugin-sessions-tests` layers (they only granted the engine) are gone; the
  sdk layer may import `effect/ai`.
  `scripts/api-snapshot.ts` refuses a root export declared under
  `src/internal/` (no package has a `src/engine/` any more).
- `quality/exports-have-consumers` checks the sdk's root
  (`packages/sdk/src/index.ts` joins `CURATED_ENTRIES`): a re-export of core
  that no other package, script or doc code block imports from the sdk is
  tagged `@public` at its specifier, and the sdk's own exports used only by
  its tests (the engine, `AgentConfig`, `AgentPluginEntry`,
  `agentTaskExecutor`) at their declarations. `api/sdk.api.txt` holds the
  70 names.
- The README, the framework guide and the website's getting-started, SDK and
  core pages import a host's names from `@xandreed/sdk`, and the packed
  consumers of `verify:packages` do too, on Node and on Bun.
- `quality/exports-have-consumers` checks every published entry: the plugin
  packages' roots and `@xandreed/plugin-models/compat` (now an entry file of
  its own, `src/compat/index.ts`) join `CURATED_ENTRIES`. Each entry names
  its exports, and the host API no first-party code imports is tagged
  `@public` at its declaration (a plugin's tag covers its default export).
- The registration gate requires each package's root entry in
  `CURATED_ENTRIES`, so a new package is checked from its first change.
- Every package's test code (test and bench files, `testing` modules and
  `testing/` folders, as the build leaves it out) is its own `<name>-tests`
  boundaries layer, placed before the package's layer, and only those layers
  may import a test library (`bun:test`, `fast-check`, `effect/testing`).
  The provider packages (`@effect/ai-anthropic`, `@effect/ai-openai`) are
  allowed in `plugin-models` only and Bun in `plugin-session-sqlite` only
  (`bun:sqlite`); no layer takes the raw `@effect/` or `effect/` prefix any
  more, each lists the `effect/<module>` barrels it imports by name.
- The boundaries gate checks each `import("…")` of a literal specifier, a
  dynamic import or an import type, like an import clause; fails on an
  external a layer lists that none of its files imports, so the lists only
  shrink; and no longer lets `effect` alone admit `effect/testing`,
  `effect/net` or `effect/graphql`, which are named like the other barrels.

### Deprecated

Each name below still works from `@xandreed/core` (and `@xandreed/sdk`,
which re-exports it) until the next minor release, which removes it from
the root.

- Import from `@xandreed/core/conformance`: `ConformanceCheck`,
  `ConformanceFailure`, `bashConformance` (`BashFixture`, `BashSubject`),
  `fileSystemConformance` (`FileSystemFixture`, `FileSystemSubject`),
  `inMemoryLog`, `memoryConformance`, `modelCatalogConformance`,
  `probeCall`, `sessionLogConformance`, `sessionLogRecoveryConformance`
  (`SessionLogSubject`), `sessionsConformance` (`SessionsInstance`,
  `SessionsProcess`, `SessionsSubject`), `stepLoopConformance`,
  `taskRunnerConformance`, `tasksConformance` (`TaskRunnerFixture`,
  `TasksDependencies`, `TasksFixture`), `textReply`,
  `toolRegistryConformance` (`ToolRegistryLimits`), `turnConformance`.
- Import from `@xandreed/core/models`: `AuthError`, `AuthStore`,
  `Credential`, `EngineSettings`, `SETTINGS_KEYS`, `SettingsError`,
  `SettingsStore`, `ModelRole`, `SettingsKey`, `authStoreConformance`
  (`AuthStoreConformanceOptions`, `AuthStoreRefreshProbe`),
  `settingsStoreConformance` (`SettingsStoreConformanceOptions`).
- Import from `@xandreed/core/engine`: `TurnLive`, `cacheKeyOf`,
  `runTurnLoop`, `schemaTokens`, `stepRequestOf` (`TurnRunServices`),
  `finishTurn`, `guardTurn`, `openTurnTools`, `settleTurn`, `traceTurn`,
  `traceTurnBegin` (`TurnBeginTrace`, `TurnTraceOptions`), `turnOf`,
  `turnTools`, `makeTurnEvents`, `makeTurnTasks`.
- Import from `@xandreed/core/internal`: `extractUsage`, `foldStreamParts`
  (`FoldedTurn`, `StreamDelta`), `handoffToMessage`, `responseReasoning`,
  `responseText`, `responseToAgentMessages`, `responseToolCalls`,
  `responseToolResults` (`ToolResultSummary`), `safeKeepFrom`,
  `strictJsonSchema`, `toolParametersSchema`, `toPromptMessages`,
  `withToolCallIds`, `withUsageOnAssistant`.
- Removed in the next minor release, with nothing to import instead: the
  session chassis (`makeSession`, `Session`, `SeqEvent`; compose with
  `Agent.define` and run turns with `Agent.turn`), the spec pipeline's
  vocabulary (`SpecDoc`, `SpecSlug`, `SpecStatus`, `SpecCheck`,
  `SpecLimits`, `SpecGates`, `DEFAULT_SPEC_LIMITS`, `renderSpecSection`,
  `SpecDocParseError`, `decodeSpecDocText`, `encodeSpecDocText`, `specSlug`,
  `uniqueSlug`, `parseFrontmatter`), the MCP bridge (`McpClient`,
  `McpError`, `McpToolDescriptor`, `McpCallOutcome`, `McpCall`,
  `McpDescribe`, `McpBridge`, `McpBridgedTool`, `buildMcpBridge`,
  `emptyMcpBridge`), `AgentFailure` (with `AgentFailureCategory`,
  `toAgentFailure` and `toolResultFailure`; use `harnessCodeOf` and
  `reasonOf`), `Checkpoint`, `DecisionOutcome`, `defineAgent`,
  `defineConfig` and `AgentDefinition`, a config's `profile` and `profiles`
  (with `Profile`, which `resolveGraph` already refuses), and the
  `EngineSettings` keys `sandbox` and `viMode`, which no package reads (a
  settings file that holds them still decodes).
Each name below still works from `@xandreed/core` (and `@xandreed/sdk`) and is
removed from the root in the next minor release; no package uses it.

- Media helpers: `base64Length`, `imageSizeOf` (`ImageSize`), `mediaAt`,
  `mediaFingerprintOf`, `normalizeMedia`.
- `toFailure`, `defaultAnnotations` and `globMatcher` (`compileGlob` stays).
- Memory log helpers: `artifactLines`, `buildContext`, `currentTurnOf`,
  `entriesSendingMedia`, `estimateTokens`, `latestRunOf`, `rawTranscript`,
  `referenceTranscript`, `stepContextOf`, `subjectsOf`, and `readerOf`.
- Journal drafts: `draftOfEntry`, `draftOfTurnEvent`, `draftsOfEntries`,
  `entryOfEvent`, `isFrameworkDraft`.
- Model request checks: `checkModelRequest`, `modelRequestHeaderOf`,
  `modelRequestTools`, `reconstructModelRequest` (`ComparedModelRequest`).
- Prompt sections: `orderSections`, `renderSections`.
- `schemaTokens`, `safeKeepFrom`, `ToolResultSummary`, `FoldedTurn` and
  `StreamDelta`, until now deprecated in favour of `@xandreed/core/engine` or
  `@xandreed/core/internal`, are not exported there.

## 0.14.0 — 2026-10-29

Agents that work on files and commands, images to and from the model, token
usage with cache writes and reasoning, telemetry outside evals, an HTTP
proxy, credential and settings stores that never touch disk, and a turn
lifecycle a service can run on: host metadata, real failure codes, resume,
a busy signal and lease keep-alive. 19 packages: `@xandreed/plugin-workspace`
is new, and `@xandreed/plugin-telemetry` is a new plugin under an old name.

### Migration

- Run `@xandreed/plugin-models` on Node 24.5 or newer (or Bun 1.3.0 or
  newer). It now depends on `undici`, and honours `HTTPS_PROXY`,
  `HTTP_PROXY` and `NO_PROXY` on Node too.
- `Agent.turn` returns a `TurnResult`: the outcome plus the turn's `usage`.
  Code that reads the outcome keeps working; code that builds one (a
  host-composed runner, a fake) adds `usage`.
- Build `TokenUsage` with `tokenUsage(...)` or spread `zeroUsage`: it has
  `cacheWriteTokens` and `reasoningTokens`. A custom `StepLoop` returns the
  run's `usage`, provides `captureTraceContent` and honours
  `onMediaRejected`; run `stepLoopConformance` against it.
- `Shell` is now `Bash`: `bash.exec(command, { cwd, timeoutMs, env, stdin })`,
  with `exitCode` an `Option` and `termination` saying how it ended. A
  `FileSystem` implementation adds the new methods (`walkGlob` gives it
  `glob`) and runs `fileSystemConformance`. `FileSystemLive` and `BashLive`
  for the local machine are in `@xandreed/plugin-workspace`, with the
  workspace tools (`workspaceToolsPlugin`).
- Hand-written `AdmittedTurn`, `TurnToAdmit`, `RunContext` and `Turn` values
  add `meta` (and `usage`). Exhaustive matches on `TurnEvent` handle
  `tool.progress`, `tool.refused` and `stream.fallback`; matches on
  `Sessions.begin`'s errors handle `AttachmentRejected` and `NotResumable`
  (`turnBeginCodes` maps both). A host event may not use any bus event's
  name.
- `UserMessageFromString` is removed: build `new UserMessage({ text })`.
  The memory plugins now send earlier turns' images too (`media: "inline"`);
  set `media: "none"` for label lines instead, or `maxMediaChars: 0` for
  text only. A tool view declares `media` (`defineTool` fills it).
- `modelsPlugin` is runtime-scoped: built once per `Agent.define`, and a
  per-turn `LanguageModel` now wins over it. `storage: "memory"` keeps
  credentials and settings off disk; `ModelEndpoint.apiKey` may be
  `Redacted`.
- Lease ownership renews every 20 seconds by default; set
  `renew: "on-commit"` for the old behaviour. A keep-alive must renew at
  least twice per lease (`everyMs * 2 <= ttlMs`).
- A plugin that fails to build with a `HarnessError` fails with that error's
  own code (`skills.duplicate`, `config.options`), not `plugin.activation`.
- The old `@xandreed/plugin-telemetry` options (`enabled`, `serviceName`)
  are refused: configure `telemetryPlugin` and export with an
  `OtlpTelemetry*` layer.

### Breaking

- **`@xandreed/plugin-session-sqlite`: a commit that waited past its lease is
  refused.** The SQLite log read the clock before taking its write lock, so a
  commit that waited for another connection's lock beyond its `notAfter` was
  still accepted, stamped with the time it started waiting. The clock (the
  caller's Effect `Clock`) is now read inside the IMMEDIATE transaction, in
  `commit` and in `create`: such a commit fails with `LeaseExpired`, and
  events and `updatedAt` carry the time they were written.
- **`@xandreed/plugin-session-sqlite`: lock contention fails with
  `store.busy`.** A write lock held by another connection past the 5 s busy
  timeout fails with `SessionLogError` code `store.busy`; it was `store.io`.
  A host that matched `store.io` to retry on lock contention matches
  `store.busy` now; `store.io` is left for other storage failures.
- **`@xandreed/core`: `TokenUsage` has two more `Type` fields**,
  `cacheWriteTokens` and `reasoningTokens`. Stored data still decodes:
  records without them read 0. Object literals (a `UtilityCompletion`'s
  usage, a `UtilityLlm` fake) must add them; build them with
  `tokenUsage({ inputTokens, outputTokens, ... })` or spread `zeroUsage`.
- **`@xandreed/core`: `RunResult.usage`, `AgentResult.usage`,
  `RunContext.usage` and `Turn.usage` are required.** A custom `StepLoop`
  returns the sum of the usage its `assistant.message` events carried;
  hand-written `RunContext` or `Turn` fakes add `usage`.
- **`@xandreed/core`, `@xandreed/sdk`: `Agent.turn`, `TurnRunner.turn` and
  `guardTurn` return `TurnResult`.** A host-composed runner built on
  `guardTurn` gets it as is; one that is not adds `usage`, for example from
  `RunContext.usage`. `use` still returns a `TurnOutcome`.
- **`@xandreed/core`: `TurnEndedEvent` requires `usage`.** Code constructing
  the bus event adds it; the stored `turn.ended` record is unchanged.
- **`@xandreed/core`: `step.usage` records and the usage stamp on stored
  assistant messages gain the two keys.** A reader that compares stored
  usage byte for byte (a golden) sees them. The memory context's token
  estimate and fingerprint include the stamp, so for new turns they change
  (the estimate grows by a few tokens per assistant message); requests sent
  to the model do not change.
- **`@xandreed/core`: `extractUsage` and `assistantUsage` hold the usage
  invariants.** `extractUsage` raises an input reported below its cache
  reads plus writes to them, and an output reported below its reasoning to
  it. Its last fallback, Gemini's raw usage metadata (used only when neither
  the response nor its finish part carries effect/ai usage, which no
  provider shipped here does), reads `thoughtsTokenCount` as reasoning
  inside the output: output = candidates + thoughts, total = input + output
  (it read `totalTokenCount`, and left thoughts out of the output).
  `assistantUsage` decodes the stamp: a malformed stamp reads `None` (it was
  `Some` of the stamp as found), and the usage it returns no longer carries
  the stamp's `model` key (`assistantModel` reads it).
- **`@xandreed/plugin-models`**: the finish part of `fromChatCompletion`
  and of the streaming client reports `cacheWrite`, `text` and `reasoning`
  beside the old counts; `fromChatCompletion` takes an optional
  `UsageReading` (`{ reasoning }`). The router reads each call's usage
  through `extractUsage`, so its `llm.usage.input_tokens` counter and span
  attribute are raised to the cache reads plus writes when the provider
  reports less, and `llm.usage.output_tokens` to the reasoning.
- **`@xandreed/core`: `Shell` is replaced by `Bash`.** `Shell`, `ShellError`
  and `ShellResult` are removed. `Bash.exec(command, { cwd, timeoutMs })`
  returns a `BashResult` whose `exitCode` and `signal` are Options and whose
  `termination` (`exit`, `signal`, `timeout`, `interrupted`) says how it
  ended: a timeout is `termination: "timeout"`, not a note on stderr. `cwd` is
  required. Live output comes from `Bash.stream` (chunks, then one
  `BashExit`) instead of the `onChunk` callback. A command no longer inherits
  the whole parent environment: only `BASH_ENV_ALLOWLIST` passes unless
  `inheritEnv` says otherwise. Migration: `shell.exec(cmd, { cwd, timeoutMs })`
  becomes `bash.exec(cmd, { cwd, timeoutMs })`, `result.exitCode` becomes
  `Option.getOrElse(result.exitCode, () => -1)` where a number is needed, and
  an implementation of the port adds `stream` and builds `exec` with
  `collectBashResult`.
- **`@xandreed/core`: `FsError.reason` is required.** `FsError` is now
  `{ path, reason, message }` with `reason` one of `NotFound`, `Exists`,
  `IsDirectory`, `NotDirectory`, `NotEmpty`, `Permission`, `Invalid`, `Io`,
  and is exported from the domain module (still from `@xandreed/core`).
  Migration: construct it with the reason that fits, `Io` when unsure.
- **`@xandreed/core`: `FileSystem.list` returns `DirEntry`s.** It was the
  names; it is now `{ name, kind }` sorted by name, links not followed.
  Migration: `list(dir).pipe(Effect.map((entries) => entries.map((entry) => entry.name)))`.
- **`@xandreed/core`: `FileSystem` implementations must add the new
  methods.** The port gains `readBytes`, `append`, `rename`, `stat` and
  `glob`; `write` takes `string | Uint8Array` and `{ createParents }`,
  `mkdir` takes `{ recursive }` (without it, an existing path fails with
  `Exists` and a missing parent with `NotFound`; pass `recursive: true` for
  the old create-if-missing behaviour), and `remove` takes `{ recursive }`
  and removes empty directories. `remove` follows links in the parent but
  never the last name (`link/` removes the link) and refuses the root and a
  path whose last segment is `.` or `..` with `Invalid`; a `rename` failure
  names the side that caused it (`to` for a missing parent there or what is
  in the way). Migration: implement `glob` as
  `walkGlob(list, pattern, options)` and run `fileSystemConformance`.
- **`@xandreed/core`: `TurnEvent` gains `tool.progress`.** Code matching the
  union exhaustively (`Match.exhaustive`, a `switch` with a `never` default)
  must handle it. It is transient (in `TransientTurnEvents`) and never
  journaled, so stored sessions are unchanged.
- **`@xandreed/plugin-tool-discovery`: a handler that dies with a
  `HarnessError` fails the turn.** That defect comes from a subscriber that
  failed on an event the handler published (`tool.progress`, or
  `skills.activated` from `load_skill`). It reached the model as a
  `ToolDefect` result and the turn went on; now the registry publishes
  `tool.completed` and then fails the turn with that error, as a subscriber
  failure on `tool.started` always did. A handler that wants the model to
  see a failure returns it on its failure channel.
- **`@xandreed/core`: `AdmittedTurn`, `TurnToAdmit`, `RunContext` and `Turn`
  have new required fields** for the host's turn metadata:
  `AdmittedTurn.meta` and `TurnToAdmit.meta` (`{}` when the turn was begun
  without any), and `RunContext.admitted` and `Turn.admitted` (the admitted
  turn). Hand-built values (a fake `TurnWriter`'s `admitted`, a `RunContext`
  or `Turn` stub) add them: `meta: {}`, and `admitted` as the writer's.
- **`@xandreed/core`: the bus `turn.started` event requires `meta`, and
  `context.built` requires `budgetTokens`.** Code constructing these events
  adds them. The stored `context.built` record gains `budgetTokens` (its
  journal schema keeps it optional, so records written before still decode);
  the stored `turn.started` gains `meta` only when the turn was given one,
  so turns without it are stored as before.
- **`@xandreed/sdk`, `@xandreed/plugin-sessions`: stored `turn.ended`
  records carry the real failure code.** A turn `Agent.turn` began and that
  fails is ended with `turnEndingOf` its exit: the error's own code and
  message (`host.failed`, `reaction.failed`, a `SessionLogError`'s code, a
  `HarnessError` carried as a defect), `turn.failed` for an error without a
  code, `turn.defect` for a defect; it was always `turn.unended`. A
  writer's scope, or a begin, interrupted before the turn ended stores
  `turn.interrupted`; `turn.unended` is left for a scope that closed
  without an interruption before anyone tried to end the turn. A turn
  whose `use` interrupted itself (an `Effect.interrupt` inside it) still
  ends `interrupted`; only its code changes, from `turn.unended` to
  `turn.interrupted`. An end the store refuses is tried again by the
  writer's scope with that same ending, where it used to store
  `turn.unended`. `Sessions.drain` ends a failed inbox turn with its
  error's code the same way (a `HarnessError` carried as a defect keeps
  its code): `inbox.turn` is no longer written. A drain `run` that
  interrupted itself ends `interrupted` with `turn.interrupted`, where it
  ended `failed`; it still counts an attempt for the items it took, even
  when it wrote nothing, so such an item is still dropped after
  `inbox.attempts`. Migration: a host that matched `turn.unended` or
  `inbox.turn` in stored `turn.ended` records matches the failing error's
  code, `turn.failed`, `turn.defect` or `turn.interrupted` instead (the
  event reference lists them), and a host that read a drain turn's
  `reason: "failed"` as any non-success reads `interrupted` as well.
- **`@xandreed/sdk`, `@xandreed/core`: token budgets are checked.**
  `Agent.define` fails with `config.budget` when `budgetTokens` is not an
  integer of at least 1, and a run fails with `turn.budget` when its
  policy's (or `TurnRunOptions`') is not; both were used as given. A step whose system prompt and tool schemas take the whole
  budget fails with `context.budget`: memory used to get a 1-token budget
  for the messages, so the window strategy failed with `context.budget`
  later and the summary strategy summarized at every step. Migration: pass
  a positive integer, at least the system prompt and tool schemas plus room
  for the messages (`context.built` records the run's `budgetTokens` beside
  `reservedTokens`).
- **`@xandreed/plugin-models`: `modelsPlugin` is runtime-scoped.** It is
  built once per `Agent.define`, no longer on every turn, so credentials,
  refreshed tokens and settings edits held in memory last across turns. Two
  consequences:
  - A turn's own services now win over the plugin: a `LanguageModel` (or
    `UtilityLlm`, `AuthStore`, `SettingsStore`, `ModelCatalog`) in a turn's
    `services` replaces the plugin's for that turn; before, the plugin's
    replaced the turn's. Migration: a host that passed a per-turn model only
    as a fallback drops it, or drops the plugin. A per-turn `AuthStore` or
    `SettingsStore` reaches the turn's own code only: the plugin's
    `LanguageModel`, `UtilityLlm` and `ModelCatalog` keep the plugin's stores.
  - Its `SessionEnvironment` and `HostCredentials` must come from
    `Agent.define({ workspace, services })`; an agent with a session-scoped
    plugin providing either is refused (`config.graph`: "runtime plugins
    cannot depend on session service"). A per-turn `SessionEnvironment` no
    longer reaches it. Migration: move the provider into `Agent.define`.
- **`@xandreed/plugin-models`: the local `SettingsStore` re-reads its files
  on every `load`.** With `storage: "local"` and `inheritPrevious`, the
  plugin's settings are `~/.efferent/config.json` and
  `<workspace>/.efferent/config.json` read on each `load` (the options laid
  over them), not a snapshot taken when a turn began. An edit to those files
  applies from the next model call.
- **`@xandreed/plugin-models`: `ModelEndpoint.apiKey` is `string | Redacted<string>`.**
  Code reading `endpoint.apiKey` (or `CurrentModelEndpoints`) as a `string`
  narrows it with `Redacted.isRedacted`.
- **`@xandreed/plugin-models`: `LocalSettingsStoreLive`'s `setRole` checks
  its selection.** A value that is not `"<provider>:<modelId>"` fails with a
  `SettingsError` and is not written; it was written and then ignored by the
  router.
- **`@xandreed/plugin-models`: error texts.** A missing credential says how to
  give one with either storage (it named `~/.efferent/auth.json`; logins go
  to `~/.efferent/runtime/auth.json`); "no model configured" no longer
  mentions a terminal or `efferent.config.json`; an OAuth subscription token
  without an account id, or an expired token of a provider with no refresh
  flow, no longer mention the removed CLI or "the new line". An unknown
  option of the plugin, or of one of its `endpoints`, reads "not an option of
  the models plugin" (or "of a model endpoint") with its path, without its
  value. Code matching on the old texts matches the new ones.
- **The plugin reference** (`docs/plugin-reference.json`) gains `optional`
  (the services a plugin uses when present) and `contributes` (the
  multi-provider keys it adds to, such as `Capabilities`) for every plugin,
  and the models plugin's entry its new scope and options; its graph
  fingerprint changes.
- **`@xandreed/core`, `@xandreed/plugin-sessions`, `@xandreed/sdk`:
  `Sessions.begin` can fail with `NotResumable`.** Its error union gains it,
  for a user's turn whose `resumes` names a turn that cannot be resumed.
  Code handling the union exhaustively (`Effect.catchTags` over every
  member, `Match.exhaustive`) adds a case; for a begin that never sets
  `resumes` it is never raised (`Sessions.drain` and plugin-tasks map it to
  "nothing begun"). `@xandreed/sdk`'s `turnBeginCodes` gains `NotResumable:
  "turn.not-resumable"`, so a host mapping its codes exhaustively
  (`Record<keyof typeof turnBeginCodes, …>`) adds one. A host's own
  implementation of the `Sessions` port honours the new optional
  `BeginTurn.User.resumes`: it refuses what `resumeRefusal` refuses (a
  `resumes` that is not a whole number of at least 1 as `missing`), stores
  `resumes` in `turn.started`, shows it on `admitted` and `TurnToAdmit`, and
  compares it in the key's fingerprint. The new `resumes` fields are
  optional keys, present only on a turn that resumes one, so turns, stored
  records and events without it are unchanged.
- **`@xandreed/core`: `UserMessage` may carry images, and its rule
  changed.** It is `{ text, attachments? }`: `text` is a plain string (it was
  `NonEmptyString`) and a message needs text or at least one attachment
  (`text.length > 0 || attachments`), at most `MEDIA_LIMITS.attachments`.
  Whitespace-only text is still a message, so every log written before
  decodes. Code that read `userMessage.text` as the whole message reads
  `userMessageText(userMessage)` (its text and a label line per image) where
  images matter.
- **`@xandreed/core`: `UserMessageFromString` is removed.** It was the
  memory log's text-only `TurnStarted` codec; the log's `TurnStarted` now
  stores `prompt` and, only when there are images, `attachments`, so a
  text-only entry is stored exactly as before. No replacement.
- **`@xandreed/core`: `UserRoleMessage.content` is
  `string | ReadonlyArray<TextPart | Media>`** (`UserContentPart`). A
  message with images renders as parts. Code that reads it as a string
  narrows first (`typeof content === "string"`).
- **`@xandreed/core`, `@xandreed/plugin-sessions`: `Sessions.begin` can
  fail with `AttachmentRejected`.** The error union gains it; a begin
  normalises the user's message first (`normalizeUserMessage`) and stores
  that value. A `catchTags` over every begin error adds it; `Agent.turn`
  fails with `turn.attachment-rejected` (`turnBeginCodes.AttachmentRejected`),
  its reason in the message only (a host that branches on it runs
  `normalizeUserMessage` itself first). A `Sessions` implementation of the
  host's adds it to `begin`, and should store and compare the normalised
  message as plugin-sessions does.
- **`@xandreed/core`: `RenderOptions.media` and `MemoryRenderRecipe.media`
  require `maxChars`**, the base64 characters of the images a request sends.
  A custom `MemoryPolicy.render` adds it (`MEDIA_LIMITS.requestChars`); a
  stored `request.prepared` header written before reads that value, and new
  headers store it (a golden of stored headers sees the new key). `maxImages`
  now also caps the images sent (never more than `MEDIA_LIMITS.requestImages`
  whatever it says), besides the artifact reference lines.
- **`@xandreed/plugin-memory-window`, `@xandreed/plugin-memory-summary`:
  `MemoryWindowConfig` and `MemorySummaryConfig` require `maxMediaChars`.**
  JSON and plugin configuration are unaffected (the graph merges the
  defaults); code that calls `windowPolicy` or `summaryPolicy` with a whole
  config literal spreads `memoryWindowDefaults` / `memorySummaryDefaults`
  or adds the field.
- **`@xandreed/core`: `sessionLogConformance` has a new check**: an event
  of `MEDIA_LIMITS.requestChars` base64 characters comes back whole. A host's
  store with a smaller row or document limit fails it; such a store cannot
  hold a message's images at their limit.
- **`@xandreed/core`: `memoryConformance` and `turnConformance` have new
  `attachments` checks**, which a host's memory strategy or turn
  composition that passed before can fail. `memoryConformance`: a message's
  images survive a reopen, the current turn's are built as image parts with
  their data, an earlier turn's as image parts or label lines, and no empty
  text part is built. `turnConformance`: the user's attachments are stored
  in `turn.started` and reach the first request as `file` parts. A strategy
  that renders `TurnStarted` from `userMessage.text` alone, or one set to
  send no images (`maxImages: 0`, `maxMediaChars: 0`), fails them; run the
  kits with a budget that admits one small image.
- **`@xandreed/core`: readers of 0.13 cannot read every newer log.** A
  0.13 reader drops a message's images and fails on a message without text;
  a replay of a request with images diverges there (`request.diverged`).
  Logs written before 0.14.0 decode unchanged in 0.14.0.
- **`@xandreed/plugin-memory-window`, `@xandreed/plugin-memory-summary`:
  `media` defaults to `"inline"`** (it was `"none"`). Earlier turns' images,
  a user's and those tools return, are now sent while they fit `maxImages`
  and `maxMediaChars`, newest turn first; the current turn's are sent in both
  modes, as before. Stored `request.prepared` headers record
  `"mode":"inline"` (a golden of them sees it). Migration: set
  `media: "none"` to show earlier turns' images as label lines, or
  `maxMediaChars: 0` for models that read text only.
- **`@xandreed/core`: `ToolViewDefinition.media` is required**, an
  `Option` of the selector of the images the model is sent with a result.
  Views built with `defineTool` get it (`None`: every image the result
  holds). Migration: a `ToolViewDefinition` written by hand adds
  `media: Option.none()`.
- **`@xandreed/core`: `StepRequest.onMediaRejected` is required**:
  `(reason) => Effect<boolean, HarnessError>`, called by the step loop when
  a provider refuses a request over an image. `stepRequestOf` provides it.
  Migration: a `StepRequest` built by hand (a fake in a test, a host's own
  turn) adds `onMediaRejected: () => Effect.succeed(false)`; a custom
  `StepLoop` calls it on an `InvalidRequestError` that names an image and,
  when it answers true, plans the step again and sends it once more.
  `stepLoopConformance` has two new checks for it, so a `StepLoop` that
  ignores the hook fails the kit. The next `plan` of that step, that one
  only, keeps the refused request's model choice, system prompt and
  directive; any other `plan` of a step asks the policy again.
- **`@xandreed/core`: `CompactionAction` gains `OmitMedia`.** Code that
  matches every action exhaustively adds the case. A step that is sent again
  after an image refusal publishes `context.built` and stores
  `request.prepared` a second time for that step; the dispatch check reads
  the latest header, as `replayModelRequest` does. A 0.13 reader fails on a
  log holding an `OmitMedia` compaction, and drops a tool result's `media`
  slots.
- **`@xandreed/plugin-agent-loop`: a streamed step refused over an image no
  longer falls back** to a settled call (`stream.fallback`): an
  `InvalidRequestError` that names an image, before the first part, goes to
  `onMediaRejected` (the step is sent again without the images, or fails).
  A refusal after the first part fails the step, as any failure there did.
- **`@xandreed/core`: `memoryConformance` has a new `tool-media` check**: a
  tool result's images (`ToolView.media` slots) are stored once, survive a
  reopen, and the current turn's are built as the result's images. A host's
  strategy that renders tool results from their view text alone, or one set
  to send no images, fails it.
- **`@xandreed/plugin-tool-discovery`: the raw view of a result holding
  images elides their data.** A tool without a view whose result holds
  `Media` values shows each with its `data` replaced by its fingerprint in
  the result's text, and sends the images as images; the text no longer
  carries the base64.
- **`@xandreed/core`: `skillsFromFiles` reads a whole tree, and names
  references by path.** It is now `readSkillFiles` made strict (below):
  - A reference's id is its path below the skill's directory
    (`references/formats.md`; it was `formats`), and every other text file
    of the directory is a reference (it was `references/**/*.md` only).
  - A `SKILL.md` at any depth is a skill (it was `<skill>/SKILL.md` only),
    and the files under a nested skill are its own, not its parent's. A
    `SKILL.md` at the root of the tree needs an `id` or a `name` (or
    `options.rootName`).
  - A skill's default `version` is a fingerprint of the skill as read (it
    was `"1"`), so a change to its `SKILL.md` or to a reference it serves
    changes it, and with it tool discovery's skill-selection `candidateHash`
    in decision records.
  - The Agent Skills fields are read: `name` as `id` and `description` as
    `summary` (`id` and `summary` win); the summary is made one line.
    Frontmatter is read as the YAML subset skill files use (`>` and `|`
    blocks, lists, quotes, comments, a byte-order mark, CRLF); keys indented
    under another (`metadata:`) are no longer read as top-level ones.
  - `tools` and `permissions` given as text are split on whitespace as well
    as commas (`permissions: fs write` was one permission, `fs write`; it is
    now two), and `always` is read in any case (`TRUE` is true; it was
    `true` only).
  - It fails with `skills.files` naming every issue at once
    (`<path>: <reason>; ...`), warnings included (an `always` that is not
    `true` or `false`, a frontmatter line that is not `key: value`, a
    reference over `maxReferenceBytes`, a reference whose path is not a
    valid id); it failed on the first bad skill.
  - `SkillFile` is a schema now (a value and a type), from
    `harness/skill-files.entity.ts`; the `harness/skill-files.ts` module is
    gone. Imports from `@xandreed/core` are unchanged.

  Migration: read a reference by its path
  (`read_skill_reference({ skill, reference: "references/formats.md" })`);
  a skill whose recorded decisions should keep the old version sets
  `version: 1` in its frontmatter; a file under a skill's directory that
  should not be a reference moves out of it; a `tools` or `permissions` item
  with a space in it is written as a list (`[fs write]`, or `- fs write`
  lines), since text is split on spaces.
- **`@xandreed/core`: a plugin layer that fails with a `HarnessError` fails
  with that error's code.** `definePlugin`'s `build` (what the plugin graph
  and `Agent.define` activate) turned every layer failure into
  `plugin.activation`, with the error as text in the message. A
  `HarnessError` now keeps its code and message, as it already did through
  the typed `live` layer, and `build` names the plugin when the error names
  none: `Agent.define` fails with `skills.duplicate`, `tools.duplicate` or
  `skills.tools` from tool discovery, for example. The error is told by its
  tag and fields, so one from a second copy of `@xandreed/core` keeps its
  code too. Other failures are still `plugin.activation`. Migration: a
  host that matched `plugin.activation` for these matches their own codes.

- **`@xandreed/core`: `TurnEvent` gains `tool.refused` and `stream.fallback`,
  and `LoopEvent` gains `stream_fallback`.** A call the tool registry
  refuses before its handler runs (an inactive tool, a missing permission,
  an `ActionPolicy` denial, the turn's or the tool's call limit) publishes
  `tool.refused`; it published nothing. A step loop whose streamed call
  fails before its first part publishes `stream.fallback` once per run.
  Both are journaled (`tool.refused` without its input). Migration: an
  exhaustive `Match` over `TurnEvent` or `LoopEvent` handles the new
  members; a reader of a session's journal meets the two new kinds.
- **`@xandreed/core`: every bus event's name is reserved.**
  `RESERVED_KINDS` gains the new journal kinds `tool.refused` and
  `stream.fallback`, and every `TurnEvent` name the journal does not store
  as itself (`assistant.message`, `assistant.delta`, `tool.progress`,
  `skills.activated`, `host`; `TURN_EVENT_NAMES` lists them all): a host
  event under one of them fails with `events.reserved`, a
  `Sessions.transact` draft with `ReservedKind`. The kinds reserved before
  are reserved as they were. `journalSchemaOf` has a schema for every kind
  the framework writes (`JOURNAL_KINDS`), not for every reserved name.
  Migration: rename a host event that used one of these names; code that
  looked up a schema for each of `RESERVED_KINDS` iterates `JOURNAL_KINDS`.
- **`@xandreed/plugin-tool-discovery`: a refused call has an invocation id.**
  The id (`<runId>:call:<n>`) is minted before the refusal checks, so a
  refused call takes the next number and the calls after it count on from
  there: their `invocationId`s differ from before when a turn had refusals.
- **`@xandreed/core`: `StepRequest.captureTraceContent` is required.** A
  hand-built `StepRequest` (a test, a host's own turn) adds it; `stepRequestOf`
  fills it from the policy, the agent and `CurrentTraceContent`. A custom
  `StepLoop` must provide it to its model calls as `CurrentTraceContent`,
  whatever the caller's: `stepLoopConformance` checks it. Migration: wrap
  the loop's model calls in
  `Effect.provideService(CurrentTraceContent, request.captureTraceContent)`.
- **The trace tree changes shape.** `Agent.turn` runs each admitted turn
  under an `agent.turn` span, so `engine.run` is no longer a root (nor a
  child of the caller's span). Contexts the framework captures and replays
  no longer carry the span current at capture: a `tool.<name>` span is a
  child of the model call that made the call (it was a child of the span
  where the turn's tools were opened), a handler's spans are children of
  its `tool.<name>` span, `engine.run` is a child of the span where
  `turn.run` is called, the loop's callbacks and a policy's run under
  `engine.turn` (some ran under `engine.run`), and the models plugin's
  `providers.generate` is a child of the calling span, not of the span its
  layer was built under. An inline bus subscriber's spans are children of
  the publisher's span (they were children of the span where it
  subscribed), and a session chassis turn's of the span where `send` is
  called. Span annotations and links set where a context was captured
  (`Effect.annotateSpans` around a layer's build or the turn's services) no
  longer reach the replayed work's spans, where they replaced the turn's
  ids. A parent span in `TurnInput.services` or `AgentConfig.services` is
  ignored (wrap the `Agent.turn` call in `Effect.withParentSpan` instead),
  and so is a `CurrentTraceContent` in `AgentConfig.services` (set
  `AgentConfig.captureTraceContent`); one in `TurnInput.services` still
  counts as where the turn's runs start. Migration: dashboards or queries
  keyed on root spans or parent names follow the new tree
  (`docs/framework.md`, "Traces and metrics").
- **`@xandreed/plugin-models`: Node now honours `HTTPS_PROXY` and
  `HTTP_PROXY` for model calls.** Node's fetch ignored them (unless
  `NODE_USE_ENV_PROXY` was set), so on Node every model and OAuth call went
  direct; now they go through the proxy those variables (or the new `proxy`
  option) name, except the `noProxy` / `NO_PROXY` hosts and loopback. (On
  Bun, whose fetch applied them already, only `NO_PROXY` exempts a host from
  a proxy in the environment, as before.) With a proxy set, Node calls go
  through undici's own agents rather than the global dispatcher, so a
  dispatcher a host installed with `setGlobalDispatcher` no longer applies
  to them, and on both runtimes a `FetchHttpClient.Fetch` a host provides
  around a turn no longer reaches the provider SDK calls (without a proxy
  nothing changes: the plugin then adds no transport). A proxy variable that
  is not an `http://` or `https://` URL (`socks5://...`) now fails
  `Agent.define`. Migration: to keep calls direct, set the plugin's
  `noProxy: "*"` on Node, which holds under `NODE_USE_ENV_PROXY` too and
  leaves a SOCKS proxy in the environment unread (on Bun, set `NO_PROXY=*`,
  since Bun applies the environment's proxy to fetch itself); to keep a
  custom HTTP stack or fetch, provide it as a `ModelsTransport` through
  `Agent.define({ services })`.
- **`@xandreed/plugin-models`: a proxied OpenAI subscription call fails on
  Bun before 1.3.6.** Bun 1.3.0 to 1.3.5 cannot send a WebSocket through a
  proxy, and the `openai-codex` WebSocket used to connect directly whatever
  the proxy setting; when a proxy applies to `chatgpt.com` it now fails with
  an `AuthError` (not retried, no fallback). Migration: run on Node or Bun
  1.3.6 or newer, or exempt `chatgpt.com` with `NO_PROXY`.
- **`@xandreed/plugin-models` requires Node 24.5 or newer** (`engines.node`
  `>=24.5`, was `>=24`): Node honours the `proxyEnv` option of `https.Agent`,
  which the subscription's WebSocket tunnels through, from 24.5. On older Node
  a proxied WebSocket fails with an `AuthError` rather than connecting
  directly.
- **`@xandreed/plugin-models` depends on `undici`** (`^7.30.1`), imported
  only on Node when a proxy applies; Bun never loads it.
- **`@xandreed/plugin-models`: the plugin has two more options and one more
  optional service.** `proxy` and `noProxy` join its options (the plugin
  reference and graph fingerprints change), and `ModelsTransport` its
  `optional` services: a host that provides one through
  `Agent.define({ services })` and also sets `proxy` or `noProxy` is
  refused. `LocalAuthStoreLive` is built with `Layer.effect` (it reads the
  optional `ModelsTransport` once), and the `fetch` of
  `TokenRequestOptions` and `MemoryAuthOptions` and the compat client's
  `fetchImpl` take a `ModelsFetch` (any `fetch` is one).

- **`@xandreed/plugin-sessions`: the default lease renews itself.**
  `sessionsDefaults.ownership` is `{ mode: "lease", ttlMs: 60_000, renew:
  { everyMs: 20_000 } }` (it renewed `"on-commit"`): while a turn's writer
  is open, a state-only commit extends its lease every 20 s, the first one
  20 s after the begin. A silent step longer than the lease (a slow model
  call, a long tool) no longer loses its turn; a renewal is queued in order
  with the turn's writes, so it waits for a `write` or `transact` still
  running, and those must stay shorter than the lease. Each renewal is a commit: it
  bumps the head's `updatedAt` (and so a session's place in `list`), costs
  a write on SQLite, and keeps a hung turn held while its process runs
  (`Sessions.cancel` still closes it). Tests that advance a `TestClock`
  past a lease with a writer left open, or that assert exact commit
  sequences or `updatedAt` over minutes, see the renewals. To keep the old
  behaviour, pass `ownership: { mode: "lease", ttlMs: 60_000, renew:
  "on-commit" }`.
- **`@xandreed/plugin-sessions`: the keep-alive's first renewal comes one
  interval after the begin.** With `renew: { everyMs }`, a renewal commit
  followed the begin at once; now the first one comes `everyMs` later (the
  begin's own commit set the lease), so a turn shorter than `everyMs`
  costs no extra commit. A host that already configured `{ everyMs }` sees
  one commit fewer per turn; a test that counted commits or revisions right
  after a begin, or waited for that first renewal, advances its clock by
  `everyMs` first.
- **`@xandreed/plugin-sessions`: a keep-alive slower than half the lease is
  refused.** `renew: { everyMs }` with `everyMs * 2 > ttlMs` fails the
  plugin's options with `config.options`, and so does `SessionsLive(config)`
  when its layer is built (it decodes `config.ownership`): such a renewal
  could land after the lease ran out. Lower `everyMs` or raise `ttlMs`.
- **`@xandreed/plugin-sessions`, `@xandreed/plugin-tasks`: wider layers.**
  `SessionsLive` and `SessionsPluginLive` provide `Sessions | TurnActivity`
  and fail with `HarnessError` (`SessionsLive` was `Layer<Sessions, never,
  …>`); `sessionsPlugin.provides` is `[Sessions, TurnActivity]`, so a graph
  with another plugin providing `TurnActivity` needs a binding.
  `InProcessTaskRunnerLive` provides `TaskRunner | TaskActivity`. Code that
  annotates these layers' types widens the annotation; built contexts carry
  one more service each.
- **`@xandreed/sdk`: `Agent` has an `activity` member.** A hand-written
  `Agent` value (a test fake) adds it, for example `activity:
  processActivity`.

- **`@xandreed/plugin-telemetry` is a new plugin under the old id.** The
  package and its plugin id, `@xandreed/plugin-telemetry`, belonged to a
  plugin shipped before 0.11.0 (`{ enabled, serviceName }`, exporting
  through the OpenTelemetry Node SDK). The new `telemetryPlugin` takes
  `{ prices, metricAttributes, spanEvents }` and refuses the old options
  with `config.options`. The earlier package's other exports are removed
  too: `TracingLive`, `FileLoggerLive`, `FileLoggerAddLive`, the default
  export, and the `TurnHooks` its plugin provided. Migration: drop the
  plugin's options and import it by name (`telemetryPlugin`);
  `TracingLive(serviceName)` becomes `OtlpTelemetryLive({ baseUrl,
  serviceName })` around the program, or `OtlpTelemetryFromEnv({
  serviceName })` for the `OTEL_EXPORTER_OTLP_*` endpoint it read (with
  `baseUrl: "http://localhost:4318"` in the defaults for its fallback); a
  file log is Effect's own `Logger.toFile`. npm's `@xandreed/plugin-telemetry`
  0.3.0 and 0.4.0 are that earlier plugin.

### Added

- `@xandreed/core`: every `TurnEvent` member carries a `description`
  annotation saying who publishes it, when, what its payload means and
  whether it is transient or stored.
- `@xandreed/core`: schemas for the journal kinds that had none —
  `InboxQueuedData`, `InboxDroppedData`, `StepUsageData` and
  `StoredMemoryData(body)` (the `{ entry, runId, step, at, body }` envelope of
  `memory.*` and `turn.reply`). `journalSchemaOf(kind)` gives the schema of
  any reserved kind's `data`, and none for a host's or plugin's own kinds.
  `RECORDED_ELSEWHERE` exports the bus events that memory or the session
  stores instead of the bus (`turn.started`, `turn.ended`,
  `skills.activated`). `@xandreed/plugin-sessions` writes `inbox.queued` and
  `inbox.dropped` through the schemas; what is stored is unchanged.
- `@xandreed/sdk`: `turnBeginCodes`, the `HarnessError` code `Agent.turn`
  fails with for each reason `Sessions.begin` refuses a turn.
- The event reference: `docs/event-reference.md`, its website page and
  `docs/event-reference.json` list every bus event (description, payload,
  how it is stored), every journal kind (writer, sensitive content, fields),
  the exact reserved kinds, the begin codes with suggested HTTP statuses,
  common turn error codes (every one raised under `turn.`, `events.`,
  `request.`, `loop.` and `tools.`), the `@xandreed/plugin-render` feed and
  socket frames, and the task records with their failure codes.
  `bun run docs:generate` writes it and fails when its hand-kept parts no
  longer match the code.
- `@xandreed/plugin-session-sqlite` exports `makeSessionLogSqlite(path)`, the
  scoped log `SessionLogSqliteLive` builds.
- `@xandreed/core`: `sessionLogRecoveryConformance(subject)` and
  `SessionLogSubject` (`open`, a new handle on the same data each time, and
  `callerClock`), a conformance kit for what a `SessionLog` must keep across
  handles, reopening and interruption: reopening, reopening twice, two open
  handles, racing compare-and-swap through two handles, interrupted commits,
  a handle whose scope never closed, and, with `callerClock`, the exact
  `notAfter` boundary. It runs over the memory log (Bun and Node) and the
  SQLite log, and the SQLite package adds subprocess tests: processes opening
  one new file at once, a commit waiting behind another process's lock,
  SIGKILL in the middle of commits, two processes making 200 compare-and-swap
  increments each, and turns reaped after their holder is killed under
  process and lease ownership. A new docs page, "Conformance kits", lists
  core's kits and `@xandreed/plugin-render`'s, and how to run them against
  your own adapter.
- `@xandreed/core`: conformance kits for the ports that had none with an
  adapter in the repository, each with self-tests that careless backends
  fail. `sessionsConformance(subject)` (`SessionsSubject`: `leased` and,
  optionally, `processOwned` instances over one store, and `advance` to move
  its clock; `SessionsInstance`, whose `activity` is optional, and
  `SessionsProcess`) checks a `Sessions` backend: create, get, list and
  fork; one open turn per session on every instance and one winner of a
  race; key retries and `KeyConflict` (`meta` not in the fingerprint);
  `meta` stored and admitted; every `NotResumable` reason;
  `AttachmentRejected` and `NothingPending` opening nothing; the writer's
  order and endings; `transact`; cancel and removal; the inbox (an item
  given back when its turn is interrupted, done when it is cancelled); a
  write renewing a lease; a turn whose lease ran out (left alone by a drain
  with nothing to take) and one whose process stopped reaped by the next
  begin; and, for an instance with one, `TurnActivity` counting each begin
  from the moment it is asked for and each turn per session and turn until
  its scope closes. `taskRunnerConformance(make, { interruptsOnClose? })`
  (`TaskRunnerFixture`) checks the hand-over, work outliving its caller, the
  deadline, work running without the caller's services, `TaskActivity` from
  the hand-over and the scope's close. `tasksConformance(make)`
  (`TasksDependencies`, `TasksFixture`) checks a task as one child turn
  delivered to the parent's inbox once, starting once, the result after the
  parent's turn, a fork's history, failure, cancel, depth, and `reconcile`
  starting a task that never ran and delivering a result the parent's full
  inbox refused, over the kit's own runner and executor.
  `toolRegistryConformance(make)` (`ToolRegistryLimits`) checks the catalog,
  activation, invocation ids minted before the checks,
  `CurrentToolInvocation` and the opener's services in handlers, events
  published on the run's bus only (never written to the journal by the
  registry), `PermissionGrants`, and a `tool.refused` for each reason. They
  run over `SessionsLive` (in-memory log and SQLite, under a `TestClock`),
  `InProcessTaskRunnerLive` (with and without `maxMs`), `TasksLive` and the
  tool discovery plugin's registry. The `TaskRunner` port's description
  says what the kit checks (no change to its type). The conformance page
  describes the four kits.
- `@xandreed/core`: the `FileSystem` port's new calls (`readBytes` ranges,
  `append`, `rename`, `stat` with `FileInfo` and `followSymlinks`, `glob`
  with `cwd`, `exclude`, `dot`, `onlyFiles` and `limit`), `walkGlob` (the
  sorted, link-safe walk over `list` every backend uses for `glob`, as
  `fs.glob` differs between Bun and Node), `compileGlob` and `globMatcher`
  (`*`, `**`, `?`, `[...]`, `{a,b}`; each returns a `Result` and refuses a
  pattern whose braces stand for more than 1024 patterns, which `glob`
  reports as `Invalid`), `GlobOptions`, `FileSystemMemoryLive` and
  `makeMemoryFileSystem(seed)` (an in-memory tree with symbolic links), and
  `fileSystemConformance(subject)`, run over the memory backend on Bun and
  Node. The disk-backed `FileSystemLive` is in `@xandreed/plugin-workspace`
  (below).
- `@xandreed/core`: the `Bash` port (`stream`, `exec`) with `BashOptions`
  (`cwd`, `env`, `inheritEnv`, `stdin` as text or bytes, `timeoutMs`), `BashChunk`,
  `BashExit`, `BashResult`, `BashError`, `collectBashResult`,
  `resolveBashEnv` and `BASH_ENV_ALLOWLIST`, and `bashConformance(subject)`:
  exit codes as results, separate streams, output before exit, stdin, the
  environment allowlist, timeouts and interrupts that kill the process
  group, `cwd`, signals and UTF-8. Core has no `Bash` adapter (its tests
  run the kit against fakes that run nothing, which fail every check);
  `BashLive` is in `@xandreed/plugin-workspace` (below). `exec` keeps the
  whole output; there is no output cap yet.
- `@xandreed/core`: `tool.progress` (`ToolProgressEvent`: `step`,
  `invocationId`, `tool`, `channel` and `text`), published from a handler
  with `publishToolProgress(channel, text)`: `stdout` or `stderr` for a
  command's output as it arrives, `status` for anything else a tool
  reports. Also
  `CurrentToolInvocation`, which `@xandreed/plugin-tool-discovery` now sets
  around every handler call (innermost, so a nested agent's tools see their
  own call).
- `@xandreed/plugin-workspace`, a new package for Node 24 and Bun on POSIX
  systems (Linux and macOS; not Windows): the local machine as the
  `FileSystem` and `Bash` ports. `FileSystemLive` (`localFileSystem`) is the
  disk through `node:fs/promises`: absolute paths only, error codes mapped
  to `FsReason`s by `fsReasonOf`, `glob` as `walkGlob` over its `list`,
  ranges read through a file handle until they are full (so a `/proc` entry
  that reports a size of 0 reads too), a `rename` that names the side a
  failure came from, and a `remove` that resolves the parent first and acts
  on the last name only, so it never follows that name, never removes the
  root and refuses a path ending in `.` or `..`. `BashLive(options)`
  (`makeBash`, options `BashLiveOptions`) runs `<shell> -c <command>`
  through `node:child_process`, detached into its own process group:
  `shell` (default `bash`, with no fallback; set `sh` where bash is
  missing) is resolved once from the parent `PATH` (`ShellMissing`
  otherwise), `cwd` is checked first (`CwdMissing`), stdin is written and
  closed (a command that never reads it is fine), output is decoded per
  stream, and a timeout, an interrupted stream and, with `killBackground`
  (default `true`), the command's return kill the whole group; `exitGraceMs`
  (default 500) bounds the wait for output a background process holds open,
  after which the output pipes close (so a background process kept with
  `killBackground: false` needs its own output, `cmd > log 2>&1 &`), and
  `parentEnv` (default `process.env`) is what commands inherit from.
  `localSystemPlugin` (`@xandreed/plugin-workspace/local`, runtime-scoped)
  provides both, configured with `shell`, `killBackground` and
  `exitGraceMs` (`LocalSystemConfig`, `localSystemDefaults`), and
  `LocalSystemPluginLive` is its typed layer. Both adapters pass
  `fileSystemConformance` and `bashConformance` on Bun and, in the
  packed-package check, on Node. The `FileSystem` kit gains a
  `remove-paths` check (a trailing slash on a link, a linked parent, a last
  `.` or `..`) and checks which path a `rename` failure names;
  `FileSystemMemoryLive` refuses a `remove` ending in `.` or `..` too.
- `@xandreed/plugin-workspace`: the workspace tools. `workspaceToolsPlugin`
  (`@xandreed/plugin-workspace/tools`, runtime-scoped; `workspaceTools(config)`
  builds the same capability, `WorkspaceToolsPluginLive` is its typed layer)
  gives the model `read`, `ls`, `find` and `grep` (skill `workspace.read`,
  always on), `write` and `edit` (`workspace.edit`, needing the grant
  `fs.write`) and `bash` (`workspace.shell`, needing `shell.exec`;
  `WORKSPACE_PERMISSIONS`) over the `FileSystem`, `Bash` and
  `SessionEnvironment` of each call, plus a `workspace.environment` prompt
  section. Without the grants, `load_skill` refuses the skills with
  `capability.forbidden` and the tools stay inactive; without a `Bash`
  service there is no `bash` tool. Failures are `Failure` data. `read` shows
  windows of at most 2000 lines or 50 KB with the offset to continue from,
  and reports binary files (a NUL byte in the first 8 KB) with the media type
  their name suggests (images aside: see `readImages` below), and a file
  that is not valid UTF-8 with U+FFFD and a notice (`lossy`); `ls`, `find`
  (globs through `walkGlob`) and `grep`
  (regular expressions or literal text, case, context, lines cut to 500
  characters before matching, a quarter of the limit per file; a pattern
  that repeats a repeating group, such as `(a+)+`, is refused as
  exponential) are capped; `edit` applies several exact, unique,
  non-overlapping replacements matched against the original, with a
  normalised fallback (`fuzzyEdit`), keeps a BOM and CRLF endings, refuses
  a file that is not valid UTF-8 (`NotUtf8`) and returns a unified diff
  (effect's `TextDiff`); `write` refuses to empty a file; both write through
  a temporary file and a rename (in place for a file whose mode the rename
  would change: execute or special bits, or a mode the temporary file did
  not get under the umask) under a per-file lock shared by every session of
  the agent; `read`, `write`, `edit` and `grep` refuse pipes, sockets and
  devices (`NotAFile`). `bash` runs in the
  workspace root with a timeout the model may raise up to
  `bashMaxTimeoutMs`, stdin, the host's `bashEnv` over an allowlist of its
  variables (`bashEnvAllow`; `bashInheritEnv` passes everything;
  `bashSessionEnv` adds the session's ids), publishes output live as
  `tool.progress` (one event per run of output from one stream every
  `progressMs`), keeps its tail and saves a long output under
  `.efferent/runtime/tool-output`, up to `maxFileBytes` (`fullOutputCut`
  past that; the newest `spillKeep` files are kept).
  Paths are confined to the workspace through the real path of the nearest
  existing ancestor, `protect` globs (`.git/**`, `.efferent/**`) refuse
  writes, and `find` and `grep` never enter links or `exclude` names (an
  entry with a `/` is a path from the root): a guardrail, not a sandbox.
  The configuration (`WorkspaceToolsConfig`, `workspaceToolsDefaults`) is
  flat; its `protect` and `exclude` globs are checked when the options are
  decoded. Also exported: the tools' parameter and
  result schemas (`workspaceToolSchemas` for `onTool`), `applyTextEdits`
  and `normalizeLine`. A new docs page, "Workspace tools", and a
  packed-package journey on Bun and Node.

- `@xandreed/core`: token usage counts cache writes and reasoning.
  `TokenUsage` gains `cacheWriteTokens` and `reasoningTokens` (both inside
  the input and output totals). New `tokenUsage(counts)` (a usage with the
  invariants held), `uncachedInputTokens`, `usageBreakdown` (the five billed
  kinds, which sum to `totalTokens`), `sumUsage`, `ModelPrice` and
  `costOf(usage, price)`. `extractUsage` reads `cacheWrite` and `reasoning`
  from effect/ai's usage.
- `@xandreed/core`, `@xandreed/sdk`: turn and run totals.
  `RunResult.usage` (one run of the step loop), `RunContext.usage` and
  `Turn.usage` (the turn's running total), `TurnResult` (`TurnOutcome` plus
  `usage`, returned by `Agent.turn` and `guardTurn`), `usage` on the bus
  `turn.ended` event, and `turnUsageOf(events, turn)`, which sums a turn's
  stored `step.usage` records to the same total. `stepLoopConformance` and
  `turnConformance` check both totals.
- `@xandreed/plugin-models`: the chat-completions client reads
  `prompt_tokens_details.cache_write_tokens` and
  `completion_tokens_details.reasoning_tokens`. The built-in `google`
  provider reads no reasoning (0), since Gemini's `completion_tokens` may
  leave its thoughts out; configured endpoints and `local` credentials read
  it. The router adds the counters `llm.usage.cache_read_tokens`,
  `llm.usage.cache_write_tokens` and `llm.usage.reasoning_tokens`, and the
  same span attributes on `providers.generate`.
- `@xandreed/plugin-agent-loop`: each step's `engine.turn` span carries the
  OpenTelemetry GenAI usage attributes `gen_ai.usage.input_tokens`,
  `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`,
  `gen_ai.usage.cache_creation.input_tokens` and
  `gen_ai.usage.reasoning.output_tokens`. The `engine.run` span carries the
  run's sums as `engine.usage.input_tokens`, `engine.usage.output_tokens`,
  `engine.usage.cache_read_tokens`, `engine.usage.cache_write_tokens` and
  `engine.usage.reasoning_tokens`, beside `engine.usage.total_tokens`, so a
  backend summing `gen_ai.usage.*` does not count a step twice.
- Docs: `docs/framework.md` "Token usage" (the invariants, where totals
  appear, what they leave out, the span attributes, what each provider
  reports) and the same table on the website's providers page; the
  conformance page lists the usage checks.
- `@xandreed/core`, `@xandreed/plugin-sessions`, `@xandreed/sdk`: the
  host's metadata on each turn. `meta` (a JSON object: a request id, a
  client, a tenant) on `BeginTurn.User`, `BeginTurn.Inbox` and `NewTurn`
  (`Agent.turn`'s `turn` input), and `Sessions.drain(address, run, {
  maxTurns, meta })` for inbox turns. It is stored in `turn.started` when
  given (`TurnStartedData.meta`), given to `TurnAdmission` (`TurnToAdmit.meta`),
  and shown on `AdmittedTurn.meta`, `RunContext.admitted`, `Turn.admitted`
  and the bus `turn.started` event. It is never shown to the model, and is
  not part of the idempotency key's fingerprint: a retry with other
  metadata is still `TurnDuplicate`.
- `@xandreed/core`: `turnEndingOf(exit)`, the `TurnEnding` a turn's exit
  stores: its outcome on success; failed with the error's own `code` and
  message (cut to 500 characters), `turn.failed` or `turn.defect`; or
  interrupted with `turn.interrupted`. An error wins over an interruption.
  `Agent.turn` and `Sessions.drain` end their turns with it; a host-composed
  runner ends its writer with `writer.end(turnEndingOf(exit))`. On success a
  failed end still fails the turn.
- `@xandreed/core`: `BudgetTokens` (an integer of at least 1) and
  `isBudgetTokens`; `context.built` records the run's `budgetTokens`. The
  doc comments of `TurnPolicy.budgetTokens`, `TurnRunOptions.budgetTokens`,
  `AgentConfig.budgetTokens` and `MaintainSignal.budgetTokens` say what the
  budget is (the target memory compaction keeps each request under, not a
  provider limit) and what each memory strategy does with it.
- `@xandreed/core`, `@xandreed/plugin-sessions`, `@xandreed/sdk`: resuming
  a cancelled or interrupted turn. A user's turn begun with `resumes: n`
  (`BeginTurn.User.resumes`, `NewTurn.resumes` for `Agent.turn`) continues
  turn `n`, which must be the session's last turn begun by a user (only
  inbox turns, and resumes of it that failed, were cancelled or were
  interrupted, may follow it) and must have ended cancelled or interrupted,
  a reaped turn included; otherwise the begin fails with `NotResumable`
  (`session`, `turn`, `reason`: `missing`, `inbox`, `superseded`,
  `finished`) and `Agent.turn` with `turn.not-resumable` (409 in the event
  reference). The check runs in the opening commit, after the key's and
  after `SessionBusy`; a `resumes` that is not a whole number of at least 1
  is `missing` before anything else, the host's admission included. Memory
  is unchanged: the model sees turn `n`'s message and whole steps, then the
  new turn's message, exactly what a plain new turn would see. `resumes` is stored
  in `turn.started` (`TurnStartedData.resumes`, only when given) and shown
  on `AdmittedTurn.resumes` (`RunContext.admitted`, `Turn.admitted`),
  `TurnToAdmit.resumes` and the bus `turn.started`, and is part of the key's
  fingerprint. `Agent.turn` keys a resume `resume:<n>` unless given a key,
  so a retried resume is `turn.duplicate`; a resume that failed is tried
  again with a new key, and a host passing its own keys needs a new one for
  each attempt. `resumeRefusal(n, turns)` and `ResumableTurn` are the rule
  as a function.
- Docs: `docs/framework.md` "Resuming a turn" (the rule, the keys, and what
  is durable after a cancel or an interrupt: the turn's start, its whole
  steps, of the step in flight only what was already stored (its tool
  events included, never its assistant message or tool results), its end;
  no reply after a cancel, and possibly a failed reply with no text after an
  interrupt) and the website's SDK and sessions page; the event reference
  lists `turn.started.resumes` and the `NotResumable` begin code, and its
  `TurnDuplicate` and `KeyConflict` meanings name `resumes` as part of the
  key's fingerprint.
- Docs: `docs/framework.md` (the host's metadata, how a turn ends and its
  stored codes, the token budget) and the website's SDK and sessions page;
  the event reference lists `turn.started.meta`, `context.built.budgetTokens`
  and the stored codes `turn.failed`, `turn.defect`, `turn.interrupted`,
  `turn.budget`, `config.budget` and `context.budget`.
- `@xandreed/plugin-models`: disk-free stores. `modelsPlugin` takes
  `storage: "local" | "memory"` (default `"local"`, today's files). With
  `"memory"` it reads and writes no file and never looks up the home
  directory: credentials come from the host's `HostCredentials`, then the API
  keys of the environment variables `credentialEnv` names, then
  `credentials` (secrets as `Redacted` values; a plain string, or a field a
  credential does not have, is refused and never repeated in the error;
  `Redacted` values print as `<redacted>` in errors and fingerprints);
  settings start at the options and `setRole` and `set` change them in
  memory; `inheritPrevious` is ignored. Memory state belongs to the agent and
  is shared by all its sessions. `credentials`
  and `credentialEnv` need `storage: "memory"`, as does a host's
  `HostCredentials`.
- `@xandreed/plugin-models`: `HostCredentials` (`load`, read when the agent
  is defined; `save`, called after every login, logout and in-memory
  refresh, with `Redacted` secrets), `MemoryAuthStoreLive(seed?, { fetch? })`
  (one refresh per provider at a time; a login or logout during a refresh's
  token request wins, so a logout is never undone by a refresh and the host
  never receives that token; one during the refreshed token's commit and
  host save waits for it), `MemorySettingsStoreLive(initial)`, `CredentialInput`,
  `CredentialInputs`, `toCredential`, `toCredentialInput`, `credentialsOf`.
- `@xandreed/plugin-models`: the shared store vocabulary, extracted from the
  file stores: `applySetting`, `applyRole`, `coerceSettingValue`,
  `roleSelection`, `settingsFromRecord`, `ROLE_FIELDS`
  (`settings/settings-value.entity.functions.ts`) and `REFRESH_SKEW_MS`,
  `isUsableAt`, `refreshCredential` (`auth/credential-refresh.entity.functions.ts`).
  `refreshAnthropicToken`, `exchangeAnthropicCode`, `refreshOpenAiCodexToken`
  and `exchangeOpenAiCodexCode` take optional `{ fetch, now }`; the expiry of
  a new token is counted from the Effect `Clock` unless `now` is given.
- `@xandreed/plugin-models`: an endpoint with its own key (`apiKey`, or a set
  `apiKeyEnv`) never reads the `AuthStore`; an empty one sends no key, as
  before. `apiKey` may be `Redacted`. `endpointOwnKey` is exported.
- `@xandreed/core`: `authStoreConformance(store)`,
  `settingsStoreConformance(store, { writable })` and
  `modelCatalogConformance(catalog, { includes? })`, each with self-tests
  that careless stores fail. The SettingsStore kit puts back every key it
  touches, and fails a check before writing when a key holds a value the
  store must refuse, so it could not be put back. They run against `MemoryAuthStoreLive`,
  `LocalAuthStoreLive`, `MemorySettingsStoreLive`, `LocalSettingsStoreLive`,
  the plugin's read-only local settings and `ConfiguredModelCatalogLive`, on
  Bun and on Node.
- Docs: the website's providers page, "Credentials and storage" (both
  storages, `Redacted` secrets, `credentialEnv`, a `HostCredentials`
  example, refresh, lifetime and precedence); the conformance page lists the
  three kits; the plugin reference shows each plugin's optional services.

- `@xandreed/core`: images. `Media` (an image inline: base64, media type,
  size, fingerprint, optional name and alt), `MediaSlot`, `ImageMediaType`,
  `MediaFingerprint`, `AttachmentRejected`, `AttachmentRejectedReason` and
  `MEDIA_LIMITS`, and the types `ImageSize` and `MediaDescription`;
  `mediaFromBytes` and `mediaFromBase64` (a `data:` prefix and line breaks
  removed; the type sniffed from the bytes; PNG, JPEG, GIF and WebP headers
  read for a size of at most 8000 pixels a side), `normalizeMedia`,
  `sniffImageType`, `imageSizeOf`, `mediaFingerprintOf`, `mediaLabel`,
  `isMediaValue`, `mediaSlotsOf`, `mediaAt`, `elideMediaData`,
  `base64Length` and `IMAGE_TOKEN_ESTIMATE`.
- `@xandreed/core`: `UserMessage.attachments`, with `attachmentsOf`,
  `normalizeUserMessage`, `sameUserMessage` and `userMessageText`. A user's
  images are stored inline in `turn.started` (the event reference lists
  `turn.started.userMessage.attachments`) and sent to the model as effect/ai
  `file` parts (an empty text part is left out): image blocks on Anthropic,
  `input_image` on the Responses routes, `image_url` parts on a
  chat-completions route that reads images (below); a route that does not
  sends the text and a label line per image, so a message of images alone is
  never empty. The
  current turn's images are sent first, within `maxImages` and the new
  `maxChars` (with the defaults a message's own images always fit;
  `maxMediaChars: 0` sends none, for models that read text only); memory's
  `media: "inline"` sends earlier turns' too, newest turn first and a whole
  turn at a time (the default, below), and `none` shows them as label lines.
  A request sends at most `MEDIA_LIMITS.requestImages` images. Token
  estimates count an image as 1 600 tokens; context fingerprints,
  `queryLog`, transcripts, digests, ledgers and the loop's captured trace
  content never carry an image's base64.
- `@xandreed/plugin-memory-window`, `@xandreed/plugin-memory-summary`:
  `maxMediaChars` (default and largest `MEDIA_LIMITS.requestChars`), the
  base64 characters of the images one request sends; `maxImages` defaults
  to `MEDIA_LIMITS.requestImages`.
- `@xandreed/sdk`: `Agent.turn` checks a new turn's attachments before it
  begins, whatever `Sessions` the turn's services hold, and fails with
  `turn.attachment-rejected`; the event reference suggests 400 for it (a
  host that wants 413 for an oversized image runs `normalizeUserMessage`
  first and reads `AttachmentRejected.reason`).
- Docs: `docs/framework.md` "Images and multi-part messages", the website's
  SDK and sessions page, a provider table of the routes that take images,
  and the new kit checks on the conformance page.
- `@xandreed/core`: images in tool results. A tool returns `Media` values
  in its success value; its view's new `media` selector
  (`ToolViewInput.media`, filled by `defineTool`) picks the ones the model is
  sent with the result, every one by default (`Tool.toModelOutput` is not
  used). `ToolView.media` carries them as `MediaSlot`s into the encoded
  result, and the memory log's `ToolResult` stores them as `media`, only
  when there are some, so each image is stored once, in the result.
  `toolResultMedia` (with `ToolResultMedia`) checks them when the result is
  written: an image whose data is not what it states is an `[image
  unavailable: …]` line in the stored view, one past
  `MEDIA_LIMITS.toolResultImages` (4) or `requestChars` its label line (both
  kept as the result's `mediaNotes` too), and a failed call sends none.
  `renderLog` sends the current turn's tool images after its attachments,
  newest result first and a whole result at a time, and earlier turns' (in
  `inline` mode) with their turn's attachments; a result shown through a
  compaction, a digest or a spill's preview shows its `mediaNotes`, then its
  images as label lines.
  `ToolResultPart.media` holds a rendered result's images, and
  `toPromptMessages` turns them into the result's effect/ai `modelOutput`
  (its text, left out when empty, then a `file` part per image): an image
  block inside Anthropic's `tool_result`, `input_image` inside the Responses
  routes' `function_call_output`.
- `@xandreed/core`, `@xandreed/plugin-agent-loop`: recovery from a refused
  image. `CompactionAction.OmitMedia { entries, reason }` shows the named
  entries' images as label lines, whatever strategy renders the log;
  `entriesSendingMedia(entries, options)` names the entries whose images a
  render sends. When a request fails with an `InvalidRequestError` that
  names an image, the loop calls `StepRequest.onMediaRejected(reason)`
  (`RunLoopOptions.onMediaRejected` for `runLoop`): `stepRequestOf` records
  an `OmitMedia` of the images that request sent, and the step is planned
  again (that plan keeps its model choice, system prompt and directive) and
  sent once more. A streamed step does not fall back to a settled call over
  such a refusal, and one that arrives after the first part is not sent
  again. The loop counts the retry as
  `engine.corrections{engine.kind="media-rejected"}`.
- `@xandreed/plugin-models`: images per route. `ModelEndpoint.images`
  (default false) says a configured endpoint's models read images;
  `imageInputFor(selection)` says it for the built-in routes (Anthropic, the
  Responses routes but `openai-codex:gpt-5.3-codex-spark`, Gemini; not
  OpenCode's chat models); `ModelCatalogEntry.input` (`@xandreed/core`)
  states it per catalog model, for the route the model is sent through
  (`configuredModelCatalog(credentials, endpoints)`: a configured endpoint of
  a built-in provider's name by its `images`, a `local` credential's URL as
  text only). On `openai-codex`, an `error` event that refuses the request
  before any other event fails it with a 400 and the OpenAI error body
  (`openAiCodexRefusal`), as the HTTP endpoint does, so a refused image is an
  `InvalidRequestError` there and not a malformed response. On a route that
  reads none, `buildProvider` sends every image as its label line
  (`promptWithImageLabels`, exported from `@xandreed/plugin-models/compat`;
  `BuiltProvider.images` says which).
  The chat-completions client (`CompatConfig.images`,
  `toChatMessages(prompt, { images })`, `ChatMessageOptions`) sends a user's
  images as `image_url` parts with `data:` URLs, and a tool result's in one
  user message after the batch's tool messages, each result's captioned
  `Images returned by <tool> (call <id>):`, merged with a user message that
  follows (captioned `The user's message:` when it has images of its own);
  without `images`, a tool result's images are label lines in its text.
- Docs: `docs/framework.md` "Images and multi-part messages" covers tool
  results, the per-route table for both kinds of image, the refused-image
  recovery and the limits; the website's providers page ("Images", with an
  endpoint's `images`), SDK page and conformance page; the roadmap (MCP
  images, resizing, PDFs, a `MediaStore`). `verify:packages` sends a tool's
  image through `toChatMessages` and `promptWithImageLabels` on Node.
- `@xandreed/plugin-workspace`: `read` returns images. With the new
  `readImages` option (`WorkspaceToolsConfig`, default `true`), a binary
  file whose bytes are a PNG, JPEG, GIF or WebP image (sniffed by core's
  `sniffImageType`, whatever its name, and built with `mediaFromBytes`) is
  `ReadResult`'s new `Image { path, image: Media }`, the image named by its
  path; the tool's view selects it, so the model is sent it as an image of
  the result (`[Image chart.png (image/png, 70 B).]` as its text) and the
  session stores it once, through its slot. An image over
  `MEDIA_LIMITS.imageBytes` or `maxPixels` a side, or one whose header gives
  no size, is the new `ImageRejected { path, mediaType, bytes, reason,
  message }` instead: a note with why (and, for a size, to read a smaller
  copy), never its bytes. A file over `maxFileBytes` is still refused
  unread (`FileTooLarge`); when its name is one of those images, the
  refusal says to read a smaller copy instead of using `grep`. Other binary
  files stay `Binary`, and so do images with `readImages: false`, which a
  host whose models read text only sets. With `readImages`, the `read`
  description tells the model it can look at images, up to the smaller of
  `MEDIA_LIMITS.imageBytes` and `maxFileBytes`. Unit tests (PNG, JPEG, GIF,
  WebP, a type from the bytes and not the name, oversized bytes and pixels,
  a corrupt header, `readImages: false`, the description's limit), the tool
  through the registry's views (a GIF and a WebP on disk among them, and an
  image over `maxFileBytes`), and a key-free journey in which a scripted
  model reads an image and the next request carries it, the log holding its
  base64 once; the packed journey in `verify:packages` reads an image on Bun
  and Node and checks that the next request sends it as a `file` part of
  the tool result's `modelOutput`. Docs: `docs/framework.md` "Workspace
  tools" and "Images and multi-part messages", the website's workspace page,
  the README. Not a break: `ReadResult` gains two members, but
  `@xandreed/plugin-workspace` has not been published yet.
- `@xandreed/core`: skills from a tree of files.
  `readSkillFiles(files, { tools, maxReferenceBytes, rootName })` returns a
  `SkillTree`: every skill that loaded, with the directory of its
  `SKILL.md`, and the issues met (`SkillFileIssue`: an `error` leaves a
  skill out, a `warning` part of one). It never fails. The id rule:
  frontmatter `id`, else `name`, else the directory's path below the root
  (`release/checklist`), else, for a `SKILL.md` at the root, `rootName`.
  `tools: "ignore"` drops the tools a `SKILL.md` declares. A reference
  whose path is not a valid id is left out with a warning, not the skill.
  `collectSkillFiles(root, { maxFiles, maxBytes, maxFileBytes })` reads the
  text files under a directory through the `FileSystem` port's `glob`
  (links not entered; dot entries, `node_modules` and binary files left
  out), failing with `skills.limit` past `maxFiles` or `maxBytes`; a file
  other than a `SKILL.md` over `maxFileBytes` is not read, and is collected
  with its `size` (`SkillFile.size`) for `readSkillFiles` to warn about.
  Binary files and unread ones do not count toward `maxBytes`. Also
  exported: the schemas `SkillFile`, `SkillFileIssue`, `SkillTree`, `SkillTreeEntry`,
  `SkillFilesOptions`, `CollectSkillFilesOptions`, and `skillIssuesText`.
- `@xandreed/plugin-workspace`: `skillsDirectoryPlugin` (plugin id
  `@xandreed/plugin-workspace/skills`, runtime-scoped, requires
  `FileSystem`, contributes `Capabilities`) loads directories of `SKILL.md`
  files, `.agents/skills` in the agent's workspace by default, once per
  `Agent.define`. Tool discovery lists them in its catalogue, `load_skill`
  returns a skill's instructions and `read_skill_reference` the other files
  of its directory; the instructions of skills marked `always` are rendered
  in a static section (`alwaysSection`, `sectionOrder`). Flat options:
  `roots` (absolute, or relative to the workspace), `required`, `strict`,
  `tools` (`"ignore"` by default: file skills activate no tools),
  `idPrefix`, `maxReferenceBytes`, `maxSkills`, `maxFiles`, `maxBytes`. The
  first root wins an id two roots define; one instance with several `roots`
  is how to read several directories (the capability and section ids are
  fixed). A file over `maxReferenceBytes` is not read and does not count
  toward `maxBytes`. A skill id the host or another plugin also defines
  fails `Agent.define` with `skills.duplicate` (set
  `idPrefix`); a missing `required` root fails with `skills.root`, a limit
  with `skills.limit`, any issue under `strict` with `skills.files` (without
  `strict`, issues are logged and what they name is left out). Also
  `SkillsDirectoryPluginLive`, `SkillsDirectoryConfig`,
  `skillsDirectoryDefaults`, and, for a host that composes capabilities
  itself, `loadSkillsDirectory(config, workspace)` (the skills) and
  `skillsCapability(skills, config)` (them as one capability, with the
  always-on section), whose ids are `SKILLS_CAPABILITY_ID` and
  `ALWAYS_SECTION_ID`.
- Docs: skills from a directory in `docs/framework.md`, the website's SDK
  and sessions page and the README; the event reference lists the
  `skills.*` codes.

- `@xandreed/core`: `traceTurn(writer, { spanMeta })`, the `agent.turn`
  span as a lifecycle step for host-composed turns: `efferent.session.id`,
  `efferent.run.id` and `efferent.turn` on it and on every span under it,
  `gen_ai.conversation.id`, `efferent.origin`, `efferent.resumes` on a
  resume, and the allowed `efferent.meta.<key>`s, and at its end `efferent.outcome`,
  `efferent.failure.code` and the turn's usage
  (`efferent.usage.*_tokens`; for a turn that failed, what `guardTurn`
  records on its span: the usage its provider calls spent).
  `Agent.turn` uses it.
- `@xandreed/sdk`: `AgentConfig.spanMeta`, the keys of a turn's metadata its
  span carries (none by default); the metrics `efferent.turns` and
  `efferent.turn.duration` (milliseconds), by `efferent.outcome`, for every
  turn `Agent.turn` runs once it is admitted.
- `@xandreed/core`, `@xandreed/sdk`: `captureTraceContent` on `AgentConfig`,
  `TurnPolicy`, `TurnRunOptions` and `StepRequest`, and the
  `CurrentTraceContent` reference: a run's spans carry its prompts and
  responses (`engine.step.input`, `engine.step.output`, the models plugin's
  `llm.reasoning`) when its policy says so, else the agent, else the
  reference where the run starts; off by default. `Agent.turn` never set
  the loop's option before, so content capture only worked when calling
  `runLoop` directly.
- `@xandreed/core`: `replayableContext(context)`, a captured context without
  the trace state of where it was captured (the parent span, the span
  annotations and links, the trace-content switch), for code that provides a
  context again later; the registry, the step loop, `turnOf`,
  `stepRequestOf`, `Agent.turn`, the bus's subscribers, the session chassis,
  `makeLiveLayer` and the models plugin's layers use it.
- `@xandreed/core`: `stepLoopConformance` checks that a loop provides the
  request's `captureTraceContent` to its model calls as
  `CurrentTraceContent`, over a caller's on or off.
- `@xandreed/core`: `ToolRefusedEvent`, `ToolRefusalReason`,
  `StreamFallbackEvent`, `TURN_EVENT_NAMES` and `JOURNAL_KINDS`.
- `@xandreed/plugin-agent-loop`: a pre-first-part stream failure emits
  `stream_fallback` (the stream's error as text, an object as JSON, cut to
  300 characters), which
  `runSteps` publishes as `stream.fallback`, and counts
  `engine.corrections{engine.kind: "stream-fallback"}`. `runLoop` provides
  its `captureTraceContent` (`CurrentTraceContent` when unset) to the run as
  `CurrentTraceContent`.
- `@xandreed/plugin-models`: `llm.reasoning` carries the model's reasoning
  when the call's `CurrentTraceContent` is on, as well as with
  `EFFERENT_TRACE_CONTENT=1`, read per call.
- Docs: `docs/framework.md` "Traces and metrics" (the span tree, the turn's
  span, where spans nest, the metrics, trace content), the event list and
  the journal vocabulary; the website's SDK and providers pages; the event
  reference lists `tool.refused`, `stream.fallback` and the reserved names.
- `@xandreed/plugin-models`: proxy support for every call the plugin makes
  (the provider SDKs, the OpenAI-compatible client, OAuth token refreshes,
  the OpenAI subscription's WebSocket), on Node and on Bun. The `proxy`
  option (a URL, `Redacted` when it carries credentials) else
  `https_proxy` / `HTTPS_PROXY` and `http_proxy` / `HTTP_PROXY` (lower case
  first, as undici and curl read them); `noProxy` added to `no_proxy` /
  `NO_PROXY` (host names with their subdomains, ports, IP addresses, CIDR
  ranges, `[::1]`, `*`); loopback always direct; a value without a scheme
  reads as `http://`. Proxy credentials are redacted from error messages; a
  failed proxied call names the proxy and the target, a proxy's 407 on Bun
  included.
- `@xandreed/plugin-models`: the `ModelsTransport` port (a `fetch`, and
  `webSocketAgent` for the subscription's WebSocket) and
  `ModelsTransportLive(options)`, a scoped layer that fails with
  `ProxyInvalid`, `ProxyUnsupported` or a `ConfigError`: on Node undici's
  `fetch` with a `ProxyAgent` and a direct `Agent`, and plain agents for
  direct WebSockets (independent of `NODE_USE_ENV_PROXY` and the global
  dispatcher and agents; a proxy that closes the connection while the tunnel
  opens fails the call at once instead of undici reopening it in a loop), on
  Bun fetch's `proxy` option and, from Bun 1.3.6, the native `WebSocket`'s.
  With `noProxy: "*"` on Node it is undici's direct agent. Hosts give the
  OAuth login helpers its `fetch`. The plugin builds a transport only when a
  proxy applies (or for `noProxy: "*"` on Node); the routed model and the
  utility model then provide its fetch as `FetchHttpClient.Fetch`
  innermost, so an ambient one cannot route a call past it. The
  subscription's WebSocket client refuses a route the runtime cannot use
  (`Agent` is for Node, `Proxy` for Bun). Also exported: `transportFetch`,
  `HttpProxyOptions`, `ProxyUrlOption`, `ProxyConfig`, `ProxyEnvironment`,
  `NoProxyRule`, `ProxyInvalid`, `ProxyUnsupported`, `resolveProxy`,
  `proxyFor`, `parseNoProxy`, `bypassesProxy`, `isLoopback`,
  `redactCredentials`, `PROXY_VARIABLES`, `BUN_WEBSOCKET_PROXY_VERSION`,
  `NODE_WEBSOCKET_PROXY_VERSION`, and `makeOpenAiCodexWebSocketHttpClient`
  (`makeOpenAiCodexLanguageModel` takes an optional `webSocketProxy`).
- Docs: the website's providers page "Proxy" (options, NO_PROXY syntax, Node
  and Bun behaviour, the subscription's WebSocket, a host's own transport,
  OAuth logins behind a proxy); `docs/framework.md` and the README mention it.

- `@xandreed/core`: the busy signal. `TurnActivity` (the turns this
  process has in flight, read at one moment as `TurnsInFlight`: the turns
  held open, each `{ session, turn, since }`, and the begins still in
  progress) and `TaskActivity` (the background work it runs) are optional
  ports; `processActivity` reads them into a `ProcessActivity` (`{
  openTurns, beginningTurns, runningTasks, busy }`, a missing port counting
  nothing), and `awaitIdle({ timeout })` waits until nothing is open,
  beginning or running at once, returning what is still in flight when the
  timeout comes first. `SessionsLive` provides `TurnActivity`: a begin
  counts from before the host's admission until its writer is handed over,
  then the turn until its writer's scope closes, per session and turn.
  `InProcessTaskRunnerLive` provides `TaskActivity` (a piece of work is
  forked and counted in one step, so an interrupted caller leaves none
  uncounted), and `@xandreed/sdk`'s `agent.activity` reads them from the
  agent's runtime services. The framework guide and the website show a
  `/ping` and a SIGTERM drain (stop admitting, wait until idle, stop the
  requests, close the services, with the task runner built on top of the
  sessions so its tasks end before the log closes), which an sdk test runs,
  including a drain that times out. The framework guide explains the lease
  keep-alive and the `everyMs <= ttlMs / 2` rule, which the plugin
  reference now shows as the lease's description. The event reference
  suggests 503 for `TurnRefused` while draining.

- **`@xandreed/plugin-telemetry`** (new; Node 24 and Bun, no `node:`
  imports): usage, cost and tool telemetry per turn, and OTLP/HTTP export.
  - `telemetryPlugin` / `TurnTelemetryLive` (session-scoped; requires
    `RunContext` and `TurnEvents`): records `efferent.llm.tokens` by
    `efferent.model` and `efferent.token.kind` (`input`, `cache_read`,
    `cache_write`, `reasoning`, `output`, from `usageBreakdown`, summing to
    each response's total), `efferent.llm.cost` (`costOf` at the host's
    `prices`, keyed by the models plugin's selection), `efferent.steps` (by
    `efferent.step.status`), `efferent.tool.calls` and
    `efferent.tool.duration` (by `efferent.tool` and `efferent.ok`),
    `efferent.tool.refused` (by `efferent.tool` and
    `efferent.refusal.reason`) and `efferent.stream.fallbacks`, each with
    the host's `metricAttributes` and never a session, run or turn id
    (`TelemetryMetrics`). The cost names carry no currency (the prices'
    currency is the host's). With `spanEvents` (the default) it sets the
    turn's ids on the span current where it is built (`agent.turn` under
    `Agent.turn`) and adds `efferent.step.usage`, `efferent.tool.refused`
    and `efferent.stream.fallback` events (each with the zero-based
    `efferent.step`) and the running `efferent.cost` attribute.
  - `OtlpTelemetryLive(options)` (global `fetch`) and
    `OtlpTelemetryHttpLive(options)` (the host's `HttpClient`): Effect's
    `OtlpTracer` and `OtlpMetrics` (`effect/observability`) with one
    `Flusher`; `serviceName` (else `resourceAttributes["service.name"]`,
    else `"efferent"`; it wins over `OTEL_SERVICE_NAME`), `baseUrl` or
    per-signal `tracesUrl`/`metricsUrl`, `headers` and per-signal
    `tracesHeaders`/`metricsHeaders`, `protocol` (`http/protobuf` by
    default, or `http/json`), `compression`, `exportInterval`,
    `shutdownTimeout`, `metricsTemporality`.
  - `OtlpTelemetryFromEnv(defaults?)` (global `fetch`) and
    `OtlpTelemetryHttpFromEnv(defaults?)` (the host's `HttpClient`): the
    standard environment (`OTEL_EXPORTER_OTLP_ENDPOINT`, the per-signal
    endpoints, headers, compression and protocol, `OTEL_SERVICE_NAME`,
    `OTEL_SERVICE_VERSION`, `OTEL_RESOURCE_ATTRIBUTES`,
    `OTEL_{TRACES,METRICS}_EXPORTER`, `OTEL_SDK_DISABLED`, the export
    intervals and temporality; not `OTEL_EXPORTER_OTLP_TIMEOUT`). Disabled
    or with no endpoint it exports nothing and reads nothing further; a
    signal's own endpoint, compression and protocol are read first, so an
    invalid shared one does not fail a signal that sets its own; a variable
    it reads that holds an invalid value fails with its `ConfigError`.
  - `flushTelemetry`, for a serverless host before it responds.
- Docs: the website's `concepts/observability.md` (export, the environment
  variables, the span tree, the metrics, cost, serverless flushing), a
  pointer from `docs/framework.md` "Traces and metrics" and the SDK page,
  and the package in the README, the getting-started table and the plugin
  reference.

- Docs: the events guide, `docs/events.md` and its website page
  (`/docs/guides/events/`, in a new Guides group; the plugin and event
  references move to a Reference group). It answers how to use the events:
  the live bus against the durable journal; streaming a turn to a client
  through one background subscription; which subscription sees
  `turn.started` and `turn.ended` (the host's per-turn layer, a scope that
  outlives the turn) and what settles when; handlers that must neither fail
  nor block (a push bounded with `Effect.timeoutOption` and a gone latch);
  `onTool`, `tool.refused` and `step.ended.results`; host events and the
  reserved names; reading the journal across processes (a shared
  `SessionLog`, polling, write-behind and reaped turns); stored failure
  codes; resume, the lease keep-alive and the busy signal; and a Fetch API
  HTTP recipe for Next.js and other servers: one host per instance, session
  creation, a turn streamed over SSE with begin codes mapped to statuses and
  `Idempotency-Key` retries (and a keyless resume's) answered from the
  journal, the journal over SSE through plugin-render's feed with a client
  projection and a write bound that drops a client that stopped reading,
  and `/ping`. Every snippet but the Next.js glue is a region of
  `packages/sdk/src/events-guide.test.ts`, which runs key-free with scripted
  models (streamed deltas reaching a client through `Agent.turn` among
  them). The README, `docs/framework.md` (events, background subscriptions,
  following a session), the website's SDK page and the event reference link
  to it.

### Fixed

- `@xandreed/plugin-session-sqlite`: processes opening one new database file
  at the same moment could fail at once with "database is locked", because
  the file was switched to WAL before the busy timeout was set. The busy
  timeout is now set first, so they wait for each other.

### Repository

- A 0.13.0 session journal, recorded deterministically by
  `scripts/record-journal-fixture.ts` (`packages/sdk/fixtures/journal-0.13.0.json`):
  every reserved kind (the fixture lists them), the task records, the inbox
  and a host event. The sdk test `journal-compat.test.ts` reads every
  fixture in that folder, decodes every event with `journalSchemaOf`,
  rebuilds the memory log and replays every stored model request from it.
- `bun run verify:packages` compiles every `@xandreed/*` import in the
  README, `docs/framework.md`, `docs/composable-evaluations.md` and the
  website docs against the packed packages, and checks that each plugin's
  version equals its package's.
- The plugin reference lists `uiOutputPlugin`; its generator imports every
  workspace package and fails when one exports a plugin it does not list.
- The docs site deploys when a `v*` tag is pushed, or by hand, no longer on
  every push to main, so it describes what npm has; the `github-pages`
  environment needs a `v*` tag rule once (CONTRIBUTING). CI still builds and
  link-checks it on every push, and fails when a generated reference under
  `docs/` or the website is not committed as generated.
- `docs/composable-evaluations.md` showed calibration APIs that were removed
  and an import path the package does not export; it now uses
  `defineGraderCalibration` and `calibrateGrader`, and imports
  `SemanticJevLive` from `@xandreed/evals`, and describes gates as the
  suite's `Gate`s and the run's `GateFinding`s. Snippets named
  `LanguageModel.Service`, which Effect 4 calls `LanguageModel.LanguageModel`.
  `docs/framework.md` and `docs/service-generations.md` no longer describe
  the removed journey driver.
- `bun run verify:packages` runs `stepLoopConformance` over the packed step
  loop (`runSteps`) and `turnConformance` over a packed `Agent` on Node.
- A key-free `bun:test` journey with scripted models (`packages/sdk/src/resume.journey.test.ts`):
  a turn cancelled while a tool call runs is resumed with its message, the
  resume retried, and a finished turn refused; and a resume whose provider
  was down is tried again with a new key, after which the turn is answered. `bun run verify:packages`
  resumes a cancelled turn through the packed packages.
- The sdk golden journal and model files are regenerated: `context.built`
  records carry `budgetTokens`, and the failed turn's `turn.ended` carries
  its error's code (`host.failed`).
- `bun run verify:packages` runs the AuthStore, SettingsStore and
  ModelCatalog kits over the packed `@xandreed/plugin-models` stores on Node,
  and runs `scripts/models-consumer.fixture.mjs` on Node in a process of its
  own whose HOME and working directory are fresh empty directories: with
  `storage: "memory"`, two turns, a login, a role edit, a logout, the catalog
  and a utility call leave both empty. `@xandreed/sdk` tests the plugin at
  the agent level (a dev dependency).
- `bun run verify:packages` runs the Sessions kit over the packed
  `SessionsLive` and in-memory log, each check under a `TestClock`, and the
  TaskRunner, Tasks and ToolRegistry kits over `InProcessTaskRunnerLive`,
  `TasksLive` and the tool discovery plugin's registry, on Node.
- `bun run verify:packages` loads a `SKILL.md` tree with the packed
  `SkillsDirectoryPluginLive` over `FileSystemLive`, on Bun and on Node. The
  plugin reference page says what each plugin contributes and reads when
  present (`Contributes`, `Optional`), and "none" for a plugin that provides
  nothing.

- `scripts/record-journal-fixture.ts` records a refused call and a stream
  fallback, so the next release's fixture holds `tool.refused` and
  `stream.fallback`; the 0.13.0 fixture is unchanged and still decodes.
  `journal-compat.test.ts` expects a fixture to hold every journal kind its
  version reserved (a reserved bus name never stored as itself excepted).
  The event-reference generator lists the journal from `JOURNAL_KINDS` and
  fails on a reserved name that is neither a journal kind nor a bus event's.
- The `@xandreed/plugin-workspace` tests run a key-free workspace-tools
  journey through `Agent.define` with the step loop, memory window, tool
  discovery and sessions plugins and `fast-check` (`foundry.config.ts`), as
  the skills directory tests do; `verify:packages` runs a packed version of
  that journey on Bun and Node.

- `@xandreed/plugin-telemetry` joins the build, the foundry gates (with a
  `plugin-telemetry-tests` layer that may import the sdk and the plugins a
  scripted turn needs), `tsconfig.base.json` and the plugin reference. Its
  tests run a key-free scripted turn (usage kinds, cost, tools, refusals,
  span events, a stream fallback) and export to a `Bun.serve` collector.
  `bun run verify:packages` runs `scripts/telemetry-consumer.fixture.mjs`
  on Node and on Bun: a turn with the packed plugin under
  `OtlpTelemetryLive` posts nothing before `flushTelemetry` and, by the time
  it returns (the export layer still open), its `agent.turn` span (with its
  ids and `engine.run` under it) and its token and cost metrics have reached
  a `node:http` collector. The plugin reference prints `Provides: none` for a
  plugin that provides nothing.
- `bun run verify:packages` runs `scripts/proxy-consumer.fixture.mjs` on Node
  24.5 or newer against the packed packages, with `NODE_USE_ENV_PROXY=1` and
  environment proxies pointing at a dead port: model and utility calls
  through a recording proxy (CONNECT), loopback and `noProxy` hosts direct
  (direct WebSocket agents included), `HTTP_PROXY` with credentials, a dead
  proxy named without its credentials, a resetting proxy failing at once,
  the subscription WebSocket's CONNECT sent through the proxy, and every
  call direct with `noProxy: "*"`. On Bun, the packed consumer sends a model
  call through the `proxy` option to a recording proxy (absolute form). The
  plugin-models tests run a recording proxy that handles CONNECT and
  absolute-form requests and resolves `*.invalid` hosts locally, so nothing
  reaches the network; the tests of direct requests skip when the machine
  has a proxy in its environment (CONTRIBUTING.md). CI runs the proxy tests
  again on Bun 1.3.6, where the subscription's WebSocket tunnels, so both
  sides of that version gate are tested. A new foundry layer
  `plugin-models-tests` lets them use `fast-check`.
  `undici-fetch.adapter.ts` joins the declared type-erasure boundary. The
  packed READMEs name the Node version a package's `engines` declares
  (`plugin-models`: Node 24.5).

- `scripts/sync-guides.ts`, chained into `bun run docs:generate`: it copies
  each `<!-- snippet: <file>#<region> -->` region of a test into the guide,
  with the import lines its code uses (from the test's own imports,
  `scripts/guide-snippets.ts`), and mirrors the guide to the website,
  rewriting each link to a repository file to its website page or to
  GitHub. It fails on a snippet that imports from a relative path, the test
  runner (`bun:`) or test scaffolding (a `testing` module), a region no
  guide quotes, a snippet marker not followed by a `ts` fence, a TypeScript
  or JavaScript fence that is neither a snippet nor marked
  `<!-- unchecked: why -->`, and a link to a missing file or heading. CI's
  generated-docs check covers the guide and its page.
- `bun run verify:packages` compiles the events guide's HTTP recipe (its
  regions of `events-guide.test.ts`, composed with their imports) against
  the packed packages, and runs `scripts/events-consumer.fixture.mjs` over it
  on Node (stripping the recipe's types) and on Bun: a session created, a
  turn streamed from `started` through its deltas to `done` while the
  journal route follows the session over SSE, its retry answered from the
  journal, and `/ping` idle.
- The `sdk-tests` foundry layer may import `@xandreed/sdk` by name and
  `@xandreed/plugin-render` (an sdk dev dependency), so the guide's snippets
  import only what a consumer can.

## 0.13.0

The composable agent (`Agent.define` and `Agent.turn` over the step loop) is
now the only way to run an agent. 17 packages: `@xandreed/plugin-memory` is no
longer published.

### Breaking

- **Effect 4.0.7.** Every package moves from `effect` 4.0.0-rc.118 to 4.0.7
  and pins that exact version. `@xandreed/plugin-models` also pins
  `@effect/ai-openai` and `@effect/ai-anthropic` at 4.0.7. Use `effect` 4.0.7
  in the host so the host and the packages share one Effect. Tool parameter
  schemas built from `Schema.Int` now state the safe-integer range (`minimum`,
  `maximum`) in their JSON Schema, which is an Effect 4 change. (#279)
- **Supported runtimes are declared.** Each manifest has `engines`: Node ≥ 24
  and Bun ≥ 1.3.0 for core, runtime, sdk and the plugins; Node ≥ 24 for
  `evals`, `evals-cli`, `evals-langfuse` and `evals-langsmith`; Bun ≥ 1.3.0
  for `plugin-session-sqlite`, which uses `bun:sqlite`. (#279)
- **The Harness API is removed.** (#280)
  - `@xandreed/sdk`: `Harness` (`Harness.make`), `domainLoop`,
    `domainSession` and `approvalPlugin`.
  - `@xandreed/core`: `AgentLoop`, `LoopInput`, `DelegateLoop`, `AgentTools`,
    `Approval`, `ContextManager`, the `Memory` port, `TurnHooks`,
    `SessionHandle`, the `SessionStore` and `ConversationStore` ports
    (with `ConversationSummary`, `RunOutcomeRecord`, `StoredMessage` and
    `StoreError`), and the harness session entities `SessionRecord`,
    `EventBody`, `SessionEvent` and `MemoryEntry`. `SessionEnvironment` no
    longer has a `session` field.
  - `@xandreed/plugin-agent-loop`: `agentLoopPlugin` and `runAgent`. The
    package's default export is now `stepLoopPlugin`; `runLoop` stays as the
    step loop's engine.
  - `@xandreed/runtime`: the `efferent.config.json` loader and plugin
    installer (`loadConfig`, `decodeConfig`, `mergeConfig`, `writeConfig`,
    `redact`, `ConfigSource`, `loadPlugins`, `pluginSchema`).
  - `@xandreed/plugin-memory`, which only implemented the removed `Memory`
    port.
- **`@xandreed/plugin-session-sqlite`.** (#280)
  - `sessionSqlitePlugin` now provides `SessionLog` and the open admission
    policy (`TurnAdmission`). It requires nothing and takes only `path`;
    compose `sessionsPlugin` explicitly in the host graph.
  - Removed: the `SessionStore` and `ConversationStore` projections
    (`SessionStoreLive`, `SessionStoreProjectionLive`,
    `ConversationStoreProjectionLive`, `SqliteConversationStoreLive`), the
    `legacyPaths` option, and the importer for older SQLite journals.
    `SessionLogSqliteLive(path)` takes no options.
- `@xandreed/sdk` no longer depends on `@xandreed/plugin-memory` or
  `@xandreed/plugin-session-sqlite`. Install the plugins you compose. (#280)

### Migration

- Install `effect@4.0.7`, and run on Node 24 or newer, or Bun 1.3.0 or newer.
  `@xandreed/plugin-session-sqlite` needs Bun.
- Define the agent once with `Agent.define({ plugins, turnServices, system })`.
  Run each turn with `agent.turn({ turn, services }, use)` over a `Sessions`
  service, where `use` runs the step loop (`turn.run`) and returns the turn's
  outcome and reply. The README's "Compose" section has the full example.
- Replace `agentLoopPlugin` with `stepLoopPlugin`, which is also the
  package's default export now.
- Replace `@xandreed/plugin-memory` with a memory strategy:
  `@xandreed/plugin-memory-window`, `-summary` or `-digest`.
- Store sessions through the `SessionLog` port: `SessionLogMemoryLive` from
  `@xandreed/core` (in memory, Node or Bun) or `SessionLogSqliteLive(path)`
  from `@xandreed/plugin-session-sqlite` (a SQLite file, Bun). Provide it with
  `TurnAdmissionOpen` to `SessionsPluginLive` from `@xandreed/plugin-sessions`.
  Older SQLite journals (the `legacyPaths` option) are no longer imported.
- Move configuration from `efferent.config.json` into the `Agent.define`
  plugin entries: `{ plugin, id?, options }`.

### Fixed

- `@xandreed/evals-cli`: the `efferent-eval` bin keeps its `#!/usr/bin/env node`
  line, so it runs as a command. The build used to drop that line, so in
  0.12.0 and earlier the bin fails when run directly; with those, run
  `node node_modules/@xandreed/evals-cli/dist/main.js` instead.

### Repository

- `bun run publish:packages` publishes the built packages; 0.13.0 is its
  first release. It is a dry run unless `--publish` is passed. It
  refuses when the packages do not share one version, when a built version
  differs from its source manifest, when the build is not from the current
  `HEAD` or was made from a tree with changes, when the working tree has
  changes, when the `@xandreed/*` dependencies form a cycle, when `npm whoami`
  fails or names an account other than the project's, or when the registry
  cannot say whether a version is already published. It publishes
  dependencies first, skips versions already on npm, and uses
  registry.npmjs.org for every step. Its checks and order are tested
  (`scripts/publish-plan.test.ts`). See
  [CONTRIBUTING.md](CONTRIBUTING.md#publishing).
- `bun run build:packages` writes `.artifacts/packages/build.json` with the
  commit, whether the tree had changes (gitignored files in a package's
  published folders included), the shared version and the packages.
- `bun run typecheck` also type-checks `scripts/` (`scripts/tsconfig.json`).

## 0.12.0 — 2026-10-28

### Added

- `@xandreed/plugin-models`: named OpenAI-compatible endpoints under the
  `endpoints` option (`ModelEndpoint`, `ModelEndpoints`,
  `CurrentModelEndpoints`). A model selected as `<name>:<model id>` is sent to
  `<url>/chat/completions`. The key is optional: the endpoint's `apiKey`,
  then the environment variable `apiKeyEnv` names, then a key stored for
  that name; with none, no `Authorization` header is sent. `standardOnly`
  defaults to true, and an endpoint named like a built-in provider replaces
  it. (#278)
- A stored `local` credential with a `baseUrl` now routes the same way
  instead of failing as an unwired provider. (#278)

Hosts that build `LanguageModelLive` themselves are unaffected: the endpoints
reach the router as a context reference with an empty default.

## 0.11.0 — 2026-10-28

- The repository holds the composable agent framework only: core, runtime,
  sdk, the plugins hosts compose (agent loop, models, the memory strategies,
  tool discovery, sessions, the SQLite session store, tasks, render) and the
  evals packages. The coding CLI, the reference applications and the plugins
  only they used (context, mcp, policy-workspace, telemetry, tools-local) were
  removed from this repository. (#277)
- Every package except `@xandreed/plugin-session-sqlite` runs on Node 24 as
  well as Bun. (#277)
- All packages share one version, published under `latest` instead of
  `next`. (#277) The `next` dist-tag is no longer updated and still points at
  an older prerelease; install from `latest`.
