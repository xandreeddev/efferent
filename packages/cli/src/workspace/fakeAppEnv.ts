import { Effect, Layer, Ref } from "effect"
import { HttpServer } from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { LanguageModel } from "@effect/ai"
import {
  type AgentContextNode,
  type AgentMessage,
  type ContextNodeId,
  type Scope,
  ApprovalAllowAllLive,
  AuthStore,
  ContextTreeStore,
  ConversationStore,
  DefaultSettings,
  FileSystem,
  Http,
  SettingsStore,
  Shell,
  UtilityLlm,
  WebSearch,
  Workspace,
} from "@xandreed/sdk-core"
import { makeInProcessWorkspace } from "./inProcess.js"
import { makeFleetSupervisor } from "../cli/state/fleet.js"
import { workspaceRouter } from "../transport/http/server.js"

/**
 * Shared test fakes for the Workspace/daemon stack — stub ports + a scripted
 * `LanguageModel`, the in-process Workspace over them, and a real loopback HTTP
 * server (`BunHttpServer.layerTest`) exposing it. Imported ONLY by `*.test.ts`
 * (never by production code, so the bundle never sees it). Keeps the daemon
 * tests from each re-declaring the same five-stub harness.
 */

export const FAKE_ROOT_CID = "33333333-3333-3333-3333-333333333333"

export const fakeRootScope: Scope = {
  name: "root",
  description: "ws",
  rootDir: "/tmp/ws",
  displayRoot: "/tmp/ws",
  systemPrompt: "you are a coder",
  isRoot: true,
  enforceWrite: false,
  children: [],
}

/** A model that answers with `text` and stops on turn 0. */
export const fakeModel = (text = "done") =>
  Layer.succeed(
    LanguageModel.LanguageModel,
    LanguageModel.LanguageModel.of({
      generateText: () =>
        Effect.succeed({ content: [], text, finishReason: "stop", usage: undefined }),
      generateObject: () => Effect.die("unused"),
      streamText: () => Effect.die("unused"),
    } as never),
  )

const stubTree = Layer.succeed(
  ContextTreeStore,
  ContextTreeStore.of({
    spawn: () => Effect.succeed(crypto.randomUUID() as ContextNodeId),
    append: () => Effect.void,
    listMessages: () => Effect.succeed<ReadonlyArray<AgentMessage>>([]),
    recordReturn: () => Effect.void,
    get: () => Effect.die("unused"),
    listTree: () => Effect.succeed<ReadonlyArray<AgentContextNode>>([]),
    drop: () => Effect.void,
  }),
)

export const stubConv = (rootCid: string) =>
  Layer.effect(
    ConversationStore,
    Effect.gen(function* () {
      const msgs = yield* Ref.make<ReadonlyArray<AgentMessage>>([])
      return ConversationStore.of({
        create: () => Effect.succeed(rootCid as never),
        ensure: () => Effect.void,
        append: (_id, m) => Ref.updateAndGet(msgs, (a) => [...a, m]).pipe(Effect.map((a) => a.length - 1)),
        list: () => Ref.get(msgs),
        listActive: () => Ref.get(msgs),
        getLatestCheckpoint: () => Effect.succeed(undefined),
        listCheckpoints: () => Effect.succeed([]),
        checkpoint: () => Effect.void,
        setTitle: () => Effect.void,
        setModel: () => Effect.void,
        listByWorkspace: () => Effect.succeed([]),
        markPending: () => Effect.void,
        clearPending: () => Effect.void,
        listPending: () => Effect.succeed([]),
      })
    }),
  )

/** Stub ports MINUS the ConversationStore — so a test can supply its own conv
 *  (e.g. one with a pending in-flight marker for the resume path). */
export const fakeEnvLayersNoConv = (modelText?: string) =>
  Layer.mergeAll(
    Layer.succeed(
      FileSystem,
      FileSystem.of({
        read: () => Effect.fail({ _tag: "FileNotFound" }),
        write: () => Effect.void,
        list: () => Effect.succeed([]),
        glob: () => Effect.succeed([]),
      } as never),
    ),
    Layer.succeed(
      Shell,
      Shell.of({ exec: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }) } as never),
    ),
    Layer.succeed(Http, Http.of({ get: () => Effect.die("unused") } as never)),
    Layer.succeed(WebSearch, WebSearch.of({ search: () => Effect.die("unused") } as never)),
    Layer.succeed(UtilityLlm, UtilityLlm.of({ complete: () => Effect.die("unused") } as never)),
    // Stateful so updateSettings round-trips (the config-through-API path).
    Layer.effect(
      SettingsStore,
      Effect.gen(function* () {
        const ref = yield* Ref.make(DefaultSettings)
        return SettingsStore.of({
          get: () => Ref.get(ref),
          global: () => Ref.get(ref),
          update: (f) => Ref.updateAndGet(ref, f),
          load: () => Ref.get(ref),
        })
      }),
    ),
    fakeAuthStore,
    fakeModel(modelText),
    stubTree,
  )

/** A no-op AuthStore (the daemon router's /auth/reload needs it; tests never log in). */
export const fakeAuthStore = Layer.succeed(
  AuthStore,
  AuthStore.of({
    init: () => Effect.void,
    all: Effect.succeed({}),
    get: () => Effect.succeed(undefined),
    resolveKey: () => Effect.succeed(undefined),
    setApiKey: () => Effect.void,
    setOAuth: () => Effect.void,
    setLocal: () => Effect.void,
    remove: () => Effect.void,
  } as never),
)

/** The merged stub ports (FS/Shell/Http/WebSearch/UtilityLlm/Settings/model/tree/conv). */
export const fakeEnvLayers = (rootCid: string, modelText?: string) =>
  Layer.merge(fakeEnvLayersNoConv(modelText), stubConv(rootCid))

/** The in-process Workspace over the fake env. */
export const fakeWorkspaceLayer = (rootCid: string, modelText?: string) =>
  Layer.effect(
    Workspace,
    makeInProcessWorkspace({
      roots: [{ cid: rootCid as never }],
      rootScope: fakeRootScope,
      cwd: "/tmp/ws",
      skills: [],
      memory: [],
      agents: [],
      tools: [],
      instructionFiles: [],
      approvalLayer: ApprovalAllowAllLive,
      fleet: makeFleetSupervisor(),
    }),
  ).pipe(Layer.provide(fakeEnvLayers(rootCid, modelText)))

/** A real loopback HTTP server exposing the fake Workspace, plus a pre-pointed
 *  HttpClient (from `BunHttpServer.layerTest`) for hitting it. */
export const fakeServerLive = (rootCid: string, modelText?: string) =>
  HttpServer.serve()(
    workspaceRouter({ pid: 1234, workspace: "/tmp/ws", version: "test" }),
  ).pipe(
    Layer.provide(fakeWorkspaceLayer(rootCid, modelText)),
    Layer.provide(fakeAuthStore),
    Layer.provideMerge(BunHttpServer.layerTest),
  )
