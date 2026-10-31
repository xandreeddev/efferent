import { Match } from "effect"
import type { ImageResizeTool } from "./image-resizer.entity.js"
import { shellQuote } from "./shell.entity.functions.js"

const executable: Readonly<Record<ImageResizeTool, string>> = { magick: "magick", convert: "convert", vips: "vipsthumbnail", sips: "sips" }

export const imageToolProbe = (tool: ImageResizeTool): string => [executable[tool], tool === "magick" || tool === "convert" ? "-version" : "--version"].map(shellQuote).join(" ")

/** A first-frame conversion; every shell word is literal and the box never upscales. */
export const imageResizeCommand = (tool: ImageResizeTool, input: string, output: string, side: number, jpeg = false): string => Match.value(tool).pipe(
  Match.when("magick", () => ["magick", `${input}[0]`, "-coalesce", "-auto-orient", "-strip", "-resize", `${side}x${side}>`, "-quality", "85", output]),
  Match.when("convert", () => ["convert", `${input}[0]`, "-coalesce", "-auto-orient", "-strip", "-resize", `${side}x${side}>`, "-quality", "85", output]),
  Match.when("vips", () => ["vipsthumbnail", input, "--size", `${side}x${side}>`, "--path", `${output}[strip${jpeg ? ",Q=85" : ""}]`]),
  Match.when("sips", () => ["sips", "-s", "format", jpeg ? "jpeg" : "png", ...(jpeg ? ["-s", "formatOptions", "85"] : []), "-Z", String(side), input, "--out", output]),
  Match.exhaustive,
  (args) => args.map(shellQuote).join(" "),
)

/** The converter's own opacity check; a backend without one keeps transparency conservatively. */
export const imageOpacityCommand = (tool: ImageResizeTool, input: string): string => Match.value(tool).pipe(
  Match.when("magick", () => ["magick", `${input}[0]`, "-format", "%[opaque]", "info:"]),
  Match.when("convert", () => ["convert", `${input}[0]`, "-format", "%[opaque]", "info:"]),
  Match.when("vips", () => []),
  Match.when("sips", () => ["sips", "-g", "hasAlpha", input]),
  Match.exhaustive,
  (args) => args.map(shellQuote).join(" "),
)
