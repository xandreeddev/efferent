import { FetchHttpClient, HttpClient } from "@effect/platform"
import { Context, Effect, Layer, Stream } from "effect"
import { Workspace, type WorkspaceError } from "@xandreed/sdk-core"
import { makeHttpTransport } from "../transport/http/client.js"

/**
 * The **remote Workspace adapter** — implements the `Workspace` port by calling
 * a transport client (HTTP today). It is transport-generic in spirit: it wraps
 * an `HttpTransport`, capturing the `HttpClient` once and re-providing it per
 * call so the port methods are `R = never`. A TUI/web client injects this Layer
 * to attach to the daemon; injecting the in-process adapter instead runs
 * daemonless — the frontend code is identical against either.
 *
 * The frontend never imports this file's HTTP dependency directly; it depends
 * only on the `Workspace` port and picks the impl at the composition root.
 */
export const makeRemoteWorkspace = (
  baseUrl: string,
): Effect.Effect<
  Context.Tag.Service<typeof Workspace>,
  never,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const t = makeHttpTransport(baseUrl)
    const withClient = <A>(
      e: Effect.Effect<A, WorkspaceError, HttpClient.HttpClient>,
    ): Effect.Effect<A, WorkspaceError> =>
      e.pipe(Effect.provideService(HttpClient.HttpClient, client))

    return Workspace.of({
      snapshot: () => withClient(t.snapshot()),
      listSessions: () => withClient(t.listSessions()),
      getState: (id, since) => withClient(t.getState(id, since)),
      metrics: () => withClient(t.metrics()),
      send: (id, prompt) => withClient(t.send(id, prompt)),
      interrupt: (id) => withClient(t.interrupt(id)),
      stop: (id) => withClient(t.stop(id)),
      spawn: (req) => withClient(t.spawn(req)),
      createFleet: (req) => withClient(t.createFleet(req)),
      setFleetModel: (id, model) => withClient(t.setFleetModel(id, model)),
      approve: (id, decision) => withClient(t.approve(id, decision)),
      subscribe: (id, since) =>
        t.subscribe(id, since).pipe(Stream.provideService(HttpClient.HttpClient, client)),
      getDirective: () => withClient(t.getDirective()),
      setDirective: (d) => withClient(t.setDirective(d)),
      importAgents: (spec) => withClient(t.importAgents(spec)),
      importTools: (spec) => withClient(t.importTools(spec)),
    })
  })

/**
 * The remote Workspace as a self-contained Layer for production: builds a
 * `FetchHttpClient` and points it at `baseUrl` (`http://127.0.0.1:<port>`).
 */
export const RemoteWorkspaceLive = (
  baseUrl: string,
): Layer.Layer<Workspace, never, never> =>
  Layer.effect(Workspace, makeRemoteWorkspace(baseUrl)).pipe(
    Layer.provide(FetchHttpClient.layer),
  )
