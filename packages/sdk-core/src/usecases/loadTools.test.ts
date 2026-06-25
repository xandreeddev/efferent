import { describe, expect, it } from "bun:test"
import { parseToolFile, shellEscape, substituteTemplate } from "./loadTools.js"

describe("parseToolFile", () => {
  it("parses a shell tool with params + timeout", () => {
    const def = parseToolFile(
      `---
name: count_lines
description: count lines in files
type: shell
command: wc -l \${glob}
params: glob: the glob, extra: another
timeout: 30
---
notes`,
      "/t.md",
    )
    expect(def).toEqual({
      name: "count_lines",
      description: "count lines in files",
      kind: "shell",
      template: "wc -l ${glob}",
      params: [
        { name: "glob", description: "the glob" },
        { name: "extra", description: "another" },
      ],
      timeoutMs: 30000,
      sourcePath: "/t.md",
    })
  })

  it("parses an http tool from a url template", () => {
    const def = parseToolFile(
      `---
name: fetch_status
description: check a status page
type: http
url: https://example.com/status/\${id}
params: id: the id
---`,
      "/t.md",
    )
    expect(def?.kind).toBe("http")
    expect(def?.template).toBe("https://example.com/status/${id}")
  })

  it("returns undefined without name/description or a template", () => {
    expect(parseToolFile("no frontmatter", "/t.md")).toBeUndefined()
    expect(parseToolFile("---\nname: x\ndescription: y\n---\nno command", "/t.md")).toBeUndefined()
  })
})

describe("substituteTemplate", () => {
  it("substitutes + escapes present params and reports missing ones", () => {
    const r = substituteTemplate("wc -l ${glob}", { glob: "src/*.ts" }, shellEscape)
    expect(r.filled).toBe("wc -l 'src/*.ts'")
    expect(r.missing).toEqual([])
    const m = substituteTemplate("echo ${a} ${b}", { a: "x" }, shellEscape)
    expect(m.missing).toEqual(["b"])
  })

  it("shell-escapes single quotes (no injection)", () => {
    expect(shellEscape("a'; rm -rf /")).toBe(`'a'\\''; rm -rf /'`)
    const r = substituteTemplate("run ${x}", { x: "$(whoami)" }, shellEscape)
    expect(r.filled).toBe("run '$(whoami)'") // command substitution neutralised by quoting
  })

  it("url-encodes for http templates", () => {
    const r = substituteTemplate("https://x/${q}", { q: "a b&c" }, encodeURIComponent)
    expect(r.filled).toBe("https://x/a%20b%26c")
  })
})
