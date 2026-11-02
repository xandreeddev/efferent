import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nodeFilesIo, readFully } from "./files-io.adapter.js"
import type { ReadAt } from "./files-io.adapter.js"

const content = Uint8Array.from({ length: 1000 }, (_, index) => (index * 13) & 0xff)
/** A file whose every read answers at most `most` bytes, as an interrupted read or a network mount may. */
const shortReads = (most: number): ReadAt => (buffer, offset, length, position) => {
  const taken = content.subarray(position, position + Math.min(most, length))
  buffer.set(taken, offset)
  return Promise.resolve({ bytesRead: taken.length })
}

test("a start read keeps reading after short answers until the buffer is full", async () => {
  expect(await readFully(shortReads(7), 500)).toEqual(content.subarray(0, 500))
})

test("a start read stops at the end of a file shorter than asked", async () => {
  expect(await readFully(shortReads(64), 4096)).toEqual(content)
})

test("the node start read returns a file's leading bytes and the whole of a shorter file", async () => {
  const root = await mkdtemp(join(tmpdir(), "efferent-files-io-"))
  const path = join(root, "file.bin")
  await writeFile(path, content)
  expect(await nodeFilesIo.readStart(path, 10)).toEqual(content.subarray(0, 10))
  expect(await nodeFilesIo.readStart(path, 4096)).toEqual(content)
  await rm(root, { recursive: true, force: true })
})
