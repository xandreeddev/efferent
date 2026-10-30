import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { Bash, BashError, Capabilities, FileSystem, Failure, makeMemoryFileSystem, MEDIA_LIMITS, mediaFromBytes, PluginInstanceId, SessionEnvironment, toolResultMedia } from "@xandreed/core"
import { toolParametersSchema } from "@xandreed/core/internal"
import type { Capability } from "@xandreed/core"
import { makeRegistry } from "@xandreed/plugin-tool-discovery"
import type { DiscoveryConfig } from "@xandreed/plugin-tool-discovery"
import { activateGraph, resolveGraph } from "@xandreed/runtime"
import { BashLive } from "./bash.adapter.js"
import { localFileSystem } from "./file-system.adapter.js"
import { localSystemPlugin, workspaceToolsPlugin, WorkspaceToolsPluginLive } from "./plugin.adapter.js"
import { workspaceTools } from "./workspace-tools.adapter.js"
import { BashToolResult, EditResult, FindResult, GrepResult, LsResult, ReadResult, workspaceToolsDefaults, WriteResult } from "./workspace-tools.entity.js"
import type { WorkspaceToolsConfig } from "./workspace-tools.entity.js"
import { toolDescriptions } from "./workspace-tools.entity.functions.js"

const temporary = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "efferent-tools-"))).pipe(Effect.flatMap((dir) => Effect.promise(() => realpath(dir)))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
)
const io = <A>(run: () => Promise<A>) => Effect.promise(run)
/** "café\nx=1\n" in Latin-1: the é is the single byte E9, which is not UTF-8. */
const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x3d, 0x31, 0x0a])

type Call = (name: string, params: unknown) => Effect.Effect<unknown, unknown>

/**
 * The capability over a fresh directory of the disk, with `BashLive`
 * (whose parent environment has `planted` added) and the given options.
 * `outside` is a second directory, beside the workspace, for escapes.
 */
const bench = (options: Partial<WorkspaceToolsConfig> = {}, planted: Readonly<Record<string, string>> = {}) => Effect.gen(function* () {
  const root = yield* temporary
  const outside = yield* temporary
  const bash = yield* Effect.service(Bash).pipe(Effect.provide(BashLive({ parentEnv: { ...process.env, ...planted }, exitGraceMs: 100 })))
  const capability = yield* workspaceTools({ ...workspaceToolsDefaults, ...options }).pipe(Effect.provideService(Bash, bash))
  const services = Context.make(FileSystem, localFileSystem).pipe(Context.add(SessionEnvironment, { workspace: root }), Context.add(Bash, bash))
  return { root, outside, capability, call: caller(capability, services) }
})

const caller = (capability: Capability, services: Context.Context<never>): Call => (name, params) => Option.match(Option.fromNullishOr(capability.tools.find((entry) => entry.tool.name === name)), {
  onNone: () => Effect.die(`no tool ${name}`),
  onSome: (entry) => entry.handler(params).pipe(Effect.provide(services)),
})

/** The result of a call that must succeed, decoded with its schema. */
const succeeds = <A, I>(schema: Schema.Codec<A, I>) => (effect: Effect.Effect<unknown, unknown>): Effect.Effect<A> =>
  effect.pipe(Effect.flatMap((value) => Schema.decodeUnknownEffect(schema)(value)), Effect.orDie)
/** The failure a call returns to the model. */
const fails = (effect: Effect.Effect<unknown, unknown>): Effect.Effect<Failure> =>
  Effect.flip(effect).pipe(Effect.flatMap((error) => Schema.decodeUnknownEffect(Failure)(error)), Effect.orDie)
const errorOf = (effect: Effect.Effect<unknown, unknown>) => fails(effect).pipe(Effect.map((failure) => failure.error))

/** What the model is shown of a result. */
const shown = (capability: Capability, name: string, result: unknown, params: unknown): string =>
  Option.getOrThrow(Option.flatMap(Option.fromNullishOr(capability.tools.find((entry) => entry.tool.name === name)), (entry) => entry.view)).render(result, params)

const scoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

describe("read", () => {
  test("a window of lines with the offset to continue from; binary files and directories are reported", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, capability, call } = yield* bench({ maxLines: 3 })
      yield* io(() => writeFile(join(root, "notes.txt"), "one\ntwo\nthree\nfour\nfive\n"))
      yield* io(() => writeFile(join(root, "solo.txt"), "one\n"))
      yield* io(() => writeFile(join(root, "font.woff2"), new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0, 0, 0, 0, 13])))
      yield* io(() => mkdir(join(root, "src")))
      const first = yield* succeeds(ReadResult)(call("read", { path: "notes.txt" }))
      const second = yield* succeeds(ReadResult)(call("read", { path: "notes.txt", offset: 4 }))
      return {
        first, second,
        firstView: shown(capability, "read", first, { path: "notes.txt" }),
        binary: yield* succeeds(ReadResult)(call("read", { path: "font.woff2" })),
        directory: yield* fails(call("read", { path: "src" })),
        past: yield* fails(call("read", { path: "notes.txt", offset: 9 })),
        pastOne: yield* fails(call("read", { path: "solo.txt", offset: 2 })),
        missing: yield* fails(call("read", { path: "nope.txt" })),
      }
    }))
    expect(seen.first).toEqual({ _tag: "Text", path: "notes.txt", text: "one\ntwo\nthree", firstLine: 1, lastLine: 3, totalLines: 5, next: 4, clipped: false, lossy: false })
    expect(seen.firstView).toBe("one\ntwo\nthree\n[Showing lines 1-3 of 5. Use offset=4 to continue.]")
    expect(seen.second).toMatchObject({ text: "four\nfive", next: null })
    expect(seen.binary).toEqual({ _tag: "Binary", path: "font.woff2", bytes: 12, mediaType: "font/woff2" })
    expect([seen.directory, seen.past, seen.pastOne, seen.missing]).toEqual([
      { error: "IsDirectory", message: "src is a directory; use ls to list it" },
      { error: "OffsetPastEnd", message: "notes.txt has 5 lines; offset must be at most 5" },
      { error: "OffsetPastEnd", message: "solo.txt has 1 line; offset must be at most 1" },
      { error: "NotFound", message: "nope.txt does not exist" },
    ])
  })

  test("a file larger than maxFileBytes is refused with what to use instead", async () => {
    const failure = await scoped(Effect.gen(function* () {
      const { root, call } = yield* bench({ maxFileBytes: 1_024 })
      yield* io(() => writeFile(join(root, "big.log"), "x".repeat(2_000)))
      return yield* fails(call("read", { path: "big.log" }))
    }))
    expect(failure).toEqual({ error: "FileTooLarge", message: "big.log is 2.0 KB, more than the 1 KB read loads; use grep to find lines in it, or bash (head, tail, sed -n) for parts of it" })
  })

  test("a file that is not valid UTF-8 is shown with U+FFFD and a notice", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, capability, call } = yield* bench()
      yield* io(() => writeFile(join(root, "latin1.txt"), latin1))
      const result = yield* succeeds(ReadResult)(call("read", { path: "latin1.txt" }))
      return { result, view: shown(capability, "read", result, {}) }
    }))
    expect(seen.result).toMatchObject({ _tag: "Text", text: "caf\ufffd\nx=1", lossy: true })
    expect(seen.view).toBe("caf\ufffd\nx=1\n[latin1.txt is not valid UTF-8: bytes that are not show as \ufffd. edit refuses such a file; change it with bash.]")
  })
})

describe("read images", () => {
  /** A 1x1 PNG, 70 bytes. */
  const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  const pixel = new Uint8Array(Buffer.from(pixelPng, "base64"))
  /** A 1x1 GIF89a (43 bytes) and a 1x1 lossless WebP (34 bytes), as image tools write them. */
  const pixelGif = new Uint8Array(Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"))
  const pixelWebp = new Uint8Array(Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64"))
  /** The PNG grown past `MEDIA_LIMITS.imageBytes`: a valid header, then zeros. */
  const oversized = (() => {
    const file = new Uint8Array(MEDIA_LIMITS.imageBytes + 1)
    file.set(pixel)
    return file
  })()
  const discovery: DiscoveryConfig = {
    grants: [], loadSkill: true, maxCallsPerRun: 8, maxSkillLoadsPerRun: 4, readConcurrency: 2, matcherTimeoutMs: 1_000, catalogVersion: "test",
  }

  /** Read `path` through the capability, then show its encoded result through the registry's views, as memory records it. */
  const readThroughRegistry = (options: Partial<WorkspaceToolsConfig>, files: Readonly<Record<string, Uint8Array>>, path: string) => Effect.gen(function* () {
    const { root, capability, call } = yield* bench(options)
    yield* Effect.forEach(Object.entries(files), ([name, content]) => io(() => writeFile(join(root, name), content)), { discard: true })
    const result = yield* succeeds(ReadResult)(call("read", { path }))
    const encoded = Schema.encodeSync(ReadResult)(result)
    const registry = yield* makeRegistry(discovery, [capability])
    const view = yield* registry.views.view("read", encoded, { path }, false)
    const checked = yield* toolResultMedia(encoded, view.media ?? [])
    return { result, encoded, view, checked }
  })

  test("a PNG on disk is returned as an image; through the registry its view sends it, by one slot that memory's check keeps", async () => {
    const seen = await scoped(readThroughRegistry({}, { "chart.png": pixel }, "chart.png"))
    const image = Effect.runSync(mediaFromBytes(pixel, { name: "chart.png" }))
    expect(seen.result).toEqual({ _tag: "Image", path: "chart.png", image })
    expect(seen.encoded).toEqual({ _tag: "Image", path: "chart.png", image: { ...image, data: pixelPng } })
    expect(seen.view.text).toBe("[Image chart.png (image/png, 70 B).]")
    expect(seen.view.text).not.toContain(pixelPng)
    expect(seen.view.media).toEqual([{ path: ["image"], fingerprint: image.fingerprint, mediaType: "image/png", bytes: 70 }])
    expect<unknown>(seen.view.subjects.map((subject) => subject.id)).toEqual(["chart.png"])
    expect(seen.checked).toEqual({ slots: seen.view.media ?? [], labels: [] })
  })

  test("a GIF and a WebP on disk are images too: the NUL probe takes them for binary, and their bytes give the type", async () => {
    const files = { "anim.gif": pixelGif, "photo.webp": pixelWebp }
    const gif = await scoped(readThroughRegistry({}, files, "anim.gif"))
    const webp = await scoped(readThroughRegistry({}, files, "photo.webp"))
    expect(gif.result).toEqual({ _tag: "Image", path: "anim.gif", image: Effect.runSync(mediaFromBytes(pixelGif, { name: "anim.gif" })) })
    expect(webp.result).toEqual({ _tag: "Image", path: "photo.webp", image: Effect.runSync(mediaFromBytes(pixelWebp, { name: "photo.webp" })) })
    expect([gif.view.text, webp.view.text]).toEqual(["[Image anim.gif (image/gif, 43 B).]", "[Image photo.webp (image/webp, 34 B).]"])
    expect([gif.view.media?.map((slot) => slot.mediaType), webp.view.media?.map((slot) => slot.mediaType)]).toEqual([["image/gif"], ["image/webp"]])
  })

  test("an image over maxFileBytes is refused unread, and told to read a smaller copy", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, call } = yield* bench({ maxFileBytes: 1_024 })
      const large = new Uint8Array(2_048)
      large.set(pixel)
      yield* io(() => writeFile(join(root, "big.png"), large))
      yield* io(() => writeFile(join(root, "big.log"), "x".repeat(2_048)))
      return { image: yield* fails(call("read", { path: "big.png" })), text: yield* fails(call("read", { path: "big.log" })) }
    }))
    expect(seen.image).toEqual({ error: "FileTooLarge", message: "big.png is 2 KB, more than the 1 KB read loads; to see it, make a smaller copy with bash (scaled down or recompressed) and read that" })
    expect(seen.text).toEqual({ error: "FileTooLarge", message: "big.log is 2 KB, more than the 1 KB read loads; use grep to find lines in it, or bash (head, tail, sed -n) for parts of it" })
  })

  test("an image over the size cap is a note without its bytes, and its view sends no image", async () => {
    const seen = await scoped(readThroughRegistry({}, { "big.png": oversized }, "big.png"))
    expect(seen.result).toMatchObject({ _tag: "ImageRejected", path: "big.png", mediaType: "image/png", bytes: MEDIA_LIMITS.imageBytes + 1, reason: "TooLarge" })
    expect(seen.view.text).toBe(`[big.png is an image (image/png, 3.8 MB) that read cannot show: the image has ${MEDIA_LIMITS.imageBytes + 1} bytes, more than ${MEDIA_LIMITS.imageBytes}. To see it, make a smaller copy with bash (scaled down or recompressed) and read that.]`)
    expect(seen.view.media).toBeUndefined()
    expect(JSON.stringify(seen.encoded).length).toBeLessThan(1_000)
  })

  test("with readImages false a PNG is a binary file again, and nothing is sent", async () => {
    const seen = await scoped(readThroughRegistry({ readImages: false }, { "chart.png": pixel }, "chart.png"))
    expect(seen.result).toEqual({ _tag: "Binary", path: "chart.png", bytes: 70, mediaType: "image/png" })
    expect(seen.view.text).toBe("[chart.png is a binary file (70 B, image/png); it cannot be shown as text.]")
    expect(seen.view.media).toBeUndefined()
  })
})

describe("files that are not regular files", () => {
  test("read, write, edit and grep refuse a named pipe instead of waiting on it; a directory walk passes it by", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, call } = yield* bench()
      yield* io(() => writeFile(join(root, "notes.txt"), "pipe dream\n"))
      yield* succeeds(BashToolResult)(call("bash", { command: "mkfifo pipe" }))
      return {
        read: yield* fails(call("read", { path: "pipe" })),
        write: yield* fails(call("write", { path: "pipe", content: "x" })),
        edit: yield* fails(call("edit", { path: "pipe", edits: [{ oldText: "a", newText: "b" }] })),
        grep: yield* fails(call("grep", { pattern: "pipe", path: "pipe" })),
        walk: yield* succeeds(GrepResult)(call("grep", { pattern: "pipe" })),
        kind: (yield* io(() => stat(join(root, "pipe")))).isFIFO(),
      }
    }))
    const notAFile = (tool: string) => ({ error: "NotAFile", message: `pipe is not a regular file (a pipe, socket or device); ${tool} works on regular files only, use bash for it` })
    expect([seen.read, seen.write, seen.edit, seen.grep]).toEqual([notAFile("read"), notAFile("write"), notAFile("edit"), notAFile("grep")])
    expect(seen.walk).toMatchObject({ matches: 1, skipped: 0 })
    expect(seen.walk.lines.map((line) => line.path)).toEqual(["notes.txt"])
    expect(seen.kind).toBe(true)
  })
})

describe("confinement", () => {
  test("paths that leave the workspace, by .., by an absolute path or through a link, are refused", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, outside, call } = yield* bench()
      yield* io(() => writeFile(join(outside, "secret.txt"), "secret"))
      yield* io(() => writeFile(join(root, "inside.txt"), "inside"))
      yield* io(() => symlink(join(outside, "secret.txt"), join(root, "leak.txt")))
      yield* io(() => symlink(outside, join(root, "door")))
      yield* io(() => symlink(join(root, "inside.txt"), join(root, "alias.txt")))
      yield* io(() => symlink(join(outside, "missing.txt"), join(root, "dangling.txt")))
      return {
        dots: yield* errorOf(call("read", { path: "../secret.txt" })),
        absolute: yield* errorOf(call("read", { path: join(outside, "secret.txt") })),
        link: yield* errorOf(call("read", { path: "leak.txt" })),
        throughDirectory: yield* errorOf(call("write", { path: "door/new.txt", content: "x" })),
        dangling: yield* errorOf(call("write", { path: "dangling.txt", content: "x" })),
        listOutside: yield* errorOf(call("ls", { path: "door" })),
        absoluteInside: yield* succeeds(ReadResult)(call("read", { path: join(root, "inside.txt") })),
        linkInside: yield* succeeds(ReadResult)(call("read", { path: "alias.txt" })),
        untouched: yield* io(() => readdir(outside)),
      }
    }))
    expect([seen.dots, seen.absolute, seen.link, seen.throughDirectory, seen.listOutside]).toEqual(["OutsideWorkspace", "OutsideWorkspace", "OutsideWorkspace", "OutsideWorkspace", "OutsideWorkspace"])
    expect(seen.dangling).toBe("BrokenSymlink")
    expect(seen.absoluteInside).toMatchObject({ path: "inside.txt", text: "inside" })
    expect(seen.linkInside).toMatchObject({ path: "alias.txt", text: "inside" })
    expect(seen.untouched).toEqual(["secret.txt"])
  })

  test("without confine, paths outside are read; protect still guards writes", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, outside, call } = yield* bench({ confine: false })
      yield* io(() => writeFile(join(outside, "notes.txt"), "far away"))
      return {
        read: yield* succeeds(ReadResult)(call("read", { path: join(outside, "notes.txt") })),
        git: yield* fails(call("write", { path: ".git/config", content: "[core]" })),
        efferent: yield* errorOf(call("edit", { path: join(root, ".efferent/x"), edits: [{ oldText: "a", newText: "b" }] })),
      }
    }))
    expect(seen.read).toMatchObject({ text: "far away" })
    expect(seen.git).toEqual({ error: "Protected", message: ".git/config is protected (.git/**); the workspace tools do not change it" })
    expect(seen.efferent).toBe("Protected")
  })
})

describe("write", () => {
  test("creates parents, replaces through a rename, refuses to empty a file, and keeps a file's permissions", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, capability, call } = yield* bench()
      const created = yield* succeeds(WriteResult)(call("write", { path: "a/b/c.txt", content: "héllo" }))
      const replaced = yield* succeeds(WriteResult)(call("write", { path: "a/b/c.txt", content: "bye" }))
      const emptied = yield* fails(call("write", { path: "a/b/c.txt", content: "" }))
      yield* io(() => writeFile(join(root, "run.sh"), "#!/bin/sh\necho old\n"))
      yield* io(() => chmod(join(root, "run.sh"), 0o755))
      yield* io(() => writeFile(join(root, "private.txt"), "mine"))
      yield* io(() => chmod(join(root, "private.txt"), 0o600))
      yield* succeeds(WriteResult)(call("write", { path: "run.sh", content: "#!/bin/sh\necho new\n" }))
      yield* succeeds(WriteResult)(call("write", { path: "private.txt", content: "still mine" }))
      return {
        created, replaced, emptied,
        view: shown(capability, "write", created, {}),
        content: yield* io(() => readFile(join(root, "a/b/c.txt"), "utf8")),
        modes: [(yield* io(() => stat(join(root, "run.sh")))).mode & 0o777, (yield* io(() => stat(join(root, "private.txt")))).mode & 0o777],
        shared: yield* Effect.forEach([0o664, 0o644, 0o640, 0o666], (mode) => Effect.gen(function* () {
          // Whatever the umask, a rename would give one of these a new file's mode: each keeps its own.
          const name = `mode-${mode.toString(8)}.txt`
          yield* io(() => writeFile(join(root, name), "before"))
          yield* io(() => chmod(join(root, name), mode))
          yield* succeeds(WriteResult)(call("write", { path: name, content: "after" }))
          yield* succeeds(EditResult)(call("edit", { path: name, edits: [{ oldText: "after", newText: "edited" }] }))
          const after = yield* io(() => stat(join(root, name)))
          return [after.mode & 0o777, yield* io(() => readFile(join(root, name), "utf8"))]
        })),
        leftovers: (yield* io(() => readdir(join(root, "a/b")))).filter((name) => name.includes("efferent-tmp")),
        directory: yield* fails(call("write", { path: "a", content: "x" })),
        empty: yield* succeeds(WriteResult)(call("write", { path: "empty.txt", content: "" })),
      }
    }))
    expect(seen.created).toEqual({ path: "a/b/c.txt", bytes: 6, created: true })
    expect(seen.replaced).toEqual({ path: "a/b/c.txt", bytes: 3, created: false })
    expect(seen.view).toBe("Created a/b/c.txt (6 B).")
    expect([seen.emptied, seen.content, seen.directory]).toEqual([
      { error: "WouldEmpty", message: "a/b/c.txt has content; write refuses to empty it. Use edit to remove parts of it, or bash to delete it" },
      "bye",
      { error: "IsDirectory", message: "a is a directory; write takes the path of a file" },
    ])
    expect(seen.modes).toEqual([0o755, 0o600])
    expect(seen.shared).toEqual([[0o664, "edited"], [0o644, "edited"], [0o640, "edited"], [0o666, "edited"]])
    expect(seen.leftovers).toEqual([])
    expect(seen.empty).toEqual({ path: "empty.txt", bytes: 0, created: true })
  })
})

describe("edit", () => {
  test("keeps the BOM and CRLF endings, and returns a diff with a one-line view", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, capability, call } = yield* bench()
      yield* io(() => writeFile(join(root, "win.txt"), "﻿first\r\nsecond\r\nthird\r\n"))
      const params = { path: "win.txt", edits: [{ oldText: "second", newText: "2nd" }, { oldText: "third", newText: "3rd\nfourth" }] }
      const result = yield* succeeds(EditResult)(call("edit", params))
      return {
        result,
        view: shown(capability, "edit", result, params),
        bytes: [...new Uint8Array(yield* io(() => readFile(join(root, "win.txt"))))].slice(0, 3),
        text: yield* io(() => readFile(join(root, "win.txt"), "utf8")),
        missing: yield* fails(call("edit", { path: "nope.txt", edits: [{ oldText: "a", newText: "b" }] })),
        noMatch: yield* fails(call("edit", { path: "win.txt", edits: [{ oldText: "absent", newText: "b" }] })),
        latin1: yield* io(() => writeFile(join(root, "latin1.txt"), latin1)).pipe(Effect.andThen(fails(call("edit", { path: "latin1.txt", edits: [{ oldText: "x=1", newText: "x=2" }] })))),
        latin1Bytes: [...new Uint8Array(yield* io(() => readFile(join(root, "latin1.txt"))))],
      }
    }))
    expect(seen.result).toEqual({
      path: "win.txt", replaced: 2, normalized: false, firstChangedLine: 2,
      diff: "--- win.txt\n+++ win.txt\n@@ -1,3 +1,4 @@\n first\n-second\n-third\n+2nd\n+3rd\n+fourth\n",
    })
    expect(seen.view).toBe("Replaced 2 blocks in win.txt; the first change is at line 2.")
    expect(seen.bytes).toEqual([0xef, 0xbb, 0xbf])
    expect(seen.text).toBe("﻿first\r\n2nd\r\n3rd\r\nfourth\r\n")
    expect([seen.missing, seen.noMatch, seen.latin1]).toEqual([
      { error: "NotFound", message: "nope.txt does not exist; use write to create it" },
      { error: "NoMatch", message: "oldText was not found in the file; read it again and copy the text exactly, whitespace included" },
      { error: "NotUtf8", message: "latin1.txt is not valid UTF-8 (Latin-1 or another encoding, say); edit changes UTF-8 text files only, since it would replace the bytes it cannot decode. Use bash (sed, iconv) to change it" },
    ])
    expect(seen.latin1Bytes).toEqual([...latin1])
  })

  test("refuses a directory, a binary file and a file over maxFileBytes, saying why", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, call } = yield* bench({ maxFileBytes: 1_024 })
      yield* io(() => mkdir(join(root, "src")))
      yield* io(() => writeFile(join(root, "data.bin"), new Uint8Array([0x61, 0, 0x62])))
      yield* io(() => writeFile(join(root, "big.log"), "x".repeat(2_048)))
      const edit = (path: string) => fails(call("edit", { path, edits: [{ oldText: "a", newText: "b" }] }))
      return [yield* edit("src"), yield* edit("data.bin"), yield* edit("big.log")]
    }))
    expect(seen).toEqual([
      { error: "IsDirectory", message: "src is a directory; edit takes the path of a file" },
      { error: "BinaryFile", message: "data.bin is a binary file; edit changes text files only" },
      { error: "FileTooLarge", message: "big.log is 2 KB, more than the 1 KB edit loads; change it with bash (sed -i, or a script)" },
    ])
  })

  test("edits of one file, from calls running at once, are applied one after the other", async () => {
    const text = await scoped(Effect.gen(function* () {
      const memory = yield* makeMemoryFileSystem({ "/work/shared.txt": "a = 1\nb = 2\nc = 3\n" })
      // Time between reading a file and writing it: without the file's lock, every edit would read the original and the last write would win.
      const slow = FileSystem.of({ ...memory, readBytes: (path, range) => memory.readBytes(path, range).pipe(Effect.tap(() => Effect.sleep("20 millis"))) })
      const capability = yield* workspaceTools({ ...workspaceToolsDefaults, tools: ["edit"] })
      const call = caller(capability, Context.make(FileSystem, slow).pipe(Context.add(SessionEnvironment, { workspace: "/work" })))
      yield* Effect.all(["a", "b", "c"].map((name) => succeeds(EditResult)(call("edit", { path: "shared.txt", edits: [{ oldText: `${name} = `, newText: `${name} := ` }] }))), { concurrency: "unbounded" })
      return yield* memory.read("/work/shared.txt")
    }))
    expect(text).toBe("a := 1\nb := 2\nc := 3\n")
  })
})

describe("ls, find and grep", () => {
  const tree = (root: string, outside: string) => Effect.gen(function* () {
    yield* io(() => mkdir(join(root, "src/lib"), { recursive: true }))
    yield* io(() => mkdir(join(root, "node_modules/dep"), { recursive: true }))
    yield* io(() => mkdir(join(root, ".github")))
    yield* io(() => writeFile(join(root, "src/main.ts"), "import { helper } from './lib/helper'\n// TODO: tidy\nhelper()\n"))
    yield* io(() => writeFile(join(root, "src/lib/helper.ts"), "export const helper = () => 1 // todo\n"))
    yield* io(() => writeFile(join(root, "src/lib/data.bin"), new Uint8Array([0x54, 0x4f, 0x44, 0x4f, 0, 1])))
    yield* io(() => writeFile(join(root, "node_modules/dep/index.ts"), "// TODO hidden\n"))
    yield* io(() => writeFile(join(root, ".github/ci.yml"), "# TODO ci\n"))
    yield* io(() => writeFile(join(root, "README.md"), "# Readme\n"))
    yield* io(() => writeFile(join(outside, "far.ts"), "// TODO far\n"))
    yield* io(() => symlink(outside, join(root, "linked")))
    yield* io(() => symlink(join(outside, "far.ts"), join(root, "src/far.ts")))
  })

  test("ls lists entries by name with their kinds", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, outside, capability, call } = yield* bench()
      yield* tree(root, outside)
      const all = yield* succeeds(LsResult)(call("ls", {}))
      const limited = yield* succeeds(LsResult)(call("ls", { path: "src", limit: 2 }))
      return { all, view: shown(capability, "ls", all, {}), limited, limitedView: shown(capability, "ls", limited, {}), file: yield* fails(call("ls", { path: "README.md" })) }
    }))
    expect(seen.all.entries.map((entry) => entry.name)).toEqual([".github", "README.md", "linked", "node_modules", "src"])
    expect(seen.view).toBe(".github/\nREADME.md\nlinked@\nnode_modules/\nsrc/")
    expect(seen.limited).toEqual({ path: "src", entries: [{ name: "far.ts", kind: "symlink" }, { name: "lib", kind: "directory" }], total: 3 })
    expect(seen.limitedView).toBe("far.ts@\nlib/\n[Showing 2 of 3 entries. Use find with a pattern to narrow them down.]")
    expect(seen.file).toEqual({ error: "NotDirectory", message: "README.md is not a directory; use read to see a file" })
  })

  test("find matches globs from the root or a path, skipping excluded names and links", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, outside, call } = yield* bench()
      yield* tree(root, outside)
      return {
        ts: yield* succeeds(FindResult)(call("find", { pattern: "**/*.ts" })),
        lib: yield* succeeds(FindResult)(call("find", { pattern: "*", path: "src/lib" })),
        dotted: yield* succeeds(FindResult)(call("find", { pattern: "**/*.yml" })),
        limited: yield* succeeds(FindResult)(call("find", { pattern: "**/*", limit: 2 })),
        escape: yield* fails(call("find", { pattern: "../*" })),
        unusable: yield* fails(call("find", { pattern: "{a,b}".repeat(11) })),
      }
    }))
    expect(seen.ts).toEqual({ pattern: "**/*.ts", path: ".", paths: ["src/lib/helper.ts", "src/main.ts"], truncated: false })
    expect(seen.lib.paths).toEqual(["src/lib/data.bin", "src/lib/helper.ts"])
    expect(seen.dotted.paths).toEqual([".github/ci.yml"])
    expect(seen.limited).toMatchObject({ paths: [".github/ci.yml", "README.md"], truncated: true })
    expect([seen.escape, seen.unusable]).toEqual([
      { error: "InvalidPattern", message: "../*: a glob pattern is relative to its cwd and stays below it (no leading / or .. segment)" },
      { error: "InvalidPattern", message: `${"{a,b}".repeat(11)}: not a usable glob pattern: its braces stand for more than 1024 patterns` },
    ])
  })

  test("grep searches text files, never through links or excluded names, with context and caps", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, outside, capability, call } = yield* bench()
      yield* tree(root, outside)
      const todo = yield* succeeds(GrepResult)(call("grep", { pattern: "todo", ignoreCase: true }))
      const withContext = { pattern: "TODO", path: "src/main.ts", context: 1 }
      const context = yield* succeeds(GrepResult)(call("grep", withContext))
      return {
        todo, todoView: shown(capability, "grep", todo, { pattern: "todo" }),
        context, contextView: shown(capability, "grep", context, withContext),
        globbed: yield* succeeds(GrepResult)(call("grep", { pattern: "helper", glob: "*.ts" })),
        literal: yield* succeeds(GrepResult)(call("grep", { pattern: "helper()", literal: true })),
        invalid: yield* fails(call("grep", { pattern: "helper(" })),
        unusableGlob: yield* fails(call("grep", { pattern: "helper", glob: "{a,b}".repeat(11) })),
        none: yield* succeeds(GrepResult)(call("grep", { pattern: "absent" })),
      }
    }))
    expect(seen.todo.lines).toEqual([
      { path: ".github/ci.yml", line: 1, text: "# TODO ci", match: true },
      { path: "src/lib/helper.ts", line: 1, text: "export const helper = () => 1 // todo", match: true },
      { path: "src/main.ts", line: 2, text: "// TODO: tidy", match: true },
    ])
    expect(seen.todo).toMatchObject({ matches: 3, files: 3, truncated: false, skipped: 1 })
    expect(seen.todoView).toBe([
      ".github/ci.yml:1:# TODO ci",
      "src/lib/helper.ts:1:export const helper = () => 1 // todo",
      "src/main.ts:2:// TODO: tidy",
      "[1 file skipped: binary, larger than the read limit, or leading outside the workspace.]",
    ].join("\n"))
    expect(seen.contextView).toBe("src/main.ts-1-import { helper } from './lib/helper'\nsrc/main.ts:2:// TODO: tidy\nsrc/main.ts-3-helper()")
    expect(seen.globbed.lines.map((line) => line.path)).toEqual(["src/lib/helper.ts", "src/main.ts", "src/main.ts"])
    expect(seen.literal.lines.map((line) => `${line.path}:${line.line}`)).toEqual(["src/main.ts:3"])
    // The message, with the engine's reason in it, is pinned beside compilePattern.
    expect(seen.invalid.error).toBe("InvalidPattern")
    expect(seen.unusableGlob).toEqual({ error: "InvalidPattern", message: `glob ${"{a,b}".repeat(11)}: not a usable glob pattern: its braces stand for more than 1024 patterns` })
    expect(seen.none.matches).toBe(0)
  })

  test("an exclude written as a path is relative to the root, wherever find and grep start", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, call } = yield* bench({ exclude: ["node_modules", "src/gen"] })
      yield* io(() => mkdir(join(root, "src/gen"), { recursive: true }))
      yield* io(() => mkdir(join(root, "src/lib/gen"), { recursive: true }))
      yield* io(() => writeFile(join(root, "src/gen/made.ts"), "// mark\n"))
      yield* io(() => writeFile(join(root, "src/lib/gen/kept.ts"), "// mark\n"))
      yield* io(() => writeFile(join(root, "src/main.ts"), "// mark\n"))
      return {
        fromRoot: yield* succeeds(FindResult)(call("find", { pattern: "**/*.ts" })),
        fromSrc: yield* succeeds(FindResult)(call("find", { pattern: "**/*.ts", path: "src" })),
        grepSrc: yield* succeeds(GrepResult)(call("grep", { pattern: "mark", path: "src" })),
        asked: yield* succeeds(FindResult)(call("find", { pattern: "*", path: "src/gen" })),
      }
    }))
    expect(seen.fromRoot.paths).toEqual(["src/lib/gen/kept.ts", "src/main.ts"])
    expect(seen.fromSrc.paths).toEqual(["src/lib/gen/kept.ts", "src/main.ts"])
    expect(seen.grepSrc.lines.map((line) => line.path)).toEqual(["src/lib/gen/kept.ts", "src/main.ts"])
    expect(seen.asked.paths).toEqual(["src/gen/made.ts"])
  })

  test("grep stops at its limit, and one file of many gives at most a quarter of it", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, call } = yield* bench({ grepMatches: 8 })
      yield* io(() => writeFile(join(root, "a.txt"), "hit\n".repeat(20)))
      yield* io(() => writeFile(join(root, "b.txt"), "hit\n".repeat(20)))
      return {
        many: yield* succeeds(GrepResult)(call("grep", { pattern: "hit" })),
        one: yield* succeeds(GrepResult)(call("grep", { pattern: "hit", path: "a.txt" })),
      }
    }))
    expect(seen.many).toMatchObject({ matches: 4, files: 2, truncated: true })
    expect(seen.many.lines.map((line) => line.path)).toEqual(["a.txt", "a.txt", "b.txt", "b.txt"])
    expect(seen.one).toMatchObject({ matches: 8, files: 1, truncated: true })
  })

  test("grep names a file it may not read as permission denied, not as skipped", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, capability, call } = yield* bench()
      yield* io(() => writeFile(join(root, "open.txt"), "hit\n"))
      yield* io(() => writeFile(join(root, "secret.txt"), "hit\n"))
      yield* io(() => chmod(join(root, "secret.txt"), 0o000))
      const result = yield* succeeds(GrepResult)(call("grep", { pattern: "hit" }))
      yield* io(() => chmod(join(root, "secret.txt"), 0o600))
      return { result, view: shown(capability, "grep", result, { pattern: "hit" }) }
    }))
    // A superuser reads any file: then both match.
    if (process.getuid?.() === 0) expect(seen.result).toMatchObject({ matches: 2, skipped: 0, unreadable: [] })
    else {
      expect(seen.result).toMatchObject({ matches: 1, skipped: 0, unreadable: [{ path: "secret.txt", reason: "Permission" }] })
      expect(seen.view).toBe("open.txt:1:hit\n[Could not read 1 file, permission denied: secret.txt.]")
    }
  })

  test("read, ls, find and grep show the model the largest limit they take, and refuse a larger one; each tool carries its description", async () => {
    const options = { maxLines: 40, lsEntries: 30, findResults: 20, grepMatches: 10 }
    const tools = await scoped(Effect.gen(function* () {
      const { capability } = yield* bench(options)
      return capability.tools
    }))
    const tool = (name: string) => Option.getOrThrow(Option.fromNullishOr(tools.find((entry) => entry.tool.name === name))).tool
    const maxima = ["read", "ls", "find", "grep"].map((name) => {
      const limit: unknown = Object.entries(toolParametersSchema(tool(name)).properties ?? {}).find(([key]) => key === "limit")?.[1]
      return [name, typeof limit === "object" && limit !== null && "maximum" in limit ? limit.maximum : undefined]
    })
    expect(maxima).toEqual([["read", 40], ["ls", 30], ["find", 20], ["grep", 10]])
    const decodes = (name: string, params: unknown) => Schema.is(tool(name).parametersSchema)(params)
    expect([decodes("ls", { limit: 30 }), decodes("ls", { limit: 31 }), decodes("grep", { pattern: "x", limit: 11 }), decodes("read", { path: "a", limit: 0 })])
      .toEqual([true, false, false, false])
    // The descriptions' words are pinned beside toolDescriptions.
    expect(Object.fromEntries(tools.map((entry) => [entry.tool.name, entry.tool.description]))).toEqual(toolDescriptions({ ...workspaceToolsDefaults, ...options }))
  })
})

describe("bash", () => {
  test("exit codes are results; stdin, the environment allowlist and the host's variables reach the command", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, capability, call } = yield* bench({ bashEnv: { GREETING: "hi" } }, { SECRET_TOKEN: "s3cret", LC_PROBE: "c" })
      const failed = yield* succeeds(BashToolResult)(call("bash", { command: "echo out; sleep 0.1; echo err >&2; exit 3" }))
      return {
        failed, failedView: shown(capability, "bash", failed, {}),
        stdin: yield* succeeds(BashToolResult)(call("bash", { command: "tr a-z A-Z", stdin: "shout" })),
        env: yield* succeeds(BashToolResult)(call("bash", { command: "echo \"$GREETING:${SECRET_TOKEN:-none}:$LC_PROBE:${PATH:+path}\"; pwd" })),
        root,
      }
    }))
    expect(seen.failed).toMatchObject({ output: "out\nerr", exitCode: 3, termination: "exit", truncated: false, fullOutput: null, totalLines: 2 })
    expect(seen.failedView).toBe("out\nerr\n[Exit code 3.]")
    expect(seen.stdin.output).toBe("SHOUT")
    expect(seen.env.output).toBe(`hi:none:c:path\n${seen.root}`)
  })

  test("the model's timeout is capped, and a command past it is killed and reported", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { capability, call } = yield* bench({ bashTimeoutMs: 200, bashMaxTimeoutMs: 1_000 })
      const slow = yield* succeeds(BashToolResult)(call("bash", { command: "echo started; sleep 5" }))
      const capped = yield* succeeds(BashToolResult)(call("bash", { command: "sleep 5", timeout: 600 }))
      return { slow, view: shown(capability, "bash", slow, {}), capped }
    }))
    expect(seen.slow).toMatchObject({ output: "started", termination: "timeout", exitCode: null })
    // How long it ran varies; the words are pinned beside renderBash.
    expect(seen.view).toMatch(/^started\n\[The command was killed after \d+\.\d s, at its timeout\.\]$/)
    expect(seen.capped.termination).toBe("timeout")
    expect(seen.capped.durationMs).toBeLessThan(4_000)
  })

  test("long output is cut to its tail, saved whole under spillDir, and only the newest spillKeep files stay", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, capability, call } = yield* bench({ maxLines: 5, spillKeep: 2 })
      const long = yield* succeeds(BashToolResult)(call("bash", { command: "seq 1 50" }))
      yield* succeeds(BashToolResult)(call("bash", { command: "seq 1 60" }))
      yield* Effect.sleep("5 millis")
      const last = yield* succeeds(BashToolResult)(call("bash", { command: "seq 1 70" }))
      const short = yield* succeeds(BashToolResult)(call("bash", { command: "seq 1 5" }))
      const spillDir = join(root, ".efferent/runtime/tool-output")
      return {
        long, view: shown(capability, "bash", long, {}), last, short,
        whole: yield* io(() => readFile(join(root, last.fullOutput ?? "missing"), "utf8")),
        kept: (yield* io(() => readdir(spillDir))).length,
        reread: yield* succeeds(ReadResult)(call("read", { path: last.fullOutput ?? "missing", offset: 66 })),
      }
    }))
    expect(seen.long).toMatchObject({ output: "46\n47\n48\n49\n50", truncated: true, totalLines: 50 })
    expect(seen.long.fullOutput).toStartWith(".efferent/runtime/tool-output/bash-")
    expect(seen.view).toBe(`46\n47\n48\n49\n50\n[Output cut to its last 5 of 50 lines. The whole output is in ${seen.long.fullOutput}; read it with offset to see the rest.]\n[Exit code 0.]`)
    expect(seen.whole).toBe(`${Array.from({ length: 70 }, (_, at) => at + 1).join("\n")}\n`)
    expect(seen.kept).toBe(2)
    expect(seen.short).toMatchObject({ truncated: false, fullOutput: null })
    expect(seen.reread).toMatchObject({ text: "66\n67\n68\n69\n70" })
  })

  test("a command that cannot run at all is a failure with the Bash service's reason and message, as they are", async () => {
    const refused = new BashError({ reason: "SpawnFailed", message: "could not read the command's stdout: read failed" })
    const failing = Bash.of({ stream: () => Stream.fail(refused), exec: () => Effect.fail(refused) })
    const failure = await scoped(Effect.gen(function* () {
      const root = yield* temporary
      const capability = yield* workspaceTools({ ...workspaceToolsDefaults, tools: ["bash"] }).pipe(Effect.provideService(Bash, failing))
      const call = caller(capability, Context.make(FileSystem, localFileSystem).pipe(Context.add(SessionEnvironment, { workspace: root }), Context.add(Bash, failing)))
      return yield* fails(call("bash", { command: "echo hi" }))
    }))
    expect(failure).toEqual({ error: "SpawnFailed", message: "could not read the command's stdout: read failed" })
  })
})

describe("bash output at the limits", () => {
  test("output exactly as long as the limit is shown whole, with or without a last newline, and nothing is saved", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { call } = yield* bench({ maxBytes: 1_024 })
      return {
        open: yield* succeeds(BashToolResult)(call("bash", { command: "head -c 1024 /dev/zero | tr '\\0' y" })),
        closed: yield* succeeds(BashToolResult)(call("bash", { command: "head -c 1024 /dev/zero | tr '\\0' y; echo" })),
        // 1030 bytes, of which the view drops a \r per line and the last \n: 1019 are shown.
        crlf: yield* succeeds(BashToolResult)(call("bash", { command: "for n in $(seq 1 10); do printf '%0101d\\r\\n' 0; done" })),
        over: yield* succeeds(BashToolResult)(call("bash", { command: "head -c 1025 /dev/zero | tr '\\0' y" })),
      }
    }))
    expect(seen.open).toMatchObject({ truncated: false, fullOutput: null, totalLines: 1 })
    expect(seen.open.output).toHaveLength(1_024)
    expect(seen.closed).toMatchObject({ truncated: false, fullOutput: null, totalLines: 1 })
    expect(seen.crlf).toMatchObject({ truncated: false, fullOutput: null, totalLines: 10 })
    expect(seen.over).toMatchObject({ truncated: true, fullOutputCut: false })
    expect(seen.over.fullOutput).not.toBeNull()
  })

  test("a spill file stops growing at maxFileBytes, keeping the output's start, and the result says so", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, capability, call } = yield* bench({ maxLines: 5, maxBytes: 1_024, maxFileBytes: 2_048 })
      const result = yield* succeeds(BashToolResult)(call("bash", { command: "seq 1 2000" }))
      const saved = yield* io(() => readFile(join(root, result.fullOutput ?? "missing"), "utf8"))
      return { result, saved, view: shown(capability, "bash", result, {}), reread: yield* succeeds(ReadResult)(call("read", { path: result.fullOutput ?? "missing" })) }
    }))
    const whole = `${Array.from({ length: 2_000 }, (_, at) => at + 1).join("\n")}\n`
    expect(seen.result).toMatchObject({ output: "1996\n1997\n1998\n1999\n2000", truncated: true, totalLines: 2_000, fullOutputCut: true })
    expect(seen.saved).toHaveLength(2_048)
    expect(whole.startsWith(seen.saved)).toBe(true)
    expect(seen.view).toBe([
      "1996\n1997\n1998\n1999\n2000",
      `[Output cut to its last 5 of 2000 lines. Only its start was saved, in ${seen.result.fullOutput}: the output grew past the size read opens, and the rest was not kept. Read the file with offset to see that start; to see the rest, run the command again with its output filtered (grep, tail, sed -n).]`,
      "[Exit code 0.]",
    ].join("\n"))
    expect(seen.reread).toMatchObject({ _tag: "Text", firstLine: 1 })
  })
})

describe("workspaceToolsPlugin", () => {
  test("without a Bash service there is no bash tool and no workspace.shell skill", async () => {
    const capability = await scoped(workspaceTools(workspaceToolsDefaults))
    expect(capability.tools.map((entry) => entry.tool.name)).toEqual(["read", "ls", "find", "grep", "write", "edit"])
    expect<unknown>(capability.skills.map((skill) => [skill.id, skill.always, skill.permissions])).toEqual([
      ["workspace.read", true, []],
      ["workspace.edit", false, ["fs.write"]],
    ])
    expect(capability.promptSections.map((section) => [section.id, section.tier, section.order])).toEqual([["workspace.environment", "session", 800]])
  })

  test("each tool declares the services it reads on each call: the file system and the session's workspace, and bash the shell too", async () => {
    const { capability } = await scoped(bench())
    const workspace = [FileSystem.key, SessionEnvironment.key]
    expect(capability.tools.map((entry) => [entry.tool.name, entry.requires])).toEqual([
      ...["read", "ls", "find", "grep", "write", "edit"].map((name) => [name, workspace]),
      ["bash", [...workspace, Bash.key]],
    ])
  })

  test("the environment section declares the same services: it renders the workspace where they are, and fails with requires.missing where they are not", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const { root, capability } = yield* bench()
      const [section] = capability.promptSections
      const render = section!.render({ variant: Option.none(), active: [], skills: [] })
      const services = Context.make(FileSystem, localFileSystem).pipe(Context.add(SessionEnvironment, { workspace: root }))
      return {
        root,
        requires: section!.requires,
        text: Option.getOrElse(yield* render.pipe(Effect.provide(services)), () => ""),
        missing: yield* Effect.flip(render.pipe(Effect.provideService(FileSystem, localFileSystem))),
      }
    }))
    expect(seen.requires).toEqual([FileSystem.key, SessionEnvironment.key])
    expect(seen.text).toContain(seen.root)
    expect(seen.missing).toMatchObject({ code: "requires.missing", message: `workspace.environment requires ${SessionEnvironment.key}` })
  })

  test("the skills' catalogue summaries, word for word", async () => {
    const capability = await scoped(bench().pipe(Effect.map((built) => built.capability)))
    expect(capability.skills.map((skill) => [skill.id, skill.summary])).toEqual([
      ["workspace.read", "Read, list and search the workspace's files (read, ls, find, grep)."],
      ["workspace.edit", "Create and change files in the workspace (write, edit)."],
      ["workspace.shell", "Run shell commands in the workspace (bash)."],
    ])
  })

  test("resolves in a graph after the local system, with Bash, and refuses bad options", async () => {
    const tools = await scoped(Effect.gen(function* () {
      const graph = yield* resolveGraph({ version: 1, plugins: [
        { id: PluginInstanceId.make("local"), use: localSystemPlugin.id, options: { exitGraceMs: 100 } },
        { id: PluginInstanceId.make("tools"), use: workspaceToolsPlugin.id, options: { always: ["read", "shell"], tools: ["read", "bash"] } },
      ] }, [workspaceToolsPlugin, localSystemPlugin], [SessionEnvironment.key])
      const context = yield* activateGraph(graph, "runtime", Context.make(SessionEnvironment, { workspace: "." }), yield* Effect.scope)
      const contributed: ReadonlyArray<Capability> = Option.getOrElse(Context.getOption(context, Capabilities), () => [])
      return contributed.flatMap((capability) => capability.skills.map((skill) => `${skill.id}:${skill.tools.join(",")}:${skill.always}`))
    }))
    expect(tools).toEqual(["workspace.read:read:true", "workspace.shell:bash:true"])
    const refused = await Promise.all([
      { bashTimeoutMs: 10_000, bashMaxTimeoutMs: 5_000 },
      { spillDir: "../elsewhere" },
      { spillDir: "/tmp/out" },
      { tools: ["cat"] },
      { maxBytes: 10 },
      { unknown: true },
      { protect: ["{a,b}".repeat(11)] },
      { exclude: ["{a,b}".repeat(11)] },
    ].map((options) => Effect.runPromise(Effect.flip(resolveGraph({ version: 1, plugins: [{ id: PluginInstanceId.make("tools"), use: workspaceToolsPlugin.id, options }] }, [workspaceToolsPlugin], [FileSystem.key, SessionEnvironment.key]))).then((error) => error.code)))
    expect(refused).toEqual(Array.from({ length: 8 }, () => "config.options"))
    const badGlob = await Effect.runPromise(Effect.flip(Effect.scoped(Layer.build(WorkspaceToolsPluginLive({ protect: ["{a,b}".repeat(11)] })))))
    expect(badGlob.message).toContain("protect")
  })
})

describe("host file-tool roots", () => {
  test("read, ls, find and grep use an extra read root; write and edit refuse it and allow a more specific writable root", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const root = yield* temporary
      const references = yield* temporary
      yield* io(() => writeFile(join(references, "notes.txt"), "alpha\nbeta\n"))
      yield* io(() => mkdir(join(references, "drafts")))
      yield* io(() => symlink(references, join(root, "reference-link")))
      const capability = yield* workspaceTools({ ...workspaceToolsDefaults, tools: ["read", "ls", "find", "grep", "write", "edit"], roots: [
        { path: references, access: "read" }, { path: join(references, "drafts"), access: "write" },
      ] })
      const call = caller(capability, Context.make(FileSystem, localFileSystem).pipe(Context.add(SessionEnvironment, { workspace: root })))
      const read = yield* succeeds(ReadResult)(call("read", { path: join(references, "notes.txt") }))
      const list = yield* succeeds(LsResult)(call("ls", { path: references }))
      const find = yield* succeeds(FindResult)(call("find", { path: references, pattern: "*.txt" }))
      const grep = yield* succeeds(GrepResult)(call("grep", { path: "reference-link/notes.txt", pattern: "alpha" }))
      const refused = yield* Effect.all([
        fails(call("write", { path: join(references, "notes.txt"), content: "changed" })),
        fails(call("edit", { path: "reference-link/notes.txt", edits: [{ oldText: "alpha", newText: "changed" }] })),
      ])
      const written = yield* succeeds(WriteResult)(call("write", { path: join(references, "drafts/new.txt"), content: "draft" }))
      return { read, list, find, grep, refused, written, unchanged: yield* io(() => readFile(join(references, "notes.txt"), "utf8")), references }
    }))
    expect(seen.read).toMatchObject({ _tag: "Text", text: "alpha\nbeta" })
    expect(seen.list.entries.map((entry) => entry.name)).toEqual(["drafts", "notes.txt"])
    expect(seen.find.paths).toEqual([join(seen.references, "notes.txt")])
    expect(seen.grep.lines.map((line) => line.text)).toEqual(["alpha"])
    expect(seen.refused.map((failure) => failure.error)).toEqual(["ReadOnly", "ReadOnly"])
    expect(seen.written.created).toBe(true)
    expect(seen.unchanged).toBe("alpha\nbeta\n")
  })

  test("a read-only workspace still supports reads and bash, while file writes refuse before changing it", async () => {
    const seen = await scoped(Effect.gen(function* () {
      const built = yield* bench({ workspaceAccess: "read" })
      yield* io(() => writeFile(join(built.root, "notes.txt"), "original"))
      const read = yield* succeeds(ReadResult)(built.call("read", { path: "notes.txt" }))
      const refused = yield* fails(built.call("write", { path: "notes.txt", content: "replacement" }))
      const shell = yield* succeeds(BashToolResult)(built.call("bash", { command: "printf from-shell > notes.txt" }))
      return { read, refused, shell, after: yield* io(() => readFile(join(built.root, "notes.txt"), "utf8")) }
    }))
    expect(seen.read).toMatchObject({ _tag: "Text", text: "original" })
    expect(seen.refused).toEqual({ error: "ReadOnly", message: "notes.txt is under the workspace root, which the workspace tools may read but not change" })
    expect(seen.shell.exitCode).toBe(0)
    expect(seen.after).toBe("from-shell")
  })
})

test("workspace protect globs still reject an extra-root alias into .git, and do not cover an explicitly writable extra root's own .git", async () => {
  const seen = await scoped(Effect.gen(function* () {
    const root = yield* temporary
    const extra = yield* temporary
    yield* io(() => mkdir(join(root, ".git")))
    yield* io(() => writeFile(join(root, ".git/config"), "workspace config"))
    yield* io(() => mkdir(join(extra, ".git")))
    yield* io(() => writeFile(join(extra, ".git/config"), "external config"))
    yield* io(() => symlink(join(root, ".git/config"), join(extra, "workspace-alias")))
    const capability = yield* workspaceTools({ ...workspaceToolsDefaults, tools: ["write", "find"], roots: [{ path: extra, access: "write" }] })
    const call = caller(capability, Context.make(FileSystem, localFileSystem).pipe(Context.add(SessionEnvironment, { workspace: root })))
    const refused = yield* fails(call("write", { path: join(extra, "workspace-alias"), content: "replacement" }))
    yield* succeeds(WriteResult)(call("write", { path: join(extra, ".git/config"), content: "explicit external change" }))
    const found = yield* succeeds(FindResult)(call("find", { path: extra, pattern: "**/*" }))
    return { refused, found, workspace: yield* io(() => readFile(join(root, ".git/config"), "utf8")), external: yield* io(() => readFile(join(extra, ".git/config"), "utf8")) }
  }))
  expect(seen.refused.error).toBe("Protected")
  expect(seen.workspace).toBe("workspace config")
  expect(seen.external).toBe("explicit external change")
  expect(seen.found.paths.some((path) => path.includes("/.git/"))).toBe(false)
})
