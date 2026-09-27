import { Option, Schema } from "effect"
import { canonicalJson, fingerprintOf } from "@xandreed/core"
import type { UiOutputError, UiOutputProposal, UiOutputScope } from "./render-output.entity.js"
import { RenderError, SurfaceCommitted, SurfaceCompleted, SurfaceFrozen, SurfacePlanned } from "./render-surface.entity.js"
import type { RenderNode, RenderSnapshot, SurfaceRecord, SurfaceScope, SurfaceState } from "./render-surface.entity.js"

/** A surface's durable progress for the current message, rebuilt from its records. */
export type SurfaceProgress = {
  readonly state: Omit<SurfaceState, "pending">
  readonly signature: Option.Option<string>
  readonly frozenRecorded: boolean
}

/** Identical content has an identical signature, whatever the phase or key order. */
export const signatureOf = (snapshot: RenderSnapshot): string =>
  fingerprintOf(canonicalJson({ spec: snapshot.spec, nodes: snapshot.nodes, placeholders: snapshot.placeholders }))

export const versionIdOf = (messageId: string, generation: number): string => `${messageId}:v${generation}`

/** Stable per generation and node: a retried publish reuses the id, a new generation never collides. */
export const operationIdOf = (runId: string, generation: number, nodeId: string): string => `${runId}:render:${generation}:${nodeId}`

export const fillOperationIdOf = (runId: string, placeholder: string): string => `${runId}:render:fill:${placeholder}`

export const outputScopeOf = (scope: SurfaceScope): UiOutputScope => ({
  threadId: scope.threadId, runId: scope.runId, messageId: scope.messageId, principalId: scope.principalId, fence: scope.fence,
})

export const proposalOf = (operationId: string, node: RenderNode): UiOutputProposal => ({
  operationId, nodeId: node.nodeId, release: node.release, props: node.props, evidence: node.evidence,
})

export const fromOutputError = (error: UiOutputError): RenderError => new RenderError({ code: error.code, message: error.message })

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
export const progressOf = (surfaceId: string, messageId: string, records: ReadonlyArray<SurfaceRecord>): SurfaceProgress => {
  const mine = records.filter((record) => record.surfaceId === surfaceId && record.messageId === messageId)
  const latest = latestPlanned(mine)
  const version = Option.map(latest, (planned) => planned.versionId)
  const ofVersion = (versionId: string) => mine.filter((record) => record.versionId === versionId)
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
    frozenRecorded: mine.some((record) => isCompleted(record) && record.frozen),
  }
}

export const describeError = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : String(error)
