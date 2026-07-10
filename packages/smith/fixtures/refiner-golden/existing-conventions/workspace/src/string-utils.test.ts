import { expect, test } from "bun:test"
import { titleCase } from "./string-utils.js"
test("title-cases words", () => expect(titleCase("a b")).toBe("A B"))
