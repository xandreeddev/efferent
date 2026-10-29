import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Effect, Option, Schema } from "effect"
import { PrivateTextConfig } from "../domain/Rules.js"
import { makePrivateTextGate } from "./privateTextGate.js"

// The paths are assembled at run time: this file is itself scanned by the
// repository's own private-text gate.
const posixHome = (root: "home" | "Users", name: string) => ["", root, name, "project"].join("/")
const windowsHome = (name: string, separator: string) => ["C:", "Users", name, "project"].join(separator)

/** A git work tree holding `files` (path → text), with `ignore` as its .gitignore. */
const repo = (files: Readonly<Record<string, string>>, ignore: ReadonlyArray<string> = []): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "foundry-private-"))
  execFileSync("git", ["init", "-q"], { cwd: dir })
  writeFileSync(path.join(dir, ".gitignore"), ignore.map((line) => `${line}\n`).join(""))
  Object.entries(files).forEach(([file, text]) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), text)
  })
  return dir
}

const configOf = (fields: Partial<typeof PrivateTextConfig.Encoded> = {}) =>
  Schema.decodeUnknownSync(PrivateTextConfig)({ placeholders: ["user", "runner"], ...fields })

const findingsIn = (dir: string, config: PrivateTextConfig) =>
  Effect.runPromise(makePrivateTextGate(config).run({ rootDir: dir, files: [] }))

const at = (findings: Awaited<ReturnType<typeof findingsIn>>) =>
  findings.map((finding) => ({
    file: Option.match(finding.location, { onNone: () => "-", onSome: (location) => String(location.file) }),
    line: Option.match(finding.location, { onNone: () => 0, onSome: (location) => location.line }),
    message: finding.message,
  }))

describe("the private-text gate", () => {
  test("a home path in any file git tracks or would track fails; a placeholder home and an ignored file pass", async () => {
    const dir = repo({
      "README.md": `install into ${posixHome("home", "quill")}\nor ${posixHome("home", "user")}\n`,
      "src/paths.ts": `export const mac = "${posixHome("Users", "quill")}"\nexport const ci = "${posixHome("home", "runner")}"\n`,
      "src/windows.ts": `export const escaped = "${windowsHome("quill", "\\\\")}"\nexport const plain = "${windowsHome("Quill", "/")}"\n`,
      "notes/local.md": `${posixHome("home", "quill")}\n`,
    }, ["notes/"])
    execFileSync("git", ["add", "README.md"], { cwd: dir })
    const findings = await findingsIn(dir, configOf())
    expect(at(findings).map(({ file, line }) => `${file}:${line}`).sort()).toEqual(["README.md:1", "src/paths.ts:1", "src/windows.ts:1", "src/windows.ts:2"])
    // The message never repeats the name: a CI log is as public as the file.
    expect(findings.every((finding) => !finding.message.includes("quill") && !finding.message.includes("Quill"))).toBe(true)
  })

  test("a fake home is fine only under one of the placeholder names, and `exclude` leaves files out", async () => {
    const dir = repo({ "a.ts": `"${posixHome("home", "fixture")}"\n`, "b.ts": `"${posixHome("home", "fixture")}"\n` })
    expect(at(await findingsIn(dir, configOf({ exclude: ["b.ts"] }))).map(({ file }) => file)).toEqual(["a.ts"])
    expect(await findingsIn(dir, configOf({ placeholders: ["Fixture"] }))).toEqual([])
  })

  test("without the denylist only paths are checked; with it, its terms fail as whole words, case-insensitively", async () => {
    const files = { "doc.md": "Built by Zorblax.\nzorblaxian is fine\n# ZORBLAX\n" }
    const absent = repo(files, ["local/"])
    expect(await findingsIn(absent, configOf({ denylist: "local/terms.txt" }))).toEqual([])

    const present = repo({ ...files, "local/terms.txt": "# private terms, one per line\n\nZorblax\n" }, ["local/"])
    const findings = await findingsIn(present, configOf({ denylist: "local/terms.txt" }))
    expect(at(findings).map(({ file, line }) => `${file}:${line}`)).toEqual(["doc.md:1", "doc.md:3"])
    expect(findings.every((finding) => finding.message === "a term from the local denylist (local/terms.txt, line 3)")).toBe(true)
  })

  test("a denylist git would not ignore is a finding, and is never scanned", async () => {
    const dir = repo({ "terms.txt": "Zorblax\n", "doc.md": "clean\n" })
    const findings = await findingsIn(dir, configOf({ denylist: "terms.txt" }))
    expect(at(findings)).toEqual([{ file: "-", line: 0, message: "the denylist terms.txt is not ignored by git: committed, it would publish every term it lists" }])
  })

  test("outside a git work tree the gate cannot list the files, and fails closed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "foundry-private-"))
    const exit = await Effect.runPromiseExit(makePrivateTextGate(configOf()).run({ rootDir: dir, files: [] }))
    expect(exit._tag).toBe("Failure")
    expect(String(exit)).toContain("is not a git work tree")
  })
})
