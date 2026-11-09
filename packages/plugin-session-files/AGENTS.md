# @xandreed/plugin-session-files

Core's `SessionLog` port as files in a directory, local or on a network mount (NFS), and a plugin that pairs it with the open `TurnAdmission`; hosts compose `sessionsPlugin` (plugin-sessions) on top. Node 24 and Bun: the durable store a Node host uses. Layer `plugin-session-files` in `foundry.config.ts` (imports core and `node:`); its tests' layer `plugin-session-files-tests` also imports plugin-sessions.

## Rules

- File layout 2 gives each creation an immutable generation: `sessions/<id>/claims/<generation>.json` exclusively publishes its header and initial state; `sessions/<id>/lives/<incarnation>/` holds `header.json`, `commits/`, `tmp/` and its permanent `removed` tombstone. Never reuse a generation path or delete claims/tombstones.
- A commit writes a private temporary file, flushes and exclusively hard-links it to its revision. Settle an uncertain publication by its nonce. Owner and incarnation are mandatory fences before work and publication; `notAfter` is checked twice. A replacement session has different paths.
- Removal tombstones the addressed generation first, clears only its payloads and follows children with the full parent reference. Readers verify ancestor references and tombstones; a crash cannot reveal an orphan. Creation validates the parent before and after its exclusive claim.
- Stage marker publication with storage time; sweep only recognized abandoned staging names. Fresh roots may initialize layout 2. Other markers and nonempty unmarked roots fail with `store.version`, without adopting or deleting old data; before refusing an unmarked root, read the marker again, since another handle may have initialized it meanwhile (`refuseUnmarked`). There is no migration.
- A session's file that vanished under a call is `SessionMissing` when the session's header is gone too (`goneOr`), else `current` reads once more (a tail another handle set aside); never `store.io` for a session removed meanwhile.
- A commit file ends with its trailer (the bytes before it and their CRC-32). One at a session's tail that is not whole is moved to `quarantine/<id>/<incarnation>/` with its bytes kept, a warning logged, and the commit before it is the head; one before the tail fails with `store.decode` and nothing is moved (`tailVerdict`). The move goes by name: read back what was moved, and put it back by an exclusive link when it is not the torn bytes read (another writer published that revision again after another handle set the torn one aside).
- Go through the shared `makeBoundedFilesCall` for every file system call. Healthy calls queue for a slot with a bounded admission deadline; an expired waiter starts no IO. Each handle has at most two native operations, including promises whose callers timed out or were interrupted: such a caller hands its slot to the operation, which releases it when it settles (the semaphore's capacity is lowered meanwhile), never by a caller's deadline. Healthy calls wait for the slots left, never fail for a held one; a cooldown probe never waits (a full slot set fails it at once). Native waits have their own `stallMs` deadline; interrupted probes release their health claim. No detached Effect waits for a hung native promise, so scope cleanup does not join it. A stalled publish's outcome is unknown until the head is read again.
- Publish uninterruptibly (write, link, settle, clean up): an interrupt waits for the outcome, which `call` bounds.
- A temporary commit file whose revision is taken can never be published (a writer stopped between writing and linking, or between linking and removing it): the first commit a handle makes to a session removes those (`sweepTemporaries`), never one for a later revision, which another writer may be about to link.
- Return copies: a head's state and meta are the handle's own (`structuredClone`), a commit's state is stored through `storedJson`; what a handle caches per session (the tail, the commits' first lines) is keyed by the header's nonce, so a session removed and created again is read afresh. Keep the cache within `CACHE_BOUNDS` (`trimCache`, least recently used first); a read stores the first lines it read once, when it is done. A commit's `last` never decreases with its revision: a read after a position starts at the first commit past it, found by a binary search over first lines, and stops past its ceiling (forward) or its position (from the end).
- The directory's layout is `store.json`'s `layout` (`FILES_LAYOUT`): any different one fails to open with `store.version`, neither read nor written; a directory without hard links fails with `store.open` at every open (a link probe staged in `staging/`), fresh or holding a store already.
- Change behaviour by adding the check to core's `sessionLogConformance` or `sessionLogRecoveryConformance` first.
- Each `SessionLog` call is an `Effect.fn` span, `session_log.<create|head|list|read|commit|remove>`, with `efferent.session.id` when it names a session (`onSession`); `makeSessionLogFiles` is `Effect.fnUntraced`.
- `MediaStoreDirectoryLive` owns an independent media root: `media-store.json` records its layout 1 and SHA-256 algorithm, `blobs/<hash>.bin` holds immutable bytes, `tmp/` holds private publications (`<hash|marker>.<created millis>.<uuid>[.tmp]`), and `quarantine/` keeps damaged blobs a put replaced. It never changes the session directory's `store.json` or `FILES_LAYOUT`.
- Media hashing uses the platform's SHA-256 (`node:crypto`), the same key as core's pure `mediaHashOf`. Media puts synchronously validate and copy their bytes before any wait, including Buffer inputs. Final blob names are published only by exclusive hard link from a synced temporary file. Equal existing content is idempotent; every uncertain or conflicting publication is checked by full hash/bytes. A put whose final file is damaged hard-links it into `quarantine/` as evidence, then renames its synced bytes over it. Reads are bounded to `MEDIA_LIMITS.imageBytes + 1`, verify the key, and return copies, so core's decorator need not hash them again. Missing is `None`; invalid inputs, unavailable IO and corrupt data are `MediaStoreError` values.
- Opening the store sweeps `tmp/` files whose name records a creation more than an hour old (a process stopped between create and publication); recent files and names it did not write stay. `nodeFilesIo.readStart` reads again after a short answer until the buffer is full or the file ends (`readFully`).
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
| `src/session-files.entity.functions.ts` | the commit codec and CRC-32, names (staging names with their time), the tail verdict, the listing's order, the cache's bounds, health transitions |
| `src/plugin.adapter.ts` | `sessionFilesPlugin`, `sessionLogFilesPlugin` |
| `src/index.ts` | the public exports |

## Tests

- `src/session-log.adapter.test.ts`: core's `sessionLogConformance` and `sessionLogRecoveryConformance` over a temporary directory; the files a commit leaves, a torn tail set aside, damage before the tail, a newer layout, two handles opening a fresh directory at once, a directory without hard links, a stall and its recovery, a link whose answer was lost, a create raced by two handles, a write that ran past its `notAfter`, a child created while its parent is removed, a session removed under a read and a listing, a torn tail's revision published again before a late handle moved it, the staging sweep, a session removed and created again while a commit wrote its file, and before it; the commit files a cold read opens (a binary search to its first commit, early stops).
- `src/sessions.conformance.test.ts`: core's `sessionsConformance` over SessionsLive instances on two handles of one directory; a turn's opening commit that stalls and lands after its begin failed.
- `src/session-files.entity.functions.test.ts`: the codec (every truncation and byte change is caught), names (staging names and their age), the listing, the cache's bounds, health.
- `src/bounded-call.adapter.test.ts`: native slots survive timeout/interruption, healthy queueing and bounded admission, a hung operation lowering the capacity by one while healthy calls queue for the rest, late rejection/cause identity, and interrupted-probe recovery.
- `src/media-store-directory.adapter.test.ts`: core's seven-check MediaStore kit, held Buffer mutation, cold reads, concurrent publishers, lost link ACK, corrupt/oversized blobs and the quarantining repair of a damaged one, the opening sweep of abandoned temporary files, private permissions, marker and hard-link failures, safe hash paths and prompt cancellation. `src/files-io.adapter.test.ts`: start reads that continue after short answers.
- `src/session-recovery.test.ts`: crash recovery against real processes (`fixtures/session-files-holder.mjs`, plain JavaScript, so Bun runs it here and Node over the packed package in `verify:packages`): a writer SIGKILLed while it commits leaves whole commits; killed after writing its file and before the link it committed nothing, after the link it committed; two processes racing by compare-and-swap lose no update. `EFFERENT_SESSION_FILES_MOUNT=<dir>` runs the crash and race checks on that directory too (a network mount).
- Elsewhere: `packages/sdk/src/agent.backends.test.ts` runs the golden conversation over the directory; `verify:packages` runs both SessionLog kits over the packed package on Node, and the holder with Node: killed mid-commit, then two racing.
- Run: `bun test packages/plugin-session-files`.

See the root AGENTS.md for the enforced rules and the definition of done.
