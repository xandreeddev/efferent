import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { JsonSchema, Option, Schema, SchemaAST } from "effect"
import { HARNESS_CODES, JOURNAL_KINDS, journalSchemaOf, RECORDED_ELSEWHERE, RESERVED_KINDS, TransientTurnEvents, turnBeginCodes, TurnEvent } from "@xandreed/core"
import type { TurnEventName } from "@xandreed/core"
import { encodeSocketFrame, encodeSse, FeedHeartbeat, FeedReady, FeedRecord, renderFeedDefaults, sseHeaders, ssePreamble } from "@xandreed/plugin-render"
import { deliveryId, TASK_CANCELLED, TASK_RESULT, TASK_STARTED, TaskCancelled, TaskResult, TaskStarted } from "@xandreed/plugin-tasks"
import { codeListProblems, raisedCodes } from "./error-codes.js"

/*
 * The event reference: what a turn publishes on its bus, what a session's
 * journal stores, and the codes and frames a host serves them with. Payloads,
 * descriptions, the reserved kinds and the begin codes come from the code;
 * the writers, sensitivity, HTTP statuses and error-code meanings below are
 * kept by hand, and this script fails when one no longer matches the code.
 * Writes docs/event-reference.json, docs/event-reference.md and the website page.
 */

const root = join(import.meta.dir, "..")
const failures: Array<string> = []
const fail = (message: string) => failures.push(message)

/* ── hand-kept facts, checked against the code ── */

/** Who writes each journal kind, and what a host must treat as sensitive in it. */
const JOURNAL: Readonly<Record<string, { readonly writer: string; readonly sensitive: string }>> = {
  "turn.started": { writer: "plugin-sessions, when `Sessions.begin` opens the turn", sensitive: "The user's message (its images, inline as base64, included), the host's command and the host's metadata (`meta`), when given." },
  "memory.system": { writer: "Memory, when the turn's system prompt (or a variant) changes", sensitive: "The full system prompt text." },
  "memory.section": { writer: "Memory: `turn.context(…)` and turn-tier prompt sections", sensitive: "Turn sections: the host's context for this turn, as the model sees it." },
  "memory.step": { writer: "Memory: the combined step policy and optional host-hook context", sensitive: "Step context text." },
  "memory.message": { writer: "Memory: the step loop's recorded messages; `TurnWriter.take` for queued steering, atomically with its receipt", sensitive: "User and assistant text, reasoning, tool call inputs, and a steer's images inline as base64." },
  "memory.tool-result": { writer: "Memory: the step loop's recorded tool results", sensitive: "Tool output, encoded (a tool's images, inline as base64, included) and as the model saw it; optional interception metadata includes the accepted rewritten input." },
  "memory.tool-presentation": { writer: "Memory, after a durable raw tool result's view is prepared", sensitive: "Tool output rendered as text, subjects and artifact references; encoded output and image bytes stay only in memory.tool-result." },
  "memory.digest": { writer: "Memory: a digester (`plugin-memory-digest`)", sensitive: "Tool output, digested." },
  "memory.skills": { writer: "Memory: the tool registry's skill activations", sensitive: "None: skill and tool names." },
  "memory.compaction": { writer: "Memory: the memory strategy's compactions (window, summary); the turn, when a provider refuses an image (`OmitMedia`)", sensitive: "Conversation text: summaries and compact views; an `OmitMedia`'s `reason` quotes the provider's error (up to 500 characters)." },
  "memory.snapshot": { writer: "Opted-in memory after a reducing summary and digest acknowledgments; the turn writer publishes its head pointer in the same commit", sensitive: "Copies of retained raw memory, including tool output, reasoning, host context, image values and compaction facts. Treat these copies like their original records and retain referenced media." },
  "turn.reply": { writer: "Memory, when the turn's reply is recorded (`TurnMemory.persistReply`), held for the turn's closing commit: stored with its `turn.ended`, right before it", sensitive: "The assistant's reply." },
  "step.started": { writer: "The turn's bus (stored from `step.started`)", sensitive: "None: tool names." },
  "step.ended": { writer: "The turn's bus (stored from `step.ended`)", sensitive: "None: entry ids and tool names." },
  "step.usage": { writer: "The turn's bus (stored from `assistant.message`)", sensitive: "None: model name, token counts and finish reason." },
  "tool.started": { writer: "The turn's bus (stored from `tool.started`)", sensitive: "Tool input." },
  "tool.refused": { writer: "The turn's bus (stored from `tool.refused`)", sensitive: "The refusal message, which may name missing permissions or quote the host's denial; the input is left out." },
  "tool.completed": { writer: "The turn's bus (stored from `tool.completed`)", sensitive: "None: input and result are left out." },
  "tool.intercepted": { writer: "The registry's validated host decisions, published on the turn bus and flushed before handler side effects or final outcome delivery", sensitive: "Rewritten encoded arguments and host refusal text. Respond and Replace record only outcome kind; the final encoded answer stays in memory.tool-result." },
  "completion.evaluated": { writer: "The turn's bus (stored from `completion.evaluated`)", sensitive: "The host's facts behind the verdict." },
  "context.built": { writer: "The turn's bus (stored from `context.built`)", sensitive: "None: fingerprints, counts and tool names." },
  "decision.recorded": { writer: "The turn's bus (stored from `decision.recorded`)", sensitive: "Candidate descriptions; the context itself only as a hash." },
  "stream.fallback": { writer: "The turn's bus (stored from `stream.fallback`)", sensitive: "The stream's error text, which may quote the provider's error." },
  "request.prepared": { writer: "The turn, before each provider call (`TurnMemory.prepareRequest`)", sensitive: "Version 1 embeds system text and tool declarations; version 2 references preceding request.part records. Public model configuration, request controls and optional accepted host-hook text remain in both." },
  "request.part": { writer: "The turn, in the same append batch before a version 2 request header (`TurnMemory.prepareRequest`)", sensitive: "A system prompt (including system-mode step context) or one active tool declaration. Provider-tool argument values remain excluded." },
  "turn.ended": { writer: "plugin-sessions: the turn writer's `end` (`Agent.turn` and `Sessions.drain` end with `turnEndingOf` the turn's exit), the writer's scope, `Sessions.cancel`, or a reap", sensitive: "Failure messages, which may quote errors." },
  "inbox.queued": { writer: "plugin-sessions: `Sessions.deliver` (a notice) or `Sessions.enqueue` (user input)", sensitive: "The item's content, user message, attachments and source." },
  "inbox.dropped": { writer: "plugin-sessions: the end of the last turn that took the item and failed", sensitive: "None: the item id." },
  "inbox.taken": { writer: "plugin-sessions: `TurnWriter.take`, in the same commit as the exact user memory.message and removal of the pending steer", sensitive: "None: the input id and raw memory entry id; message and image bytes stay in memory.message." },
  "model.called": { writer: "The turn-owned model-call recorder, directly appended and flushed before notification", sensitive: "Actual model selection, usage precision/counts, outcome and correlation metadata; no prompts, credentials, endpoint settings or provider bodies." },
}

/** Where a bus event recorded elsewhere ends up. */
const RECORDED_AS: Readonly<Record<string, string>> = {
  "turn.started": "the session's own `turn.started`, written when the turn began",
  "turn.ended": "memory's `turn.reply` and the session's own `turn.ended`",
  "skills.activated": "memory's `memory.skills`",
  "model.called": "the recorder's directly appended and flushed `model.called` fact",
}

/** A suggested HTTP status for each begin code, for a host that serves turns over HTTP. */
const BEGIN_HTTP: Readonly<Record<string, { readonly status: string; readonly meaning: string }>> = {
  AttachmentRejected: { status: "400", meaning: "An attachment of the user's message is not an image the framework takes (not base64, not a PNG, JPEG, GIF or WebP, over the size or pixel limits, too large together; see `MEDIA_LIMITS`). `Agent.turn` checks before it calls `Sessions.begin`: nothing was opened. The `HarnessError` carries the reason only in its message; a host that wants it typed (to answer 413 for `TooLarge` and `TooLargeTogether`, or name the attachment by its `index`) runs `normalizeUserMessage` from `@xandreed/core` on the message first and branches on `AttachmentRejected.reason`." },
  SessionBusy: { status: "409", meaning: "Another turn is open in the session. Retry after it ends, or queue the message." },
  TurnDuplicate: { status: "200 once that turn ended, 409 while it is open", meaning: "The key was begun before with the same message, command and `resumes`: that turn is the answer, so serve its result instead of running again (`Sessions.lookup(address, key)` finds it)." },
  KeyConflict: { status: "409", meaning: "The key was begun before with another message, command or `resumes` (the key `resume:<n>` begun again without `resumes` conflicts)." },
  RunIdReused: { status: "409", meaning: "The run id was used before, by an earlier turn of the session or of the history a fork inherits: a run id names one turn's run (memory numbers its entries from it). Begin again with a new run id, a retry under a new key included; nothing was opened." },
  NothingPending: { status: "204", meaning: "An inbox turn found nothing to take (inbox turns only)." },
  NotResumable: { status: "409", meaning: "The turn named in `resumes` cannot be resumed: `missing` (no such turn in the session, or `resumes` is not a whole number of at least 1), `inbox` (an inbox turn), `task` (a background task's turn), `superseded` (a user's turn began after it, other than a resume of it that failed, was cancelled or was interrupted) or `finished` (it ended completed, partial or failed). Only the last user's turn, ended cancelled or interrupted, can be; a resume that failed is tried again with a new key (and, as every turn, a new run id)." },
  TurnRefused: { status: "429 for a quota or rate, 403 when not allowed, 503 while draining before a shutdown", meaning: "The host's `TurnAdmission` refused the turn; nothing was opened or counted." },
  SessionMissing: { status: "404", meaning: "No such session for this owner." },
  SessionContended: { status: "503", meaning: "Other writers kept committing to the session first, and nothing was opened. Retry later." },
  SessionLogError: { status: "503", meaning: "The session store failed. Retry later." },
}

interface ErrorCode { readonly code: string; readonly where: string; readonly meaning: string }

/**
 * Where each published code (`HARNESS_CODES`) comes from and what it means,
 * the begin codes and `TASK_CODES` aside: one entry per code. A code a
 * package raises, in any namespace but the kits' `conformance.*`, must be
 * published, and a published code must have its entry (`codeListProblems`).
 * A code no longer raised stays, as stored data may carry it: say so in its
 * meaning.
 */
const ERROR_CODES: ReadonlyArray<ErrorCode> = [
  { code: "images.unavailable", where: "imageResizerPlugin activation", meaning: "No configured image conversion tool is available through Bash. Install ImageMagick, libvips or sips, or provide another ImageResizer adapter." },
  { code: "turn.closed", where: "`Agent.turn`, the turn writer (`TurnClosed`); a run started after the reply (`TurnMemory.startRun`)", meaning: "The turn takes no more writes: someone else closed it (`cancelled`; `interrupted`, reaped; `removed`, its session removed), or it `ended` (its own end stored or under way, or its scope closed). The writer and `Agent.turn` fail with `TurnClosed`, whose `reason` says which; this is the code it stands for. A run of the step loop started once the turn's reply is recorded fails with a `HarnessError` of this code: the reply ends the turn's runs." },
  { code: "turn.failed", where: "stored `turn.ended` failure (`turnEndingOf`)", meaning: "The turn failed with an error `harnessCodeOf` gives no code for (a tagged error without a `code`, or an untagged value, even one carrying a `code` such as a Node error's); the message is `<_tag>: <message>`, or the error as text (reason failed)." },
  { code: "turn.defect", where: "stored `turn.ended` failure (`turnEndingOf`) or the `recordCompletion` recorder boundary", meaning: "The turn died with a defect, an unexpected error; the message is the defect as text (reason failed). `recordCompletion` converts an unexpected recorder defect to a typed `HarnessError` with a fixed recording-failure message and the original defect as its cause, preventing model replay. `Agent.turn`, `Sessions.drain` and `recordCompletion` restore a `TurnError` carried as a defect (a `HarnessError`, `TurnClosed`, ...) to a failure, so it keeps its own identity and code; a runner calling `turnEndingOf` itself does the same with `harnessDefectsAsFailures`." },
  { code: "turn.interrupted", where: "stored `turn.ended` failure", meaning: "The turn was interrupted before it ended: its body (`turnEndingOf`), the scope its writer lived in, or its begin after the opening commit (reason interrupted)." },
  { code: "turn.unended", where: "stored `turn.ended` failure", meaning: "The turn's scope closed, without an interruption, before anyone tried to end the turn (reason failed). An end that was tried but could not be stored is tried again by the scope with that same ending, and a turn that held a completed or partial reply ends as that reply implies, not with this code." },
  { code: "turn.lease", where: "stored `turn.ended` failure", meaning: "The turn's holder stopped writing and another instance reaped it (reason interrupted)." },
  { code: "turn.budget", where: "a run of the step loop (`turn.run`, `runTurnLoop`)", meaning: "The run's `budgetTokens` (the policy's, else the agent's) is not an integer of at least 1." },
  { code: "config.budget", where: "`Agent.define`", meaning: "The agent's `budgetTokens` is not an integer of at least 1." },
  { code: "turn.unstarted", where: "the turn's memory", meaning: "Memory was asked to record, for the turn's number or to start a run, before the user's message was taken." },
  { code: "turn.persisted", where: "`TurnMemory.persistMessage`", meaning: "The user's message was taken twice in one turn." },
  { code: "turn.numbering", where: "the turn's memory", meaning: "Memory numbered the user's message differently from the turn the session stored." },
  { code: "events.reserved", where: "publishing a host event; a turn writer's `append` or `transact` and `Sessions.transact` (`ReservedKind`)", meaning: "The host event's name, or the draft's kind, is one of the reserved kinds; only the framework's turn writes those (`frameworkDraft`)." },
  { code: "events.depth", where: "publishing an event", meaning: "Reactions nested deeper than `maxEventDepth` (8 by default)." },
  { code: "events.background", where: "a background subscription", meaning: "A background handler was interrupted; the turn fails when the bus drains. One that dies with a defect fails it with that defect (`turn.defect`)." },
  { code: "events.encode", where: "a host event's `make` / `publish`; the turn storing a bus event", meaning: "The payload did not encode with the host event's schema, or its encoded form held a value JSON cannot (a BigInt), or a bus event did not encode with its own when the turn stored it (a value its type allows but a check refuses, such as a non-integer step)." },
  { code: "service.missing", where: "`Agent.turn`", meaning: "A service the turn needs is not provided by the agent's plugins or the turn's services." },
  { code: "config.graph", where: "`Agent.define`", meaning: "The plugin graph cannot be built (a missing provider, a cycle, a misplaced turn-dependent plugin), or the agent's turns would have no `ConversationMemory`, `ToolRegistry` or `StepLoop` (none from a plugin, `services` or `turnServices`)." },
  { code: "config.profile", where: "`resolveGraph`", meaning: "The configuration still carries `profile` or `profiles`, which the graph does not resolve: fold the selected profile's plugins, bindings and system into the configuration first." },
  { code: "config.options", where: "`Agent.define`, activating a plugin", meaning: "A plugin's options did not decode with its schema." },
  { code: "plugin.activation", where: "activating a plugin (a session plugin's, every turn)", meaning: "The plugin's layer failed to build with an error that is not a `HarnessError` (one that is keeps its own code: `skills.duplicate`, `skills.root`, ...)." },
  { code: "plugin.defect", where: "activating a plugin (a session plugin's, every turn)", meaning: "The plugin's layer died with a defect that is not a `HarnessError` while it was built (one that is keeps its own code)." },
  { code: "requires.missing", where: "activating a plugin (`definePlugin`'s `build`); opening a run's tools (`ToolRegistry.open`); rendering a prompt section (`definePromptSection`)", meaning: "A service the plugin lists in `requires`, or a tool or a prompt section in its own (`defineTool`, `definePromptSection`), is not among the services there; the message names the plugin, each tool or the section, and each missing service. The plugin's layer is not built; the run's tools do not open, so the turn fails before its first step (a handler called without one fails the call); the section does not render, so the turn fails where it renders the system prompt or its turn sections." },
  { code: "module.closed", where: "`makeLiveLayer` (`@xandreed/runtime`)", meaning: "A replaceable module was used or replaced after its scope closed." },
  { code: "tools.duplicate", where: "building the tool registry", meaning: "Two capabilities define a tool of the same name." },
  { code: "skills.duplicate", where: "building the tool registry", meaning: "Two capabilities define a skill with the same id (a host's and a skills directory's: set the directory's `idPrefix`)." },
  { code: "skills.tools", where: "building the tool registry", meaning: "A skill names a tool no capability registers." },
  { code: "skills.files", where: "`skillsFromFiles`; `@xandreed/plugin-workspace` skills directory (`strict`)", meaning: "A skills tree has an issue: a `SKILL.md` without frontmatter or description, an id already used, a reference over the size limit. The message names each file." },
  { code: "skills.root", where: "`@xandreed/plugin-workspace` skills directory", meaning: "A `required` skills root does not exist, or a root or a file in it cannot be read." },
  { code: "skills.limit", where: "`collectSkillFiles`; `@xandreed/plugin-workspace` skills directory", meaning: "A skills root holds more files (`maxFiles`) or text (`maxBytes`) than allowed, or the roots more skills than `maxSkills`." },
  { code: "skills.unknown", where: "activating a skill (`@xandreed/plugin-tool-discovery`)", meaning: "No skill of the catalog has that id. `load_skill` returns the refusal to the model as its failure, named `UnknownSkill`, and the turn goes on." },
  { code: "capability.forbidden", where: "`resolveCapabilities`; activating a skill", meaning: "A tool of the selection needs a permission the turn was not granted. `load_skill` returns the refusal to the model as its failure, named `PermissionDenied`, and the turn goes on; a matcher's choice it refuses is not activated." },
  { code: "capability.catalog", where: "`resolveCapabilities`; activating a skill", meaning: "The selection names a skill or a tool the catalog does not hold, or the catalog holds two with one id." },
  { code: "matcher.timeout", where: "the skill matcher (`@xandreed/plugin-tool-discovery`)", meaning: "The matcher did not answer within `matcherTimeoutMs`. The turn goes on: its decision is recorded as failed, and only the always-on skills are active." },
  { code: "tools.opened", where: "`openTurnTools`", meaning: "The turn's tools were opened twice." },
  { code: "tools.unavailable", where: "the turn's tools", meaning: "The tools were used before `openTurnTools` opened them." },
  { code: "loop.model", where: "the step loop", meaning: "The turn's services carry no `LanguageModel`." },
  { code: "loop.failed", where: "the step loop", meaning: "The loop failed with an unclassified error that is not a turn error or a typed model failure; the message is that error's message, without its tag (`messagesOf`), and the error is the cause." },
  { code: "model.auth", where: "the step loop", meaning: "The model request failed authentication or authorization. The original error or failed response is kept as cause." },
  { code: "model.context-overflow", where: "the step loop", meaning: "The model request exceeded the context window, established by an explicit failure stamp. No response tool handler runs; an ordinary output-token limit remains a truncated reply." },
  { code: "model.failed", where: "the step loop", meaning: "A model request failed without a more specific semantic classification. The original error or failed response is kept as cause." },
  { code: "model.invalid-request", where: "the step loop", meaning: "The model request was invalid or rejected by content policy. The original error or failed response is kept as cause." },
  { code: "model.invalid-response", where: "the step loop", meaning: "The model returned a response incompatible with its protocol. This is distinct from correctable model-generated tool arguments." },
  { code: "model.quota", where: "the step loop", meaning: "The model request exhausted available quota or billing capacity. The original error or failed response is kept as cause." },
  { code: "model.rate-limit", where: "the step loop", meaning: "The model request was rate limited. The original error or failed response is kept as cause, including available retry timing." },
  { code: "model.timeout", where: "the step loop", meaning: "The model request exceeded a request or call deadline, established by an explicit failure stamp." },
  { code: "model.unavailable", where: "the step loop", meaning: "The model service or transport was temporarily unavailable. The original error or failed response is kept as cause." },
  { code: "loop.truncated", where: "the step loop, a run failing", meaning: "The model's reply was cut short (its finish reason is not `stop`, `tool-calls` or `pause`; `unknown`, no finish reason given, cuts only a reply with tool calls the loop would run), and the run stops: a cut other than the output limit (`content-filter`, `error`, `other`, `unknown`), or more replies in a row cut at the output limit than the loop answers with correctives (2). The cut step is recorded, its status `truncated`, and none of its tool calls ran. `runLoop` fails with it as a `HarnessError`, and the step loop passes it on as it is." },
  { code: "request.encode", where: "the turn, before each provider call", meaning: "The request header or its canonical parts did not encode as JSON." },
  { code: "request.missing", where: "before each provider call or during replay", meaning: "No stored request header was found for the requested step or event identity." },
  { code: "request.decode", where: "before each provider call or during replay", meaning: "The selected stored request header or a referenced part did not decode." },
  { code: "request.descriptor", where: "before each provider call", meaning: "The model's descriptor (provider, model and settings) did not decode." },
  { code: "request.diverged", where: "before each provider call or during replay", meaning: "The actual request differs from its stored reconstruction, or a selected part reference is missing, conflicting, has the wrong category or fails its content hash." },
  { code: "request.model", where: "`@xandreed/plugin-models`", meaning: "The selected model could not be resolved or described." },
  { code: "request.memory", where: "`replayModelRequest`", meaning: "The memory events before a stored request did not decode." },
  { code: "request.hook", where: "the turn, before preparing a fresh model request", meaning: "A host request-hook draft or patch is invalid, a patched tool choice is inactive, or the callback fails unexpectedly. Original turn errors and interruptions retain their identity." },
  { code: "tool.intercept", where: "the tool registry and its result-recording boundary", meaning: "An interceptor decision or encoded input/outcome is invalid, a callback fails unexpectedly, or invocation ownership is missing, mismatched or reused. Original turn errors and interruptions remain intact." },
  { code: "memory.log", where: "the turn", meaning: "Stored memory events did not decode, or memory could not be stored." },
  { code: "memory.digest", where: "`@xandreed/plugin-memory-digest`", meaning: "The digester's model call failed or did not answer within `digestTimeoutMs`. It is logged, and the turn goes on: memory records no digest, and the tool result stays whole." },
  { code: "memory.summary", where: "`@xandreed/plugin-memory-summary`", meaning: "The turn's services carry no `UtilityLlm`, and the turn fails when its memory opens; or the summarizer failed or did not answer within `summaryTimeoutMs`, which is logged: the turn goes on without a new summary, and its later steps do not ask again." },
  { code: "context.budget", where: "each step of a run; `@xandreed/plugin-memory-window`", meaning: "At a step, the system prompt and the active tools' schemas leave nothing of the context budget (`budgetTokens`); with the window strategy, also when the current turn alone does not fit the budget memory is given: the whole budget at the turn's start, what they leave at each step." },
  { code: "session.log", where: "the turn writer, a turn failing with a `SessionLogError`", meaning: "The session store failed during the turn. A turn that fails with a `SessionLogError` stores this code; the error's own `code` (`store.io`, ...) says what failed." },
  { code: "session.contended", where: "the turn writer, plugin-sessions' `Sessions` and the `Tasks` over it (`SessionContended`)", meaning: "Too many conflicting writes to the session in a row: nothing was written, and a retry may succeed." },
  { code: "inbox.input-conflict", where: "`Sessions.enqueue` (`InputConflict`)", meaning: "The input id already names another normalized message, delivery or source, or a legacy notice. Nothing was replaced or queued; retry with the original input or a new id." },
  { code: "session.state", where: "the turn writer (a `HarnessError`); plugin-sessions' `Sessions` (a `SessionLogError`)", meaning: "The session's state, kept in its head, did not decode." },
  { code: "session.encode", where: "the turn writer", meaning: "The writer's closing `turn.ended` did not encode. plugin-sessions' `Sessions` no longer raises it for a record or a state of its own since `SessionLogError` became storage only (it is a defect now); older journals may hold it." },
  { code: "session.decode", where: "`Sessions.begin` and selected memory checkpoint validation (a `SessionLogError`)", meaning: "A stored turn did not decode during key/resume checks, or a selected memory snapshot has invalid identity, schema, frontier or retained contents. The pointed-record reader reports that the stored memory snapshot is invalid; other checkpoint decoders name the failed invariant. Malformed overall head state retains session.state." },
  { code: "turn.shutdown", where: "a stored `turn.ended` failure (reason `interrupted`), written by plugin-sessions' `Sessions` (`TurnShutdown.interrupt`)", meaning: "The process shut down before the turn ended: the host's shutdown deadline passed (`shutdownGracefully`, `Agent.shutdown`, `AgentConfig.shutdown`) with the turn still running, and its end was stored while the log was still open. The turn is resumable, and its inbox items wait again with no attempt counted." },
  { code: "turn.time-limit", where: "a stored `turn.ended` failure (reason `interrupted`), written by plugin-sessions' `Sessions`", meaning: "The turn ran past its time limit (the begin's `timeLimitMs`, else the Sessions' `turns.timeLimitMs`): its holder closed it, and its writer refuses every later write with `TurnClosed` of reason `timed-out`. The turn is resumable; its inbox items wait again, an attempt counted." },
  { code: "turn.takeover", where: "a stored `turn.ended` failure (reason `interrupted`), written by plugin-sessions' `Sessions`", meaning: "A begin with `takeOver` closed the session's open turn, still held by another holder, which the host says is gone (a restarted process). The turn is resumable, and its inbox items wait again with no attempt counted." },
  { code: "session.version", where: "plugin-sessions' `Sessions` (a `SessionLogError`), before it plans a write", meaning: "A newer release wrote the session: the stored format in its head (`STORED_FORMAT`) is above this release's. Nothing was written: `begin`, `deliver`, `drain`, `cancel`, `transact` and `fork` refuse it, while `get`, `list` and `read` still read it. Use that release or a later one." },
  { code: "session.defect", where: "the turn writer", meaning: "Storing the turn's appended events died with a defect (a store or an encoder that threw); it is logged with its cause, and the writer refuses every later write and flush with this code." },
  { code: "session.begin", where: "`Sessions.begin` (a `SessionLogError`)", meaning: "The begin's opening commit came back uncommitted, or without the turn's `turn.started`. No longer raised since `SessionLogError` became storage only (it is a defect now); older journals may hold it." },
  { code: "session.create", where: "`Sessions.create` (a `SessionLogError`)", meaning: "The store answered the creation of a session without a parent with `SessionMissing`. No longer raised since `SessionLogError` became storage only (it is a defect now); older journals may hold it." },
  { code: "session.expired", where: "plugin-sessions' commits (a `SessionLogError`)", meaning: "The store refused a commit made without a lease guard as expired (`LeaseExpired`). No longer raised since `SessionLogError` became storage only (it is a defect now); older journals may hold it." },
  { code: "store.open", where: "`@xandreed/plugin-session-sqlite` and `@xandreed/plugin-session-files` (a `SessionLogError`)", meaning: "The database file, or the store's directory, could not be created or opened; for the file store, also a directory without hard links, which it needs to publish a commit exclusively." },
  { code: "store.io", where: "`@xandreed/plugin-session-sqlite` and `@xandreed/plugin-session-files` (a `SessionLogError`)", meaning: "A read or a write failed, or a session just created could not be read back." },
  { code: "store.busy", where: "`@xandreed/plugin-session-sqlite` (a `SessionLogError`)", meaning: "Another connection held the lock past the busy wait, or a new file could not be switched to WAL. Nothing was written, and a retry may succeed (`isStoreBusy`)." },
  { code: "store.decode", where: "`@xandreed/plugin-session-sqlite` and `@xandreed/plugin-session-files` (a `SessionLogError`)", meaning: "A stored row (a session's head or an event), or a commit file before a session's tail, did not decode." },
  { code: "store.encode", where: "a `SessionLog` (core's in memory, `@xandreed/plugin-session-sqlite`; a `SessionLogError`)", meaning: "A value to store (an event's data, the session's state or `meta`) is not one JSON can hold (a BigInt, a cycle)." },
  { code: "store.stalled", where: "`@xandreed/plugin-session-files` (a `SessionLogError`)", meaning: "A file system call did not answer within `stallMs` (a hung network mount), or the store is failing every call at once after such a stall, until one let through a `stallMs` later answers. A commit that stalled may still land: read the head again before deciding it did not." },
  { code: "store.version", where: "`@xandreed/plugin-session-sqlite` and `@xandreed/plugin-session-files` (a `SessionLogError`), opening the store", meaning: "A newer release wrote the store: the SQLite file's schema version (`PRAGMA user_version`), or the directory's layout (`store.json`), is above the last one this release knows. Nothing was read or written; open it with that release or a later one. A SQLite file without a version, as 0.14.0 wrote it, still opens." },
  { code: "tasks.encode", where: "`@xandreed/plugin-tasks` (a `SessionLogError`)", meaning: "A task's `task.started` or `task.result` did not encode. No longer raised since `SessionLogError` became storage only (it is a defect now); older journals may hold it." },
  { code: "tasks.kind", where: "`@xandreed/plugin-tasks` (a `SessionLogError`)", meaning: "The session refused one of the tasks plugin's records as a reserved kind (`ReservedKind`); its kinds are not reserved. No longer raised since `SessionLogError` became storage only (it is a defect now); older journals may hold it." },
  { code: "tasks.lost", where: "`Tasks.start` (a `SessionLogError`)", meaning: "The task was started, but the parent session does not hold it when read back. No longer raised since `SessionLogError` became storage only (it is a defect now); older journals may hold it." },
  { code: "auth.corrupt", where: "an `AuthStore` (an `AuthError`; `@xandreed/plugin-models`' credentials file)", meaning: "The store's data could not be read or decoded. Nothing was read as absent and nothing was written over it: fix or remove it." },
  { code: "settings.corrupt", where: "a `SettingsStore` (a `SettingsError`; `@xandreed/plugin-models`' config files)", meaning: "The settings' data could not be read or decoded. Nothing was read as defaults and nothing was written over it: fix or remove it." },
]

/** The failure codes of a task's result or status (`@xandreed/plugin-tasks`). */
const TASK_CODES: ReadonlyArray<ErrorCode> = [
  { code: "task.turn", where: "a task's result failure", meaning: "The task's turn failed, or died with an error that is not a `HarnessError` (a `HarnessError` keeps its own code)." },
  { code: "task.refused", where: "a task's result failure", meaning: "The host would not admit the task's turn." },
  { code: "task.deadline", where: "a task's result or the parent's reaction", meaning: "The task runner's deadline cut the work." },
  { code: "task.lost", where: "a task's status", meaning: "The task's turn stopped without a result." },
  { code: "task.removed", where: "a task's status", meaning: "The task's session was removed with its parent." },
]

/* ── payload schemas, summarized ── */

type Json = { readonly [key: string]: unknown }

const jsonSchemaOf = (schema: Schema.Top): Json => {
  const document = JsonSchema.toDocumentDraft07(Schema.toJsonSchemaDocument(schema))
  return { $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07, ...document.schema, ...(Object.keys(document.definitions).length > 0 ? { definitions: document.definitions } : {}) }
}

const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const arrayOf = (value: unknown): ReadonlyArray<unknown> => Array.isArray(value) ? value : []

/** A JSON schema as a short type: `string`, `integer`, `"a" | "b"`, `Array<…>`, `Record<string, …>`, `{ a, b }`. */
const typeOf = (schema: unknown, definitions: Json): string => {
  if (!isJson(schema)) return "unknown"
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.split("/").at(-1) ?? ""
    return typeOf(definitions[name], definitions)
  }
  if (Array.isArray(schema.anyOf)) {
    const members = schema.anyOf.filter((member) => !(isJson(member) && Array.isArray(member.enum) && member.enum.includes("NaN")))
    return [...new Set(members.map((member) => typeOf(member, definitions)))].join(" | ")
  }
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ")
  if (schema.type === "array") return `Array<${typeOf(schema.items, definitions)}>`
  if (schema.type === "object" && isJson(schema.properties)) return `{ ${Object.keys(schema.properties).join(", ")} }`
  if (schema.type === "object" && isJson(schema.additionalProperties)) return `Record<string, ${typeOf(schema.additionalProperties, definitions)}>`
  if (schema.type === "object") return "object"
  return typeof schema.type === "string" ? schema.type : "unknown"
}

interface Field { readonly name: string; readonly type: string; readonly required: boolean }

const fieldsOf = (schema: Json): ReadonlyArray<Field> => {
  const definitions = isJson(schema.definitions) ? schema.definitions : {}
  const variants = [...arrayOf(schema.anyOf), ...arrayOf(schema.oneOf)].filter(isJson)
  if (variants.length > 0) {
    const fields = variants.map((variant) => fieldsOf({ ...variant, definitions }))
    return [...new Set(fields.flatMap((member) => member.map((field) => field.name)))].map((name) => {
      const members = fields.flatMap((member) => member.filter((field) => field.name === name))
      return {
        name,
        type: [...new Set(members.map((field) => field.type))].join(" | "),
        required: members.length === variants.length && members.every((field) => field.required),
      }
    })
  }
  const properties = isJson(schema.properties) ? schema.properties : {}
  const required = arrayOf(schema.required)
  return Object.entries(properties).filter(([name]) => name !== "_tag").map(([name, property]) => ({ name, type: typeOf(property, definitions), required: required.includes(name) }))
}

/* ── the reference ── */

const bus = TurnEvent.members.map((member) => {
  const name: TurnEventName = member.fields._tag.schema.literal
  const description = SchemaAST.resolveDescription(member.ast) ?? ""
  if (description.trim().length === 0) fail(`TurnEvent member ${name} has no description annotation`)
  const schema = jsonSchemaOf(member)
  const transient = TransientTurnEvents.includes(name)
  const kind = name === "assistant.message" ? "step.usage" : name
  const storedSchema = journalSchemaOf(kind)
  const stored = transient ? { as: "transient" as const }
    : RECORDED_ELSEWHERE.has(name) ? { as: "recorded-elsewhere" as const, where: RECORDED_AS[name] ?? "" }
      : name === "host" ? { as: "host" as const }
        : Option.match(storedSchema, {
          onNone: () => { fail(`${name} is stored as ${kind}, which has no journal schema`); return { as: "kind" as const, kind, omitted: [] } },
          onSome: (journal) => {
            const keep = new Set(fieldsOf(jsonSchemaOf(journal)).map((field) => field.name))
            return { as: "kind" as const, kind, omitted: fieldsOf(schema).map((field) => field.name).filter((field) => !keep.has(field)) }
          },
        })
  if (stored.as === "recorded-elsewhere" && stored.where.length === 0) fail(`${name} is recorded elsewhere, but RECORDED_AS does not say where`)
  return { name, description, transient, stored, fields: fieldsOf(schema), schema }
})

const journal = JOURNAL_KINDS.map((kind) => {
  const facts = JOURNAL[kind]
  if (facts === undefined) fail(`Journal kind ${kind} has no writer and sensitivity entry in scripts/generate-event-reference.ts`)
  if (!RESERVED_KINDS.includes(kind)) fail(`Journal kind ${kind} is not reserved`)
  const schema: Json = Option.match(journalSchemaOf(kind), { onNone: (): Json => { fail(`Journal kind ${kind} has no journal schema (journalSchemaOf)`); return {} }, onSome: jsonSchemaOf })
  const properties = isJson(schema.properties) ? schema.properties : {}
  const body = isJson(properties.body) ? fieldsOf({ ...properties.body, definitions: isJson(schema.definitions) ? schema.definitions : {} }) : []
  return { kind, writer: facts?.writer ?? "", sensitive: facts?.sensitive ?? "", fields: fieldsOf(schema), body, schema }
})
Object.keys(JOURNAL).filter((kind) => !JOURNAL_KINDS.includes(kind)).forEach((kind) => fail(`${kind} has a writer entry but is not a journal kind`))
const busNames = new Set<string>(bus.map((event) => event.name))
RESERVED_KINDS.filter((kind) => !JOURNAL_KINDS.includes(kind) && !busNames.has(kind)).forEach((kind) => fail(`Reserved kind ${kind} is neither a journal kind nor a bus event's name`))

const beginCodes = Object.entries(turnBeginCodes).map(([tag, code]) => {
  const http = BEGIN_HTTP[tag]
  if (http === undefined) fail(`Begin code ${code} (${tag}) has no suggested HTTP status`)
  return { tag, code, http: http?.status ?? "", meaning: http?.meaning ?? "" }
})
Object.keys(BEGIN_HTTP).filter((tag) => !(tag in turnBeginCodes)).forEach((tag) => fail(`BEGIN_HTTP names ${tag}, which is not a begin error`))

/** Every code the packages raise is published, and every published code has its entry. */
const sources = async (directory: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true })
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")).map((entry) => join(entry.parentPath, entry.name))
}
const packages = (await readdir(join(root, "packages"))).filter((name) => !["website", "foundry"].includes(name))
const sourceText = (await Promise.all(packages.map(async (name) => {
  const files = await sources(join(root, "packages", name, "src")).then((found) => found, () => [])
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n")
}))).join("\n")
codeListProblems({
  published: HARNESS_CODES,
  entries: [...ERROR_CODES, ...TASK_CODES].map((entry) => entry.code),
  begin: Object.values(turnBeginCodes),
  raised: raisedCodes(sourceText),
}).forEach(fail)

const sample = FeedRecord.make({ sequence: 42, event: "turn.reply", data: { outcome: "completed", reply: "Done." } })
const feed = {
  sse: {
    headers: sseHeaders,
    preamble: ssePreamble,
    record: encodeSse(sample),
    ready: encodeSse(FeedReady.make({})),
    heartbeat: encodeSse(FeedHeartbeat.make({})),
  },
  socket: {
    record: encodeSocketFrame(sample),
    ready: encodeSocketFrame(FeedReady.make({})),
    heartbeat: encodeSocketFrame(FeedHeartbeat.make({})),
    resume: JSON.stringify({ after: 41 }),
  },
  defaults: renderFeedDefaults,
}

const tasks = [
  { kind: TASK_STARTED, where: "the parent session", when: "`Tasks.start`: the task's instructions, mode, the starter's `meta` and, when given, the turn that started it (`startedBy`); its child session is created with it.", schema: jsonSchemaOf(TaskStarted) },
  { kind: TASK_RESULT, where: "the child session", when: "Before the child's turn ends (or outside a turn when the host refused it): the outcome, reply and failure.", schema: jsonSchemaOf(TaskResult) },
  { kind: TASK_CANCELLED, where: "the child, then the parent", when: "`Tasks.cancel`, while the task is pending or running; the first of a result and a cancellation ends the task.", schema: jsonSchemaOf(TaskCancelled) },
].map((record) => ({ ...record, fields: fieldsOf(record.schema) }))

if (failures.length > 0) {
  console.error(`The event reference is out of date with the code:\n${failures.map((line) => `- ${line}`).join("\n")}`)
  process.exit(1)
}

const reference = { reserved: RESERVED_KINDS, bus, journal, beginCodes, errorCodes: ERROR_CODES, feed, tasks: { records: tasks, codes: TASK_CODES, delivery: { id: deliveryId("<taskId>"), source: { kind: "task", taskId: "<taskId>", child: "<taskId>", status: "<status>" } } } }

/* ── markdown ── */

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ")
const code = (text: string) => `\`${text}\``
const table = (head: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n")
const fieldTable = (fields: ReadonlyArray<Field>) => fields.length === 0 ? "No fields." : table(["Field", "Type"], fields.map((field) => [code(field.name), code(field.type) + (field.required ? "" : " (optional)")]))
const storedText = (stored: (typeof bus)[number]["stored"]) =>
  stored.as === "transient" ? "Not stored (transient)"
    : stored.as === "recorded-elsewhere" ? `Recorded elsewhere: ${stored.where}`
      : stored.as === "host" ? "Under its `name`"
        : `${code(stored.kind)}${stored.omitted.length > 0 ? `, without ${stored.omitted.map(code).join(", ")}` : ""}`
const fence = (language: string, text: string) => `\`\`\`${language}\n${text}\n\`\`\``

const body = (links: { readonly guide: string }) => [
  `Generated by \`bun run docs:generate\` (\`scripts/generate-event-reference.ts\`) from the event and journal schemas; the full JSON schemas are in \`docs/event-reference.json\`. Writers, sensitivity, HTTP statuses and error-code meanings are kept by hand in that script, which fails when they no longer match the code.`,
  `There are two kinds of events. The **bus** carries a turn's typed events (\`TurnEvent\`) live, in process, to the turn's subscribers. The **journal** is the session's durable log: the turn's writer subscribes to the bus first and stores most bus events, memory stores its entries, and the sessions plugin stores the turn's start, end and the inbox. Another request or process reads the journal with \`Sessions.read\`; only the bus carries token deltas. See [the events guide](${links.guide}) for how to subscribe to them, stream a turn to a client and follow a session.`,
  "## Bus events",
  "`_tag` is the event's name. Subscribe with `turn.events.subscribe`, `onEvent`, `onTool` or a host event's `on`.",
  table(["Event", "Transient", "Stored as"], bus.map((event) => [code(event.name), event.transient ? "yes" : "no", storedText(event.stored)])),
  ...bus.flatMap((event) => [`### ${code(event.name)}`, event.description, fieldTable(event.fields)]),
  "## Journal kinds",
  "Every event of a session's journal is `{ session, seq, turn, kind, at, data }`; `seq` is dense from 1 and is the cursor for `Sessions.read({ after })`. These are the kinds the framework writes. `journalSchemaOf(kind)` (from `@xandreed/core`) gives the schema of each kind's `data`. A host that exports, streams or redacts session events must treat the sensitive kinds like the conversation itself: `request.part`, historical `request.prepared`, `memory.system`, `memory.section` and `memory.step` hold the system prompt and the host's context.",
  table(["Kind", "Written by", "Sensitive content", "Fields"], journal.map((entry) => [code(entry.kind), entry.writer, entry.sensitive, entry.fields.map((field) => code(field.name)).join(", ")])),
  "A memory kind's `data` is `{ entry, runId, step, at, body }`: the memory entry's id, run, step and time, and its body without the `_tag` (the kind names it). Memory is rebuilt from these events by `entriesOfEvents`.",
  table(["Kind", "Body fields"], journal.filter((entry) => entry.body.length > 0).map((entry) => [code(entry.kind), entry.body.map((field) => `${code(field.name)}: ${code(field.type)}`).join(", ")])),
  "Any other kind is a host's or a plugin's own record (`defineHostEvent`, `Sessions.transact`, the tasks plugin's `task.*`).",
  "## Reserved kinds",
  "A host event, a `Sessions.transact` draft, or a draft a host or plugin appends through a turn's writer (`TurnWriter.append`, `transact`), may not use these names: the publish fails with `events.reserved`, the writer and `Sessions.transact` with `ReservedKind` (whose code is `events.reserved`); only the framework's turn writes them (`frameworkDraft`). They are the journal kinds above and every bus event's name (`TURN_EVENT_NAMES`), the ones the journal never stores under their own name included (`assistant.message`, `assistant.delta`, `tool.progress`, `skills.activated`, `host`). The list is matched exactly, not by prefix: other names in these namespaces are accepted, but a host should use its own namespace.",
  fence("text", RESERVED_KINDS.join("\n")),
  "## Begin codes",
  "When `Agent.turn` begins the turn itself and the turn cannot begin (`Sessions.begin` refuses it, or, for `AttachmentRejected`, `Agent.turn`'s own check of the attachments before it), the turn fails with the begin error itself (`TurnBeginError`), before anything is opened: match it with `Effect.catchTag`. Each stands for one of these codes (`turnBeginCodes` from `@xandreed/core`, also exported by `@xandreed/sdk`; `harnessCodeOf` and `turnEndingOf` give it). The HTTP status is a suggestion for a host serving turns over HTTP.",
  table(["Begin error", "Code", "Suggested HTTP status", "Meaning"], beginCodes.map((entry) => [code(entry.tag), code(entry.code), entry.http, entry.meaning])),
  "## Error codes",
  "`HARNESS_CODES` (from `@xandreed/core`; `HarnessCode` is its schema) lists every code the framework's packages raise or store: the begin codes above, the task failure codes below and these. The list is published: a code in it is never renamed or removed, only added, and the generator fails on a code a package raises that the list does not hold. A host's and a third-party plugin's own codes are not in it (`HarnessError.code` is any string).",
  "A failed turn's `turn.ended` carries in `failure.code` the code `harnessCodeOf` gives for the error it failed with (one of these, a plugin's, or a host's own), else `turn.failed`, `turn.defect` or `turn.interrupted` (`turnEndingOf` from `@xandreed/core`), with the error's message cut to 500 characters; a closer that ends its writer itself stores its own code (plugin-tasks: `task.turn`, `task.deadline`). Most codes are a `HarnessError`'s; a tag (`TAGGED_CODES`: a begin refusal, `TurnClosed`, `ReservedKind`, `SessionContended`) stands for its own. A `SessionLogError` carries a store's (`store.*`, and the sessions and tasks plugins' storage codes), and a turn that fails with one stores `session.log`; an `AuthError` or a `SettingsError` carries its own.",
  table(["Code", "Where", "Meaning"], ERROR_CODES.map((entry) => [code(entry.code), entry.where, entry.meaning])),
  "## Feed and socket frames",
  "`@xandreed/plugin-render` turns a journal into client frames (`RenderFeed`); the host's projection names each record's `event` and `data`, and its cursor is the journal's `seq`. Over SSE, each connection starts with the preamble; a record carries its sequence as the event id, so a reconnecting `EventSource` resumes with `Last-Event-ID`. One `ready` frame follows the backlog (the first poll that finds nothing new), then a heartbeat comment while the feed is idle. The feed ends after `maxDurationMs`, and the client reconnects with its cursor.",
  table(["Frame", "SSE", "WebSocket"], [
    ["preamble", code(JSON.stringify(feed.sse.preamble)), "none"],
    ["record", code(JSON.stringify(feed.sse.record)), code(feed.socket.record)],
    ["ready", code(JSON.stringify(feed.sse.ready)), code(feed.socket.ready)],
    ["heartbeat", code(JSON.stringify(feed.sse.heartbeat)), code(feed.socket.heartbeat)],
    ["resume", "the `Last-Event-ID` request header", `the client's first message, ${code(feed.socket.resume)}`],
  ]),
  "SSE response headers (`sseHeaders`):",
  fence("json", JSON.stringify(feed.sse.headers, null, 2)),
  "Feed defaults (`renderFeedDefaults`, in milliseconds):",
  fence("json", JSON.stringify(feed.defaults, null, 2)),
  "## Task records",
  `\`@xandreed/plugin-tasks\` records its own kinds (not reserved). A finished task is delivered to the parent's inbox once, as \`inbox.queued\` with the id ${code(reference.tasks.delivery.id)} and the source \`{ kind: "task", taskId, child, status }\`.`,
  table(["Kind", "Recorded in", "When"], tasks.map((record) => [code(record.kind), record.where, record.when])),
  ...tasks.flatMap((record) => [`### ${code(record.kind)}`, fieldTable(record.fields)]),
  "### Task failure codes",
  "The `code` of a task result's `failure`, or of a task's status, besides any `HarnessError` code the task's turn failed with.",
  table(["Code", "Where", "Meaning"], TASK_CODES.map((entry) => [code(entry.code), entry.where, entry.meaning])),
].join("\n\n")

await Bun.write(join(root, "docs/event-reference.json"), `${JSON.stringify(reference, null, 2)}\n`)
await Bun.write(join(root, "docs/event-reference.md"), `# Event reference\n\n${body({ guide: "events.md" })}\n`)
await Bun.write(join(root, "packages/website/src/content/docs/concepts/event-reference.md"),
  `---\ntitle: Event reference\ndescription: Generated reference of turn events, session journal kinds, begin and error codes, and feed frames.\n---\n\n${body({ guide: "/docs/guides/events/" })}\n`)
console.log(`Generated the event reference: ${bus.length} bus events, ${journal.length} journal kinds, ${beginCodes.length} begin codes`)
