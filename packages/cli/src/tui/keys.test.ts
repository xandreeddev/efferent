import { describe, expect, it } from "bun:test"
import { KeyParser, type Key } from "./keys.js"

/** Feed one full byte sequence and return the parsed keys. */
const parse = (s: string): Key[] => new KeyParser().feed(s)

describe("arrow modifier decoding", () => {
  it("plain CSI arrow has no modifiers", () => {
    expect(parse("\x1b[A")).toEqual([{ type: "arrow", dir: "up", shift: false, ctrl: false }])
    expect(parse("\x1b[C")).toEqual([{ type: "arrow", dir: "right", shift: false, ctrl: false }])
  })
  it("SS3 arrow (ESC O A) has no modifiers", () => {
    expect(parse("\x1bOA")).toEqual([{ type: "arrow", dir: "up", shift: false, ctrl: false }])
  })
  it("CSI 1;5<dir> sets ctrl (modifier 5)", () => {
    expect(parse("\x1b[1;5A")).toEqual([{ type: "arrow", dir: "up", shift: false, ctrl: true }])
    expect(parse("\x1b[1;5D")).toEqual([{ type: "arrow", dir: "left", shift: false, ctrl: true }])
  })
  it("CSI 1;2<dir> stays shift-only", () => {
    expect(parse("\x1b[1;2B")).toEqual([{ type: "arrow", dir: "down", shift: true, ctrl: false }])
  })
  it("CSI 1;6<dir> is ctrl+shift", () => {
    expect(parse("\x1b[1;6C")).toEqual([{ type: "arrow", dir: "right", shift: true, ctrl: true }])
  })
})

describe("Shift-Tab parsing", () => {
  it("plain CSI Z → shiftTab", () => {
    expect(parse("\x1b[Z")).toEqual([{ type: "shiftTab" }])
  })
  it("CSI 1;2Z (xterm shift modifier) → shiftTab", () => {
    expect(parse("\x1b[1;2Z")).toEqual([{ type: "shiftTab" }])
  })
  it("CSI 27;2;9~ (modifyOtherKeys) → shiftTab", () => {
    expect(parse("\x1b[27;2;9~")).toEqual([{ type: "shiftTab" }])
  })
})
