import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import { Bash, BashError, FileSystem, fitTarget, ImageResizer, imageSizeOf, mediaFromBytes } from "@xandreed/core"
import { imageResizerConformance, imageResizerPng } from "@xandreed/core/conformance"
import { BashLive } from "./bash.adapter.js"
import { localFileSystem } from "./file-system.adapter.js"
import { ImageResizerCliLive } from "./image-resizer.adapter.js"
import type { BashResult } from "@xandreed/core"
import { imageResizeCommand } from "./image-resizer.entity.functions.js"

const magick = spawnSync("magick", ["-version"]).status === 0
const convert = spawnSync("convert", ["-version"]).status === 0
const vips = spawnSync("vipsthumbnail", ["--version"]).status === 0
const tool = magick ? "magick" as const : "convert" as const
const live = (choice: "magick" | "convert" | "vips" = tool, tempDir: string | null = null) => Layer.build(ImageResizerCliLive({ tool: choice, tempDir }).pipe(
  Layer.provide(Layer.merge(Layer.succeed(FileSystem, localFileSystem), BashLive())),
)).pipe(Effect.map((context) => Context.get(context, ImageResizer)))

imageResizerConformance({ open: () => live() }).forEach((check) => {
  test.skipIf(!magick && !convert)(`the CLI passes the image resize kit: ${check.name}`, () => Effect.runPromise(check.run))
})

const temporary = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "efferent-image-resizer-"))).pipe(Effect.flatMap((dir) => Effect.tryPromise(() => realpath(dir)))),
  (dir) => Effect.tryPromise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.orDie),
)

test.skipIf(!magick && !convert)("conversion removes its private directory after success and decode failure", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const dir = yield* temporary
  const resizer = yield* live(tool, dir)
  const resized = yield* resizer.fit({ bytes: imageResizerPng(9000, 10), mediaType: "image/png" }, fitTarget())
  expect(Option.getOrThrow(imageSizeOf(resized, "image/png"))).toEqual({ width: 8000, height: 9 })
  expect(yield* Effect.tryPromise(() => readdir(dir))).toEqual([])
  const corrupt = imageResizerPng(9000, 10).slice(0, 40)
  expect(yield* Effect.flip(resizer.fit({ bytes: corrupt, mediaType: "image/png" }, fitTarget()))).toMatchObject({ _tag: "ImageResizeError", reason: "Failed" })
  expect(yield* Effect.tryPromise(() => readdir(dir))).toEqual([])
}))))

test.skipIf(!vips)("libvips also fits the side limit without enlarging the source", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const resizer = yield* live("vips")
  const resized = yield* resizer.fit({ bytes: imageResizerPng(9000, 10), mediaType: "image/png" }, fitTarget())
  expect(Option.getOrThrow(imageSizeOf(resized, "image/png"))).toEqual({ width: 8000, height: 9 })
}))))

test("tool arguments remain literal and each backend preserves the resize box", () => {
  expect(imageResizeCommand("magick", "/tmp/a'b", "/tmp/out.png", 128)).toBe("'magick' '/tmp/a'\\''b[0]' '-coalesce' '-auto-orient' '-strip' '-resize' '128x128>' '-quality' '85' '/tmp/out.png'")
  expect(imageResizeCommand("vips", "/tmp/in", "/tmp/out.png", 128)).toBe("'vipsthumbnail' '/tmp/in' '--size' '128x128>' '--path' '/tmp/out.png[strip]'")
  expect(imageResizeCommand("sips", "/tmp/in", "/tmp/out.png", 128)).toBe("'sips' '-s' 'format' 'png' '-Z' '128' '/tmp/in' '--out' '/tmp/out.png'")
})


const ok: BashResult = { stdout: "", stderr: "", exitCode: Option.some(0), signal: Option.none(), termination: "exit", durationMs: 1 }

test("an opted-in plugin fails activation when its configured tool is unavailable", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const bash = Bash.of({ exec: () => Effect.succeed({ ...ok, exitCode: Option.some(127) }), stream: () => Stream.die("not used") })
  const error = yield* Effect.flip(Layer.build(ImageResizerCliLive({ tool: "magick", tempDir: "/tmp" }).pipe(Layer.provide(Layer.merge(Layer.succeed(FileSystem, localFileSystem), Layer.succeed(Bash, bash))))))
  expect(error).toMatchObject({ _tag: "HarnessError", code: "images.unavailable" })
}))))

test("auto selection continues after a probe error, while an explicit tool fails activation", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const commands: Array<string> = []
  const bash = Bash.of({ exec: (command) => Effect.suspend(() => {
    commands.push(command)
    return command.includes("'convert'") ? Effect.succeed(ok) : Effect.fail(new BashError({ reason: "SpawnFailed", message: "probe unavailable" }))
  }), stream: () => Stream.die("not used") })
  const services = Layer.merge(Layer.succeed(FileSystem, localFileSystem), Layer.succeed(Bash, bash))
  yield* Layer.build(ImageResizerCliLive({ tempDir: "/tmp" }).pipe(Layer.provide(services)))
  expect(commands).toEqual(["'magick' '-version'", "'convert' '-version'"])
  const error = yield* Effect.flip(Layer.build(ImageResizerCliLive({ tool: "magick", tempDir: "/tmp" }).pipe(Layer.provide(services))))
  expect(error).toMatchObject({ _tag: "HarnessError", code: "images.unavailable" })
}))))

test("interruption and timeout remove conversion files while keeping the caller's directory", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const dir = yield* temporary
  const entered = yield* Deferred.make<void>()
  const bash = Bash.of({ exec: (command) => command.includes("-version") ? Effect.succeed(ok) : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)), stream: () => Stream.die("not used") })
  const services = Layer.merge(Layer.succeed(FileSystem, localFileSystem), Layer.succeed(Bash, bash))
  const resizer = Context.get(yield* Layer.build(ImageResizerCliLive({ tool: "magick", tempDir: dir }).pipe(Layer.provide(services))), ImageResizer)
  const pending = yield* Effect.forkChild(resizer.fit({ bytes: imageResizerPng(9000, 10), mediaType: "image/png" }, fitTarget()))
  yield* Deferred.await(entered)
  yield* Fiber.interrupt(pending)
  expect(yield* Effect.tryPromise(() => readdir(dir))).toEqual([])
  const short = Context.get(yield* Layer.build(ImageResizerCliLive({ tool: "magick", tempDir: dir, timeoutMs: 20 }).pipe(Layer.provide(services))), ImageResizer)
  expect(yield* Effect.flip(short.fit({ bytes: imageResizerPng(9000, 10), mediaType: "image/png" }, fitTarget()))).toMatchObject({ _tag: "ImageResizeError", reason: "Failed", message: "the image conversion exceeded its time limit" })
  expect(yield* Effect.tryPromise(() => readdir(dir))).toEqual([])
})).pipe(Effect.timeout("3 seconds"))))

test.skipIf(!magick && !convert)("opaque PNG byte overflow can fall back to JPEG after bounded shrinking", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const resizer = yield* live()
  const bytes = yield* resizer.fit({ bytes: imageResizerPng(127, 127), mediaType: "image/png" }, { maxBytes: 5000, maxSide: 127 })
  const image = yield* mediaFromBytes(bytes)
  expect(image.mediaType).toBe("image/jpeg")
  expect(image.bytes).toBeLessThanOrEqual(5000)
}))))

test.skipIf(!magick && !convert)("GIF and WebP sources become their first fitted PNG frame", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const dir = yield* temporary
  const bash = Context.get(yield* Layer.build(BashLive()), Bash)
  // Distinct frames catch a backend that silently chooses the last frame.
  yield* bash.exec(`${tool} -size 200x100 xc:red xc:blue source.gif`, { cwd: dir })
  yield* bash.exec(`${tool} -size 200x100 xc:red xc:blue source.webp`, { cwd: dir })
  const resizer = yield* live(tool, dir)
  yield* Effect.forEach(["gif", "webp"] as const, (kind) => Effect.gen(function* () {
    const source = yield* localFileSystem.readBytes(join(dir, `source.${kind}`))
    const bytes = yield* resizer.fit({ bytes: source, mediaType: kind === "gif" ? "image/gif" : "image/webp" }, { maxBytes: 100_000, maxSide: 64 })
    expect(Option.getOrThrow(imageSizeOf(bytes, "image/png"))).toEqual({ width: 64, height: 32 })
    yield* localFileSystem.write(join(dir, "fitted.png"), bytes)
    const colour = yield* bash.exec(`${tool} fitted.png -format '%[fx:r>0.8&&b<0.1]' info:`, { cwd: dir })
    expect(colour.stdout).toBe("1")
  }), { concurrency: 1 })
  expect((yield* Effect.tryPromise(() => readdir(dir))).filter((name) => name.startsWith("efferent-img-"))).toEqual([])
}))))

test.skipIf(!magick && !convert)("literal percent sequences in the host temporary path never reach a CLI format language", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const dir = yield* Effect.acquireRelease(Effect.tryPromise(() => mkdtemp(join(tmpdir(), "efferent-image-%d-%s-%c-"))), (path) => Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(Effect.orDie))
  const choices = [...(magick ? ["magick" as const] : []), ...(convert ? ["convert" as const] : []), ...(vips ? ["vips" as const] : [])]
  yield* Effect.forEach(choices, (choice) => Effect.gen(function* () {
    const resizer = yield* live(choice, dir)
    const bytes = yield* resizer.fit({ bytes: imageResizerPng(400, 200), mediaType: "image/png" }, { maxBytes: 100_000, maxSide: 200 })
    expect(Option.getOrThrow(imageSizeOf(bytes, "image/png"))).toEqual({ width: 200, height: 100 })
    expect(yield* Effect.tryPromise(() => readdir(dir))).toEqual([])
  }), { concurrency: 1 })
}))))

test.skipIf(!magick && !convert)("JPEG inputs retain JPEG compression while satisfying a tighter byte budget", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const dir = yield* temporary
  yield* Effect.tryPromise(() => writeFile(join(dir, "source.png"), imageResizerPng(640, 320)))
  const bash = Context.get(yield* Layer.build(BashLive()), Bash)
  yield* bash.exec(`${tool} source.png -quality 100 source.jpg`, { cwd: dir })
  const source = yield* localFileSystem.readBytes(join(dir, "source.jpg"))
  const resizer = yield* live(tool, dir)
  const fitted = yield* resizer.fit({ bytes: source, mediaType: "image/jpeg" }, { maxBytes: 6000, maxSide: 200 })
  const image = yield* mediaFromBytes(fitted)
  expect(image.mediaType).toBe("image/jpeg")
  expect(image.bytes).toBeLessThanOrEqual(6000)
  expect(Math.max(...Object.values(Option.getOrThrow(imageSizeOf(fitted, "image/jpeg"))))).toBeLessThanOrEqual(200)
}))))


test.skipIf(!magick && !convert)("a partial first GIF frame retains its logical canvas and aspect", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const dir = yield* temporary
  const bash = Context.get(yield* Layer.build(BashLive()), Bash)
  yield* bash.exec(`${tool} -size 100x100 xc:red -page 200x100+0+0 partial.gif`, { cwd: dir })
  const source = yield* localFileSystem.readBytes(join(dir, "partial.gif"))
  expect(Option.getOrThrow(imageSizeOf(source, "image/gif"))).toEqual({ width: 200, height: 100 })
  const choices = [...(magick ? ["magick" as const] : []), ...(convert ? ["convert" as const] : []), ...(vips ? ["vips" as const] : [])]
  yield* Effect.forEach(choices, (choice) => Effect.gen(function* () {
    const resizer = yield* live(choice, dir)
    const bytes = yield* resizer.fit({ bytes: source, mediaType: "image/gif" }, { maxBytes: 100_000, maxSide: 64 })
    expect(Option.getOrThrow(imageSizeOf(bytes, "image/png"))).toEqual({ width: 64, height: 32 })
  }), { concurrency: 1 })
}))))
