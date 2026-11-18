import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Array as Arr, Context, Effect, Layer, Order } from "effect"
import type { Scope } from "effect"
import { Core, JournalStorage, kernel, Sessions } from "@xandreed/core/kernel"
import type { ConformanceCheck, JournalStorageSubject, SessionsSubject } from "@xandreed/core/kernel"
import { sessions } from "../plugins/session/sessions.adapter.js"
import type { JournalOpenFailed } from "./writer/writer.entity.js"

/*
 * What the tests of the kernel's Node entry share: a scratch directory a
 * test removes, the kits' subjects over a durable store, and a child
 * process that holds a store (`fixtures/kernel-store-holder.ts`).
 */

type StorageShape = Context.Service.Shape<typeof JournalStorage>

/** A fresh directory for the scope, removed with everything in it when the scope closes. */
export const scratch = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "efferent-kernel-node-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
)

/** A store's layer over a path: what a test opens a durable journal with. */
export type StoreAt = (path: string) => Layer.Layer<JournalStorage, JournalOpenFailed>

/** Build a store's layer in the scope and take its `JournalStorage`; a store that does not open is the test's defect. */
export const storageAt = (store: StoreAt, path: string): Effect.Effect<StorageShape, never, Scope.Scope> =>
  Effect.map(Effect.orDie(Layer.build(store(path))), (services) => Context.get(services, JournalStorage))

/** The storage kit's subject over a store: a fresh path per check, and two handles of this process on one path. */
export const storageSubject = (store: StoreAt, file: string): JournalStorageSubject => ({
  open: Effect.flatMap(scratch, (directory) => storageAt(store, join(directory, file))),
  pair: Effect.flatMap(scratch, (directory) => Effect.all([storageAt(store, join(directory, file)), storageAt(store, join(directory, file))], { concurrency: 1 })),
})

/** The sessions kit's subject over a store: the stock session plugin over a fresh one. */
export const sessionsSubject = (store: StoreAt, file: string): SessionsSubject => ({
  open: (core) => Effect.gen(function* () {
    const directory = yield* scratch
    const storage = yield* storageAt(store, join(directory, file))
    const built = yield* Layer.build(sessions().pipe(Layer.provide(Layer.merge(Layer.succeed(Core, core), Layer.succeed(JournalStorage, storage)))))
    return { sessions: Context.get(built, Sessions), storage }
  }),
})

/** The ids of the checks of a kit that fail, sorted, each with what it said. */
export const failedChecks = (checks: ReadonlyArray<ConformanceCheck>) =>
  Effect.runPromise(Effect.forEach(checks, (check) => Effect.result(check.run).pipe(
    Effect.map((result) => result._tag === "Failure" ? [`${check.id}: ${result.failure.message}`] : [])), { concurrency: 1 }))
    .then((failed) => Arr.sort(failed.flat(), Order.String))

/** One process's stack over a store at a path: the kernel, the session plugin and the store. */
export const processOver = (store: StoreAt, path: string) => sessions().pipe(Layer.provideMerge(store(path)), Layer.provideMerge(kernel()))

const holderScript = join(import.meta.dir, "../../../fixtures/kernel-store-holder.ts")

/**
 * A child process over a store: `hold` builds the store and waits; `turn` also creates a session, opens a turn,
 * stores a user message and waits inside the turn. It says what it holds on its first line of output, and waits
 * until it is killed. Its stderr is the test's.
 */
export const holder = (kind: "directory" | "sqlite", path: string, mode: "hold" | "turn") => Effect.acquireRelease(
  Effect.promise(async () => {
    const child = Bun.spawn(["bun", holderScript, kind, path, mode], { stdout: "pipe", stderr: "inherit" })
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    const first = async (got: string): Promise<string> => {
      if (got.includes("\n")) return got.slice(0, got.indexOf("\n"))
      const { value, done } = await reader.read()
      return done ? got : first(got + decoder.decode(value))
    }
    const line = await first("")
    reader.releaseLock()
    return { child, line }
  }),
  ({ child }) => Effect.promise(() => { child.kill("SIGKILL"); return child.exited }),
)

/** Kill a child at once, as a crash would: no finalizer of its runs. */
export const killed = (child: { readonly kill: (signal: "SIGKILL") => void; readonly exited: Promise<number> }) =>
  Effect.promise(() => { child.kill("SIGKILL"); return child.exited })
