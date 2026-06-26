import { expect, test } from "bun:test"
import { parseMast } from "./mast.js"

test("parses valid modes and maps their categories", () => {
  const v = parseMast('here: {"modes": ["FM-2.4", "FM-3.2"]}')
  expect(v.modes).toEqual(["FM-2.4", "FM-3.2"])
  expect(v.categories).toEqual({ FC1: false, FC2: true, FC3: true })
})

test("drops unknown codes and dedups", () => {
  const v = parseMast('{"modes": ["FM-1.1", "FM-1.1", "FM-9.9", "nonsense"]}')
  expect(v.modes).toEqual(["FM-1.1"])
  expect(v.categories.FC1).toBe(true)
})

test("a clean run (empty modes) has no categories", () => {
  const v = parseMast('{"modes": []}')
  expect(v.modes).toEqual([])
  expect(v.categories).toEqual({ FC1: false, FC2: false, FC3: false })
})

test("unparseable / no-JSON input ⇒ clean (no false failures)", () => {
  expect(parseMast("the model rambled with no json").modes).toEqual([])
  expect(parseMast("{not valid").modes).toEqual([])
})
