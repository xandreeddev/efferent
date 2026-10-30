# @xandreed/plugin-render

Agent output a host renders: versioned render surfaces over the host's `RenderStore` and admission, a journal feed of client frames with SSE and WebSocket transports, and the `render_component` tool through which a model publishes one exact, admitted component. Node 24 and Bun; layer `plugin-render` in `foundry.config.ts` (imports core; `node:http` only as the type `sseNodePeer` takes).

## Rules

- Admit before any write: the size check and `UiOutputAdmission.validate` run before the store or journal sees a component, and a refused one is never replaced.
- Keep a store's guarantees in the store (`RenderStore` contract, `src/ports/render.port.ts:20-42`), each in its write's own transaction: a write under a fence lower than the highest the surface and message accepted is `forbidden`, `plan` refuses a frozen surface and a generation that is not the highest planned plus one (`conflict`), `commit` is idempotent by `operationId`, and records never mix across threads or principals.
- A publish whose plan another writer beat (`conflict`) re-hydrates and decides once more, never twice: the same content resumes that version, other content plans the next.
- Derive operation ids with `operationIdOf` / `fillOperationIdOf` (stable per run, surface, generation and node, parts percent-encoded) and versions with `versionIdOf`; never join raw ids. Every id is a brand (`ThreadId`, `PrincipalId`, `RenderMessageId`, `SurfaceId`, `VersionId`, `NodeId`, `OperationId`, `RevisionId`; the scope's `runId` is core's `RunId`): mint one with `.make` where the host creates it.
- Identical content (same `signatureOf`) opens no generation: it commits only the nodes still missing, then completes.
- Releases are exact (`UiRelease`, both hashes) and never resolved through a latest alias; the host supplies the scope (`UiOutputContext`), the model only props and evidence ids.
- A failing feed ends the connection like a finished one and is logged, never sent to the client.
- Keep SSE and WebSocket frames identical; a wire change reruns `bun run docs:generate`, which writes the frames into `docs/event-reference.md`.
- A behaviour change starts as a check in `src/render-surface.conformance.ts` or `src/render-transport.conformance.ts`, which the shipped adapters then pass.

## Public surface

- Plugins and defaults: `renderSurfacePlugin`, `renderFeedPlugin`, `uiOutputPlugin`, `renderSurfaceDefaults`, `renderFeedDefaults`. `uiOutputPlugin` provides the toolkit in `UiOutputTools`; the host serves it with `UiOutputHandlersLive`.
- Ports: `Render`, `RenderStore`, `JournalTail`, `RenderFeed` (types `RenderSurface`, `RenderOpenOptions`, `FeedProjection`, `RenderTransport`, `SsePeer`, `SocketPeer`), `UiOutput`, `UiOutputAdmission`, `UiOutputJournal`, `UiOutputContext`, `UiOutputTools`. Adapters: `RenderLive` / `openSurface`, `MemoryRenderStoreLive` / `makeMemoryRenderStore`, `RenderFeedLive` / `makeRenderFeed`, `SessionsJournalTailLive`, `SseTransport`, `WebSocketTransport`, `sseNodePeer`, `sseHeaders`, `UiOutputLive`, `UiOutputHandlersLive`; the tool `RenderComponent` in `uiOutputToolkit` (an effect/ai `Toolkit`, not a core capability).
- Schemas: ids (`ThreadId`, `PrincipalId`, `RenderMessageId`, `NodeId`, `OperationId`, `RevisionId`, `SurfaceId`, `VersionId`), surfaces (`SurfaceScope`, `RenderNode`, `RenderSnapshot`, `FreezeReason`, `SurfacePlanned`, `SurfaceCommitted`, `SurfaceCompleted`, `SurfaceFrozen`, `SurfaceRecord`, `SurfaceState`, `PublishResult`, `RenderError`), the feed (`FeedScope`, `JournalRecord`, `FeedPayload`, `FeedRecord`, `FeedReady`, `FeedHeartbeat`, `FeedFrame`, `SseRecordFields`, `FeedOptions`, `SocketFrame`, `SocketResume`), output (`UiRelease`, `UiOutputProposal`, `UiOutputScope`, `UiOutputReceipt`, `UiOutputError`), and core's `ConformanceFailure`, re-exported.
- Functions: `signatureOf`, `versionIdOf`, `operationIdOf`, `fillOperationIdOf`, `missingNodesOf`, `outputScopeOf`, `proposalOf`, `fromOutputError`, `isFrozenRefusal`, `isConflictRefusal`, `progressOf`, `describeError`, `ssePreamble`, `encodeSse`, `decodeSse`, `encodeSocketFrame`, `decodeSocketFrame`, `socketResumeOf`, `nextPollMs`. Kits: `renderSurfaceConformance`, `renderFeedConformance`, `renderTransportConformance`, `makeMemoryJournal` (types `ConformanceCheck`, `SurfaceSubject`). The `./output` subpath (`src/output.ts`) exports the output half alone.

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `renderSurfacePlugin` | `@xandreed/plugin-render/surface` | runtime | `efferent/render/Render` | none | `efferent/render/Store`, `efferent/ui/OutputAdmission` |
| `renderFeedPlugin` | `@xandreed/plugin-render/feed` | runtime | `efferent/render/Feed` | none | `efferent/render/JournalTail` |
| `uiOutputPlugin` | `@xandreed/plugin-render/output` | session | `efferent/ui/Output`, `efferent/ui/OutputTools` | none | `efferent/ui/OutputAdmission`, `efferent/ui/OutputJournal`, `efferent/ui/OutputContext` |

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| `render_component` description | `src/render-output.tools.ts:6` | unpinned |
| Its parameters (`UiOutputProposal` fields, no descriptions) | `src/domain/render-output.entity.ts:43-49` | unpinned |
| Failures as `{ error: code, message }` (admission and journal messages are the host's) | `src/render-output.adapter.ts:29` | unpinned (`src/render-output.test.ts:29`, `:48` check only that `emit` fails) |
| `invalid` messages: invalid proposal, not serializable, over the size limit | `src/render-output.adapter.ts:14`, `:17`, `:19` | unpinned |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/domain/*.entity.ts`, `src/domain/*.entity.functions.ts` | schemas and pure functions: surfaces and their progress fold, feed frames and wire encoding, output, the kits' failure |
| `src/ports/render.port.ts`, `src/ports/render-output.port.ts` | the ports and their contracts |
| `src/render-surface.adapter.ts`, `src/render-store.memory.adapter.ts` | `openSurface` / `RenderLive`; the in-process store |
| `src/render-feed.adapter.ts`, `src/render-tail.sessions.adapter.ts`, `src/render-transport.adapter.ts` | the feed; a session as its journal; SSE, WebSocket, `sseNodePeer` |
| `src/render-output.adapter.ts`, `src/render-output.tools.ts` | `UiOutputLive`, the handlers, `uiOutputPlugin`; the `render_component` tool |
| `src/plugin.adapter.ts`, `src/*.conformance.ts` | the surface and feed plugins; the shipped kits |
| `src/index.ts`, `src/output.ts` | the public exports; the `./output` subpath |

## Tests

- Kits: `src/render-surface.test.ts:21` runs `renderSurfaceConformance` over `RenderLive` and `makeMemoryRenderStore`; `src/render-transport.test.ts:13` and `:19` run `renderTransportConformance` over both transports and `renderFeedConformance` over `makeRenderFeed`. `src/render-surface.conformance.test.ts` is the surface kit's self-test: a careless store with no generation check must fail exactly the generation checks. The feed and transport kits have no self-tests. `src/render-output.test.ts` covers admission before commit; `src/render-tail.sessions.test.ts` the session tail over a stub `Sessions`.
- `packages/sdk/src/events-guide.test.ts` serves a session's journal through `RenderFeedLive`, `SessionsJournalTailLive` and `SseTransport`; `scripts/verify-packages.ts:376` imports the packed package on Node. Run: `bun test packages/plugin-render packages/sdk/src/events-guide.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.
