import { describe, expect, test } from "bun:test"
import { Result, Option } from "effect"
import { contextHeadline, contextView, pinLine, standingLine } from "./contextView.js"
import { emptyContextSet, parsePinRef, toggleStanding, withPin } from "../../context/context-set.entity.functions.js"
import type { ContextBundle } from "../../context/assemble.js"
import type { StandingSources } from "../../context/standing.js"

const pin = (raw: string) => Result.getOrThrow(parsePinRef(raw))

describe("the context panel's view model", () => {
  test("standing and pinned sources read back with their sizes; off is off, deferred is deferred", () => {
    const set = toggleStanding(withPin(withPin(emptyContextSet, pin("src/x.ts")), pin("diff")), "lessons")
    const standing: StandingSources = {
      rules: Option.some("r".repeat(2_100)),
      lessons: Option.none(),
      memory: Option.some("m".repeat(800)),
      doctrine: Option.none(),
      measured: [
        { name: "rules", on: true, chars: 2_100 },
        { name: "lessons", on: false, chars: 500 },
        { name: "memory", on: true, chars: 800 },
        { name: "doctrine", on: true, chars: 0 },
      ],
    }
    const bundle: ContextBundle = {
      blocks: [
        { label: "src/x.ts", kind: "file", chars: 3_200, status: "included", text: Option.some("…"), note: Option.none() },
        { label: "diff", kind: "diff", chars: 0, status: "deferred", text: Option.none(), note: Option.none() },
      ],
      totalChars: 3_200,
      text: Option.some("…"),
      fingerprint: "abc",
    }
    const view = contextView(set, standing, bundle)
    expect(view.standing.map(standingLine)).toEqual([
      "rules file 2.1k",
      "forge lessons off",
      "workspace memory 800",
      "quality bar (empty)",
    ])
    expect(view.pins.map(pinLine)).toEqual(["src/x.ts 3.2k", "diff deferred"])
    expect(view.standingChars).toBe(2_900)
    expect(view.pinChars).toBe(3_200)
    expect(contextHeadline(view)).toBe("6.1k chars ≈ 1.5k tokens · pins 3.2k of 24.0k")
  })
})
