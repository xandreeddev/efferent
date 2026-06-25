import { CommandExecutor, FileSystem, Path } from "@effect/platform"
import { Context, Effect, Exit, Layer, Ref, Scope } from "effect"
import {
  ConversationStore,
  ContextTreeStore,
  StoreSwitch,
  StoreSwitchError,
  LOCAL_DB_NAME,
  type ConvSummary,
  type DatabaseConn,
  type DbKind,
} from "@xandreed/sdk-core"
import { bootConn, localConn, storesLayerFor } from "./migrator.js"

type ConvSvc = Context.Tag.Service<typeof ConversationStore>
type TreeSvc = Context.Tag.Service<typeof ContextTreeStore>

/** Platform services the SQLite/Postgres clients need to build. Captured at
 *  layer build (from `BunContext`) and re-provided to each on-demand store. */
type DbR = CommandExecutor.CommandExecutor | FileSystem.FileSystem | Path.Path

/** A built store, its services, and the scope that owns its connection. */
interface Handle {
  readonly ctx: Context.Context<ConversationStore | ContextTreeStore>
  readonly scope: Scope.CloseableScope
  readonly name: string
  readonly kind: DbKind
}

/** Best-effort message out of a layer-build failure (prefer the driver cause). */
const buildErrorMessage = (e: unknown): string => {
  if (typeof e === "object" && e !== null) {
    const a = e as { message?: unknown; cause?: { message?: unknown } }
    const cause = a.cause?.message
    if (typeof cause === "string" && cause.trim().length > 0) return cause
    if (typeof a.message === "string" && a.message.trim().length > 0) return a.message
  }
  return "could not open database"
}

const bootName = (conn: DatabaseConn): string => {
  const named = process.env.EFFERENT_DB_NAME?.trim()
  if (named !== undefined && named.length > 0) return named
  return conn.kind === "postgres" ? "remote" : LOCAL_DB_NAME
}

/**
 * Provides `ConversationStore` + `ContextTreeStore` as facades over a `Ref` to
 * the **current** store, plus the `StoreSwitch` control port. Every store method
 * reads the Ref per call (the `router.ts` pattern), so swapping the underlying
 * connection takes effect immediately with no restart. Replaces the static
 * `StoresLive` at the composition root; its platform deps (`DbR`) come from
 * `BunContext` exactly as `StoresLive`'s did.
 */
export const SwitchableStoresLive: Layer.Layer<
  ConversationStore | ContextTreeStore | StoreSwitch,
  StoreSwitchError,
  DbR
> = Layer.scopedContext(
  Effect.gen(function* () {
    // Capture the platform context once; re-provide it to every store we build.
    const platform = yield* Effect.context<DbR>()

    // Build a store for `conn` in its OWN closeable scope (kept open past this
    // effect — closed on the next swap / layer shutdown). Building runs the
    // migrator → only pending migrations apply.
    const buildHandle = (name: string, conn: DatabaseConn): Effect.Effect<Handle, StoreSwitchError> =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const ctx = yield* Layer.buildWithScope(scope)(storesLayerFor(conn)).pipe(
          Effect.provide(platform),
          Effect.onError(() => Scope.close(scope, Exit.void)),
          Effect.mapError((e) => new StoreSwitchError({ message: buildErrorMessage(e) })),
        )
        return { ctx, scope, name, kind: conn.kind }
      })

    const conn0 = bootConn()
    // Fall back to local SQLite if the configured boot connection can't open.
    const initial = yield* buildHandle(bootName(conn0), conn0).pipe(
      Effect.orElse(() => buildHandle(LOCAL_DB_NAME, localConn())),
    )
    const ref = yield* Ref.make<Handle>(initial)
    // Serialize switchTo calls so two concurrent swaps can't interleave
    // (build next → count → getAndSet → close prev must be atomic).
    const switchLock = yield* Effect.makeSemaphore(1)
    // Close whichever store is current when the app's scope closes.
    yield* Effect.addFinalizer(() =>
      Ref.get(ref).pipe(Effect.flatMap((h) => Scope.close(h.scope, Exit.void))),
    )

    const withConv = <A, E>(f: (s: ConvSvc) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.flatMap(Ref.get(ref), (h) => f(Context.get(h.ctx, ConversationStore)))
    const withTree = <A, E>(f: (s: TreeSvc) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.flatMap(Ref.get(ref), (h) => f(Context.get(h.ctx, ContextTreeStore)))

    const conv = ConversationStore.of({
      create: (cwd) => withConv((s) => s.create(cwd)),
      ensure: (id, cwd) => withConv((s) => s.ensure(id, cwd)),
      append: (id, msg) => withConv((s) => s.append(id, msg)),
      list: (id) => withConv((s) => s.list(id)),
      checkpoint: (id, summary) => withConv((s) => s.checkpoint(id, summary)),
      getLatestCheckpoint: (id) => withConv((s) => s.getLatestCheckpoint(id)),
      listCheckpoints: (id) => withConv((s) => s.listCheckpoints(id)),
      listActive: (id) => withConv((s) => s.listActive(id)),
      setTitle: (id, title) => withConv((s) => s.setTitle(id, title)),
      listByWorkspace: (dir) => withConv((s) => s.listByWorkspace(dir)),
      setModel: (id, model) => withConv((s) => s.setModel(id, model)),
      markPending: (id, prompt) => withConv((s) => s.markPending(id, prompt)),
      clearPending: (id) => withConv((s) => s.clearPending(id)),
      listPending: (dir) => withConv((s) => s.listPending(dir)),
    })

    const tree = ContextTreeStore.of({
      spawn: (input) => withTree((s) => s.spawn(input)),
      append: (id, msg) => withTree((s) => s.append(id, msg)),
      listMessages: (id) => withTree((s) => s.listMessages(id)),
      recordReturn: (id, r) => withTree((s) => s.recordReturn(id, r)),
      get: (id) => withTree((s) => s.get(id)),
      listTree: (root) => withTree((s) => s.listTree(root)),
      drop: (id) => withTree((s) => s.drop(id)),
    })

    const switchSvc = StoreSwitch.of({
      current: Ref.get(ref).pipe(Effect.map((h) => ({ name: h.name, kind: h.kind }))),
      switchTo: (name, conn, cwd) =>
        switchLock.withPermits(1)(
          Effect.gen(function* () {
            const next = yield* buildHandle(name, conn)
            const count = yield* Context.get(next.ctx, ConversationStore)
              .listByWorkspace(cwd)
              .pipe(
                Effect.map((l) => l.length),
                Effect.catchAll(() => Effect.succeed(0)),
              )
            const prev = yield* Ref.getAndSet(ref, next)
            yield* Scope.close(prev.scope, Exit.void)
            return { conversationCount: count }
          }),
        ),
      listSessions: (conn, cwd) =>
        Layer.build(storesLayerFor(conn)).pipe(
          Effect.provide(platform),
          Effect.mapError((e) => new StoreSwitchError({ message: buildErrorMessage(e) })),
          Effect.flatMap((ctx) =>
            Context.get(ctx, ConversationStore)
              .listByWorkspace(cwd)
              .pipe(Effect.catchAll(() => Effect.succeed<ReadonlyArray<ConvSummary>>([]))),
          ),
          Effect.scoped,
        ),
    })

    return Context.empty().pipe(
      Context.add(ConversationStore, conv),
      Context.add(ContextTreeStore, tree),
      Context.add(StoreSwitch, switchSvc),
    )
  }),
)
