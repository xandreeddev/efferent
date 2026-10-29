import { describe, expect, test } from "bun:test"
import { importsFor, importsOf, regionsOf, snippetOf } from "./guide-snippets.js"

const source = [
  `import { describe, test } from "bun:test"`,
  `import { Effect, Option, Schema } from "effect"`,
  `import { Agent, type Turn, Sessions as S } from "@xandreed/sdk"`,
  `import type { SessionAddress } from "@xandreed/sdk"`,
  `import { Tally } from "./testing.port.js"`,
  ``,
  `// #region read`,
  `/** Effect, Schema and Agent are only named here, in a comment. */`,
  `export const read = (sessions: typeof S.Service, address: SessionAddress) =>`,
  `  sessions.read(address).pipe(Effect.map((events) => \`\${Option.some(events.length)} "Schema"\`))`,
  `// #endregion read`,
  ``,
  `describe("x", () => {`,
  `  test("y", () => {`,
  `    // #region inline`,
  `    const turn: Turn = make()`,
  `      .pipe(tally(Tally))`,
  `    // #endregion inline`,
  `  })`,
  `})`,
].join("\n")

describe("guide snippets", () => {
  test("a region is its code, dedented, and imports only the names its code uses", () => {
    const { regions, problems } = regionsOf(source)
    expect(problems).toEqual([])
    expect([...regions.keys()]).toEqual(["read", "inline"])
    expect(regions.get("inline")).toBe("const turn: Turn = make()\n  .pipe(tally(Tally))")
    expect(importsFor(importsOf(source), regions.get("read") ?? "").lines).toEqual([
      `import { Effect, Option } from "effect"`,
      `import { Sessions as S } from "@xandreed/sdk"`,
      `import type { SessionAddress } from "@xandreed/sdk"`,
    ])
  })

  test("a snippet that takes a name from a relative path or a test runner is a problem", () => {
    const { regions } = regionsOf(source)
    const snippet = snippetOf(importsOf(source), regions.get("inline") ?? "")
    expect(snippet.text.split("\n")[0]).toBe(`import { type Turn } from "@xandreed/sdk"`)
    expect(snippet.problems).toEqual(["uses Tally from ./testing.port.js, which a reader cannot import"])
    expect(importsFor(importsOf(source), "describe(test)").problems).toEqual(["uses describe, test from bun:test, which a reader cannot import"])
  })

  test("regions closed under another name, named twice or nested are problems", () => {
    expect(regionsOf("// #region a\nx\n// #endregion b\n").problems).toEqual(["#region a is closed as #endregion b"])
    expect(regionsOf("// #region a\nx\n// #endregion\n// #region a\ny\n// #endregion a\n").problems).toEqual(["#region a appears twice"])
    expect(regionsOf("// #region a\n// #region b\nx\n// #endregion b\n").problems).toEqual(["#region a is closed as #endregion b", "#region a holds another region"])
  })
})
