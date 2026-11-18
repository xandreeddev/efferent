import { Result } from "effect"
import type { LineDamage, SessionLines } from "./directory-journal.entity.js"

const CRC_TABLE: ReadonlyArray<number> = Array.from({ length: 256 }, (_, n) =>
  Array.from({ length: 8 }).reduce<number>((c) => (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1, n))

/** The CRC-32 (IEEE 802.3) of `bytes`, as eight lowercase hexadecimal digits. */
export const crc32Of = (bytes: Uint8Array): string =>
  ((bytes.reduce((crc, byte) => (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0")

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const NEWLINE = 0x0a
const SPACE = 0x20

/** A line of a session file, as its bytes: the CRC-32 of the JSON's bytes, a space, the JSON, a line break. */
export const lineOf = (json: string): Uint8Array => {
  const body = encoder.encode(json)
  const line = new Uint8Array(9 + body.length + 1)
  line.set(encoder.encode(crc32Of(body)))
  line[8] = SPACE
  line.set(body, 9)
  line[line.length - 1] = NEWLINE
  return line
}

/** The JSON of one line's bytes (its break left off), when its CRC-32 says it is the line that was written. */
const jsonOf = (line: Uint8Array): Result.Result<string, void> => {
  if (line.length < 10 || line[8] !== SPACE) return Result.fail(undefined)
  const body = line.subarray(9)
  return decoder.decode(line.subarray(0, 8)) === crc32Of(body) ? Result.succeed(decoder.decode(body)) : Result.fail(undefined)
}

/**
 * A session file's bytes as its lines. The bytes after the last line break are
 * a torn tail, a write that did not finish: never a line, whatever they hold.
 * A whole line whose CRC-32 does not match is damage the store does not
 * repair: the file is refused at that line, never read past it.
 */
export const linesOf = (bytes: Uint8Array): Result.Result<SessionLines, LineDamage> => {
  const whole = bytes.lastIndexOf(NEWLINE) + 1
  const lines: Array<string> = []
  for (let start = 0, number = 1; start < whole; number++) {
    const end = bytes.indexOf(NEWLINE, start)
    const json = jsonOf(bytes.subarray(start, end))
    if (Result.isFailure(json)) return Result.fail({ line: number })
    lines.push(json.success)
    start = end + 1
  }
  return Result.succeed({ lines, whole })
}

/** The first line of a file's start, when the start holds a whole one: what a listing reads of a session. */
export const firstLineOf = (start: Uint8Array): Result.Result<string, LineDamage> => {
  const end = start.indexOf(NEWLINE)
  return end < 0 ? Result.fail({ line: 1 }) : Result.mapError(jsonOf(start.subarray(0, end)), () => ({ line: 1 }))
}

const PLAIN = /^[a-z0-9][a-z0-9-]{0,99}$/

/**
 * A session's file name, from its id: the id itself when it is lower-case
 * letters, digits and hyphens (a UUID, as the session plugin mints), else
 * `~` and the hexadecimal of its UTF-8 bytes, so any id is a name no file
 * system reads as a path or folds into another's by case.
 */
export const fileNameOf = (id: string): string =>
  `${PLAIN.test(id) ? id : `~${Array.from(encoder.encode(id), (byte) => byte.toString(16).padStart(2, "0")).join("")}`}.jsonl`

/** Whether a name in `sessions/` is a session's file; anything else there (an editor's file) is not the store's. */
export const isSessionFile = (name: string): boolean => name.endsWith(".jsonl") && !name.startsWith(".")
