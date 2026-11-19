// The one source of truth for lesson 7's store.ts: a `JournalStorage` the
// learner writes over the browser's `localStorage`, so the conversation
// outlives the page. The page shows STORE_IMPORTS (read-only) above the code
// the learner edits and runs that text as written; program.test.ts compiles
// it and holds it to the storage kit, a second handle on the same storage
// included, beside the kernel's own `webStorageJournal`.

/** Read-only: where each name the store uses comes from. */
export const STORE_IMPORTS = `import { Array as Arr, Clock, Effect, Layer, Schema } from "effect"
import {
  byCreation,
  JournalStorage,
  JournalStorageError,
  Seq,
  SessionHeader,
  StoredEvent,
} from "@xandreed/core"`

/** What the learner edits: the store. */
export const DEFAULT_STORE = `// The store: where every record is kept. It is one more module, with five calls, and this one
// keeps what it is given in the browser's localStorage, so a conversation outlives the page.
// A session's header has a key of its own, and so has each of its events:
//   <prefix><id>:header    <prefix><id>:1    <prefix><id>:2    ...

const refused = (reason, message) => Effect.fail(new JournalStorageError({ reason, message }))

// A stored text, read back as what it should be. One that is something else is not a journal's.
const headerText = Schema.fromJsonString(SessionHeader)
const eventText = Schema.fromJsonString(StoredEvent)
const read = (schema, key, text) =>
  Schema.decodeUnknownEffect(schema)(text).pipe(
    Effect.mapError(
      () =>
        new JournalStorageError({
          reason: "Unreadable",
          message: \`the value stored under \${key} is not a journal's\`,
        }),
    ),
  )

export const store = (storage, { prefix }) => {
  const headerKey = (id) => \`\${prefix}\${id}:header\`
  const eventKey = (id, seq) => \`\${prefix}\${id}:\${seq}\`
  // Where the events are kept: the same storage as the headers.
  const kept = storage

  return Layer.succeed(
    JournalStorage,
    JournalStorage.of({
      // A new session: its header, stored once.
      create: (header) =>
        Effect.suspend(() => {
          if (storage.getItem(headerKey(header.id)) !== null) {
            return refused("SessionExists", \`session \${header.id} exists\`)
          }
          storage.setItem(headerKey(header.id), JSON.stringify(header))
          return Effect.void
        }),

      // One more event, at the place after expectedSeq. The check is what keeps a journal in
      // order when two writers meet: the place before must be taken, and this one free.
      append: (id, expectedSeq, turn, event) =>
        Effect.flatMap(Clock.currentTimeMillis, (at) =>
          Effect.suspend(() => {
            if (storage.getItem(headerKey(id)) === null) {
              return refused("SessionMissing", \`no session \${id}\`)
            }
            const behind = expectedSeq > 0 && kept.getItem(eventKey(id, expectedSeq)) === null
            const taken = kept.getItem(eventKey(id, expectedSeq + 1)) !== null
            if (behind || taken)
              return refused("SeqConflict", \`the journal is not at \${expectedSeq}\`)
            const stored = { seq: Seq.make(expectedSeq + 1), at, turn, ...event }
            kept.setItem(eventKey(id, stored.seq), JSON.stringify(stored))
            return Effect.succeed(stored)
          }),
        ),

      // A session's header and its events in order, from a place on when one is given: read until
      // the first place that holds nothing.
      read: (id, from) =>
        Effect.gen(function* () {
          const header = storage.getItem(headerKey(id))
          if (header === null) return yield* refused("SessionMissing", \`no session \${id}\`)
          const events = []
          for (let seq = Number(from ?? 1); kept.getItem(eventKey(id, seq)) !== null; seq++) {
            events.push(yield* read(eventText, eventKey(id, seq), kept.getItem(eventKey(id, seq))))
          }
          return { header: yield* read(headerText, headerKey(id), header), events }
        }),

      // Every session's header, by creation: how a program finds a conversation again.
      list: Effect.gen(function* () {
        const headers = []
        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index)
          if (key === null || !key.startsWith(prefix) || !key.endsWith(":header")) continue
          const header = yield* read(headerText, key, storage.getItem(key))
          // A key of another store, whose prefix starts with this one, is not this store's session.
          if (key === headerKey(header.id)) headers.push(header)
        }
        return Arr.sort(headers, byCreation)
      }),

      // A branch: a new session whose journal starts as another's, up to a place, each event as
      // it was stored. The events are written first and the header last: the header makes it.
      fork: (header) =>
        Effect.suspend(() => {
          if (storage.getItem(headerKey(header.id)) !== null) {
            return refused("SessionExists", \`session \${header.id} exists\`)
          }
          const { of, through } = header.branch
          if (storage.getItem(headerKey(of)) === null)
            return refused("SessionMissing", \`no session \${of}\`)
          const texts = []
          for (let seq = 1; seq <= through; seq++) texts.push(kept.getItem(eventKey(of, seq)))
          if (texts.some((text) => text === null)) {
            return refused("SeqConflict", \`the journal is not at \${through}\`)
          }
          texts.forEach((text, at) => kept.setItem(eventKey(header.id, at + 1), text ?? ""))
          storage.setItem(headerKey(header.id), JSON.stringify(header))
          return Effect.void
        }),
    }),
  )
}`

/** Everything before the editable store. */
export const STORE_HEADER = `${STORE_IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const storeDocumentOf = (store: string): string => `${STORE_HEADER}${store}\n`

/** The statements the page runs: the learner's text without its `export`. */
export const storeBodyOf = (store: string): string => store.replace(/^export /gm, "")

/** What the typed module replaces in the learner's text, as `[from, to]`: the parameters a compiler must be told the types of. */
export const TYPED: ReadonlyArray<readonly [string, string]> = [
  ["const refused = (reason, message) =>", 'const refused = (reason: JournalStorageError["reason"], message: string) =>'],
  ["const read = (schema, key, text) =>", "const read = <A>(schema: Schema.Codec<A, string>, key: string, text: string | null) =>"],
  ["export const store = (storage, { prefix }) => {", "export const store = (storage: KeyValueStore, { prefix }: { readonly prefix: string }) => {"],
  ["const headerKey = (id) =>", "const headerKey = (id: SessionId) =>"],
  ["const eventKey = (id, seq) =>", "const eventKey = (id: SessionId, seq: number) =>"],
  ["          const events = []\n", "          const events: Array<StoredEvent> = []\n"],
  ["        const headers = []\n", "        const headers: Array<SessionHeader> = []\n"],
  ["          const texts = []\n", "          const texts: Array<string | null> = []\n"],
]

/** The same file as a module a test can compile: the learner's text with its parameters typed. */
export const storeModuleOf = (store: string): string =>
  `${STORE_IMPORTS}\nimport type { SessionId } from "@xandreed/core"\nimport type { KeyValueStore } from "@xandreed/sdk"\n\n${TYPED.reduce((text, [from, to]) => text.replace(from, to), store)}\n`
