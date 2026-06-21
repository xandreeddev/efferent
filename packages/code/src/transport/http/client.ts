import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Effect, Option, Schema, Stream } from "effect"
import {
  type CreateFleetRequest,
  ImportResult,
  SessionId,
  SessionState,
  SessionSummary,
  SpawnRequest,
  WorkspaceError,
  WorkspaceSnapshot,
  type ApprovalDecision,
  type Directive,
  type SeqEvent,
} from "@xandreed/sdk-core"
import { Directive as DirectiveSchema } from "@xandreed/sdk-core"
import { frameToSeqEvent, makeSseParser } from "./sse.js"

/**
 * HTTP client — the **swappable transport adapter** (client half). It turns the
 * daemon's HTTP + SSE endpoints back into the `Workspace`-shaped calls the
 * remote adapter (`workspace/remote.ts`, phase c) consumes. Every method
 * requires `HttpClient` (a `FetchHttpClient` in production; the test server's
 * pre-pointed client in tests) and maps wire failures into `WorkspaceError`, so
 * the remote adapter is a thin pass-through. The ONLY HTTP client code.
 */

const DirectiveBody = Schema.Struct({ directive: Schema.NullOr(DirectiveSchema) })

const toWs = (e: unknown): WorkspaceError =>
  new WorkspaceError({
    message:
      typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
        ? e.message
        : String(e),
  })

export interface HttpTransport {
  readonly snapshot: () => Effect.Effect<WorkspaceSnapshot, WorkspaceError, HttpClient.HttpClient>
  readonly listSessions: () => Effect.Effect<
    ReadonlyArray<SessionSummary>,
    WorkspaceError,
    HttpClient.HttpClient
  >
  readonly getState: (
    id: SessionId,
    since?: number,
  ) => Effect.Effect<SessionState, WorkspaceError, HttpClient.HttpClient>
  readonly send: (
    id: SessionId,
    prompt: string,
  ) => Effect.Effect<void, WorkspaceError, HttpClient.HttpClient>
  readonly interrupt: (id: SessionId) => Effect.Effect<void, WorkspaceError, HttpClient.HttpClient>
  readonly stop: (id: SessionId) => Effect.Effect<void, WorkspaceError, HttpClient.HttpClient>
  readonly spawn: (
    req: SpawnRequest,
  ) => Effect.Effect<SessionId, WorkspaceError, HttpClient.HttpClient>
  readonly createFleet: (
    req: CreateFleetRequest,
  ) => Effect.Effect<SessionId, WorkspaceError, HttpClient.HttpClient>
  readonly setFleetModel: (
    id: SessionId,
    model: string,
  ) => Effect.Effect<void, WorkspaceError, HttpClient.HttpClient>
  readonly approve: (
    id: SessionId,
    decision: ApprovalDecision,
  ) => Effect.Effect<void, WorkspaceError, HttpClient.HttpClient>
  readonly subscribe: (
    id: SessionId,
    since?: number,
  ) => Stream.Stream<SeqEvent, WorkspaceError, HttpClient.HttpClient>
  readonly getDirective: () => Effect.Effect<
    Directive | undefined,
    WorkspaceError,
    HttpClient.HttpClient
  >
  readonly setDirective: (
    d: Directive | undefined,
  ) => Effect.Effect<void, WorkspaceError, HttpClient.HttpClient>
  readonly importAgents: (
    spec: string,
  ) => Effect.Effect<ImportResult, WorkspaceError, HttpClient.HttpClient>
  readonly importTools: (
    spec: string,
  ) => Effect.Effect<ImportResult, WorkspaceError, HttpClient.HttpClient>
  /** Tell the daemon to reload its AuthStore (after a client-side login). */
  readonly reloadAuth: () => Effect.Effect<void, WorkspaceError, HttpClient.HttpClient>
  /** Ask the daemon to shut down gracefully. */
  readonly shutdown: () => Effect.Effect<void, WorkspaceError, HttpClient.HttpClient>
}

/** Build a transport client for a base URL (`""` with a pre-pointed test client,
 *  else `http://127.0.0.1:<port>`). */
export const makeHttpTransport = (baseUrl: string): HttpTransport => {
  const url = (path: string): string => `${baseUrl}${path}`

  const getJson = <A, I>(path: string, schema: Schema.Schema<A, I>) =>
    HttpClient.get(url(path)).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.mapError(toWs),
    )

  const postVoid = (path: string, body?: unknown) =>
    (body === undefined
      ? Effect.succeed(HttpClientRequest.post(url(path)))
      : HttpClientRequest.post(url(path)).pipe(HttpClientRequest.bodyJson(body))
    ).pipe(
      Effect.flatMap(HttpClient.execute),
      Effect.asVoid,
      Effect.mapError(toWs),
    )

  const postJson = <A, I>(path: string, body: unknown, schema: Schema.Schema<A, I>) =>
    HttpClientRequest.post(url(path)).pipe(
      HttpClientRequest.bodyJson(body),
      Effect.flatMap(HttpClient.execute),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.mapError(toWs),
    )

  return {
    snapshot: () => getJson("/snapshot", WorkspaceSnapshot),
    listSessions: () => getJson("/sessions", Schema.Array(SessionSummary)),
    getState: (id, since) =>
      getJson(
        `/sessions/${id}/state${since !== undefined ? `?since=${since}` : ""}`,
        SessionState,
      ),
    send: (id, prompt) => postVoid(`/sessions/${id}/send`, { prompt }),
    interrupt: (id) => postVoid(`/sessions/${id}/interrupt`),
    stop: (id) => postVoid(`/sessions/${id}/stop`),
    spawn: (req) => postJson("/sessions", req, SessionId),
    createFleet: (req) => postJson("/fleets", req, SessionId),
    setFleetModel: (id, model) => postVoid(`/sessions/${id}/model`, { model }),
    approve: (id, decision) => postVoid(`/sessions/${id}/approve`, decision),
    subscribe: (id, since) => {
      const parser = makeSseParser()
      const decoder = new TextDecoder()
      return HttpClientResponse.stream(
        HttpClient.get(
          url(`/sessions/${id}/events${since !== undefined ? `?since=${since}` : ""}`),
        ),
      ).pipe(
        Stream.mapConcat((bytes) => parser.push(decoder.decode(bytes, { stream: true }))),
        Stream.filterMap((frame) => Option.fromNullable(frameToSeqEvent(frame))),
        Stream.mapError(toWs),
      )
    },
    getDirective: () =>
      getJson("/directive", DirectiveBody).pipe(
        Effect.map((b) => b.directive ?? undefined),
      ),
    setDirective: (d) => postVoid("/directive", { directive: d ?? null }),
    importAgents: (spec) => postJson("/agents/import", { spec }, ImportResult),
    importTools: (spec) => postJson("/tools/import", { spec }, ImportResult),
    reloadAuth: () => postVoid("/auth/reload"),
    shutdown: () => postVoid("/shutdown"),
  }
}
