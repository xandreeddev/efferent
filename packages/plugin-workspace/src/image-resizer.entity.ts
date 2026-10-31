import { Schema } from "effect"

/** The optional host CLI used to fit images. @public */
export const ImageResizeTool = Schema.Literals(["magick", "convert", "vips", "sips"])
export type ImageResizeTool = typeof ImageResizeTool.Type

/**
 * Opt-in image conversion through the host's matching FileSystem and Bash.
 * auto probes once in tool order. tempDir is an existing absolute directory;
 * null reads the Bash environment's TMPDIR, falling back to /tmp. timeoutMs
 * bounds one fit, including its conversion attempts (cleanup follows).
 * @public
 */
export const ImageResizerConfig = Schema.Struct({
  tool: Schema.Literals(["auto", ...ImageResizeTool.literals]),
  tempDir: Schema.NullOr(Schema.String.check(Schema.makeFilter((path) => path.startsWith("/") && !path.includes("\0") ? true : "an absolute POSIX directory"))),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600_000 })),
})
export type ImageResizerConfig = typeof ImageResizerConfig.Type

/** @public */
export const imageResizerDefaults: ImageResizerConfig = { tool: "auto", tempDir: null, timeoutMs: 30_000 }
