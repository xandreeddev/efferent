import { Either, Schema } from "effect"
import { UiProtocolEnvelope, UiProtocolRecord } from "./ui-generation-protocol.entity.js"
import type { UiGenerationProtocol, UiProtocolDecodeResult, UiProtocolDecoderState } from "./ui-generation-protocol.entity.js"

const decodeRecord = Schema.decodeUnknownEither(UiProtocolRecord)
const decodeEnvelope = Schema.decodeUnknownEither(UiProtocolEnvelope)

export const emptyUiProtocolDecoderState = (): UiProtocolDecoderState => ({ buffer: "", seen: new Set(), sawDelta: false })

/** Protocol records are an internal model-to-harness channel. Hosts use this
 * predicate to keep a settled record from appearing as assistant copy. */
export const isUiProtocolPayload = (text: string): boolean => {
  const first = text.trim().split("\n").find((line) => line.trim().length > 0 && !line.trim().startsWith("```"))?.trim() ?? ""
  return first.startsWith("@ui ") || /^\{\s*"ui"\s*:/.test(first)
}

const json = (source: string): Either.Either<unknown, string> => Either.try({ try: () => JSON.parse(source) as unknown, catch: () => "record is not valid JSON" })

const parseCompact = (line: string): Either.Either<typeof UiProtocolRecord.Type, string> => {
  const match = /^@ui\s+(start|patch|prop|component|theme)\s+(.+)$/.exec(line)
  if (match === null) return Either.left("line does not use @ui <operation> <json>")
  return Either.flatMap(json(match[2] ?? ""), (input) => Either.mapLeft(decodeRecord({ op: match[1], input }), (issue) => String(issue)))
}

const parseJsonl = (line: string): Either.Either<typeof UiProtocolRecord.Type, string> => Either.flatMap(
  json(line),
  (decoded) => Either.map(Either.mapLeft(decodeEnvelope(decoded), (issue) => String(issue)), (envelope) => envelope.ui),
)

const parseLine = (protocol: UiGenerationProtocol, line: string): Either.Either<typeof UiProtocolRecord.Type, string> => protocol === "compact-lines" ? parseCompact(line) : parseJsonl(line)

export const decodeUiProtocolChunk = (
  protocol: UiGenerationProtocol,
  state: UiProtocolDecoderState,
  chunk: string,
  isDelta = true,
): UiProtocolDecodeResult => {
  if (protocol === "native-tools") return { state: { ...state, sawDelta: state.sawDelta || isDelta }, records: [], findings: [] }
  const joined = state.buffer + chunk
  const lines = joined.split("\n")
  const complete = lines.slice(0, -1).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("```") && (protocol === "compact-lines" ? line.startsWith("@ui ") : line.startsWith("{")))
  const parsed = complete.map((line) => ({ line, result: parseLine(protocol, line) }))
  const accepted = parsed.flatMap(({ line, result }) => Either.match(result, {
    onLeft: () => [],
    onRight: (record) => state.seen.has(line) ? [] : [{ line, record }],
  }))
  const seen = new Set([...state.seen, ...accepted.map(({ line }) => line)])
  return {
    state: { buffer: lines.at(-1) ?? "", seen, sawDelta: state.sawDelta || isDelta },
    records: accepted.map(({ record }) => record),
    findings: parsed.flatMap(({ result }) => Either.match(result, { onLeft: (finding) => [finding], onRight: () => [] })),
  }
}

export const uiProtocolInstruction = (protocol: UiGenerationProtocol): string => {
  if (protocol === "native-tools") return "Call the typed tools directly."
  if (protocol === "compact-lines") return "Emit newline-delimited records exactly as @ui <start|patch|prop|component|theme> <JSON input>. Do not use Markdown fences or call tools."
  return "Emit one JSON object per line exactly as {\"ui\":{\"op\":\"start|patch|prop|component|theme\",\"input\":{...}}}. Do not use Markdown fences or call tools."
}
