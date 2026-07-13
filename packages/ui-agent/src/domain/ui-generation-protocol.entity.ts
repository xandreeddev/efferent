import { Schema } from "effect"
import { ThemeDelta } from "./design-system.entity.js"
import { UiComponentDefinition } from "./ui-component.entity.js"
import { PageManifest, UiBlock } from "./ui-page.entity.js"

export const UiGenerationProtocol = Schema.Literal("native-tools", "a2ui-jsonl", "compact-lines")
export type UiGenerationProtocol = typeof UiGenerationProtocol.Type

export const UiProtocolRecord = Schema.Union(
  Schema.Struct({ op: Schema.Literal("start"), input: Schema.Struct({ page: PageManifest, criticalBlocks: Schema.Array(UiBlock) }) }),
  Schema.Struct({ op: Schema.Literal("patch"), input: Schema.Struct({ pageId: Schema.String, blocks: Schema.Array(UiBlock), complete: Schema.optional(Schema.Boolean) }) }),
  Schema.Struct({ op: Schema.Literal("prop"), input: Schema.Struct({ pageId: Schema.String, nodeId: Schema.String, key: Schema.String, value: Schema.Unknown }) }),
  Schema.Struct({ op: Schema.Literal("component"), input: Schema.Struct({ definition: UiComponentDefinition }) }),
  Schema.Struct({ op: Schema.Literal("theme"), input: Schema.Struct({ pageId: Schema.String, delta: ThemeDelta }) }),
)
export type UiProtocolRecord = typeof UiProtocolRecord.Type

export const UiProtocolEnvelope = Schema.Struct({ ui: UiProtocolRecord })
export type UiProtocolEnvelope = typeof UiProtocolEnvelope.Type

export interface UiProtocolDecoderState {
  readonly buffer: string
  readonly seen: ReadonlySet<string>
  readonly sawDelta: boolean
}

export interface UiProtocolDecodeResult {
  readonly state: UiProtocolDecoderState
  readonly records: ReadonlyArray<UiProtocolRecord>
  readonly findings: ReadonlyArray<string>
}
