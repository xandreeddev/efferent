import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import type { Context } from "effect"
import { ImageResizeError } from "../domain/image-resize.entity.js"
import { scaledSize } from "../domain/image-resize.entity.functions.js"
import { imageSizeOf } from "../domain/media.entity.functions.js"
import { ImageResizer } from "../ports/image-resizer.port.js"
import { imageResizerConformance, imageResizerPng } from "./image-resizer.conformance.js"

type Resizer = Context.Service.Shape<typeof ImageResizer>
const unsupported = () => Effect.fail(new ImageResizeError({ reason: "Unsupported", message: "the input is not a readable image" }))
const dimensions = (image: Parameters<Resizer["fit"]>[0]) => imageSizeOf(image.bytes, image.mediaType)
const producing = ImageResizer.of({ fit: (image, target) => Option.match(dimensions(image), {
  onNone: unsupported,
  onSome: (size) => {
    const output = scaledSize(size, Math.min(800, target.maxSide))
    return Effect.succeed(imageResizerPng(output.width, output.height))
  },
}) })
const checks = (resizer: typeof ImageResizer.Service) => imageResizerConformance({ open: () => Effect.succeed(resizer) })
const failedChecks = (resizer: typeof ImageResizer.Service) => Effect.runPromise(Effect.forEach(checks(resizer), (check) =>
  Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [result.failure.check] : [])), { concurrency: 1 },
).pipe(Effect.map((results) => results.flat().toSorted())))

test("the kit lists the five resize promises", () => {
  expect(checks(producing).map((check) => check.name)).toEqual([
    "an over-limit side is reduced into readable media",
    "an over-limit byte payload is reduced into readable media",
    "a requested smaller side preserves the image aspect",
    "an image below the target dimensions is never upscaled",
    "unknown bytes fail as Unsupported rather than a defect",
  ])
})

test("a dimension-aware producer passes the protocol checks", async () => {
  expect(await failedChecks(producing)).toEqual([])
})

test("a backend that only returns its input fails size and requested-side checks", async () => {
  const unchanged = ImageResizer.of({ fit: (image) => Option.match(dimensions(image), { onNone: unsupported, onSome: () => Effect.succeed(image.bytes) }) })
  expect(await failedChecks(unchanged)).toEqual(["aspect", "byte-limit", "side-limit"])
})

test("a backend that upscales a small image fails no-upscale", async () => {
  const enlarges = ImageResizer.of({ fit: (image, target) => Option.match(dimensions(image), {
    onNone: unsupported,
    onSome: (size) => size.width === 32 ? Effect.succeed(imageResizerPng(64, 32)) : producing.fit(image, target),
  }) })
  expect(await failedChecks(enlarges)).toEqual(["no-upscale"])
})

test("a backend that exceeds maxBytes fails every image-output check", async () => {
  const oversized = ImageResizer.of({ fit: (image, target) => Option.match(dimensions(image), {
    onNone: unsupported,
    onSome: () => {
      const output = new Uint8Array(target.maxBytes + 1)
      output.set(imageResizerPng(16, 16))
      return Effect.succeed(output)
    },
  }) })
  expect(await failedChecks(oversized)).toEqual(["aspect", "byte-limit", "no-upscale", "side-limit"])
})

test("a backend that changes a rectangular image into a square fails aspect", async () => {
  const square = ImageResizer.of({ fit: (image, target) => Option.match(dimensions(image), {
    onNone: unsupported,
    onSome: (size) => size.width === 640 ? Effect.succeed(imageResizerPng(200, 200)) : producing.fit(image, target),
  }) })
  expect(await failedChecks(square)).toEqual(["aspect"])
})

test("a backend that dies on unsupported bytes fails unsupported", async () => {
  const dies = ImageResizer.of({ fit: (image, target) => Option.match(dimensions(image), {
    onNone: () => Effect.die("unsupported input defect"),
    onSome: () => producing.fit(image, target),
  }) })
  expect(await failedChecks(dies)).toEqual(["unsupported"])
})


test("a backend that always reduces to one pixel fails the requested geometry check", async () => {
  const pixel = ImageResizer.of({ fit: (image) => Option.match(dimensions(image), { onNone: unsupported, onSome: () => Effect.succeed(imageResizerPng(1, 1)) }) })
  expect(await failedChecks(pixel)).toEqual(["aspect"])
})

test("a backend that always fails has every check's documented id", async () => {
  const failed = ImageResizer.of({ fit: () => Effect.fail(new ImageResizeError({ reason: "Failed", message: "the backend is unavailable" })) })
  expect(await failedChecks(failed)).toEqual(["aspect", "byte-limit", "no-upscale", "side-limit", "unsupported"])
})
