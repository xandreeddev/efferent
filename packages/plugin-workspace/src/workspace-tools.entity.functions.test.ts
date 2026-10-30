import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { MEDIA_LIMITS, mediaFromBytes } from "@xandreed/core"
import { ReadResult, workspaceToolsDefaults } from "./workspace-tools.entity.js"
import type { BashToolResult, GrepResult, WorkspaceToolName } from "./workspace-tools.entity.js"
import { mediaTypeOf } from "./text-window.entity.functions.js"
import {
  binaryRead, compactBash, compactEdit, compactFind, compactGrep, compactLs, compactRead, compactWrite, environmentText, fileTooLargeHint, readMedia,
  renderBash, renderEdit, renderFind, renderGrep, renderLs, renderRead, renderWrite, toolDescriptions,
} from "./workspace-tools.entity.functions.js"

const ascii = (text: string): ReadonlyArray<number> => Array.from(text, (char) => char.charCodeAt(0))
const be32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
const be16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff]
const le16 = (value: number) => [value & 0xff, (value >>> 8) & 0xff]
const le24 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]
const le32 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
const bytes = (...parts: ReadonlyArray<ReadonlyArray<number>>): Uint8Array => new Uint8Array(parts.flat())
/** A file of `size` bytes that starts with `header`, zeros after it. */
const padded = (header: Uint8Array, size: number): Uint8Array => {
  const file = new Uint8Array(size)
  file.set(header)
  return file
}

/** A PNG's signature and IHDR chunk (its size), then a few bytes. */
const png = (width: number, height: number) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), ascii("IHDR"), be32(width), be32(height), [8, 6, 0, 0, 0], [0, 0, 0, 0])
/** A baseline JPEG's SOI, a JFIF APP0 and the frame header (its size). */
const jpeg = (width: number, height: number) => bytes(
  [0xff, 0xd8],
  [0xff, 0xe0], be16(16), ascii("JFIF"), [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
  [0xff, 0xc0], be16(17), [8], be16(height), be16(width), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
  [0xff, 0xd9],
)
/** A GIF89a's header and logical screen (its size), a two-colour table, one image of one LZW block, the trailer. */
const gif = (width: number, height: number) => bytes(
  ascii("GIF89a"), le16(width), le16(height), [0x80, 0, 0], [0, 0, 0, 0xff, 0xff, 0xff],
  [0x2c], le16(0), le16(0), le16(width), le16(height), [0], [2, 2, 0x44, 0x01, 0], [0x3b],
)
/** An extended WebP: the RIFF header and its VP8X chunk (each side less one, in 24 bits). */
const webp = (width: number, height: number) => bytes(ascii("RIFF"), le32(22), ascii("WEBP"), ascii("VP8X"), le32(10), [0, 0, 0, 0], le24(width - 1), le24(height - 1))

const read = (path: string, file: Uint8Array, readImages = true) => Effect.runSync(binaryRead(path, file, readImages, Option.getOrNull(mediaTypeOf(path))))
const encode = Schema.encodeSync(ReadResult)

/** The `read` description under the defaults, word for word, with the image limit it is given. */
const readDescription = (imageLimit: string) =>
  `Read a text file of the workspace, or look at an image. Shows at most 2000 lines or 50 KB at a time; when more is left, the result says which offset to continue from. offset is the first line to show (1-based), limit how many lines (at most 2000). A PNG, JPEG, GIF or WebP image (up to ${imageLimit} and 8000 pixels a side) is returned as an image you can see; another binary file is reported, not shown. To see a directory, use ls.`

describe("read over a binary file", () => {
  test("a PNG is an Image whose type, size and fingerprint are its bytes', named by its path; the view sends it", () => {
    const file = png(640, 480)
    const result = read("docs/chart.png", file)
    expect(result).toEqual({ _tag: "Image", path: "docs/chart.png", image: Effect.runSync(mediaFromBytes(file, { name: "docs/chart.png" })) })
    expect(result._tag === "Image" ? [result.image.mediaType, result.image.bytes] : []).toEqual(["image/png", file.length])
    expect(readMedia(result)).toEqual(result._tag === "Image" ? [result.image] : [])
    expect(renderRead(result)).toBe(`[Image docs/chart.png (image/png, ${file.length} B).]`)
    expect(compactRead(result)).toBe(`(read docs/chart.png: image/png image, ${file.length} B)`)
    expect(encode(result)).toEqual(result)
  })

  test("a JPEG is an Image too, and the type is the bytes', not the name's", () => {
    const file = jpeg(3, 2)
    const named = read("photo.jpg", file)
    const misnamed = read("photo.png", file)
    const pngNamedJpg = read("chart.jpg", png(1, 1))
    expect(named._tag === "Image" ? named.image.mediaType : named._tag).toBe("image/jpeg")
    expect(misnamed._tag === "Image" ? misnamed.image.mediaType : misnamed._tag).toBe("image/jpeg")
    expect(pngNamedJpg._tag === "Image" ? pngNamedJpg.image.mediaType : pngNamedJpg._tag).toBe("image/png")
  })

  test("a GIF and a WebP are Images too, each with the type its bytes are", () => {
    const animation = gif(320, 200)
    const photo = webp(4000, 3000)
    expect(read("anim.gif", animation)).toEqual({ _tag: "Image", path: "anim.gif", image: Effect.runSync(mediaFromBytes(animation, { name: "anim.gif" })) })
    expect(read("photo.webp", photo)).toEqual({ _tag: "Image", path: "photo.webp", image: Effect.runSync(mediaFromBytes(photo, { name: "photo.webp" })) })
    expect([read("anim.gif", animation), read("photo.png", photo)].map((result) => result._tag === "Image" ? result.image.mediaType : result._tag)).toEqual(["image/gif", "image/webp"])
    expect(renderRead(read("anim.gif", animation))).toBe(`[Image anim.gif (image/gif, ${animation.length} B).]`)
    expect(read("tall.webp", webp(10, MEDIA_LIMITS.maxPixels + 1))).toMatchObject({ _tag: "ImageRejected", mediaType: "image/webp", reason: "TooManyPixels" })
    expect(read("tall.gif", gif(10, MEDIA_LIMITS.maxPixels + 1))).toMatchObject({ _tag: "ImageRejected", mediaType: "image/gif", reason: "TooManyPixels" })
  })

  test("an image over MEDIA_LIMITS.imageBytes is a note with its path, type, size and why, without its bytes", () => {
    const file = padded(png(100, 100), MEDIA_LIMITS.imageBytes + 1)
    const result = read("big.png", file)
    expect(result).toEqual({
      _tag: "ImageRejected", path: "big.png", mediaType: "image/png", bytes: MEDIA_LIMITS.imageBytes + 1, reason: "TooLarge",
      message: `the image has ${MEDIA_LIMITS.imageBytes + 1} bytes, more than ${MEDIA_LIMITS.imageBytes}`,
    })
    expect(readMedia(result)).toEqual([])
    expect(renderRead(result)).toBe(`[big.png is an image (image/png, 3.8 MB) that read cannot show: the image has ${MEDIA_LIMITS.imageBytes + 1} bytes, more than ${MEDIA_LIMITS.imageBytes}. To see it, make a smaller copy with bash (scaled down or recompressed) and read that.]`)
    expect(compactRead(result)).toBe("(read big.png: image/png image not shown, too large to send)")
    // Every reason in words, never its name.
    const reasons = ["TooLarge", "TooManyPixels", "Unreadable", "Empty", "InvalidBase64", "UnsupportedType", "TooMany", "TooLargeTogether"] as const
    const rejected = { _tag: "ImageRejected", path: "big.png", mediaType: "image/png", bytes: 1, message: "" } as const
    expect(reasons.map((reason) => compactRead({ ...rejected, reason }))).toEqual([
      "too large to send", "more pixels a side than the limit", "its header gives no size", "it has no bytes", "its data is not base64",
      "not a PNG, JPEG, GIF or WebP image", "too many images at once", "too large together with the other images",
    ].map((why) => `(read big.png: image/png image not shown, ${why})`))
  })

  test("an image over MEDIA_LIMITS.maxPixels a side is a note too", () => {
    const result = read("wide.png", png(MEDIA_LIMITS.maxPixels + 1, 10))
    expect(result).toMatchObject({ _tag: "ImageRejected", path: "wide.png", mediaType: "image/png", reason: "TooManyPixels" })
    expect(renderRead(result)).toBe(`[wide.png is an image (image/png, 33 B) that read cannot show: the image is ${MEDIA_LIMITS.maxPixels + 1}x10 pixels, more than ${MEDIA_LIMITS.maxPixels} a side. To see it, make a smaller copy with bash (scaled down) and read that.]`)
  })

  test("a corrupt image (a signature without a size) is a note that it may be damaged", () => {
    const result = read("broken.png", bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]))
    expect(result).toMatchObject({ _tag: "ImageRejected", path: "broken.png", mediaType: "image/png", bytes: 12, reason: "Unreadable" })
    expect(renderRead(result)).toBe("[broken.png is an image (image/png, 12 B) that read cannot show: the image/png header does not give the image's size. The file may be damaged or cut short.]")
  })

  test("without readImages an image is Binary, with the media type its name suggests, as any other binary file", () => {
    const file = png(1, 1)
    expect(read("chart.png", file, false)).toEqual({ _tag: "Binary", path: "chart.png", bytes: file.length, mediaType: "image/png" })
    expect(read("chart", file, false)).toEqual({ _tag: "Binary", path: "chart", bytes: file.length, mediaType: null })
    expect(read("font.woff2", bytes(ascii("wOF2"), [0, 1, 0, 0]))).toEqual({ _tag: "Binary", path: "font.woff2", bytes: 8, mediaType: "font/woff2" })
    expect(readMedia(read("chart.png", file, false))).toEqual([])
  })

  test("the read description says images are seen only with readImages", () => {
    expect(toolDescriptions(workspaceToolsDefaults).read).toBe(readDescription("3.75 MB"))
    expect(toolDescriptions({ ...workspaceToolsDefaults, readImages: false }).read).toBe(
      "Read a text file of the workspace. Shows at most 2000 lines or 50 KB at a time; when more is left, the result says which offset to continue from. offset is the first line to show (1-based), limit how many lines (at most 2000). A binary file is reported, not shown. To see a directory, use ls.",
    )
  })

  test("the read description gives the smaller of the image limit and maxFileBytes, rounded down", () => {
    const limit = (maxFileBytes: number) => toolDescriptions({ ...workspaceToolsDefaults, maxFileBytes }).read
    expect(limit(MEDIA_LIMITS.imageBytes + 1)).toBe(readDescription("3.75 MB"))
    expect(limit(1_048_576)).toBe(readDescription("1 MB"))
    expect(limit(2_000_000)).toBe(readDescription("1.9 MB"))
    expect(limit(1_536)).toBe(readDescription("1.5 KB"))
  })

  test("a file over maxFileBytes named as an image read can show is told to read a smaller copy; any other to read parts of it", () => {
    const smallerCopy = "to see it, make a smaller copy with bash (scaled down or recompressed) and read that"
    const parts = "use grep to find lines in it, or bash (head, tail, sed -n) for parts of it"
    expect(["shots/big.PNG", "a.jpg", "a.jpeg", "a.gif", "a.webp"].map((path) => fileTooLargeHint(path, true))).toEqual(Array.from({ length: 5 }, () => smallerCopy))
    expect([fileTooLargeHint("big.png", false), fileTooLargeHint("scan.tiff", true), fileTooLargeHint("server.log", true)]).toEqual([parts, parts, parts])
  })
})

describe("tool descriptions", () => {
  test("the seven descriptions under the defaults, word for word", () => {
    expect(toolDescriptions(workspaceToolsDefaults)).toEqual({
      read: readDescription("3.75 MB"),
      write: "Create a file, or replace all of an existing one, with content; missing directories are created. To change part of a file, use edit. Emptying a non-empty file is refused.",
      edit: "Change part of a file by replacing exact text. Each edit's oldText must appear exactly once in the file: copy it from read (without the notice lines), with enough surrounding lines to be unique. All edits are matched against the file as it was before this call and must not overlap; newText replaces oldText (empty to delete it). Line endings and a byte-order mark are kept.",
      ls: "List a directory (by default the workspace root): one entry per line, directories ending in /, symbolic links in @. At most 500 entries; limit (1 to 500) asks for fewer.",
      find: "Find files whose path matches a glob pattern, relative to path (by default the workspace root): * and ? match within a name, ** any number of directories, {a,b} either; e.g. **/*.ts or src/**/test_*.py. Never looks inside node_modules, .git, .efferent or symbolic links. At most 1000 paths; limit (1 to 1000) asks for fewer.",
      grep: "Search file contents for a regular expression (JavaScript syntax), or for plain text with literal: true. path is a file or a directory (by default the workspace root); glob limits the files searched (*.ts searches every directory). Shows path:line:text for each matching line, and context lines around each match when asked. Lines are cut to 500 characters before matching. At most 100 matching lines; limit (1 to 100) asks for fewer. Binary files, node_modules, .git, .efferent and symbolic links are skipped, and files that cannot be read are named.",
      bash: "Run a shell command with bash -c in the workspace root. timeout is in seconds (default 120 s, at most 600 s); stdin is written to the command's standard input. Returns the exit code and the output, stdout and stderr in the order they came. Output longer than 2000 lines or 50 KB is cut to its end, and the whole of it (up to 32 MB) is saved to a file you can read. A non-zero exit code is a result to read, not a failure. Anything the command leaves running may be stopped when it returns.",
    })
  })

  test("the limits are the configured ones; without spillDir bash promises no saved output, and an empty exclude names only symbolic links", () => {
    const config = {
      ...workspaceToolsDefaults, maxLines: 40, maxBytes: 4_096, lsEntries: 30, findResults: 20, grepMatches: 10, grepLineChars: 200,
      exclude: [], bashTimeoutMs: 30_000, bashMaxTimeoutMs: 90_000, spillDir: null,
    }
    const { read, write, edit, ...configured } = toolDescriptions(config)
    expect(configured).toEqual({
      ls: "List a directory (by default the workspace root): one entry per line, directories ending in /, symbolic links in @. At most 30 entries; limit (1 to 30) asks for fewer.",
      find: "Find files whose path matches a glob pattern, relative to path (by default the workspace root): * and ? match within a name, ** any number of directories, {a,b} either; e.g. **/*.ts or src/**/test_*.py. Never looks inside symbolic links. At most 20 paths; limit (1 to 20) asks for fewer.",
      grep: "Search file contents for a regular expression (JavaScript syntax), or for plain text with literal: true. path is a file or a directory (by default the workspace root); glob limits the files searched (*.ts searches every directory). Shows path:line:text for each matching line, and context lines around each match when asked. Lines are cut to 200 characters before matching. At most 10 matching lines; limit (1 to 10) asks for fewer. Binary files and symbolic links are skipped, and files that cannot be read are named.",
      bash: "Run a shell command with bash -c in the workspace root. timeout is in seconds (default 30 s, at most 90 s); stdin is written to the command's standard input. Returns the exit code and the output, stdout and stderr in the order they came. Output longer than 40 lines or 4 KB is cut to its end. A non-zero exit code is a result to read, not a failure. Anything the command leaves running may be stopped when it returns.",
    })
    expect(read).toBe("Read a text file of the workspace, or look at an image. Shows at most 40 lines or 4 KB at a time; when more is left, the result says which offset to continue from. offset is the first line to show (1-based), limit how many lines (at most 40). A PNG, JPEG, GIF or WebP image (up to 3.75 MB and 8000 pixels a side) is returned as an image you can see; another binary file is reported, not shown. To see a directory, use ls.")
    expect([write, edit]).toEqual([toolDescriptions(workspaceToolsDefaults).write, toolDescriptions(workspaceToolsDefaults).edit])
  })
})

describe("the workspace.environment section", () => {
  const every: ReadonlyArray<WorkspaceToolName> = ["read", "ls", "find", "grep", "write", "edit", "bash"]

  test("with every tool, under the defaults, word for word", () => {
    expect(environmentText("/work", workspaceToolsDefaults, every)).toBe([
      "## Workspace",
      "The workspace is /work. Give paths relative to it; the tools refuse paths that lead outside it.",
      "read shows a file 2000 lines or 50 KB at a time; continue with the offset it gives.",
      "find and grep never look inside node_modules, .git, .efferent.",
      "edit replaces exact text: read the file first and copy the text to change from it.",
      "write and edit leave .git/**, .efferent/** alone.",
      "bash runs commands in the workspace root with a 120 s timeout. When their output is cut, the whole of it is saved to a file under .efferent/runtime/tool-output that read can open.",
    ].join("\n"))
  })

  test("a line for each enabled tool; without confine, protect or spillDir their clauses go, and so does the exclude line when nothing is excluded", () => {
    expect(environmentText("/work", workspaceToolsDefaults, ["read", "ls"])).toBe([
      "## Workspace",
      "The workspace is /work. Give paths relative to it; the tools refuse paths that lead outside it.",
      "read shows a file 2000 lines or 50 KB at a time; continue with the offset it gives.",
    ].join("\n"))
    expect(environmentText("/work", workspaceToolsDefaults, ["grep", "write"])).toBe([
      "## Workspace",
      "The workspace is /work. Give paths relative to it; the tools refuse paths that lead outside it.",
      "find and grep never look inside node_modules, .git, .efferent.",
      "write and edit leave .git/**, .efferent/** alone.",
    ].join("\n"))
    expect(environmentText("/work", { ...workspaceToolsDefaults, confine: false, protect: [], exclude: [], spillDir: null, bashTimeoutMs: 30_000 }, every)).toBe([
      "## Workspace",
      "The workspace is /work. Give paths relative to it.",
      "read shows a file 2000 lines or 50 KB at a time; continue with the offset it gives.",
      "edit replaces exact text: read the file first and copy the text to change from it.",
      "bash runs commands in the workspace root with a 30 s timeout.",
    ].join("\n"))
  })
})

describe("result views", () => {
  const text = (fields: Partial<Extract<ReadResult, { readonly _tag: "Text" }>>): ReadResult =>
    ({ _tag: "Text", path: "notes.txt", text: "one\ntwo", firstLine: 1, lastLine: 2, totalLines: 2, next: null, clipped: false, lossy: false, ...fields })

  test("read: the empty-file note, then the clipped-line, lossy and continue notes in that order; a binary file of no known type; the compact views", () => {
    expect(renderRead(text({ text: "", lastLine: 0, totalLines: 0 }))).toBe("[notes.txt is empty.]")
    expect(renderRead(text({}))).toBe("one\ntwo")
    expect(renderRead(text({ text: "xxxx", firstLine: 3, lastLine: 3, totalLines: 9, next: 4, clipped: true, lossy: true }))).toBe([
      "xxxx",
      "[Line 3 is longer than the window; only its start is shown. Use bash (cut, head -c) to see the rest.]",
      "[notes.txt is not valid UTF-8: bytes that are not show as �. edit refuses such a file; change it with bash.]",
      "[Showing lines 3-3 of 9. Use offset=4 to continue.]",
    ].join("\n"))
    expect(renderRead({ _tag: "Binary", path: "data.bin", bytes: 2_048, mediaType: null })).toBe("[data.bin is a binary file (2 KB); it cannot be shown as text.]")
    expect([compactRead(text({ totalLines: 9, next: 3 })), compactRead({ _tag: "Binary", path: "data.bin", bytes: 2_048, mediaType: null })])
      .toEqual(["(read notes.txt: lines 1-2 of 9)", "(read data.bin: binary, 2 KB)"])
  })

  test("write and edit: replaced, normalised, one block or several; the compact views", () => {
    expect(renderWrite({ path: "a.txt", bytes: 1_536, created: false })).toBe("Replaced a.txt (1.5 KB).")
    expect([compactWrite({ path: "a.txt", bytes: 6, created: true }), compactWrite({ path: "a.txt", bytes: 1_536, created: false })]).toEqual(["(created a.txt: 6 B)", "(replaced a.txt: 1.5 KB)"])
    const edited = { path: "a.ts", replaced: 1, normalized: true, firstChangedLine: 7, diff: "" }
    expect(renderEdit(edited)).toBe("Replaced 1 block in a.ts; the first change is at line 7. Some text matched only once whitespace and quotes were normalised: read the changed lines to check them.")
    expect([compactEdit(edited), compactEdit({ ...edited, replaced: 2 })]).toEqual(["(edited a.ts: 1 block from line 7)", "(edited a.ts: 2 blocks from line 7)"])
  })

  test("ls: an empty directory, a listing cut at the limit, entries of every kind; the compact view", () => {
    expect(renderLs({ path: "src", entries: [], total: 0 })).toBe("[src is empty.]")
    expect(renderLs({ path: ".", entries: [{ name: "a.txt", kind: "file" }, { name: "lib", kind: "directory" }, { name: "dev", kind: "other" }], total: 3 })).toBe("a.txt\nlib/\ndev")
    expect(renderLs({ path: ".", entries: [{ name: "a.txt", kind: "file" }, { name: "up", kind: "symlink" }], total: 5 }))
      .toBe("a.txt\nup@\n[Showing 2 of 5 entries. Use find with a pattern to narrow them down.]")
    expect([compactLs({ path: "src", entries: [], total: 0 }), compactLs({ path: ".", entries: [{ name: "a.txt", kind: "file" }], total: 1 })])
      .toEqual(["(listed src: 0 entries)", "(listed .: 1 entry)"])
  })

  test("find: no match, the paths, a list cut to the view, a walk stopped at its limit; the compact view", () => {
    const found = { pattern: "**/*.ts", path: ".", paths: ["src/a.ts", "src/b.ts", "src/c.ts"], truncated: false }
    expect(renderFind({ ...found, paths: [] }, 10, 1_024)).toBe("No files under the workspace root match **/*.ts.")
    expect(renderFind(found, 10, 1_024)).toBe("src/a.ts\nsrc/b.ts\nsrc/c.ts")
    expect(renderFind({ ...found, truncated: true }, 2, 1_024)).toBe("src/a.ts\nsrc/b.ts\n[1 more path not shown. Narrow the pattern or the path.]")
    expect(renderFind({ ...found, truncated: true }, 10, 1_024)).toBe("src/a.ts\nsrc/b.ts\nsrc/c.ts\n[Stopped at 3 paths; there are more. Narrow the pattern or the path.]")
    expect([compactFind(found), compactFind({ ...found, truncated: true }), compactFind({ ...found, paths: ["src/a.ts"] })])
      .toEqual(["(find **/*.ts in .: 3 paths)", "(find **/*.ts in .: 3+ paths)", "(find **/*.ts in .: 1 path)"])
  })

  test("grep: no match with what was passed by, a view cut to its lines, a search stopped at its limit, files it could not read; the compact view", () => {
    const hit = (path: string, line: number) => ({ path, line, text: `hit ${line}`, match: true })
    const searched: GrepResult = { pattern: "hit", path: ".", lines: [hit("a.txt", 1), hit("a.txt", 2), hit("b.txt", 1)], matches: 3, files: 2, truncated: false, skipped: 0, unreadable: [] }
    expect(renderGrep({ ...searched, lines: [], matches: 0, files: 0 }, false, 10, 1_024)).toBe("No matches for hit in the workspace root.")
    expect(renderGrep({ ...searched, lines: [], matches: 0, files: 0, skipped: 2, unreadable: [{ path: "x.txt", reason: "Io" }] }, false, 10, 1_024)).toBe([
      "No matches for hit in the workspace root.",
      "[2 files skipped: binary, larger than the read limit, or leading outside the workspace.]",
      "[Could not read 1 file, a file-system error: x.txt.]",
    ].join("\n"))
    expect(renderGrep({ ...searched, truncated: true }, false, 2, 1_024)).toBe([
      "a.txt:1:hit 1",
      "a.txt:2:hit 2",
      "[1 more line not shown. Narrow the pattern or the path.]",
      "[Stopped at 3 matching lines; there are more. Narrow the pattern or the path, or raise limit.]",
    ].join("\n"))
    const denied = Array.from({ length: 7 }, (_, at) => ({ path: `p${at + 1}`, reason: "Permission" as const }))
    expect(renderGrep({ ...searched, skipped: 1, unreadable: [...denied, { path: "q", reason: "Io" }] }, false, 10, 1_024)).toBe([
      "a.txt:1:hit 1",
      "a.txt:2:hit 2",
      "b.txt:1:hit 1",
      "[1 file skipped: binary, larger than the read limit, or leading outside the workspace.]",
      "[Could not read 7 files, permission denied: p1, p2, p3, p4, p5, and 2 more.]",
      "[Could not read 1 file, a file-system error: q.]",
    ].join("\n"))
    // Each reason in words, never its name; reasons that read alike share a line.
    const every = (["NotFound", "NotDirectory", "Permission", "Invalid", "Exists", "IsDirectory", "NotEmpty", "Io"] as const).map((reason) => ({ path: reason.toLowerCase(), reason }))
    expect(renderGrep({ ...searched, lines: [], matches: 0, files: 0, unreadable: every }, false, 10, 1_024)).toBe([
      "No matches for hit in the workspace root.",
      "[Could not read 2 files, no longer there: notfound, notdirectory.]",
      "[Could not read 1 file, permission denied: permission.]",
      "[Could not read 1 file, not a path the file system accepts: invalid.]",
      "[Could not read 4 files, a file-system error: exists, isdirectory, notempty, io.]",
    ].join("\n"))
    expect([compactGrep(searched), compactGrep({ ...searched, matches: 1, files: 1, truncated: true }), compactGrep({ ...searched, matches: 1, files: 1 })])
      .toEqual(["(grep hit in .: 3 matching lines in 2 files)", "(grep hit in .: 1+ matching lines in 1 file)", "(grep hit in .: 1 matching line in 1 file)"])
  })

  test("bash: no output, every way a command ends, output cut with and without a saved file; the compact view", () => {
    const ran: BashToolResult = { command: "make", output: "done", exitCode: 0, signal: null, termination: "exit", truncated: false, totalLines: 1, fullOutput: null, fullOutputCut: false, durationMs: 1_200 }
    const stopped = { ...ran, exitCode: null }
    expect(renderBash({ ...stopped, output: "" })).toBe("(no output)\n[Exit code unknown.]")
    expect([
      renderBash({ ...stopped, termination: "timeout", durationMs: 2_345 }),
      renderBash({ ...stopped, termination: "timeout", durationMs: 125_400 }),
      renderBash({ ...stopped, termination: "interrupted" }),
      renderBash({ ...stopped, termination: "signal", signal: "SIGTERM" }),
      renderBash({ ...stopped, termination: "signal" }),
    ]).toEqual([
      "done\n[The command was killed after 2.3 s, at its timeout.]",
      "done\n[The command was killed after 125 s, at its timeout.]",
      "done\n[The command was stopped before it finished.]",
      "done\n[The command was killed by SIGTERM.]",
      "done\n[The command was killed by a signal.]",
    ])
    const cut = { ...ran, output: "9\n10", truncated: true, totalLines: 10 }
    expect(renderBash(cut)).toBe("9\n10\n[Output cut to its last 2 of 10 lines.]\n[Exit code 0.]")
    expect(renderBash({ ...cut, fullOutput: "out/bash-1.log" }))
      .toBe("9\n10\n[Output cut to its last 2 of 10 lines. The whole output is in out/bash-1.log; read it with offset to see the rest.]\n[Exit code 0.]")
    expect(renderBash({ ...ran, output: "the end", truncated: true, totalLines: 1, fullOutput: "out/bash-1.log", fullOutputCut: true })).toBe([
      "the end",
      "[Output cut: only the end of its last line is shown. Only its start was saved, in out/bash-1.log: the output grew past the size read opens, and the rest was not kept. Read the file with offset to see that start; to see the rest, run the command again with its output filtered (grep, tail, sed -n).]",
      "[Exit code 0.]",
    ].join("\n"))
    expect([
      compactBash(ran), compactBash(stopped), compactBash({ ...stopped, command: "x".repeat(81), termination: "timeout", fullOutput: "out/bash-1.log" }),
      compactBash({ ...stopped, termination: "signal", signal: "SIGTERM" }), compactBash({ ...stopped, termination: "signal" }), compactBash({ ...stopped, termination: "interrupted" }),
    ]).toEqual([
      "(ran make: exit 0)", "(ran make: exit ?)", `(ran ${"x".repeat(80)}…: killed at its timeout; output in out/bash-1.log)`,
      "(ran make: killed by SIGTERM)", "(ran make: killed by a signal)", "(ran make: stopped before it finished)",
    ])
  })
})
