# ADR 0034: Media is kept by its hash

- **Status:** accepted, 19 November 2026
- **Applies to:** `@xandreed/sdk/kernel` (new: `MediaStore`, `MediaHash`, `MediaRefused`, `MediaRefusedBecause`,
  `MediaUnavailable`, `MediaDamaged`, `MEDIA_LIMIT`, `mediaHashOf`, `checkedBytes`, `mediaStoreConformance`,
  `MediaStoreSubject`, `inMemoryMedia`, `InMemoryMediaOptions`), `@xandreed/sdk/kernel/node` (new: `directoryMedia`,
  `DirectoryMediaOptions`)
- **Amends:** ADR 0028 (the media it left "in its own cut": the store comes first, alone)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

The old engine and every `plugin-*` package are removed before the next release. The old engine keeps images and
other bytes for the model in core's `MediaStore`: content-addressed by SHA-256, with an in-memory adapter in core, a
directory adapter in `plugin-session-files` and a kit, all importing core's root. The kernel had no store of bytes: a
host of it that wants an image to reach a model has nowhere to keep it, and nothing of the old one may be imported. So
this cut gives the kernel the store, and only the store.

## Decision

### The contract (`contracts/media`, key `@xandreed/sdk/kernel/MediaStore`)

- **`put(bytes)` gives the bytes' key, `get(hash)` gives them back.** The key is their SHA-256 in lowercase hexadecimal
  (`MediaHash`, 64 digits), so the same bytes have the same key in every store and a key names content, granting
  nothing by itself. Kept bytes never change: the same bytes put again give the same key and keep what is there.
- **A bound on size, the store's own.** `maxBytes` (on the service, so a caller and the kit can read it) is the most
  one key keeps: `MEDIA_LIMIT`, 3,932,160 bytes (3.75 MiB, the largest image a provider takes inline as 5 MiB
  of base64, the old engine's image bound) unless the store's options name another. No bytes, or more than
  the bound, are refused (`MediaRefused`, `empty` or `size`) and keep nothing. There is no resizing: bytes over the
  bound are the host's to make smaller.
- **Copies at both edges.** A put copies the bytes before the store waits for anything (`checkedBytes`): a caller
  that changes its buffer later changes nothing kept. The copy reads the array's own window through the intrinsic
  getters, so a subclass that lies about its length, an aliasing `slice`, a lying iterator, a proxy (refused,
  `bytes`) or a buffer handed away (no bytes) cannot change what is kept. A get gives a copy of its own each time.
- **What is under a key is the key's bytes, or an error.** A key that is no `MediaHash` is refused (`key`) and never
  looked for, so no text a caller gives becomes a path. A store that cannot rule out damage verifies what it reads:
  bytes whose SHA-256 is not their key are `MediaDamaged` (with the key), never given back and never said to be
  absent. A medium that fails is `MediaUnavailable`.
- **SHA-256 is the contract's, pure** (`mediaHashOf`, core's pure function written again in the kernel, which never
  imports core's root): a page with no secure context has no `crypto.subtle`, and an entity's function cannot wait for
  one. It is held to the platform's own hash at every length a block's padding turns on (0, 1, 55, 56, 57, 63, 64,
  65, 119, 120, 128 bytes), at three megabytes, and on a window of a larger buffer. A store with native crypto may hash
  with it, to the same key (`directoryMedia` does).
- **The kit** (`mediaStoreConformance`, `MediaStoreSubject`): `hash` (three vectors worked out apart, FIPS 180-4's
  `abc` among them, each put as a window of a larger buffer), `again`, `apart`, `missing`, `input-copy`,
  `output-copy`, `bounds` (at the store's own `maxBytes`, so a subject checked often gives a small bound) and `key`.
  Core's seven checks are its source; its `idempotent` is split in two (`again`, `apart`) and `roundtrip` folded into
  them, so each careless store fails its own check and no other: one that keys by another hash (`hash`), one that
  refuses a put twice (`again`), one that answers a key with the bytes of another (`apart`), one that keeps the
  caller's buffer (`input-copy`), one that gives its own buffer (`output-copy`), one that makes up bytes for a key
  nothing was put under (`missing`), one that keeps more than its bound (`bounds`), one that answers nothing for a
  key that is no key (`key`). The self-test holds that exact list, a store that fails every call failing all eight,
  and the same hand-written store with no fault passing.

### The stores

- **`inMemoryMedia({ maxBytes? })`** (`plugins/media-in-memory`): a map in a `Ref`, gone with the layer's scope, each
  build a store of its own. It imports no runtime module, so a page uses it. A host pairs it with a journal kept in
  the process: one that outlives the process would name bytes this store no longer has.
- **`directoryMedia({ directory, maxBytes? })`** (`node/media-directory`, its own boundaries layer, which imports the
  contract alone): a folder of `media.json` (`MediaMarker`: `efferent-media`, layout 1, `sha256`), `blobs/<hash>`,
  `tmp/` and `damaged/`, written as `diskFiles` writes: the bytes to a temporary file (named with its purpose, its
  time and an id), flushed, then published under the key by an exclusive hard link, and the folder flushed; the
  publication runs uninterruptibly. A crash leaves a blob whole or absent and perhaps a temporary file, which a get
  never reads and an opening removes once it is an hour old (a clock on a shared mount may disagree; a name the store
  did not write is left). Bytes already kept are not written again. A get reads at most `maxBytes` and one more, and
  verifies: a file cut short, changed or too long is `MediaDamaged`. A put of the right bytes over a damaged blob
  links the damaged file into `damaged/` as evidence and renames the good bytes over it, with a warning. A folder with
  other files and no marker, or with another store's or layout's marker, is refused and left as it is.
- **No writer lock** (ADR 0024's `holdWriter` is not taken): a blob never changes once kept, and its name is its
  content, so two stores (two processes) that put the same bytes converge: the second link finds the name taken and
  the blob there whole. A journal needs one writer because its order is its truth; a store of content has no order.
- **A bound is not lowered under bytes a folder holds**: a blob longer than the bound a store is opened with reads as
  damaged. A host that lowers it starts a new folder.

### Not in this cut, by decision

No way yet for an image to reach a model. That needs a record of its own beside core's conversation records (a
message that names a key, so the journal holds the key and never the bytes), the OpenAI-compatible wire sending image
parts (`openAiCompatibleModel` refuses a file part today), and a change to memory that the wrapper kit does not allow
today (a memory would resolve a key to bytes as it builds a context). It is the next media cut, after the release.
So this store adds no journal record and changes no stored format.

## Consequences

- A host on Node or Bun, or in a page, keeps the bytes it will send a model under keys a journal can hold, with the
  same contract and kit everywhere; `scripts/kernel-consumer.fixture.mjs` runs the kit over both stores, from the
  packed packages, on Node and on Bun.
- Core's `MediaStore`, its kit and its adapters stay for the old engine until it goes; nothing of the kernel imports
  them, and they go with it.
- A store keeps whatever is put, unbounded in number: nothing is deleted when a session is, and there is no garbage
  collection. A host that must forget bytes removes the folder, or keeps a store per conversation.

## Left open

- The media record, image parts on the OpenAI-compatible wire and a memory that resolves keys (above).
- Removing bytes no journal names, which needs the record first.
- A store over a database or an object store: the kit is what one must pass.

## What would reopen this

- A provider that takes images larger than the bound inline, or a host that keeps other bytes (a PDF) larger than it:
  the default would rise, or the bound become each record's.
- A medium that can rule out damage (a database with its own checksums), which could skip the verification on read.
