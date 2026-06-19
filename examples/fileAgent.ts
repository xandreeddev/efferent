/**
 * An agent whose tool handler uses a *port* — `FileSystem` from `@xandreed/sdk-core`.
 *
 * This is the point of the handler layer: it's the seam where runtime dependencies
 * enter. The `read_file` handler resolves `FileSystem` from context, so the handler
 * layer now *requires* `FileSystem` — which the composition root satisfies with
 * `LocalFileSystemLive`. Swap that one layer (a stub, an in-memory FS) and the same
 * tool runs in a test with no disk.
 *
 * Run it (needs a credential in ~/.efferent/auth.json — add one with `:login`):
 *
 *   bun examples/fileAgent.ts
 */
import { Tool, Toolkit } from "@effect/ai"
import { FetchHttpClient } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
import {
  ConversationId,
  FileSystem,
  runAgent,
  type AgentConfig,
  type AgentHooks,
} from "@xandreed/sdk-core"
import {
  LocalAuthStoreLive,
  LocalFileSystemLive,
  LocalSettingsStoreLive,
  ModelLive,
  ModelRegistryLive,
  StoresLive,
  UtilityLlmLive,
} from "@xandreed/sdk-adapters"

const Failure = Schema.Struct({ error: Schema.String, message: Schema.String })

const ReadFile = Tool.make("read_file", {
  description: "Read a UTF-8 text file from the workspace and return its contents.",
  parameters: {
    path: Schema.String.annotations({ description: "Path to the file." }),
  },
  success: Schema.Struct({
    content: Schema.String,
    truncated: Schema.Boolean,
    totalLines: Schema.Number,
  }),
  failure: Failure,
  failureMode: "return",
})

const toolkit = Toolkit.make(ReadFile)

// ── Resolve the FileSystem PORT once, at layer-BUILD time (tool handlers must be
//    R = never, so they can't carry a requirement themselves). The handler closes
//    over `fs`; the LAYER then requires FileSystem, satisfied at the root. This is
//    exactly how the real coding toolkit injects FileSystem/Shell.
//    Tagged read errors are mapped into the tool's `failure` shape so a missing
//    file comes back to the model as data (failureMode: "return"), not a dead turn.
const handlerLayer = toolkit.toLayer(
  Effect.gen(function* () {
    const fs = yield* FileSystem
    return toolkit.of({
      read_file: ({ path }) =>
        fs.read(path).pipe(
          Effect.catchAll((e) =>
            Effect.fail({
              error: e._tag,
              message: e._tag === "FileSystemError" ? e.message : e.path,
            }),
          ),
        ),
    })
  }),
)

const config: AgentConfig<typeof toolkit extends Toolkit.Toolkit<infer T> ? T : never> = {
  key: "file-agent",
  prompt: {
    name: "file-reader",
    version: "1.0.0",
    text: "You read files for the user. Use read_file to fetch contents before answering questions about a file.",
  },
  toolkit,
}

// Typed (empty) hooks pin runAgent's requirements to `never` (see calcAgent.ts).
const hooks: AgentHooks = {}

const program = Effect.gen(function* () {
  const cid = yield* Schema.decodeUnknown(ConversationId)(crypto.randomUUID())
  const result = yield* runAgent(
    config,
    cid,
    "Read package.json and tell me the value of the \"name\" field.",
    hooks,
  ).pipe(Effect.provide(handlerLayer))
  yield* Effect.logInfo(result.finalText)
})

// ── Note `LocalFileSystemLive` at the TOP level: it provides the FileSystem port
//    the handler layer needs. (In diceAgent.ts it's only nested under settings.)
const AppLive = Layer.mergeAll(
  StoresLive,
  ModelLive,
  LocalFileSystemLive, // exposes FileSystem to the tool handler
  UtilityLlmLive.pipe(
    Layer.provide(ModelRegistryLive),
    Layer.provide(FetchHttpClient.layer),
  ),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      LocalAuthStoreLive,
      LocalSettingsStoreLive.pipe(Layer.provide(LocalFileSystemLive)),
    ),
  ),
  Layer.provideMerge(BunContext.layer),
)

BunRuntime.runMain(program.pipe(Effect.provide(AppLive)))
