import { expect, test } from "bun:test"

/*
 * The kernel runs in a browser without shims: a browser-target bundle of
 * its entry, built in memory, imports no `node:` or `bun:` module. The AI
 * library arrives through its barrel, so this covers what that pulls in.
 */
test("a browser bundle of @xandreed/sdk/kernel holds no node: or bun: import", async () => {
  const built = await Bun.build({ entrypoints: [`${import.meta.dir}/index.ts`], target: "browser", format: "esm" })
  expect(built.logs.filter((log) => log.level === "error").map((log) => log.message)).toEqual([])
  expect(built.success).toBe(true)
  const code = (await Promise.all(built.outputs.map((output) => output.text()))).join("\n")
  expect(code.length).toBeGreaterThan(1000)
  expect(code.match(/(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["\x27](?:node|bun):[^"\x27]*["\x27]/g) ?? []).toEqual([])
})
