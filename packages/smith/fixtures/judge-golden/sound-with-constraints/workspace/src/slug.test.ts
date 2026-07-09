import { expect, test } from "bun:test"
import { slugify } from "./slug.js"

test("spaces to dashes", () => expect(slugify("Hello World")).toBe("hello-world"))
test("strips punctuation", () => expect(slugify("A, B & C!")).toBe("a-b-c"))
