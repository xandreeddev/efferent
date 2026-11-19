---
name: kernel-architecture
description: How the efferent kernel's parts compose — what core owns and what a plugin's contract owns, where a contract and a plugin live, and how plugins extend each other (replace, wrap with a higher-order plugin, react to an event, record a fact in the journal; no hooks, registries, priorities or config wiring). Read before adding or changing a kernel contract, a stock kernel plugin, memory or a host's turn, anything in core's kernel, or before proposing a new way for plugins to extend each other.
---

# Change the kernel's architecture

These records hold the decisions. Read them before you design; this skill is the
checklist, the records have the reasons.

- `docs/adr/0028-the-workspace-s-ports-are-the-app-s-to-plug-in.md`: the workspace's ports are pluggable layers and permission is the app's (a contract that declines, a loop that asks with `approveIn`; never a tool that asks, never a contract wrapper that asks a person): `diskFiles` (Node entry: real paths held to the root's, a link out declined, text that is not UTF-8 or over `maxBytes` declined in words, a write whole through a temporary file and a rename, compare and set within the process's lane only, a listing that passes over ignored names, temporary files, names that make no `FilePath` and links out, to nothing or to a folder); `Shell` with its kit and `processShell` (Node entry: exactly the `env` given, never `process.env`; `SIGKILL` to the whole process group on a timeout, the shell's return, an interruption and the scope's close, proved by the kit's `*-kills` checks on Node and Bun; not confined; the end of each stream kept, the cut counted); `Search` with its kit and `filesSearch`, pure over `Files` on the browser entry, JavaScript regular expressions only, no ripgrep (another syntax), a repeated group holding a choice or a quantifier refused, and since the engine cannot be stopped a pattern the check misses can hold the process, so a host can turn regular expressions off (`filesSearch({ regex: false })`); `recoverTurns` gives `{ closed, unreadable }`, passing over a session the store cannot read; media is a later cut
- `docs/adr/0026-a-model-provider-charges-the-ledger-it-is-given.md`: the Node entry's model providers, each a `Layer<LanguageModel, never, ModelSpend>`: `openAiCompatibleModel` (one adapter for OpenAI, Gemini's OpenAI-compatible endpoint and the gateway, on its own chat-completions wire, since `@effect/ai-openai` speaks the Responses API alone) and `anthropicModel` (`@effect/ai-anthropic`, the API's own top-level prompt caching); the charge is written once (`model-spend/`), around each provider's own send, never as a wrapper of `LanguageModel`: the worst case (the body's bytes as input tokens, the output bound sent as the cap) held as the acquire of an `acquireRelease` in the call's scope, settled at the provider's bill or usage, else at the hold once the request left, released when it never left or was refused with a 4xx (but 408); a model with no price or a priced call with no output bound refused before it is sent; a ledger's refusal a non-retryable `AiError` carrying the `ModelSpendExceeded` in its reason's metadata (`isSpendRefusal`, `spendRefusalOf`); 429, 408, 5xx, a lost connection and a stream cut are retryable; they stay on the Node entry, though they import no runtime module (a key in a page)
- `docs/adr/0025-what-is-recalled-can-also-be-found-by-meaning.md`: a third list, by meaning, beside ADR 0023's two, in a second wrapper, `withKnowledgeByMeaning({ …, pool, weights })`, which needs `Embedder` and `VectorStore` (`withKnowledge` stays words only); it ranks what the other two rank (`meaningTexts`: standing memories and those ended as `changed`, an ended one taking its place for what replaced it), by the cosine of the last message alone (a `query`) and each memory's text (a `passage`); vectors an index of the journal keyed by `meaningKey(model, text)` (never an id), what the store lacks embedded 32 a call before the search, made again from the journal when lost; `recallKnowledge` stays pure and is given what the store found (`ByMeaning`); fused by rank, weights 1, 0.5 and 1.5 as measured on two embedders (a weight of 0 turns a list off, and with meaning off nothing is embedded); an `EmbedFailed` skips the list by meaning for that request (recall by the other lists, the reason in the event), never fails it, while `VectorsRefused` fails it; an optional `floor`, none by default (on e5 none separates a greeting from a real question); the walk and the note unchanged; `plugin.knowledge.recalled` says the model, the pool, the weights and each memory's place and cosine by meaning; a change to the weight is measured again
- `docs/adr/0024-the-kernel-s-node-ports-live-on-an-entry-of-their-own.md`: a port that needs a runtime's modules (`node:fs`, a SQLite driver) lives on `@xandreed/sdk/kernel/node`, a folder of its own under `packages/sdk/src/kernel/node/` with a layer of its own, never in the browser entry (`browser-bundle.test.ts` proves it); it loads on Node 24 and Bun, and a driver only one runtime has is imported when its layer is built (`bun:sqlite`, `node:sqlite`); the entry becomes `@xandreed/sdk/node` when the kernel moves to the package roots; the durable stores (`directoryJournal`, `sqliteJournal`) are durable when a call returns, refuse a format they do not know (`JournalOpenFailed`, `Format`) and a torn or damaged line, and have one writer, a process, which takes the store as the layer is built (holder files, `Held` while it lives, taken over when it is gone); the host runs `recoverTurns` once before any turn, closing every turn left open as `Abandoned`; several writers per store is later work
- `docs/adr/0023-what-is-recalled-is-chosen-from-the-conversation.md`: a host's program curates a turn with the contract's step, `curate(session, source, { review? })` (the source stored in a turn, the curator asked outside any turn, `extract` then `review` unless off, what passed and `plugin.knowledge.curated` stored in one turn; a failed call or a reply with no JSON object, the review's too, stores `plugin.knowledge.failed` and nothing else; an interruption leaves the source `Pending` for `curateAgain`), in `knowledgeSession`; no listener and no fiber of the kernel's; a request is sent what is kept about what the conversation names by `withKnowledge({ limit, walk, speaker, stopWords })`, with no model and no embedder: seeds named in the last message (the user's entity only by the host's speaker words; people by a first name when nobody is named in full), else in the turn before; the memories about a seed and those the message's words reach by the kernel's BM25 (the host's stop words; words of four characters or more meet when one starts the other), an ended memory ranking for what replaced it, fused by rank (k 10, weights 1 and 0.5); `limit` places, then up to `walk` more by subject (first `about` an entity the three best memories about a seed bring in, not named); what a memory replaced sent under it, never alone; `knowledgeNote` has no ids; `plugin.knowledge.recalled` is live, tagged `trace`; no relation record: the walk relies on a memory's first `about` being its subject; the recall is the port of the measured one, so a change to it is measured again
- `docs/adr/0022-memory-is-kept-by-a-curator.md`: long-term memory is written after the turn by a curator the host provides (`Curator`: `curate({ prompt, job })` to the model's reply, `CurationFailed`, its kit `curatorConformance`), never by a tool of the agent's; it is a journal of its own, the knowledge session (`KNOWLEDGE_OWNER`), with eight records tagged `memory`: `plugin.knowledge.source` (what was said, in parts, each with who said it), `entity`, `aliased` (skippable), `memory` (a sentence about entities, resting on a quote that is never the assistant's), `restated` (skippable), `ended` (why, and what replaced it), `curated` and `failed`; a memory is a sentence about entities, and one about two entities is what joins them (this cut has no relation record, and whether one is added is left open until recall is cut); when a memory was said is its source's `at`, never when a record was stored; nothing is deleted, a memory is ended, and `knowledgeOf` folds every memory with how often it was said and how it ended; the curator is shown what is stored about the entities a source names (`shownFor`), not the memories most like it; the prompt is the kernel's (`curationPrompt`, `reviewPrompt`, `KNOWLEDGE_PROMPT`); the checks (`curationOf`, `staged`, `draftsOf`, `KNOWLEDGE_CHECKS`) drop a bad item alone, with its reason; it supersedes ADR 0019, whose code is removed; the first cut is the pure core, with no listener, service, tool or recall
- `docs/adr/0016-a-branch-is-a-copy-cut-at-a-closed-turn.md`: a branch is a session whose journal starts as a copy of another's up to the end of a closed turn, made by the store in one step (`JournalStorage.fork`, records as stored), cut by `Sessions.fork(id, { through })` (`NoClosedTurn` otherwise); the header says where (`branch: { of, through }`, never `parent`, which stays a sub-agent's caller), the format is the same, nothing is announced; a branch carries everything stored before the cut, an "Always" approval included; facts and a workspace are not branched
- `docs/adr/0017-a-workspace-is-the-world-the-agent-acts-on.md`: files are the world an agent acts on, reached only by tools through the `Files` contract (`read`, `list` by folder, `write` with an optional `expected`, a compare and set); no part that builds the agent's state or a prompt holds it, and a file reaches a prompt only as a stored result; paths are `FilePath`s that cannot leave the workspace; the tools (`readFile`, `listFiles`, `writeFile`, `editFile`) never ask: permission is the app's (a sandbox, a `Files` that declines with `FilesRefused`, `approveIn` in its loop, a judge over the person's `Approval`); what the journal holds of files is bounded (a page read, a write's text, a list); a write is said live (`plugin.files.written`, never stored); an interrupted write can leave a changed file and no result; a branch shares the workspace; a kit (`filesConformance`)
- `docs/adr/0021-what-is-recalled-by-meaning-is-an-index-of-the-journal.md`: ranking by meaning is two contracts, each with a kit: `Embedder` (`model`, `embed(texts, as)`, one vector per text in order, of one length, as a `query` or a `passage`; `EmbedFailed` in words; `embedderConformance` over texts the subject gives) and `VectorStore` (`put`, whole or nothing, a key put again replaced; `search(vector, { limit, among? })` by cosine, best first, ties by key, `among` what stands with the limit still filled; `has`; `VectorsRefused`; `VectorsUnavailable`, a defect of the caller's call; `vectorStoreConformance`); vectors are an index of the journal, keyed by the embedder's model and the text embedded (never an id, which belongs to one journal), made again from the journal when lost, never read as truth, and no part rebuilds the agent's state from them; a vector of another model is never compared (another model misses in `has`, and `among` holds a search to the present model's keys; a store keeps one length, so a model of another length needs a fresh store); counting a claim said again is the records' (`plugin.knowledge.restated`), never likeness; the kernel ships `recordedEmbedder` and `inMemoryVectors` and calls no model; its amendment, the recall wrapper `withRecall` over facts and links, is removed (ADRs 0022 and 0023 replace it), and the knowledge's `withKnowledgeByMeaning` (ADR 0025) is the kernel wrapper that uses the two contracts
- `docs/adr/0020-a-model-call-s-cost-is-held-before-it-is-sent.md`: the spend ledger `ModelSpend` is a contract of core's kernel, the one no turn needs, because the eval packages take it and nothing else; whoever sends a model call holds its worst case before it is sent and settles it after; the total cap alone; no store beside the journal (a hold refuses a call before anything is stored); a part that charges it declares it, and no part looks for one and sends uncapped without.
- `docs/adr/0019-what-an-agent-knows-can-be-connected.md` (superseded by ADR 0022; its code is removed, and the record is kept as history): what an agent knows can be links between things, records `plugin.graph.linked`, `plugin.graph.unlinked` and `plugin.graph.restated` (a standing link said again in another turn, skippable) in a session of its own (`GRAPH_OWNER`), written by the model through `linkThings` (the kernel calls no model) and folded by `linksOf`; a thing is its normalised name, never merged by meaning (a small embedding model scored Lisbon nearer Paris than Lisboa); `withGraph({ hops, limit, speaker? })` walks from what the question names, both ways, and ranks each link by the question's words its path meets, then distance, then newest, because a small model answers from the first lines; the speaker's words are the host's option, never English in the kernel; facts stay beside it.
- `docs/adr/0018-a-background-task-reports-in-a-turn-of-its-own.md`: a background task is a child session and one turn in it on the `tasks` plugin's scope (`Tasks.start` returns at once; the work is the host's `TaskRun`, the kernel calls no model); its report goes to `TaskReports.deliver`, the host's, into the one queue its loop takes the person's messages from, one turn per item (never `Stream.merge`, which reads ahead; never a race of two takes, which rests on the loser having taken nothing; never the `Inbox`, a layer cycle), and is stored by `taskReport` as a `conversation.user.message` whose optional `from` names the task's session, so `turnsOf` and `questionOf` tell it from the person's; a cancelled task, and one the plugin's close cuts short, reports nothing; reports live in the process; no kit
- `docs/adr/0015-a-model-call-is-planned-and-an-answer-is-made-once.md`: a model call that fails is tried again and handed to another model by Effect's `ExecutionPlan`, applied to the stream the loop asks for with `planned(plan)`, never by a wrapper of `LanguageModel` (it cannot forward `streamText` without a cast); an answer is made once: parts before the first text or call are held, a failure after it is final (`AnswerCut`), for every step; an error part before content fails the attempt (`ModelAnswerFailed`), so Effect's providers' in-stream overloads are handed on, and one after content is an `AnswerCut`; a step's `while` reads the model's failures and `ModelAnswerFailed`, and `retryable(error)` is the kernel's; each attempt is said live about its turn (`plugin.model.attempt`), never stored; a publish that fails is logged; no kit
- `docs/adr/0014-what-an-agent-knows-is-a-journal-of-its-own.md`: what an agent knows across conversations is a fact, a record (`plugin.facts.learned`, `plugin.facts.forgotten`) in a session of its own, the memory session, never a store beside the journal; two tools of the kernel's write it (`rememberFact`, `forgetFact`: each call a turn on that session, declaring `Sessions` and `CurrentTurn`), and a memory wrapper reads it (`withFacts({ limit })`: the facts that stand, added last for one request, framed as data, never stored); a fact is one line of 1 to 300 characters, refused and never cut; `relevant` is a pure function; a host on a durable store recovers the memory session; no kit
- `docs/adr/0013-a-skill-is-loaded-by-a-tool-call.md`: a skill is a value (`defineSkill`), and a host's tools and skills are one value (`skills(base, ...skills)`), never a registry; the model reads a catalogue that never changes and loads a skill with the `loadSkill` tool, whose stored result is the instructions (`SentWhole`); nothing new is stored: `loadedOf(journal)` folds those results, and what a step offers (`offered(journal)`) is built on it, in load order, tools added and none taken away; a tool not offered is not run; the offered toolkit is typed as every tool it could hold, with nothing asserted; a memory that dropped a load's result gets a short note from `withReloadNote`, never the instructions again
- `docs/adr/0012-a-tool-asks-through-a-contract.md`: a tool asks a person before it acts with `approve({ action, detail })` in its handler, through `Approval`, a contract the host provides; the answer is a record of the turn (`plugin.approval.decided`), and a standing approval is that record (`grantsOf`), never a store or a configuration; a refusal is the call's failed result, in fixed words; an answer that is no decision approves nothing; a policy is a wrapper (`autoApprove`) that never grants for good; no kit
- `docs/adr/0011-a-long-result-is-sent-as-a-pointer.md`: a long tool result stays whole in the journal and is sent as its start and a pointer, by `pointed`, a function of the record alone (the same in every context, nothing stored); the pointer names the record's place, never the call's id; the model reads on with the kernel's `ReadResult` tool; a tool whose result must be sent whole says so with the `SentWhole` annotation, which `callTool` stores as `whole`; a memory points before it counts
- `docs/adr/0010-a-store-is-a-part.md`: a store is the `JournalStorage` contract and its kit (`list` by `byCreation`, no index; a `pair` of handles for a store that outlives its handle); a turn its writer left open is closed by `Sessions.recover` as `Abandoned`, called by the host, never by the kernel; one writer per store is assumed and the journal stays whole when the host was wrong; a parent is not checked to exist
- `docs/adr/0009-what-the-ui-shows-is-a-record.md`: what the UI shows is a view record (`plugin.render.view`, tagged `ui`, no message, same id replaces) a tool appends through `CurrentTurn`; a client folds them with `viewsOf`; progress is live; the model never sees a view
- `docs/adr/0008-a-memory-keeps-its-summary.md`: a memory keeps what it derived (a summary) as a record of its own, tagged `memory`, whose message it sends; it gets a model's work through a contract the host provides (`Summarizer`)
- `docs/adr/0006-a-sub-agent-is-a-session.md`: a sub-agent is a session created with the caller's as its parent, reached through a tool whose result `{ answer, session }` names it; no new contract; a helper is created under the turn its delegate call runs in (`CurrentTurn`), with a depth limit read from the parent chain
- `docs/adr/0007-a-tool-reaches-its-turn.md`: work reaches the open turn it runs for through `CurrentTurn` (a `RunningTurn`), provided by `callTool` around a tool's handler, by `modelAnswer` while the model's stream runs, and by the summary memory around its summarizer; a tool declares it in `dependencies`
- `docs/adr/0005-context-for-one-request.md`: what a wrapper of `Memory` adds for one request (the time, a chosen instruction, fetched data) comes after the memory's context, whole and in its order, and is never stored; `memoryWrapperConformance` checks it
- `docs/adr/0004-tool-traffic-is-conversation.md`: the tools are Effect AI's `Toolkit`
  (no kernel service); tool definitions are code, never stored; a call and its result
  are conversation records (`assistantMessage(text, { toolCalls })`,
  `conversation.tool.result` from `toolResult`); a tool's failure is a stored result and
  the turn goes on; every memory sends through `paired`.
- `docs/adr/0003-journal-holds-the-conversation.md`: the journal holds the conversation
  and nothing derived from configuration; the conversation's records
  (`conversation.user.message`, `conversation.assistant.message`) are core's; records carry
  tags; memory builds the context (`Memory.context`); the kernel has no loop, which is the
  host's program. It supersedes parts of the two below.
- `docs/adr/0002-core-owns-state-plugins-own-workflows.md`: what core owns (sessions and
  their journal, events, the conversation's records) and what it never will (a loop, a
  memory, a prompt, a request); where a contract and a plugin live, and the import graph.
- `docs/adr/0001-kernel-plugin-composition.md`: how plugins compose.

## Choose the place

- [ ] Every agent has it, whatever its workflow: core (`packages/core/src/kernel`). Rare:
      it changes `api/core--kernel.api.txt`, and a name removed or changed there needs a
      CHANGELOG line saying what a plugin must change.
- [ ] Anything else: a contract in `packages/sdk/src/kernel/contracts/<name>/` (entities,
      events, pure rules, kit), its stock plugin in `plugins/<name>/`.
- [ ] A plugin imports contracts and core, never another plugin's folder; a contract
      imports core and other contracts, never a plugin. The boundaries gate refuses both.
- [ ] An event is named after the owner of the contract that defines it: `core.` for
      core's, `plugin.<name>.` for a plugin contract's; `conversation.` is core's vocabulary
      for the conversation, which a turn's body writes. A plugin that reads the
      conversation or another plugin's records extends that vocabulary
      (`vocabularyOf(name, own, CONVERSATION_VOCABULARY)`).
- [ ] An event is defined with `storedEvent` or `liveEvent`, and a record is made with
      `stored(definition, data)`: a session refuses an object written by hand, a copy of a
      draft, or a record of a definition written by hand (`NotADraft`). A definition's
      mistake (a name, a tag) throws where it is made, with what is wrong.
- [ ] A record whose shape changes takes a new name. A journal that holds the old name is
      refused by the new vocabulary, or passed over when the record may be skipped; a
      plugin never changes the journal's format, which is core's.
- [ ] A part that holds the open session (a tool, a memory) publishes a live event about
      its turn with `session.publish(definition, data)`, and asks for no `Core`.
- [ ] A listener is given what its definition's kind is delivered as: a stored record
      (`seq`, `turn`, `message`) or a live event. No handler tells the two apart by hand.
- [ ] An event's definition declares its tags (`conversation`, `turn`, `memory`, `ui`,
      `trace`, `<plugin>.<tag>`). A word outside the five does not type and is refused. Only a record tagged `conversation` is read as a message
      (`messageOf`); a memory may send the message of its own record (a summary, ADR 0008);
      a memory's own records are tagged `memory` and derived from the conversation, never a
      copy of it.
- [ ] Nothing derived from configuration is stored: no system text, no request, no
      pointers to what was sent, no tool definitions.
- [ ] Tool calls and their results are stored as conversation records, a failure as a
      result with `isFailure`, never as a failed turn. A loop reads the model's answer
      with `modelAnswer(stream, session, { onText })` and runs a call with
      `callTool(toolkit, call, session)`: each stores what it produced, and gives the
      work its turn (`CurrentTurn`), rather than the loop's own copy of those blocks.
- [ ] Work that must reach its session reads `CurrentTurn`, a `RunningTurn` whose writes
      cannot fail in their type, and never wraps them in `Effect.orDie`. Only the
      function that holds the open session provides it (`callTool`, `modelAnswer`, the
      summary memory around its summarizer).
- [ ] A memory sends its messages through `paired`, so no call goes without its result;
      the memory kit's `pairs` check holds it to that. A call's id is the model's and can
      repeat across restarts: pair in order, never by id alone, and never use a call id
      as the key of something stored.
- [ ] A long tool result is shortened only by `pointed`, where a memory reads a record's
      message, before anything is counted: never by rewriting the stored result, by a
      wrapper over the context, or by a record of what was pointed. A tool whose result
      must reach the model whole carries `SentWhole`; a host that sends pointers offers
      `ReadResult` with `readResult` as its handler.
- [ ] A tool that must not act on a model's word alone asks with `approve` at the start
      of its handler and declares `dependencies: [Approval, CurrentTurn]` and a failure
      that is text. The answer is stored by `approve`, never by the host's `Approval`; a
      grant is read from the journal (`grantsOf`), never kept anywhere else; a policy
      wraps `Approval` and answers `Allowed`. A dependency a tool declares is provided to
      the program that calls it, where `callTool`'s type asks for it.
- [ ] Instructions and tools that are not always needed are a skill: a value made with
      `defineSkill`, given to `skills(base, ...skills)` with the host's tools. The loop
      reads `offered(journal)` at each step and gives that one toolkit to the model and
      to `callTool`. Loading stores nothing of its own: never add a record, a registry or
      a list of loaded skills beside the journal, and never put a skill's instructions in
      the system text. A subset of a toolkit is made by Effect AI's `make` over tools read
      one by one, so each keeps its type: never over `Object.values`, which gives
      `Tool.Any`. A skill and a base keep their own types where `skills` takes them
      (`OwnSkills`): never annotate one `Skill` or `Toolkit.Any`.
- [ ] What an agent should know in its next conversation is a fact: the host merges
      `factTools` into its toolkit, provides `factHandlers`, and wraps its memory with
      `withFacts({ limit })`. Never keep facts in a list, a file or the system text, and
      never append a fact to the conversation's own journal. A wrapper that reads what
      the user asked reads the conversation's journal (`questionOf`), by the record's
      name: never the context, where another wrapper's note is a user-role message too,
      and never a message's role, which a plugin's record in the conversation may share. A note a wrapper adds
      names no tool the same value does not also give. A plugin that needs a
      journal of its own finds it in the store by its owner, first by creation
      (`memorySession`), passes over one of another journal format, and lists again
      after it creates one. A host whose store
      outlives its process recovers that session with its conversation.
- [ ] What a host keeps of its conversations for good is the knowledge contract's (ADR 0022): a source stored
      first, the host's `Curator` asked with `curationPrompt` over `shownFor`, the reply read with `curationOf`,
      checked with `staged` and stored as `draftsOf` gives it, in the knowledge session. New work goes there, not
      into facts. Never write a memory from a tool of the agent's, never delete one (end it), never
      store one whose quote is the assistant's, and never change a word of the prompt's rules without a new
      measurement and a new `KNOWLEDGE_PROMPT`; a changed check takes a new `KNOWLEDGE_CHECKS`.
      A host curates with the contract's step (`curate`, `curateAgain`), never a copy of it, and sends what is kept
      with `withKnowledge`; recall reads the conversation from its journal (`askedOf`), holds no words of a language
      (the speaker's words and stop words are the host's); `withKnowledge` is never given an embedder or a model, and recall by meaning is `withKnowledgeByMeaning`'s (ADR 0025), never a host's own wrapper over the knowledge.
- [ ] What a turn wrote is read back with `turnsOf(journal)`: a host's test runs its
      own program over `scriptedModel` and a journal kept in the process, then checks the
      turns; a client draws a turn from the same fold. Never fold a journal's turns by
      hand in a test or a client (filters by record name, results matched by id), and
      never build a context from `turnsOf`: it passes over records a memory must refuse.
- [ ] What a tool declares in `dependencies` is held by the compiler: a function that
      runs a model's call is typed over every tool of the toolkit (`ToolNeeds<Tools>`),
      never over the call's name, and gives its effect an explicit type. The model's
      unchecked call enters the toolkit in one function (`handled`, in `callTool`), which
      holds the only type assertions on a tool's path: add none. Keep each tool's own
      type where its toolkit is called: one with a tool typed `Tool.Any` has lost what
      its tools declare, and `callTool` refuses it (`OwnTools`). A new claim of this kind gets a `type-level:`
      test in `composition.test.ts`.
- [ ] A model call that may fail is asked under a plan with `planned(plan)`, between
      the stream and `modelAnswer`: never `Stream.withExecutionPlan` alone, which tries a
      step again after a word and repeats it, and never a retry of a turn or of an
      answer's reader. What is worth another try is `retryable` or a host's own predicate
      over typed failures.
- [ ] A conversation continued from an earlier point is a branch (`Sessions.fork`), never a session a host fills
      by appending copies (each record restamped, announced again, and half made if it fails part way); a client
      tells a branch by `branch`, a helper by `parent`.
- [ ] What the UI shows is a record tagged `ui` that bears no message (a view), never a
      tool result the model reads in every later request; a client draws it by folding the
      journal, the same fold live and after a reload.
- [ ] A memory with state (a summary, a cut) stores it once as a record of its own,
      tagged `memory`, and starts every later context from it, so the prefix changes only
      when it compacts. It asks for a model's work through a contract the host provides
      (`Summarizer`), never a model of its own; a budget's errors are the memory
      contract's (`OverBudget`, `InvalidBudget`).

## Choose the way

1. A method of a contract sees the value at the right moment, with the session in hand:
   **wrap** that contract with a higher-order plugin.
2. The moment sits between two calls inside a turn: it is the host's program, so write
   it there. When two hosts copy the same block, make it a function of a contract.
3. Nobody needs an answer back: listen to an **event** with `Core.on`.
4. Other parts must see it later: append an entry to the **journal** through the open
   session.

## When you wrap

- [ ] The wrapper is a function from a plugin of the contract to a plugin of the same
      contract, hiding the inner one with `Layer.provide`. Never a plain layer placed in
      a `provideMerge` chain: one composed on the wrong line wraps nothing.
- [ ] Each contract's stack is its plugin with its wrappers applied; the rest of the agent
      gets one layer per contract.
- [ ] You know where it must sit: the last applied is the outermost and runs first. A
      memory wrapper's entry lands in the journal before those of the wrappers inside it.
      A wrapper that must sit at a fixed place says so in its doc comment.
- [ ] A memory wrapper appends its entry first, then delegates, and never edits the
      context the memory below returns.
- [ ] Nothing that must be recorded happens in a model wrapper: it has no session.
- [ ] A test shows the part using the contract sees the wrapped one, and the order.

## Do not add

A hook mechanism, a registry of steps, priorities or phase numbers on wrappers, optional
contracts a part uses when present, a config object that wires plugins, a store beside the
journal (state the agent's parts read to rebuild themselves; a world the agent acts on
through a contract only tools hold, as the workspace's `Files`, is not one: ADR 0017;
nor is an index of the journal no part rebuilds itself from, made again from it when lost, as a `VectorStore`: ADR 0021),
listeners that write to the journal of the turn they hear (one that hears a turn end may write to another
session's journal, in a turn of that session's own, as the knowledge session's curation does: ADR 0022), a tool that decides permission (it is the app's:
ADR 0017), or a stock loop. If a need seems to require
one, check "What would reopen this" in the records. If it applies, write a new record that
supersedes the one it changes before any code.
