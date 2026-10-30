import { expect, test } from "bun:test"
import { Context, Effect, Option, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { Bash, FileSystem, makeMemoryFileSystem, SessionEnvironment } from "@xandreed/core"
import type { BashEvent, BashOptions, BashResult } from "@xandreed/core"
import { workspaceTools } from "./workspace-tools.adapter.js"
import { GrepResult, workspaceToolsDefaults } from "./workspace-tools.entity.js"
import type { WorkspaceToolsConfig } from "./workspace-tools.entity.js"
import { compactGrep, environmentText, renderGrep, toolDescriptions } from "./workspace-tools.entity.functions.js"

const exit: BashEvent = { _tag: "BashExit", termination: "exit", exitCode: Option.some(0), signal: Option.none(), durationMs: 1 }
const chunk = (text: string, stream: "stdout" | "stderr" = "stdout"): BashEvent => ({ _tag: "BashChunk", stream, text })
const hit = (line: number, path = "a.txt") => JSON.stringify({ type: "match", data: { path: { text: path }, lines: { text: "hit\n" }, line_number: line } }) + "\n"
const result = (code: number): BashResult => ({ stdout: "ripgrep 15.2.0", stderr: "", exitCode: Option.some(code), signal: Option.none(), termination: "exit", durationMs: 1 })
const scoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

const bench = (stream: Stream.Stream<BashEvent>, config: Partial<WorkspaceToolsConfig> = {}, probe = 0) => Effect.gen(function* () {
  const commands: Array<{ command: string; options: BashOptions }> = []
  const probes: Array<BashOptions> = []
  const bash = Bash.of({
    exec: (_command, options) => Effect.sync(() => { probes.push(options); return result(probe) }),
    stream: (command, options) => { commands.push({ command, options }); return stream },
  })
  const fs = yield* makeMemoryFileSystem({ "/work/a.txt": "hit\n" })
  const capability = yield* workspaceTools({ ...workspaceToolsDefaults, tools: ["grep"], ...config }).pipe(Effect.provideService(Bash, bash))
  const tool = capability.tools[0]!
  const services = Context.make(FileSystem, fs).pipe(Context.add(SessionEnvironment, { workspace: "/work" }), Context.add(Bash, bash))
  const call = (params: unknown) => tool.handler(params).pipe(Effect.provide(services))
  return { commands, probes, tool, call, capability }
})

test("auto probes once; rg declares Bash and receives the pattern only on stdin with host environment", async () => {
  const seen = await scoped(Effect.gen(function* () {
    const state = yield* bench(Stream.make(chunk(hit(1)), exit), { bashEnv: { MARKER: "yes" }, bashInheritEnv: true, grepTimeoutMs: 1234 })
    const first = yield* state.call({ pattern: "$(do not run)'", path: "a.txt" }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(GrepResult)))
    yield* state.call({ pattern: "second" })
    return { ...state, first }
  }))
  expect(seen.probes).toEqual([{ cwd: "/", timeoutMs: 5000, env: { MARKER: "yes" }, inheritEnv: true }])
  expect(seen.tool.requires).toEqual([FileSystem.key, SessionEnvironment.key, Bash.key])
  expect(Option.getOrThrow(seen.tool.view).version).toBe("4")
  expect(seen.commands[0]?.options).toEqual({ cwd: "/work", stdin: "$(do not run)'", timeoutMs: 1234, env: { MARKER: "yes" }, inheritEnv: true })
  expect(seen.commands[0]?.command).not.toContain("do not run")
  expect(seen.first).toMatchObject({ matches: 1, files: 1, timedOut: false })
})

test("an unavailable probe falls back in auto and explicit ripgrep fails at build", async () => {
  const fallback = await scoped(Effect.gen(function* () {
    const state = yield* bench(Stream.empty, {}, 127)
    return { requires: state.tool.requires, value: yield* state.call({ pattern: "hit" }) }
  }))
  expect(fallback.requires).toEqual([FileSystem.key, SessionEnvironment.key])
  expect(fallback.value).toMatchObject({ matches: 1, timedOut: false })
  const failure = await scoped(Effect.flip(bench(Stream.empty, { grepEngine: "ripgrep" }, 127)))
  expect(failure).toMatchObject({ code: "config.options", message: "grepEngine ripgrep requires rg on the Bash service PATH" })
  const noBash = await scoped(Effect.flip(workspaceTools({ ...workspaceToolsDefaults, tools: ["grep"], grepEngine: "ripgrep" })))
  expect(noBash).toMatchObject({ code: "config.options" })
})

test("stopping at the global cap closes the Bash stream instead of waiting for exit", async () => {
  const closed: Array<boolean> = []
  const output = Stream.concat(Stream.make(chunk(hit(1) + hit(2, "b.txt") + JSON.stringify({ type: "end", data: { path: { text: "b.txt" }, binary_offset: null } }) + "\n")), Stream.never).pipe(Stream.ensuring(Effect.sync(() => closed.push(true))))
  const found = await scoped(Effect.gen(function* () {
    const state = yield* bench(output)
    return yield* state.call({ pattern: "hit", limit: 1 }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(GrepResult)), Effect.timeout("2 seconds"))
  }))
  expect(closed).toEqual([true])
  expect(found).toMatchObject({ matches: 1, files: 1, truncated: true, lines: [{ path: "a.txt", line: 1, text: "hit", match: true }] })
})

test("a timeout reports partial results with an exact view and compact note", async () => {
  const found = await scoped(Effect.gen(function* () {
    const state = yield* bench(Stream.make(chunk(hit(1)), { ...exit, termination: "timeout", exitCode: Option.none() }))
    return yield* state.call({ pattern: "hit" }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(GrepResult)))
  }))
  expect(found.timedOut).toBe(true)
  expect(renderGrep(found, false, 100, 4096)).toBe("a.txt:1:hit\n[Search timed out; these are partial results. Narrow the pattern or the path and search again.]")
  expect(compactGrep(found)).toBe("(grep hit in .: 1 matching line in 1 file; timed out, partial results)")
  expect(renderGrep({ ...found, lines: [], matches: 0, files: 0 }, false, 100, 4096)).toBe("No matches for hit in the workspace root.\n[Search timed out; these are partial results. Narrow the pattern or the path and search again.]")
})

test("regex failures become InvalidPattern and file diagnostics survive a partial exit2", async () => {
  const invalid = await scoped(Effect.gen(function* () {
    const state = yield* bench(Stream.make(chunk("regex parse error: unsupported look-around\n", "stderr"), { ...exit, exitCode: Option.some(2) }))
    return yield* Effect.flip(state.call({ pattern: "(?=x)" }))
  }))
  expect(invalid).toEqual({ error: "InvalidPattern", message: "The search pattern or glob could not be parsed: regex parse error: unsupported look-around. Pass literal: true to search for the pattern as text" })
  const partial = await scoped(Effect.gen(function* () {
    const state = yield* bench(Stream.make(chunk(hit(1)), chunk("rg: secret.txt: Permission denied (os error 13)\n", "stderr"), { ...exit, exitCode: Option.some(2) }))
    return yield* state.call({ pattern: "hit" }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(GrepResult)))
  }))
  expect(partial).toMatchObject({ matches: 1, unreadable: [{ path: "secret.txt", reason: "Permission" }] })
})

test("rg description and the ignore-files environment line are pinned exactly", () => {
  const config = { ...workspaceToolsDefaults, grepEngine: "ripgrep" as const, grepIgnoreFiles: true }
  expect(toolDescriptions(config).grep).toBe("Search file contents for a regular expression (ripgrep syntax: no lookaround or backreferences), or for plain text with literal: true. path is a file or a directory (by default the workspace root); glob limits the files searched (*.ts searches every directory). Shows path:line:text for each matching line, and context lines around each match when asked. Lines longer than 500 characters are shown cut. The search stops after 30 s. At most 100 matching lines; limit (1 to 100) asks for fewer. Binary files, node_modules, .git, .efferent and symbolic links are skipped, and files that cannot be read are named.")
  expect(environmentText("/work", config, ["grep"])).toBe("## Workspace\nThe workspace is /work. Give paths relative to it; the file tools refuse paths that lead outside it.\nfind and grep never look inside node_modules, .git, .efferent.\ngrep honours .gitignore, .ignore and other ripgrep ignore files.")
})

test("a binary end discards provisional matches before a global cap stops the stream", async () => {
  const binaryEnd = JSON.stringify({ type: "end", data: { path: { text: "a.txt" }, binary_offset: 10 } }) + "\n"
  const found = await scoped(Effect.gen(function* () {
    const state = yield* bench(Stream.make(chunk(hit(1) + hit(2)), chunk(binaryEnd + hit(1, "text.txt")), exit))
    return yield* state.call({ pattern: "hit", limit: 1 }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(GrepResult)))
  }))
  expect(found).toMatchObject({ matches: 1, files: 1, skipped: 1, truncated: false, lines: [{ path: "text.txt", line: 1, text: "hit", match: true }] })
})

test("older grep results decode timedOut as false", async () => {
  const value = await Effect.runPromise(Schema.decodeUnknownEffect(GrepResult)({ pattern: "x", path: ".", lines: [], matches: 0, files: 0, skipped: 0, truncated: false }))
  expect(value).toEqual({ pattern: "x", path: ".", lines: [], matches: 0, files: 0, skipped: 0, truncated: false, unreadable: [], timedOut: false })
})

test("an oversized output or failed command has a pinned search refusal", async () => {
  const values = await scoped(Effect.gen(function* () {
    const oversized = yield* bench(Stream.make(chunk("x".repeat(1024 * 6 + 65_537))), { maxFileBytes: 1024 })
    const missing = yield* bench(Stream.make({ ...exit, exitCode: Option.some(127) }))
    return [yield* Effect.flip(oversized.call({ pattern: "x" })), yield* Effect.flip(missing.call({ pattern: "x" }))]
  }))
  expect(values).toEqual([
    { error: "SearchFailed", message: "The search output was too large to read; narrow the path or the pattern and search again" },
    { error: "SearchFailed", message: "The file search could not finish; try a narrower path or tell the user the search is unavailable" },
  ])
})

test("the global limit stops at the file end without waiting for another matching file", async () => {
  const ended = JSON.stringify({ type: "end", data: { path: { text: "a.txt" }, binary_offset: null } }) + "\n"
  const output = Stream.concat(Stream.make(chunk(hit(1) + ended)), Stream.never)
  const found = await scoped(Effect.gen(function* () {
    const state = yield* bench(output)
    return yield* state.call({ pattern: "hit", limit: 1 }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(GrepResult)), Effect.timeout("2 seconds"))
  }))
  expect(found).toMatchObject({ matches: 1, truncated: true, timedOut: false })
})

test("a coalesced Bash chunk is bounded by JSON line size rather than chunk size", async () => {
  const records = Array.from({ length: 1000 }, (_, at) => {
    const path = `file${at}.txt`
    return hit(1, path) + JSON.stringify({ type: "end", data: { path: { text: path }, binary_offset: null } }) + "\n"
  }).join("")
  expect(records.length).toBeGreaterThan(1024 * 6 + 65_536)
  const found = await scoped(Effect.gen(function* () {
    const state = yield* bench(Stream.make(chunk(records), exit), { maxFileBytes: 1024 })
    return yield* state.call({ pattern: "hit" }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(GrepResult)))
  }))
  expect(found).toMatchObject({ matches: 100, files: 100, truncated: true, timedOut: false })
})
