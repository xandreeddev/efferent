# @xandreed/sdk

The composable agent: `Agent.define` builds an agent's plugin graph once (through runtime's `resolveGraph` and `activateGraph`) and `agent.turn` runs one turn over the turn engine, `TurnLive` (`src/turn/`), with the session, memory, registry and step loop its plugins provide. It re-exports, each by name, the part of core a host writes beside `Agent`, so defining an agent and running its turns imports one package; the rest of core is imported from `@xandreed/core`. Node 24 and Bun; layer `sdk` in `foundry.config.ts` (imports core and runtime); its tests are the `sdk-tests` layer, which may import every plugin.

## Rules

- The sdk owns no port: new behaviour goes in core or a plugin, and `agent.adapter.ts` only wires it. `task-executor.adapter.ts` (`agentTaskExecutor`) only wires `Agent.turn` (any `TurnRunner`) as core's `TaskExecutor`: the tasks plugin begins and ends the turns, the executor runs them, each with the host's `services` and the `Tasks` it is called with (the port requires it: the tasks plugin provides its own, a host draining a parent through `react` provides one), so the turns' `start_task` and `task_status` open. Hosts build `Tasks` beside the agent (`TasksLive(config).pipe(Layer.provide(agentTaskExecutor(agent, { services })))`): a `tasksPlugin` among the agent's own plugins would need the executor before the agent exists.
- `src/turn/` is the turn engine, core's turn-scope ports as services: `TurnLive` (`turn.adapter.ts`, its state a `TurnPhase` with pure transitions, `turn-phase.entity.ts` and its functions), a run of the step loop (`turn-run.usecase.functions.ts`) and the lifecycle (`turn-lifecycle.usecase.functions.ts`). It builds the turn's bus with core's `makeTurnEvents` and `makeTurnTasks`, and reads what it needs of core's memory, journal and model requests from `@xandreed/core/internal`; what code beneath the sdk uses stays in core (`harnessDefectsAsFailures`, the bus).
- Tracing: `traceTurn` opens `agent.turn` and `traceTurnBegin` `agent.turn.begin`, its sibling, around a begin, with core's `turnAttributes` and `sessionAttributes`. Put no span between `traceTurn` and `guardTurn`: a failed turn's usage goes on the span current where `guardTurn` runs. The engine's own span is `turn.persist_reply` (`TurnLive`'s `persistReply`, under `agent.turn`); the views a turn's code works with (`turnOf`, `stepRequestOf`) and the step request's `dispatch` are `Effect.fnUntraced`.
- Fail at define time, not at the first turn: no `ConversationMemory`, `ToolRegistry` or `StepLoop` is `config.graph`, a bad `budgetTokens` is `config.budget`.
- A turn that cannot begin fails with its `TurnBeginError` as it is (a `Sessions.begin` refusal, or `AttachmentRejected`), never a `HarnessError` made from it: hosts match it by tag, and core's `turnBeginCodes` (checked against `TurnBeginError` there) gives its code.
- Any change to what the model or the journal sees shows in `golden/`: re-record only on purpose (`EFFERENT_UPDATE_MODEL_GOLDEN=1`, `EFFERENT_UPDATE_GOLDEN=1`) and review the diff in the PR.
- Normal memory appends flush before returning, so a tool result is durable before its optional digest runs. Closing drafts (the reply and later memory) stay held for the turn's end. The loop stores the assistant before handlers and each result on return; pending calls render as `ToolInterrupted` on resume, with exact state available through core's `toolCallStatesOf`.
- `TurnLive` provides `CurrentModelCallRecorder` during `memory.open` and throughout the turn. Its recorder appends and flushes `model.called` directly, before billing observers and the ordinary bus notification; the event is recorded elsewhere so the writer-first bus subscriber never appends it twice. Each terminal key keeps its first ACK or failure, including uncertain ACKs and bus reaction failures. Accepted facts and each observer payload are independent snapshots. Same-key notification reentry fails promptly while its ACK is pending; independent concurrent callers share the original result. Only bookkeeping and writer ACK work is masked; arbitrary callbacks remain interruptible.
- The recorder owns billing observers until `TurnLive` closes after helper/finalizer/reply work. Its snapshots read only the turn's own rows (`writer.snapshot(kinds, started.seq)`), never the whole session: rows durable before this owner are `replayed`, while new bootstrap calls are fresh. Observers are soft; durable recording and ordinary bus reactions retain their original `TurnError`. `RunContext.usage`, `TurnResult.usage` and `step.usage` remain selected loop-response totals. Billing readers use the separate call ledger plus the selected usage of each loop step no `Loop` call names (each legacy fact carries its run and step).
- A new turn clears inherited `CurrentAgentRun`/`CurrentAgentStep` during bootstrap and outside its loops. SDK planning, maintenance, completion and tail-recording callbacks bind their known run ordinal/step inside captured services, so helper calls cannot borrow another turn's or concurrent run's correlation.
- Maintenance never sits between a loop and its reply: `runTurnLoop` returns the loop's result as it is. Each accepted response hands its run's `turn-end` maintenance (a once-latch over that run's accepted input) to `TurnMemory.deferAfterReply`, the latest replacing earlier ones, so a manual `stepRequestOf` → `StepLoop.run(request)` composition gets the same lifecycle. `finishTurn`, after a completed or partial reply is recorded, drained and flushed, runs `TurnMemory.afterReply`: it seals the turn (`TurnWriter.seal`), then runs the work raced against the sealed end being stored by someone else, inside the turn and its recorder. An ordinary failure there is logged and skipped (`isWriterCause` keeps the writer's, a fence's and a close's hard); an interruption cuts the work only. A writer without `seal` skips the work. A run's start (`turn-start`) is the safety net, calibrated by `TurnMemory.acceptedBefore` (the last stored `step.usage` with its step's `context.built`).
- An optional `ModelRequestHook` applies under the run's captured services and actual `CurrentAgentRun`/`CurrentAgentStep`, after policy model/system/step callbacks and before recording the one combined StepContext. Its accepted system and controls determine reserves, maintenance, render and durable header; `header.hook` keeps the normalized patch, including an explicit empty patch. Absence preserves legacy bytes. Media replanning, same-step overflow and transport or stream fallback reuse that decision; a fresh step or manual decision applies the hook again. Helpers and initial planned tool batches skip it. Hook validation owns `request.hook`; subsequent context/header writer errors and original hook `TurnError`s retain their identity. Arbitrary hook work remains interruptible and holds no writer or memory permit.
- Each preparation freezes its own message estimate, full system/tool reserve, base reserve without system StepContext, model identity and request cut. Resolve a model once before step maintenance and reuse it for the header and dispatch. A real accepted response updates observation only after `recordTail` acknowledges; omitted metadata preserves it, explicit unusable metadata clears it. Keep the actual accepted fallback identity, apply calibration only to a future matching model, and pass it directly to the run's `turn-end` maintenance. Neither bill rows nor aggregate run usage calibrate context.
- SDK maintenance always supplies its exact run/render scope. `turn-end` maintenance first takes the existing durable request snapshot, omits StepContext and subtracts the accepted step's base reserve from the run budget, falling back to the latest plan only when no accepted reserve exists. A step's ceiling is the run's input ceiling, lowered to the resolved model's `ModelCatalog` window less its output cap (the call policy's `maxOutputTokens`, else the catalog's), read once per model and run; with no room left for the system prompt and tools the step fails `context.budget`. Recorder `TurnError` defects restore to typed failures; unrelated defects remain defects.
- The SDK supplies optional `StepRequest.onContextOverflow`. Successful dispatch validation retains the exact private plan matched to its durable header, including cut, message estimate and reserves. A later unsent plan cannot supply overflow measurements. Recovery uses actual attempted neutral model/limits when present, otherwise the requested identity and optional `ModelCatalog` only as advisory evidence; it never parses provider settings, errors or billing rows. Missing attempted output stays unknown even when a catalog lists a maximum.
- Each preparation has a shrinking total input ceiling starting at `budgetTokens`. Overflow reserves system/tools once, applies known context/output bounds and targets 80% of the smaller remaining budget and failed comparable message estimate. Maintenance runs with `phase:overflow`, the same run/step and current StepContext. Retry requires strictly lower rendered estimates and a fit under that target, comparing old and new with the same frozen matching calibration. Arrivals that offset reduction refuse a retry. All maintenance/ACK failures remain hard.
- Recovery claims precede paid helpers. Pending/reentrant calls decline promptly; hard failures and interruption retain their terminal outcome, and a consumed successful candidate is never reinstalled. Only bookkeeping is masked. A successful recovery freezes one smaller projection, appends/flushes its same-step header with original model/system/tools/policy controls, then returns that exact candidate from the next plan without policy resolution or another maintenance pass. `turn-end` maintenance uses the tightened ceiling and preserves the accepted base reserve.
- Request storage uses V2 headers referencing content-addressed system/tool parts. `TurnMemory.prepareRequest` still accepts full materialized V1; planning and overflow keep canonical full-header private snapshots. Its pure encoder detaches input before storage waits. One protocol gate serializes fresh durable lookup, validation of every matching part occurrence, missing-part selection and a single append batch of dependencies then header, followed by flush ACK. Writer failures retain their exact identity; a later preparation refreshes committed truth after uncertain ACKs without changing the earlier failure.
- `RequestSnapshot.requests` stays raw headers only. The SDK also supplies ordered `requestEvents` containing visible parts and this writer's headers. Seed inherited parts through `writer.history`, preserve the returned logical order and advance the own-tail cursor only from own rows; parent sequence numbers may overlap or exceed the child's. Never concatenate all parts before all headers, synthesize event identities from hash caches, or reuse a parent part beyond its fork cutoff. Dispatch resolves `requestEvents ?? requests` to full V1 before checking bytes and matching private plans. Unreferenced damaged bodies remain opaque; referenced corruption stays a request integrity/decode error, not a caller encoding error.
- `TurnMemory.pendingSteers` is the writer's fresh probe; `steer(step, run)` prepares one exact inbox-marked user message per waiting input and uses memory's alternate commit with `writer.take`. Preserve the lock order: memory allocation, then the holding semaphore, then writer commit. Recheck the reply phase under the holding semaphore inside that commit callback, so steering cannot slip behind a recorded reply. A false take returns no entries or ids; an uncertain acknowledgment uses the memory log's fresh durable snapshot. Step requests forward probe/take and the run ordinal unchanged.
- `agentTaskExecutor` forwards its optional nondurable `steering` effect to both child and reaction turns. Durable steering comes from their prebegun writers through `TurnLive`; the executor neither begins another turn nor turns child input into a parent notice.
- `src/turn-composition.test.ts` rebuilds the golden agent by hand from the typed layers: a composition change keeps both it and `Agent.turn` byte-identical to the golden.
- Every `fixtures/journal-<version>.json` is kept as historical evidence: `src/journal-compat.test.ts` replays those at the current `STORED_FORMAT` and checks that Sessions refuses the others with `session.version`, their bytes unchanged (no migration, no compatibility decoding); record one per release with `bun scripts/record-journal-fixture.ts`, never over a released one. Development records go to `journal-unreleased.json` with `--unreleased`; only that fixture permits `--force`. Keep released fixtures byte-identical to their release tags.
- `docs/events.md` quotes regions of `src/events-guide.test.ts`: edit the snippet there, then run `bun run docs:generate`.
- Keep test-only code out of `index.ts`: `src/testing.port.ts` (`Tally`, `Stamp`) serves the tests only, and the build leaves it out.

- `agentInboxRunner(agent, { services, use? })` captures the same Sessions as the drainer and runs a borrowed writer through Agent.turn. It neither begins nor ends; preserve the outcome and typed TurnError. Build it beside the agent to avoid a graph cycle. Its contract is pinned by the core InboxRunner kit and a real-agent queued journey.
- Runtime activity captures WaitingInput and DrainActivity alongside turn/task/shutdown probes. An inbox drainer is built beside the agent, never in its runtime: `Agent.activity` and `Agent.shutdown` count the caller's `DrainActivity` when the runtime has none. Installed queue failures stay SessionLogError. Shutdown waits only for inFlight, retaining queued input and using cached queue knowledge.
- Optional `CommittedTurnObservers` contributed by before-turn session plugins are notified in graph order only after an owned writer's end acknowledges. Their scopes remain open until notification finishes; each callback has a one-second bound and failures are logged without changing the committed result. A borrowed writer is its host's to end; the host calls core's `notifyCommittedTurn` after that end. No observer means no new span, model text or journal data. `src/committed-turn.journey.test.ts` proves final reply/end visibility, failed turns, failed ACKs, borrowed writers and soft failures.
- Runtime `BackgroundWorkers` contributions are counted alongside, without replacing, `TaskActivity`. A sleeping poller is idle; `runningWorkers` is present in activity only when the service is installed. Shutdown first allows held turns and their post-commit enqueue observers to settle, then stops new worker claims and interrupts remaining work within the same absolute deadline. Worker scopes close before their store dependencies. `src/background-workers.journey.test.ts` proves task-runner coexistence, enqueue ordering and the shared deadline.

- The optional writer `memorySnapshot` capability enables a `LogHandle.checkpoint` bridge before `memory.open` can invoke it. Load resolves the selected publication's anchor and frontier through actual ordered memory rows, decoded once and shared with every save, with per-session cursors and publication visibility checks; malformed selected data fails `SessionLogError` with `session.decode`. Save copies the candidate before its gate, resolves durable cursors, verifies the shared core selection and appends and flushes `memory.snapshot` through the writer. Held closing facts without durable rows skip publication. Only ACK bookkeeping is masked; failed or interrupted publication keeps its original terminal outcome. The existing full archive, bootstrap readers, request snapshot, dispatch and historical replay remain unchanged. This accelerates rendering, with no claim of reduced initial archive or hydration I/O. Focused lifecycle/cursor/ACK tests are in `src/turn/memory-checkpoint.adapter.test.ts`.

## The kernel (`src/kernel`)

`@xandreed/sdk/kernel` is a second, much smaller agent beside the one this
file describes, over `@xandreed/core/kernel` (`docs/kernel.md`): every
workflow contract and the stock plugins (ADRs 0002 and 0003). Its layers come before
the sdk's: `sdk-kernel-contracts` (`contracts/**`), one
`sdk-kernel-plugin-<name>` per plugin folder, `sdk-kernel` (the entry) and
`sdk-kernel-tests` (every test glob the build leaves out, wherever it sits
under the kernel, a contract's or a plugin's folder included, placed
before them all). It imports core's kernel and
`effect/ai` and nothing else of the workspace, not core's root, not the
runtime, not the rest of the sdk, and no runtime module:
`browser-bundle.test.ts` builds its entry for a browser and records every
specifier the bundler resolves, none of which may name one (`node:`,
`bun:`, or a bare builtin name); its control, `fixtures/kernel-node-import.ts`,
imports `node:path` and must be caught. The rest of the sdk may not import
it: `./kernel` is a `restricted` subpath.

- A contract lives in `contracts/<name>/`: its entities, events, pure
  rules and kit. There is no loop contract (ADR 0003): the loop is the
  host's program, and the conversation's records (`userMessage`,
  `assistantMessage`, `CONVERSATION_READER`) are core's.
  `contracts/memory` holds `Memory` (`context(session)`, the messages
  that follow the system text, as Effect AI's `Prompt.MessageEncoded`),
  `Tokens`, `estimateTokens`, `estimateContext`, `messageText` (a
  message as text for an estimate, tool calls and results counted),
  `promptMessage` (a call as a `tool-call` part of the model's message, a
  result as a `tool` message), `paired` (a call only with its result, a
  result only with its call, an answer left empty dropped: every memory
  sends through it, ADR 0004) and the
  memory kit (`memoryConformance`; `MemorySubject` is `{ name,
  budgetTokens?, open }`, and the budget checks run only for a subject
  that has one), and the kit of a memory wrapper
  (`memoryWrapperConformance`; `MemoryWrapperSubject` is `{ name, wrap }`,
  `wrap` a higher-order plugin given the kit's own flat memory: the
  wrapped context starts with the inner one whole, `starts-with-inner`,
  and what it appends is under its prefix and never the conversation's,
  `own-records`; ADR 0005); `contracts/inbox` holds `Inbox`, its turn function
  (`InboxTurn`, failing with `InboxTurnFailure`), its ticket, refusals and
  event. A contract imports core's kernel and other contracts, never a
  plugin; a plugin imports contracts and core's kernel, never another
  plugin's folder: the boundaries gate refuses both. The memory kit builds
  its checks with `contracts/conformance.entity.functions.ts`, a copy of
  core's kernel helpers, which core does not export. A port that moved
  keeps its key: `Memory` is still `@xandreed/core/kernel/Memory`, as it
  was declared; a new one is `@xandreed/sdk/kernel/<Name>`, as `Inbox` is.
- Every plugin is a plain Effect `Layer`, its type saying what it needs,
  and the host composes them with `Layer.provideMerge` over core's
  `kernel({ capacity? })`, which provides `Core` alone, or provides them to
  its program with `Effect.provide`. The system text is the program's
  code, sent first in every prompt and never stored. There is no wiring here: no `Agent.define`, no plan of what plugins
  declare, no replacement API. A plugin's layer lives in an `.adapter.ts`;
  a `.usecase.ts` and an entity's functions hold no `Layer`.
- A plugin is a folder under `plugins/`: `journal-in-process`
  (`inProcessJournal`), `session` (`sessions`), `memory-window`
  (`windowMemory`, with its own events and `OverBudget`; a budget that is
  no finite number of at least one token fails the layer with
  `InvalidBudget`; its budget covers the history only, and it publishes
  `plugin.window.pressure` as it builds a context, tagged `memory` like
  `plugin.window.dropped`; it drops whole turns only, so one long tool
  turn can go over its budget and fails with `OverBudget`), `memory-flat`
  (`flatMemory`: every message of the conversation but a call no result
  answers, nothing stored, read through
  `readerFor("flat", [], CONVERSATION_READER)`), `model-scripted`
  (`scriptedModel(script)`: a `LanguageModel` layer that follows a
  `ModelScript` of `ModelAnswer`s, `Answers`, `Calls` (pieces, then
  `tool-call` parts named `call-<n>-<i>`) or `Fails`, and records the
  prompts it was sent, a call as `name(params)` and a result as `→ result`,
  for kits and tests) and `inbox`. No plugin calls a model or runs a tool:
  the host's turn does, through Effect AI's `LanguageModel` and `Toolkit`
  (ADR 0004: no tool service in the kernel).
- The inbox (`plugins/inbox`) implements the contract in
  `contracts/inbox` (`inbox.port.ts`, key `@xandreed/sdk/kernel/Inbox`):
  core does not know it. `inbox(turn)` and `inboxOf(turn, options)` take
  the host's turn function (`InboxTurn<R>`: a session and a message to a
  reply's text), run it for each message they take, and need what it
  needs. Its state is one `InboxState` (`Open` with the next ticket and a
  `SessionQueue` per session whose worker runs, in a `HashMap`, or
  `Closed`), moved by the pure transitions of `inbox.entity.functions.ts`
  (`enqueue`, `take`, `finish`, held to a table test) under one
  `Ref.modify` that also registers the reply. The ticket is the inbox's
  one counter, taken in the step that queues the message: never given
  twice in one inbox, so a session's queue need not outlive its worker. A
  worker per session is started by the transition that queues for a
  session with no queue and stops in the one that finds nothing to take,
  which removes the queue, so no message is left without a worker and the
  inbox keeps nothing of a session it is not serving. `enqueue` is one
  uninterruptible step that waits for nothing: the transition, a fiber of
  the plugin that publishes `plugin.inbox.queued` (live, about the session
  and no turn), and the worker it planned. The announcement is started at
  once (a waiting listener that does not suspend has heard it when
  `enqueue` returns) and follows the session's last announcement, kept
  beside the state (`Held.announcing`) whether its message waits, was
  taken or runs, and dropped in the transition that removes the session's
  queue, so one session's announcements are published in ticket order.
  The caller gets its ticket and reply whatever becomes of the
  announcement; it is published with `listenerFailures: "report"`, so a
  failing waiting listener is reported, fails nothing and holds back none
  after it, and an announcement cut short by the scope's close interrupts
  its signal, so its message starts no turn. The worker takes the next
  message in one transition, then waits for that message's own
  announcement before its turn starts, so a message's `turn.started`
  follows its `plugin.inbox.queued` reaching the listeners the publisher
  waits for, whenever a message is queued. Taking a message and putting
  its reply in the hands of what follows is one uninterruptible step: the
  wait for the announcement and the turn run interruptibly under one exit
  handler that settles the reply, so a close finds every reply either
  waiting, which the finalizer fails, or with a worker that settles it
  (`InboxClosed` for an announcement or a turn cut short). A failed turn fails its own reply; an interrupted wait
  for a reply does not cancel the turn; the close of the plugin's scope
  fails every reply not given with `InboxClosed`, the running turn's
  included, and refuses later messages (`InboxRefused`, `Closed`); a full
  queue refuses with `Full`. `plugins/inbox/inbox.adapter.test.ts` holds
  each, and a slow `turn.ended` listener that delays the next message
  without failing it. No test there can tell the worker's mask from its
  absence: Effect delivers an interrupt only where a fiber suspends or
  yields to the scheduler, and nothing suspends between the take and the
  start of the step whose exit settles the reply, so the mask guards
  against a scheduler yield there. Nor can one tell the interrupted signal from one that
  succeeds: the scope's close interrupts the announcer, which settles at
  once, then the worker, before the worker can run.
- The flat and window memories' layers, the session plugin's `append`,
  `open` and `turn`, the inbox's contract, and regions of
  `lesson.test.ts`, `guide.test.ts` and `swap.test.ts` are quoted in
  `docs/kernel.md`; `guide.test.ts` fails when a quote and its source
  differ, or a fence of the document is not pinned. Change the source and
  the document together.
- The session plugin stores, then publishes, and the store is the truth.
  Every `begin` reads the journal for the phase and the last place, and the
  append of `core.session.turn.started` there is the claim: a conflict is
  `SessionBusy`, not a storage failure, and a turn that did not open
  (failure or defect) holds nothing. A turn's start is announced inside the
  turn; a turn interrupted as it opened, whose body never began, has its
  start announced by the end, before the end and within a `closeWait` of
  its own (`Opened.announcing`, set in the start's `beforeHandOver`), so
  a listener that holds that start cannot keep the end from the stream. A body's append of a record named under
  `core.` is refused (`ReservedName`) before anything is stored. Its
  writes take one lock per open turn (`Turn.writes`): the check
  that the turn is open, the read of the last place and the store are one
  step, so two appends made at once are stored one after the other, and
  the end, once the body has returned, waits for an append still being
  stored and is stored after it; an append made after the end began is
  `NoOpenTurn`. The lock holds the store and not the announcement, so no
  listener holds the end; each event is announced after its own store.
  The place is unknown from the moment a store is asked until it reports
  success: a write interrupted while its store had not answered, or one
  whose store failed after it kept the event, leaves the next write, the
  end's included, to read the last place from the store, so the end is
  stored after it (such an event is in the journal and was never
  announced). Its end is stored, then announced with
  `listenerFailures: "report"` on a fiber of the plugin bounded
  by `closeWait`, whatever its listeners do, and the session is freed in
  the publish's own step before the hand-over (`beforeHandOver`): events
  appended one after another reach listeners in journal order, whoever
  hears of the end in the background finds the session free (held by a
  test under a scheduler that makes every fiber yield after a few
  operations, the only way the background runs between the hand-over and
  the publisher's next step), and an interrupted caller does not wait. A
  turn whose end cannot be stored stays open and the caller gets the
  storage failure; so does one whose start the store kept while it
  reported a failure. Closing either is crash recovery, which returns with
  the durable stores. `append` after the close is `NoOpenTurn`. `create` decodes its input (`InvalidSession`). Ids are
  version 4 UUIDs from `crypto.getRandomValues` (which needs no secure
  context, unlike `crypto.randomUUID`), or what `SessionsOptions.mintId`
  mints. `plugins/session/sessions.adapter.test.ts` and
  `listeners.test.ts` hold each of these.
- A test waits on a signal, never on a count of retries or sleeps. A
  session is free when its turn's end is on the stream; a background
  listener has handled everything before a probe once it has handled the
  probe. A test of a listener that may hang gives itself an
  `Effect.timeout`, so the code it guards fails there and does not hang
  the run.
- Tests: `no-loop` (core with no workflow: the kernel, the journal, the
  session plugin and one plugin that opens a turn and appends its own
  records, typed as needing nothing and providing only `Sessions`,
  `JournalStorage` and `Core`, run and store the turn), `one-turn`, `turns` (twenty turns, every exit, a second turn, a
  model that fails part-way, a memory that fails, what the test turn and
  the window memory refuse), `plugins` (a different turn over the same
  layers; a plugin's own event and a reaction to it), `listeners` (also a
  listener that cannot be interrupted), `unknown-records` (also a second
  session plugin over one store, and a memory swapped over one base),
  `sub-agent` (a helper in a session of its own, a child of the
  caller's, reached through a `delegate` tool, quoted by `docs/kernel.md`:
  the caller's journal holds the call and its result, which names the
  child; the helper's prompt holds only its task), `own-plugin` (an event plugin, the meter, and a wrapper of memory, the
  clock, quoted by `docs/kernel.md`; the clock stored as a plugin's record
  never reaching flat memory, stored as a user message piling up; the
  wrapper kit on the clock and on careless wrappers, each failing only
  its check), `lesson` (the first lesson's program: three messages, each turn seeing
  the ones before, and a journal of the conversation only), `tools` (a
  host's turn with tools, quoted by `docs/kernel.md`: a call stored with
  its result and the model asked again; a tool's failure, an unknown tool
  and bad parameters stored as failed results; the step limit), `swap` (a
  session going on over a shared base under another memory), `wrapping`
  (a contract wrapped by plain layers and by higher-order plugins),
  `composition` (`type-level:` a stack missing a part does not
  compile where its type is annotated), `plugins/session/sessions.adapter`
  (a store that fails, suspends, or stores and then keeps its caller
  waiting or reports a failure, on request; a turn's writes one at a
  time; an append whose store did not report success followed by the
  end; a body's append of a `core.` record; a turn interrupted as it
  opens, also with a listener that never lets its start go; every waiting listener of the end hearing it; the end's
  hand-over to a background listener that opens the next turn; two
  session plugins over one store; the ids), `plugins/memory-window/window.adapter` (`plugin.window.pressure`:
  when, how often, with what), `plugins/inbox/*` (the transitions as a
  table, and the inbox's rules, among them an announcement before its turn
  and in ticket order under a scheduler that makes every fiber yield after
  a few operations), `kits` (the storage, sessions and memory kits on the
  stock plugins, the memory kit on both memories, and on careless ones:
  each careless plugin fails the checks of what it is careless about and
  no others, and between them every check; the memory kit's `pairs` check
  has the careless `unpaired`, which sends a call no result answers), `browser-bundle`, `guide`, and
  beside the contracts' files their own
  (`contracts/memory/memory.entity.functions.test.ts`: a record's prompt
  message, tool calls and results included, `paired`, and the estimate). A test whose claim is the compiler's says
  `type-level:` in its title. `testing.ts` holds the test turn
  (`testTurn(system)`, a `Turn` needing `TurnNeeds`, which refuses a
  message of no text with its own `EmptyMessage` and fails a model's error
  part with its own `ModelFailed`), composes the stock stack (`stack`,
  `base`) and opens a built one with a test's shorthand (`open`, whose
  `send` returns the reply's text); `testing.port.ts` holds `Label`, a
  stand-in contract for `wrapping`. `scripts/kernel-consumer.fixture.mjs`
  runs the three kits, one turn of a host's own over a stack of layers,
  two messages queued with the inbox, a host's turn with tools (`toolTurn`)
  and a consumer's own contract
  composed as a layer, from the packed packages, on Node and on Bun
  (`bun run verify:packages`). Run: `bun test packages/sdk/src/kernel`.

## Public surface

- `Agent` (`Agent.define`) and the types `AgentConfig`, `AgentPluginEntry` and `AgentTurn` (`src/agent.adapter.ts`; `Agent<S>`, `AgentConfig<S>`: the type of `services`, which `use` reads without the turn requiring it, while plugins and tools check theirs by key when they open), and `agentTaskExecutor(agent, { services, steering?, child?, react? })` (`src/task-executor.adapter.ts`): a `Layer<TaskExecutor>` whose child and reaction turns run with `services` and the calling `Tasks`, and are, by default, the turn's skills selected, then one run of the step loop, its text the reply.
- The turn engine, for a host that composes a turn itself: `TurnLive`, `cacheKeyOf`, `runTurnLoop`, `stepRequestOf` (`TurnRunServices`), `finishTurn`, `guardTurn`, `openTurnTools`, `settleTurn`, `traceTurn`, `traceTurnBegin` (`TurnBeginTrace`, `TurnTraceOptions`), `turnOf` and `turnTools`.
- Core's host API, re-exported by name (`src/index.ts`) so that a host defining an agent and running its turns imports one package: a turn's input (`UserMessage`, `mediaFromBytes`, `mediaFromBase64`, `RunId`, `ConversationId`, `SessionAddress`, the types `TurnInput` and `NewTurn`); the turn and its result (the types `Turn`, `TurnPolicy`, `TurnOutcome`, `TurnResult`); the sessions turns begin in (`Sessions`, `SessionLog`, `SessionLogMemoryLive`, `TurnAdmission`, `TurnAdmissionOpen`, `TurnRefused`); the host's capabilities and plugins (`defineTool`, `defineSkill`, `definePromptSection`, `defineCapability`, the type `Capability`, `definePlugin`, `publishToolProgress`, `Failure`, `Media`, `SessionEnvironment`, `ActionPolicy`, `PermissionGrants`); the turn's events and the journal's records of its messages and end (`TurnEvent`, `TurnEvents`, the types `TurnEventOf` and `TurnEventsService`, `onEvent`, `onTool`, `subscribeAll`, `defineHostEvent`, `AssistantMessage`, `TurnEndedData`, `turnEndedOf`); what a turn fails with (`HarnessError`, `isHarnessError`, `harnessCodeOf`, `TurnBeginError`, `turnBeginCodes`, the type `TurnError`, `isTurnError`, `turnEndingOf`); and what the process has in flight and how it stops (`awaitIdle`, `processActivity`, `shutdownGracefully`, `DEFAULT_SHUTDOWN_DEADLINE`, `TurnShutdown`, `isShutdownRefusal`, the types `ShutdownOptions` and `ShutdownReport`). A port to implement and its entities, memory, model requests, stored payloads and References are imported from `@xandreed/core`, a kit from `@xandreed/core/conformance`: the sdk is the host's entry, not a second copy of core's surface. A name joins the list when a host writes it beside `Agent` in the common case, not because one test needs it.
- `quality/exports-have-consumers` runs on both entries (`CURATED_ENTRIES`): each export is imported from `@xandreed/sdk` (or `./conformance`) by another package, a script or a doc code block, or is tagged `@public`: the sdk's own declarations at the declaration, a re-export of core at its specifier in `src/index.ts`.
- `@xandreed/sdk/conformance` (`src/conformance/index.ts`): `toolRegistryConformance(make)` (`ToolRegistryLimits`), the `ToolRegistry` kit. It runs each check in a turn over `TurnLive` with a writer of its own that keeps the turn in memory: a kit ships in the build, which leaves test code out (`*.test.*`, `testing` modules and folders: `scripts/build-check.ts`), so it cannot import `recordingTurnWriter` (`src/turn/testing.ts`). It runs here, over the tool discovery plugin's registry, with its self-tests (`src/tool-registry.conformance.test.ts`).
- `@xandreed/sdk/kernel` (`src/kernel/index.ts`): the workflow contracts (memory's: `Memory` (`MemoryFailure`), `memoryConformance` (`MemorySubject`), `memoryWrapperConformance` (`MemoryWrapperSubject`), `Tokens`, `estimateTokens`, `estimateContext`, `messageText`, `promptMessage`, `paired`; the inbox's: `Inbox`, the types `InboxTurn`, `InboxTurnFailure` and `Queued`, `Ticket`, `InboxRefused`, `InboxClosed`, `inboxQueuedEvent` and its data), and the stock plugins, each a layer, with what a host needs beside them: `inProcessJournal`, `sessions` (`SessionsOptions`), `flatMemory`, `windowMemory` (`WindowOptions`, `OverBudget`, `isOverBudget`, `windowDroppedEvent`, `windowPressureEvent` and their data, `InvalidBudget`), `scriptedModel` (`ModelScript`, `ModelAnswer` with its `Calls` answer, `ScriptedCalls`), the model that follows a script, for kits and tests, and the inbox: `inbox`, `inboxOf` (`InboxOptions`). No loop and no tool service: the host writes its turn over these, core's conversation records and Effect AI's `Toolkit` (ADRs 0003 and 0004). A first cut: it changes as the parts it leaves out return.
- Plugins: none exported. `Agent.define` adds `@xandreed/sdk/host-contributions` (runtime, contributes `efferent/Capabilities`) for `AgentConfig.capabilities`.

## Model-facing text

The system prompt prefix is the host's (`AgentConfig.system`, a turn's `system`). The sdk pins its fixed bridge failure messages and what a composed agent sends:

| Pinned text | Source | Pinned by |
|---|---|---|
| Fixed task inbox bridge failures: `The inbox session is unavailable.` and `The task session has no parent.` | `src/task-inbox-runner.adapter.ts:17`, `:28`, `:32` | exact tests `src/task-inbox-runner.adapter.test.ts#bridge failures keep fixed model-facing words when a session or its parent is unavailable` |
| Every model request of the golden conversation: system prompts with the tool-discovery catalogue, tool descriptions and schemas (`load_skill`, `recall_context`, the host's), memory renderings (a `CompactViews` compaction, a digested result), seeded `load_skill` exchanges | `golden/agent-turn.model.json` | exact tests `src/agent.golden.test.ts#Agent.turn reproduces the golden conversation byte for byte`; `src/agent.backends.test.ts#the model sees the same requests wherever the session is stored` |
| Every model request of a streamed conversation: signed and redacted thinking sent back with its provider metadata, by the next request, the journal's rebuild of it and a second agent | `golden/agent-stream.model.json` | exact tests `src/agent.stream-golden.test.ts#a streamed turn keeps its reasoning's provider metadata` |
| Every model and summarizer request of two compacting conversations: the window strategy's spill preview, the `recall_context` page that reads it back, and the host note and ledger of dropped turns; the summary strategy's summarizer prompt (default instructions, the data rule, the `<earlier-summary>` and `<conversation-transcript>` frames, a clipped tool result), its handoff, and the `recall_context` schema it contributes | `golden/agent-compaction.model.json` | exact tests `src/agent.compaction-golden.test.ts#a window and a summary conversation compact as the golden holds` |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/agent.adapter.ts` | `Agent.define`, `agent.turn`, the turn metrics |
| `src/task-executor.adapter.ts` | `agentTaskExecutor`: core's `TaskExecutor` over `Agent.turn` |
| `src/task-inbox-runner.adapter.ts` | `taskInboxRunner`: borrowed child follow-ups and post-ACK parent delivery repair |
| `src/turn/turn.adapter.ts` | `TurnLive`: the turn as services over its writer |
| `src/turn/turn-phase.entity.ts`, `src/turn/turn-phase.entity.functions.ts` | where one turn stands in `TurnLive`, and its transitions |
| `src/turn/model-call-recorder.adapter.ts`, its entity pair | durable terminal call recording, sticky ACKs and turn-owned billing observation |
| `src/turn/turn-run.usecase.functions.ts` | one run of the step loop: the step request, the cache key |
| `src/turn/turn-lifecycle.usecase.functions.ts` | the lifecycle: open the tools, settle, finish, guard, trace |
| `src/turn/tool-registry.conformance.ts` | the `ToolRegistry` kit |
| `src/index.ts` | the sdk's own exports and the core names it re-exports for hosts |
| `src/conformance/index.ts` | `@xandreed/sdk/conformance` |
| `src/testing.port.ts` | test-only services for the agent tests |
| `src/turn/testing.ts` | `recordingTurnWriter`: a writer that keeps the turn in memory, for the engine's tests |
| `golden/agent-turn.model.json`, `golden/agent-turn.journal.json` | the golden conversation: what the model and host see, and what is stored |
| `golden/agent-stream.model.json` | the streamed golden: what a streamed conversation sends and stores |
| `golden/agent-compaction.model.json` | the compaction golden: what a window and a summary conversation send, and the compactions they store |
| `fixtures/journal-<version>.json` | journals each release wrote |

## Tests

- Golden and composition: `agent.golden.test.ts`, `agent.stream-golden.test.ts`, `agent.compaction-golden.test.ts`, `agent.backends.test.ts`, `turn-composition.test.ts` (also runs core's `turnConformance`), `plugin-stack.test.ts`.
- Behaviour: `agent.adapter.test.ts`, `agent.trace.test.ts` (span nesting and ids), `activity.test.ts`, `models-plugin.test.ts`; the key-free journeys `resume.journey.test.ts` and `tasks.journey.test.ts` (a background task through `agentTaskExecutor`: start, the child's turn, delivery, `pending`, drain; the `Tasks` among each turn's services, a task's `start_task` refused for depth, a reaction starting a task).
- LangSmith: `langsmith-telemetry.journey.test.ts` runs the shared local collector and fresh-process task ancestry fixture. It checks native inference ownership, missing versus reported usage, content controls, actual initial/follow-up child ancestry and no bookkeeping execution span. Packed Node and Bun run the same fixture; live ingestion is not part of these checks.
- Queued input: `queued-input.journey.test.ts` runs a prebegun queued writer through `Agent.turn`, preserving normalized attachments and user provenance, and resumes an interrupted queued turn without draining the same input again.
- Durable steering: `durable-steering.journey.test.ts` covers final-response steering after a true completion verdict, restart before first dispatch, caps, post-probe arrivals, concurrent runs and refused/lost-acknowledgment commits.
- Host tool policy: `tool-policy.journey.test.ts` exercises real Agent per-run caps with exact run ordinals, per-tool concurrency shared across turns, interruption release, fair writer exclusion, nested calls across toolkit child fibers, runs of another agent inside a handler (which wait on their own lanes and permits) and queued breaker rechecks. The shipped registry kit includes policy and lane checks with careless adapters.
- Tool interception: the registry kit adds `interceptor-absence`, `interceptor-order`, `interceptor-deny`, `interceptor-rewrite`, `interceptor-respond`, `interceptor-after`, `interceptor-durable`, `interceptor-errors`, `interceptor-scope` and `interceptor-policy`, with a careless adapter that ignores the installed hook. These checks prove registry interpretation and before-audit ACKs; they do not claim a direct Toolkit call persists a final memory answer. `tool-interceptor.journey.test.ts` drives actual normal/planned turns and codec recursion; `tool-interceptor-recovery.journey.test.ts` drives the shared directory fixture on incremental answers, held views and after callbacks, cancellation, SIGKILL, cold replay and rewritten typed view/compact/digest input.
- The engine: `turn/turn.adapter.test.ts` (`TurnLive` over `recordingTurnWriter`), `turn/turn-lifecycle.usecase.functions.test.ts` (the begin and turn spans), `turn/turn-phase.entity.functions.test.ts`.
- Model-call accounting: `turn/model-call-recorder.adapter.test.ts` runs core's recorder kit and covers ACK/reaction failure, reentry, interruption, mutation isolation and own-row snapshots. `model-call-usage.journey.test.ts` verifies bootstrap/finalizer helpers, two exact run ordinals, maintenance/planning correlation, selected-versus-billed totals with inherited parent references, and a loop model outside the ledger billed beside a recorded helper.
- Run maintenance: `turn/turn-run.lifecycle.test.ts` covers nothing between a loop and its return, the next run's start, failed and waiting loops, manual preparation, system StepContext reserves, catalog-window ceilings, frozen pre-reaction measurements, matching fallback observations, empty tails, unusable evidence, failed/held ACKs, concurrent runs, and the hand-off to the sealed reply (once, on the accepted input and base reserve; skipped without `seal`; an ordinary failure skipped, a writer's hard). `after-reply.journey.test.ts` drives `Agent.turn` through the work after a sealed reply: billed in the turn before its closing commit, on the run's reported input; an interruption, a cancel, a failure, a time limit, a shutdown and a takeover of a hung holder each leave the turn `completed` with its reply's text and not resumable, the sealed turn never asked again; the next turn's start is calibrated by the stored response. `model-call-usage.journey.test.ts` verifies the post-reply helper runs after the host's reply and the turn-owner closing helper, before the end.
- Overflow recovery: `turn/turn-overflow.adapter.test.ts` covers exact dispatched snapshots despite lookahead, frozen retry headers, no-progress/no-fit refusal, fallback-specific neutral bounds, absent output, matching scale, concurrent arrivals, reentry, hard/interrupted ACKs and independent shrinking run ceilings. `turn/turn-overflow.entity.functions.test.ts` covers reserve arithmetic, unknown bounds and unsafe/no-room refusal.
- Request parts: `turn/request-parts.adapter.test.ts` covers dependency-before-header batches, repeated/concurrent dedup, fork visibility and overlapping sequence numbers, caller mutation under held ACK, future-part refusal, conflicting and unrelated damaged parts, uncertain append/flush ACKs, cancellation releasing serialization, and codec versus writer failures. Agent and overflow tests materialize stored V2 controls while separately pinning raw references and incremental read stages.
- Request hooks: `turn/model-request-hook.adapter.test.ts` pins the exact combined context in tail/system placement, patched full/base reserves, empty-patch compatibility, held-ACK copying, writer failure identity, interruption, frozen media/overflow decisions and concurrent run context. `model-request-hook.journey.test.ts` drives optional host-service and host-layer hooks through real turns, preserves typed failures before any send, skips helpers/planned batches and replays saved controls without invoking today's hook. The shared `request-hook.journey.test.ts` adds files/process and streamed fallback evidence; the retry consumer also checks once-per-decision behavior across real local HTTP retries and routed fallback.
- Plugins tested inside a turn, here because the sdk lists them as devDependencies and a plugin the sdk lists never lists the sdk back: `tool-registry.conformance.test.ts` (the `ToolRegistry` kit over the tool discovery plugin's registry, and the kit's self-tests: careless registries that must fail), `tool-discovery-turn.test.ts` (that registry in turns over `TurnLive`: invocations and progress, subscriber failures, refusals and their journal, an open lacking declared services, defects, the matcher's choice, `load_skill` and `read_skill_reference`; the plugin's AGENTS.md pins its texts here), `sessions-begin-trace.test.ts` (the sessions plugin's spans under `traceTurnBegin`).
- Results bounded as they are written: `bound-on-write.journey.test.ts` drives `Agent.turn` under the window and the summary strategy with a host tool that has no view and returns four results far above the bound in one turn. Each is shown from its first request as its first 16,000 characters and a locator, every request fits the default budget, each request's messages are a byte-identical prefix of the next one's, `recall_context` returns the next page whole, and `boundOnWriteChars: 0` shows the results whole, with `recall_context` still offered. Calls made together in one step are each bounded as they return and the next turn's first request starts with the same messages; a tool's own `boundOnWriteChars` annotation decides what its result shows (whole at `0`, cut at its own bound); a summary session bounded at the default and continued at `0` still shows the notice, offers the tool and serves the page. A window turn whose bounded results together pass the budget spills some again instead of failing; a summary turn sends them as they are, over the budget. The compaction golden's summary conversation runs under 1,340 tokens: the 1,100 its scenario was written for and the 240 the recall tool's schema reserves. `memory-window-current-turn.journey.test.ts` runs under 1,567 for the same reason: its 1,500 and the 67 the tool's description has since added (173 when the scenario was written, 240 now). A change to that description moves both budgets with the reserve, so the messages keep the room their scenarios were written for.
- The recall guard: `recall-guard.journey.test.ts` drives `Agent.turn` under the window and the summary strategy with a host tool whose result is bounded as it is written. A model that asks `recall_context` for the result from its start is answered with `ResultShown`, which holds no offset and sends it to the one the result's shortened form shows; it follows that to the next page, is answered with `AlreadyRecalled` and that page's end when it asks for the page again, and follows that to the page after; asked then from an offset inside the first page, the reply names the end of the second, where the text it has read ends. One that keeps asking for shown text, from a new offset each step, repeats one progress signature and ends `partial` with `degenerate-loop` after seven requests, under a step limit of 24; one that reads on from the notice and then steps forward inside the page it read (one character at a time, 1,000, or 1,333) ends the same way after eight, where 0.21.0 ran to the step limit under the summary strategy and failed with `context.budget` under the window one. Six refused calls must fall inside one page of 8,000 characters, so 1,333 is the longest stride stopped: at 1,334 the journey ends `partial` with `step-cap` after 24 requests, four pages of new text and nineteen refusals. Downward steps are not stopped either, and are no longer served text the request holds: a model that reads a page at 60,000 and then steps down 1,000 or 100 characters at a time gets a whole page, then pages that each end where the one before starts and name the offset past all of them, and ends `partial` with `step-cap` after 24 requests within the budget, the last request holding each character of the report once. On 0.21.1 the same run failed with `context.budget` under the window strategy and held each page's text again under the summary one. After ten such steps a model that asks from inside the lowest page is sent past all ten pages by one reply and is served the page there (on 0.21.1's rule, which named the end of the page that held the offset, nine more refusals came first); one that instead steps forward through those pages 1,000 characters at a time gets that one reply each time and ends `partial` with `degenerate-loop` at the sixth, after seventeen requests. A result of an earlier turn is served from any offset, as often as asked. Two calls for one page made together in one response: the second is refused at the turn's default `toolConcurrency` of 1, and both are served at 2. Each refusal is stored as its call's failed result, and each stored page names its run: the page is refused again because the handler reads the loop's run. A refusal outlives what the request showed when it was written, and the scripted model follows it as a model would (a number the reply names, else the offset the result's shortened form shows in that request, else 0): read in the next turn, it leads to the result's start under the window strategy, which has given a tool with a compact view that view, and to the notice's offset under the summary one; under the window strategy with a budget the turn passes, it leads to the new notice's offset after a second spill, and to the result's start after pressure gave an earlier turn's result its compact view (`compactPreviousTurn: false`). Each of those fails on 0.21.0's text, which named the offset of a head the request no longer showed. An `AlreadyRecalled` reply names no turn: read in the next turn, under both strategies, it still has the page it calls shown above it, and the offset it names is served as the page after.
- Cuts at line breaks: `line-cuts.journey.test.ts` drives `Agent.turn` under the window and the summary strategy with `cutAtLineBreaks: true` and a host tool that has no view and returns a table of 1,000 rows, each starting with its identifier. The result is bounded as it is written after the last whole row within 16,000 characters, from the first request that includes it; each request's messages are the one before it byte for byte with more after; the model reads on from the offset each last line names, and every `recall_context` page ends after a whole row, starts with a row's identifier and is shorter than 8,000 characters; the head and the pages join to the table; the one compaction stored is the bound, under `4+cut-at-line-breaks` for the window strategy and `2` for the summary one, which every `context.built` names too. A second model asks for text it has: the last character of the head is refused with `ResultShown` and the reply leads to the notice's offset, the first page; that page again is refused with `AlreadyRecalled` and its own end, where the second page is served; an offset inside the first is then refused with the second's end, where the third is served. Without the option the same turn cuts the head at 16,000 characters and each page at 8,000, inside rows. The table's rows are of lengths that put no limit at a row's end, which the journey checks first: a table whose rows divide the limits would pass with either cut.
- Context report: `context-report.journey.test.ts` drives two turns through `Agent.turn` and holds core's `contextReportOf` over the stored journal against what the scripted model was sent, request by request: the system text, the tool declarations (their tokens equal to each `context.built`'s reserve), and each tool result's characters, one bounded as it was written, one shown through its tool's view and one raw. The step policy's context and a request hook's note are reported in separate fields, a later step still showing its run's latest context and a turn with neither reporting none. Usage comes from the model's recorded calls in the first turn and from `step.usage` in the second, whose model records none. A second session, with the bound off and a budget a third of one result, has window memory spill that result at the next step's start, after the `step.ended` of the step that returned it and before the first request that includes it: the report says `spilled`, where the preview's place before that request alone would read as a bound. A third session keeps `compactPreviousTurn: false` with the bound off, under a budget one token below what its second turn's second request takes (measured from the same turns under the default budget, so a change to the tools' reserve moves it): window memory gives an earlier turn's result its compact view at that step, and the second turn's result its own before the third turn's first request. Each of those turns counts one compact view (`compacts`), the second lists the first result `whole`, by the request that showed it whole, and the third lists both `compact`; under the default budget the same turns count none.
- Compact views under pressure: `compact-under-pressure.journey.test.ts` drives three turns of `Agent.turn` under the window strategy with `compactPreviousTurn: false` and a host tool that has a compact view, under each pressure order. Every request before the pressure is the one before it byte for byte with more messages after, across both turn starts; the first request over the budget shows the earlier result whose compact view frees the most through that view, the other earlier result and the current turn's whole, with one `CompactViews` stored and nothing spilled or dropped; the request after it extends it unchanged. Under a budget the conversation fits, the same turns record nothing.
- Kits and compatibility: `memory.conformance.test.ts` (core's `memoryConformance` over the window and summary strategies and a test-only one, with careless sessions the kit must refuse: among them one that shortens a stored view instead of what a build shows, one that shortens a result at a later write and one that keeps a bound outside the log; the kit also runs over the window and the summary strategy with `cutAtLineBreaks` on), `journal-compat.test.ts`, `events-guide.test.ts`.
- Run: `bun test packages/sdk`.

See the root AGENTS.md for the enforced rules and the definition of done.

A turn freezes `BuiltContext.stableMessages` in each new request header and
marks the outgoing copy with core's recognized volatile-context marker.
Refused-image replans freeze their own boundary; old headers replay unmarked.
The Messages and cache journeys share the HTTP fixture with packed Node/Bun
verification, retaining signatures, durable tool results and application JSON.
