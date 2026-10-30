import { Option, Schema } from "effect"
import { canonicalJson, fingerprintOf } from "@xandreed/core"
import { OperationId } from "./render-output.entity.js"
import type { NodeId, RenderMessageId, UiOutputError, UiOutputProposal, UiOutputScope } from "./render-output.entity.js"
import { RenderError, SurfaceCommitted, SurfaceCompleted, SurfaceFrozen, SurfacePlanned, VersionId } from "./render-surface.entity.js"
import type { RenderNode, RenderSnapshot, SurfaceId, SurfaceRecord, SurfaceScope, SurfaceState } from "./render-surface.entity.js"

/** A surface's durable progress for the current message, rebuilt from its records. */
export type SurfaceProgress = {
  readonly state: Omit<SurfaceState, "pending">
  readonly signature: Option.Option<string>
  /** Node ids committed into the current version (fills included). */
  readonly committed: ReadonlyArray<NodeId>
  readonly frozenRecorded: boolean
}

/** Identical content has an identical signature, whatever the phase or key order. */
export const signatureOf = (snapshot: RenderSnapshot): string =>
  fingerprintOf(canonicalJson({ spec: snapshot.spec, nodes: snapshot.nodes, placeholders: snapshot.placeholders }))

/** A joined id takes its brand unchecked: its parts are the scope's ids, and the write that stores it checks it. */
const unchecked = { disableChecks: true } as const

export const versionIdOf = (messageId: string, generation: number): VersionId => VersionId.make(`${messageId}:v${generation}`, unchecked)

/** A `:` or `%` inside an id part is percent-encoded, so different parts never join into the same id. */
const idPart = (value: string): string => value.replaceAll("%", "%25").replaceAll(":", "%3A")

/** Stable per surface, generation and node: a retried publish reuses the id; another surface or generation never collides. */
export const operationIdOf = (runId: string, surfaceId: string, generation: number, nodeId: string): OperationId =>
  OperationId.make(`${idPart(runId)}:render:${idPart(surfaceId)}:${generation}:${idPart(nodeId)}`, unchecked)

/** A placeholder's fill, per surface and generation: filling it again in a later version is a new operation. */
export const fillOperationIdOf = (runId: string, surfaceId: string, generation: number, placeholder: string): OperationId =>
  OperationId.make(`${idPart(runId)}:render:${idPart(surfaceId)}:${generation}:fill:${idPart(placeholder)}`, unchecked)

/** The snapshot's nodes the current version has not committed: what a retry of identical content still owes. */
export const missingNodesOf = (progress: SurfaceProgress, snapshot: RenderSnapshot): ReadonlyArray<RenderNode> =>
  snapshot.nodes.filter((node) => !progress.committed.includes(node.nodeId))

export const outputScopeOf = (scope: SurfaceScope): UiOutputScope => ({
  threadId: scope.threadId, runId: scope.runId, messageId: scope.messageId, principalId: scope.principalId, fence: scope.fence,
})

export const proposalOf = (operationId: OperationId, node: RenderNode): UiOutputProposal => ({
  operationId, nodeId: node.nodeId, release: node.release, props: node.props, evidence: node.evidence,
})

export const fromOutputError = (error: UiOutputError): RenderError => new RenderError({ code: error.code, message: error.message })

/** Whether a store refused a write because the surface is frozen for the message (`RenderStore.plan`'s guard). */
export const isFrozenRefusal = (error: RenderError): boolean => error.code === "frozen"

/**
 * Whether a store refused a write as a conflict: from `plan`, another writer
 * planned the generation first (`RenderStore.plan`'s generation rule); from
 * `commit`, the operation id was used with other content.
 */
export const isConflictRefusal = (error: RenderError): boolean => error.code === "conflict"

const isPlanned = Schema.is(SurfacePlanned)
const isCommitted = Schema.is(SurfaceCommitted)
const isCompleted = Schema.is(SurfaceCompleted)
const isFrozen = Schema.is(SurfaceFrozen)

const latestPlanned = (records: ReadonlyArray<SurfaceRecord>): Option.Option<SurfacePlanned> =>
  records.reduce<Option.Option<SurfacePlanned>>((best, record) => isPlanned(record) && Option.match(best, {
    onNone: () => true,
    onSome: (current) => record.generation > current.generation,
  }) ? Option.some(record) : best, Option.none())

/** Fold the records of one surface into the current message's progress. */
export const progressOf = (surfaceId: SurfaceId, messageId: RenderMessageId, records: ReadonlyArray<SurfaceRecord>): SurfaceProgress => {
  const mine = records.filter((record) => record.surfaceId === surfaceId && record.messageId === messageId)
  const latest = latestPlanned(mine)
  const version = Option.map(latest, (planned) => planned.versionId)
  const ofVersion = (versionId: VersionId) => mine.filter((record) => !isFrozen(record) && record.versionId === versionId)
  const current = Option.match(version, { onNone: () => [], onSome: ofVersion })
  return {
    state: {
      surfaceId,
      version,
      generation: Option.match(latest, { onNone: () => 0, onSome: (planned) => planned.generation }),
      frozen: mine.some(isFrozen),
      completed: current.some((record) => isCompleted(record) && !record.frozen),
      components: [...new Set(current.flatMap((record) => isCommitted(record) ? [record.component] : []))],
      placeholders: Option.match(latest, { onNone: () => [], onSome: (planned) => planned.placeholders }),
    },
    signature: Option.map(latest, (planned) => planned.signature),
    committed: current.flatMap((record) => isCommitted(record) ? [record.nodeId] : []),
    frozenRecorded: mine.some((record) => isCompleted(record) && record.frozen),
  }
}

export const describeError = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : String(error)
