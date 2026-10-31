import { Effect, Layer, Option, Path, Schema } from "effect"
import { Bash, FileSystem, harnessError, ImageFitTarget, ImageInput, ImageResizeError, ImageResizer, imageSizeOf, mediaFromBytes, mergeOptions, sniffImageType } from "@xandreed/core"
import type { BashResult } from "@xandreed/core"
import { imageOpacityCommand, imageResizeCommand, imageToolProbe } from "./image-resizer.entity.functions.js"
import { ImageResizerConfig, imageResizerDefaults, ImageResizeTool } from "./image-resizer.entity.js"
import { bashEnvironment } from "./workspace-tools.entity.functions.js"
import { workspaceToolsDefaults } from "./workspace-tools.entity.js"

const resizeError = (reason: ImageResizeError["reason"], message: string, cause?: unknown) => new ImageResizeError({ reason, message, ...(cause === undefined ? {} : { cause }) })
const succeeded = (result: BashResult): boolean => result.termination === "exit" && Option.contains(result.exitCode, 0)

const makeResizer = Effect.fnUntraced(function* (options: Partial<ImageResizerConfig>) {
  const config = yield* Schema.decodeUnknownEffect(ImageResizerConfig)(mergeOptions(ImageResizerConfig, imageResizerDefaults, options), { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) => harnessError("config.options", "the image resizer options do not decode", cause)),
  )
  const fs = yield* FileSystem
  const bash = yield* Bash
  const path = yield* Path.Path.pipe(Effect.provide(Path.layer))
  const environment = bashEnvironment(workspaceToolsDefaults, Option.none())
  const candidates = config.tool === "auto" ? ImageResizeTool.literals : [config.tool]
  const available = yield* Effect.findFirst(candidates, (tool) => bash.exec(imageToolProbe(tool), { cwd: "/", timeoutMs: Math.min(config.timeoutMs, 5_000), ...environment }).pipe(
    Effect.map(succeeded),
    Effect.catch((error) => Effect.logDebug("an image conversion tool could not be probed", error).pipe(Effect.as(false))),
  ))
  if (Option.isNone(available)) return yield* Effect.fail(harnessError("images.unavailable", "no image conversion tool is available; install ImageMagick, libvips or sips, or provide an ImageResizer"))
  const tool = available.value
  const temporary = config.tempDir === null
    ? (yield* bash.exec("printf '%s' \"${TMPDIR:-/tmp}\"", { cwd: "/", timeoutMs: Math.min(config.timeoutMs, 5_000), ...environment }).pipe(
      Effect.mapError((cause) => harnessError("config.options", "the image resizer could not read TMPDIR; set tempDir", cause)),
    )).stdout
    : config.tempDir
  if (!temporary.startsWith("/") || temporary.includes("\0")) return yield* Effect.fail(harnessError("config.options", "the image resizer tempDir must be an absolute POSIX directory"))

  const fit: typeof ImageResizer.Service.fit = Effect.fn("images.fit")(function* (image, target) {
    const input = yield* Schema.decodeUnknownEffect(ImageInput)(image).pipe(Effect.mapError((cause) => resizeError("Unsupported", "the image input does not decode", cause)))
    const bounds = yield* Schema.decodeUnknownEffect(ImageFitTarget)(target).pipe(Effect.mapError((cause) => resizeError("Failed", "the image fit target does not decode", cause)))
    const type = sniffImageType(input.bytes)
    if (!Option.contains(type, input.mediaType)) return yield* Effect.fail(resizeError("Unsupported", "the bytes are not an image of the declared type"))
    const size = imageSizeOf(input.bytes, input.mediaType)
    if (Option.isNone(size)) return yield* Effect.fail(resizeError("Unsupported", "the image header does not give its dimensions"))
    const original = size.value
    if (input.bytes.length <= bounds.maxBytes && Math.max(original.width, original.height) <= bounds.maxSide) return input.bytes
    return yield* Effect.scoped(Effect.gen(function* () {
      const nonce = yield* Effect.sync(() => crypto.randomUUID())
      const directory = path.join(temporary, `efferent-img-${nonce}`)
      yield* Effect.acquireRelease(fs.mkdir(directory).pipe(Effect.mapError((cause) => resizeError("Failed", "the image conversion directory could not be created", cause))), () =>
        fs.remove(directory, { recursive: true }).pipe(Effect.ignore({ log: "Warn", message: "the image conversion temporary directory could not be removed" })))
      const source = path.join(directory, "input.img")
      yield* fs.write(source, input.bytes).pipe(Effect.mapError((cause) => resizeError("Failed", "the image conversion input could not be written", cause)))
      const convert = (side: number, jpeg: boolean) => Effect.gen(function* () {
        const output = path.join(directory, jpeg ? "output.jpg" : "output.png")
        const result = yield* bash.exec(imageResizeCommand(tool, "input.img", jpeg ? "output.jpg" : "output.png", side, jpeg), { cwd: directory, timeoutMs: config.timeoutMs, ...environment }).pipe(
          Effect.mapError((cause) => resizeError("Failed", "the image conversion command could not run", cause)),
        )
        if (!succeeded(result)) return yield* Effect.fail(resizeError("Failed", result.termination === "timeout" ? "the image conversion command timed out" : "the image conversion command failed", result))
        const bytes = yield* fs.readBytes(output).pipe(Effect.mapError((cause) => resizeError("Failed", "the converted image could not be read", cause)))
        const outputType = sniffImageType(bytes)
        const outputSize = Option.flatMap(outputType, (mediaType) => imageSizeOf(bytes, mediaType))
        if (Option.isNone(outputSize)) return yield* Effect.fail(resizeError("Failed", "the converted image header does not give its dimensions"))
        const actual = outputSize.value
        const noUpscale = (actual.width <= original.width && actual.height <= original.height) || (actual.width <= original.height && actual.height <= original.width)
        if (!noUpscale) return yield* Effect.fail(resizeError("Failed", "the image converter enlarged the source"))
        if (bytes.length > bounds.maxBytes || Math.max(actual.width, actual.height) > bounds.maxSide) return Option.none<Uint8Array>()
        return yield* mediaFromBytes(bytes).pipe(Effect.as(Option.some(bytes)), Effect.mapError((cause) => resizeError("Failed", "the converted image is not valid media", cause)))
      })
      const fallback = (side: number): Effect.Effect<Uint8Array, ImageResizeError> => Effect.gen(function* () {
        const command = imageOpacityCommand(tool, "input.img")
        const opaque = input.mediaType === "image/png" && command.length > 0
          ? yield* bash.exec(command, { cwd: directory, timeoutMs: config.timeoutMs, ...environment }).pipe(
            Effect.map((result) => succeeded(result) && (result.stdout.trim().toLowerCase() === "true" || /hasAlpha:\s*no\b/i.test(result.stdout))),
            Effect.catch((cause) => Effect.logDebug("the source opacity could not be checked", cause).pipe(Effect.as(false))),
          ) : false
        if (opaque) {
          const fitted = yield* convert(side, true)
          if (Option.isSome(fitted)) return fitted.value
        }
        return yield* Effect.fail(resizeError("CannotFit", "the image could not fit the requested byte and pixel limits"))
      })
      const attempt = (side: number, remaining: number): Effect.Effect<Uint8Array, ImageResizeError> => convert(side, input.mediaType === "image/jpeg").pipe(Effect.flatMap(Option.match({
        onSome: Effect.succeed,
        onNone: () => {
          const smaller = Math.max(1, Math.floor(side * 0.75))
          return remaining > 1 && smaller < side ? attempt(smaller, remaining - 1) : fallback(side)
        },
      })))
      return yield* attempt(Math.min(bounds.maxSide, Math.max(original.width, original.height)), 4)
    })).pipe(Effect.timeoutOrElse({ duration: config.timeoutMs, orElse: () => Effect.fail(resizeError("Failed", "the image conversion exceeded its time limit")) }))
  })
  return ImageResizer.of({ fit })
})

/** Fit images through an optional host CLI; FileSystem and Bash must share a file tree. @public */
export const ImageResizerCliLive = (options: Partial<ImageResizerConfig> = {}) => Layer.effect(ImageResizer, makeResizer(options))
