import { describe, expect, test } from "bun:test"
import { EditorState } from "@codemirror/state"
import { editableText, lockedExtension, regionField } from "./editor-locks.ts"

const HEAD = "import x\n// edit below\n"
const BODY = "{ a: 1 }"
const FOOT = "\nrun(config)"
const make = () => EditorState.create({ doc: HEAD + BODY + FOOT, extensions: [lockedExtension({ from: HEAD.length, to: HEAD.length + BODY.length })] })

describe("locked editor regions", () => {
  test("edits inside the region apply, and the region follows them", () => {
    let state = make()
    state = state.update({ changes: { from: HEAD.length + 5, insert: "99" } }).state
    expect(editableText(state)).toBe("{ a: 991 }")
    expect(state.field(regionField).to).toBe(HEAD.length + BODY.length + 2)
  })

  test("typing at either edge of the region is inside it", () => {
    let state = make()
    state = state.update({ changes: { from: HEAD.length, insert: "/*s*/" } }).state
    state = state.update({ changes: { from: state.field(regionField).to, insert: "/*e*/" } }).state
    expect(editableText(state)).toBe("/*s*/{ a: 1 }/*e*/")
    expect(state.doc.toString().startsWith(HEAD)).toBe(true)
    expect(state.doc.toString().endsWith(FOOT)).toBe(true)
  })

  test("edits in the locked head or foot are refused", () => {
    const state = make()
    expect(state.update({ changes: { from: 2, insert: "X" } }).state.doc.toString()).toBe(state.doc.toString())
    expect(state.update({ changes: { from: state.doc.length, insert: "X" } }).state.doc.toString()).toBe(state.doc.toString())
  })

  test("a change that crosses the boundary is refused whole", () => {
    const state = make()
    const crossing = state.update({ changes: { from: HEAD.length - 3, to: HEAD.length + 3, insert: "" } }).state
    expect(crossing.doc.toString()).toBe(state.doc.toString())
    const wipe = state.update({ changes: { from: 0, to: state.doc.length, insert: "" } }).state
    expect(wipe.doc.toString()).toBe(state.doc.toString())
  })

  test("deleting the whole editable text is allowed, leaving the region empty but in place", () => {
    const state = make().update({ changes: { from: HEAD.length, to: HEAD.length + BODY.length, insert: "" } }).state
    expect(editableText(state)).toBe("")
    expect(state.doc.toString()).toBe(HEAD + FOOT)
  })

  test("a program's own update (filter: false) can replace the region, as the controls do", () => {
    const state = make()
    const { from, to } = state.field(regionField)
    const next = state.update({ changes: { from, to, insert: "{ a: 2 }" }, filter: false }).state
    expect(editableText(next)).toBe("{ a: 2 }")
  })
})
