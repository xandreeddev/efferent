import { describe, expect, test } from "bun:test"
import { landingReference } from "./reference-pages.functions.js"
import { decodeUiProtocolChunk, emptyUiProtocolDecoderState } from "./domain/ui-generation-protocol.entity.functions.js"

const input = { page: landingReference.page, criticalBlocks: [landingReference.blocks[0]!] }

describe("the incremental UI generation protocols", () => {
  test("compact records decode only after a complete newline", () => {
    const line = `@ui start ${JSON.stringify(input)}\n`
    const chunks = [line.slice(0, 17), line.slice(17, 61), line.slice(61)]
    const folded = chunks.reduce((acc, chunk) => {
      const decoded = decodeUiProtocolChunk("compact-lines", acc.state, chunk)
      return { state: decoded.state, records: [...acc.records, ...decoded.records], findings: [...acc.findings, ...decoded.findings] }
    }, { state: emptyUiProtocolDecoderState(), records: [] as ReadonlyArray<unknown>, findings: [] as ReadonlyArray<string> })
    expect(folded.findings).toEqual([])
    expect(folded.records).toHaveLength(1)
    expect(folded.records[0]).toMatchObject({ op: "start" })
  })

  test("A2UI-style JSONL envelopes decode and duplicate replay is ignored", () => {
    const line = `${JSON.stringify({ ui: { op: "start", input } })}\n`
    const first = decodeUiProtocolChunk("a2ui-jsonl", emptyUiProtocolDecoderState(), line)
    const replay = decodeUiProtocolChunk("a2ui-jsonl", first.state, line)
    expect(first.records).toHaveLength(1)
    expect(replay.records).toEqual([])
  })

  test("malformed complete records become findings instead of throwing", () => {
    const decoded = decodeUiProtocolChunk("compact-lines", emptyUiProtocolDecoderState(), "@ui start {bad}\n")
    expect(decoded.records).toEqual([])
    expect(decoded.findings).toEqual(["record is not valid JSON"])
  })
})
