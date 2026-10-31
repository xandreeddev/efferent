# @xandreed/plugin-session-files

Core's `SessionLog` port as files in a directory, local or on a network mount (NFS), and a plugin that pairs it with the open `TurnAdmission`; hosts compose `sessionsPlugin` (plugin-sessions) on top. Node 24 and Bun: the durable store a Node host uses. Layer `plugin-session-files` in `foundry.config.ts` (imports core and `node:`); its tests' layer `plugin-session-files-tests` also imports plugin-sessions.

## Rules

- One immutable file per commit, `sessions/<id>/commits/<revision>.jsonl`: written to `tmp/`, flushed, then published by an exclusive hard link to its revision's name. The link is the compare-and-swap: never write a commit's final name directly, never rewrite a published file, never take a lock (no handle may wait on another, and a stopped process must block nobody).
- Settle every failed publish by what the name holds (`publish`): the commit's own nonce means it landed whatever the link answered (a network file system retransmits), another's means the revision was taken, none means it did not land. Settle a failed create's rename by the header's nonce the same way.
- Never empty a session's directory in place: `remove` renames it into `trash/` first, so a rename can never land a new session over an emptied one; `create` stages a session in `staging/` and publishes it by one rename, then checks its parent is still there.
- A commit file ends with its trailer (the bytes before it and their CRC-32). One at a session's tail that is not whole is moved to `quarantine/<id>/` with its bytes kept, a warning logged, and the commit before it is the head; one before the tail fails with `store.decode` and nothing is moved (`tailVerdict`).
- Go through the shared `makeBoundedFilesCall` for every file system call. Healthy calls queue with a bounded admission deadline; an expired waiter starts no IO. Each handle has at most two native operations, including promises whose callers timed out or were interrupted: their tokens are released by native settlement, never by a caller's deadline. A full token set blocks cooldown probes. Native waits have their own `stallMs` deadline; interrupted probes release their health claim. No detached Effect waits for a hung native promise, so scope cleanup does not join it. A stalled publish's outcome is unknown until the head is read again.
- Publish uninterruptibly (write, link, settle, clean up): an interrupt waits for the outcome, which `call` bounds.
- A temporary commit file whose revision is taken can never be published (a writer stopped between writing and linking, or between linking and removing it): the first commit a handle makes to a session removes those (`sweepTemporaries`), never one for a later revision, which another writer may be about to link.
- Return copies: a head's state and meta are the handle's own (`structuredClone`), a commit's state is stored through `storedJson`; what a handle caches per session (the tail, the commits' first lines) is keyed by the header's nonce, so a session removed and created again is read afresh.
- The directory's layout is `store.json`'s `layout` (`FILES_LAYOUT`): a later one fails to open with `store.version`, neither read nor written; a directory without hard links fails with `store.open`.
- Change behaviour by adding the check to core's `sessionLogConformance` or `sessionLogRecoveryConformance` first.
- Each `SessionLog` call is an `Effect.fn` span, `session_log.<create|head|list|read|commit|remove>`, with `efferent.session.id` when it names a session (`onSession`); `makeSessionLogFiles` is `Effect.fnUntraced`.
- `MediaStoreDirectoryLive` owns an independent media root: `media-store.json` records its layout 1 and SHA-256 algorithm, `blobs/<hash>.bin` holds immutable bytes, and `tmp/` holds private publications. It never changes the session directory's `store.json` or `FILES_LAYOUT`.
- Media puts synchronously validate and copy their bytes before any wait, including Buffer inputs. Final blob names are published only by exclusive hard link from a synced temporary file. Equal existing content is idempotent; every uncertain or conflicting publication is checked by full hash/bytes, and corrupt existing blobs are never overwritten. Reads are bounded to `MEDIA_LIMITS.imageBytes + 1`, verify the key, and return copies. Missing is `None`; invalid inputs, unavailable IO and corrupt data are `MediaStoreError` values.
- Blob IO remains interruptible; only the governor's token and Promise construction is masked. Interrupted/failed puts may leave safe temporary or published orphans, and cleanup is bounded and best effort. Directory-entry sync follows the session store's best-effort semantics. No blob is deleted on session removal or rollback, and no garbage collection runs here.

## Public surface

- `sessionFilesPlugin` (also the default export): the log plus `TurnAdmissionOpen`; `sessionLogFilesPlugin`: the log alone. Config `SessionFilesConfig` and `sessionFilesDefaults` (`path: ".efferent/runtime/sessions"`, `stallMs: 10000`).
- `makeSessionLogFiles(root, options?)` (a scoped `SessionLog` service) and `SessionLogFilesLive(root, options?)` (its layer); `SessionLogFilesOptions` (`stallMs`, `io`), and the file system seam `FilesIo` with its default `nodeFilesIo`.
- `MediaStoreDirectoryLive(root, options?)` provides core's `MediaStore`. `MediaStoreDirectoryOptions` accepts the same `io` fault seam and an optional positive `stallMs` (default 10000). Hosts apply core's `withMediaStore` to a SessionLog explicitly; this layer stores bytes and does not change journal payloads itself.

The root names each export, and `quality/exports-have-consumers` checks each one: the sdk's tests, the scripts and the docs import some, and the rest are tagged `@public` at their declarations.

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `sessionFilesPlugin` | `@xandreed/plugin-session-files` | runtime | `efferent/SessionLog`, `efferent/TurnAdmission` | none | none |
| `sessionLogFilesPlugin` | `@xandreed/plugin-session-files/log` | runtime | `efferent/SessionLog` | none | none |

## Model-facing text

None.

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/session-log.adapter.ts` | `makeSessionLogFiles`, `SessionLogFilesLive`: the store |
| `src/files-io.adapter.ts` | `FilesIo`, `nodeFilesIo`: the file system calls |
| `src/bounded-call.adapter.ts` | shared logical admission, native operation slots, deadlines and health |
| `src/media-store-directory.entity.ts` | the independent media directory marker and layout |
| `src/media-store-directory.adapter.ts` | immutable SHA-256 media publication and checked reads |
| `src/session-files.entity.ts` | the files' records, the config, the store's errors and health |
| `src/session-files.entity.functions.ts` | the commit codec and CRC-32, names, the tail verdict, the listing's order, health transitions |
| `src/plugin.adapter.ts` | `sessionFilesPlugin`, `sessionLogFilesPlugin` |
| `src/index.ts` | the public exports |

## Tests

- `src/session-log.adapter.test.ts`: core's `sessionLogConformance` and `sessionLogRecoveryConformance` over a temporary directory; the files a commit leaves, a torn tail set aside, damage before the tail, a newer layout, a directory without hard links, a stall and its recovery, a link whose answer was lost, a create raced by two handles.
- `src/sessions.conformance.test.ts`: core's `sessionsConformance` over SessionsLive instances on two handles of one directory.
- `src/session-files.entity.functions.test.ts`: the codec (every truncation and byte change is caught), names, the listing, health.
- `src/bounded-call.adapter.test.ts`: native slots survive timeout/interruption, healthy queueing and bounded admission, late rejection/cause identity, and interrupted-probe recovery.
- `src/media-store-directory.adapter.test.ts`: core's seven-check MediaStore kit, held Buffer mutation, cold reads, concurrent publishers, lost link ACK, corrupt/oversized blobs, private permissions, marker and hard-link failures, safe hash paths and prompt cancellation.
- `src/session-recovery.test.ts`: crash recovery against real processes (`fixtures/session-files-holder.mjs`, plain JavaScript, so Bun runs it here and Node over the packed package in `verify:packages`): a writer SIGKILLed while it commits leaves whole commits; killed after writing its file and before the link it committed nothing, after the link it committed; two processes racing by compare-and-swap lose no update. `EFFERENT_SESSION_FILES_MOUNT=<dir>` runs the crash and race checks on that directory too (a network mount).
- Elsewhere: `packages/sdk/src/agent.backends.test.ts` runs the golden conversation over the directory; `verify:packages` runs both SessionLog kits over the packed package on Node, and the holder with Node: killed mid-commit, then two racing.
- Run: `bun test packages/plugin-session-files`.

See the root AGENTS.md for the enforced rules and the definition of done.
