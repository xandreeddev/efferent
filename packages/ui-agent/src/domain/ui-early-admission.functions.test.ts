import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { extractEarlyPatch, extractEarlyStart } from "./ui-early-admission.functions.js"

const PAGE = '{"id":"roastery-landing","title":"Roastery","archetype":"landing","slots":["hero","story","cta"]}'
const HERO = '{"kind":"component","id":"hero","component":"marketing.hero","props":{"title":"Coffee {with} braces","lede":"A \\"quoted\\" lede"},"children":[]}'

describe("extractEarlyStart", () => {
  test("a complete page and first block admit from a mid-stream prefix", () => {
    const prefix = `{"page":${PAGE},"criticalBlocks":[${HERO},{"kind":"comp`
    const early = extractEarlyStart(prefix)
    expect(Option.isSome(early)).toBe(true)
    const value = Option.getOrThrow(early)
    expect(value.page.id).toBe("roastery-landing")
    expect(value.page.slots).toEqual(["hero", "story", "cta"])
    expect(value.firstBlock.id).toBe("hero")
    // Braces and escaped quotes inside copy never confuse the scanner.
    expect(value.firstBlock.kind === "component" && value.firstBlock.props.title).toBe("Coffee {with} braces")
  })

  test("an incomplete page or unfinished first block yields none", () => {
    expect(Option.isNone(extractEarlyStart('{"page":{"id":"x","title":"T"'))).toBe(true)
    expect(Option.isNone(extractEarlyStart(`{"page":${PAGE},"criticalBlocks":[{"kind":"component","id":"hero"`))).toBe(true)
    expect(Option.isNone(extractEarlyStart(""))).toBe(true)
  })

  test("a shape that decodes invalid yields none instead of a bad admission", () => {
    const prefix = `{"page":{"id":"x","title":"T","archetype":"poster"},"criticalBlocks":[${HERO}]`
    expect(Option.isNone(extractEarlyStart(prefix))).toBe(true)
  })
})

describe("extractEarlyPatch", () => {
  const STORY = '{"kind":"component","id":"story","component":"content.prose","props":{"body":"From [farms] to cups"},"children":[]}'
  const CTA = '{"kind":"component","id":"cta","component":"marketing.cta","props":{"title":"Order"},"children":[]}'

  test("complete blocks collect in order as the stream grows; incomplete tails wait", () => {
    const early = extractEarlyPatch(`{"pageId":"roastery-landing","blocks":[${STORY},${CTA.slice(0, 40)}`)
    const value = Option.getOrThrow(early)
    expect(value.pageId).toBe("roastery-landing")
    expect(value.blocks.map((block) => block.id)).toEqual(["story"])
    const grown = Option.getOrThrow(extractEarlyPatch(`{"pageId":"roastery-landing","blocks":[${STORY},${CTA}]`))
    expect(grown.blocks.map((block) => block.id)).toEqual(["story", "cta"])
  })

  test("no pageId or no complete block yields none; complete is never inferred", () => {
    expect(Option.isNone(extractEarlyPatch('{"pageId":"x","blocks":[{"kind":"comp'))).toBe(true)
    expect(Option.isNone(extractEarlyPatch(`{"blocks":[${STORY}]`))).toBe(true)
  })
})
