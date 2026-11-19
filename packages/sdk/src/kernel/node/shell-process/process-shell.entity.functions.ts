/**
 * The end of a stream's bytes as text: the last `limit` bytes of `chunks`, started at a character (a UTF-8
 * continuation byte at the cut is left out with what was cut before it), decoded with U+FFFD for a byte that is no
 * UTF-8; and how many bytes were left out before it.
 */
export const tailOf = (chunks: ReadonlyArray<Uint8Array>, limit: number): { readonly text: string; readonly cut: number } => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const bytes = new Uint8Array(total)
  chunks.reduce((at, chunk) => { bytes.set(chunk, at); return at + chunk.length }, 0)
  let start = Math.max(0, total - limit)
  if (start > 0) while (start < total && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1
  return { text: new TextDecoder("utf-8").decode(bytes.subarray(start)), cut: start }
}

/**
 * A stream's chunks with what is older than the last `limit` bytes dropped, keeping whole chunks: what a run holds of
 * a stream while the command writes, so a command that writes without end holds at most `limit` bytes and a chunk.
 */
export const keptOf = (chunks: ReadonlyArray<Uint8Array>, limit: number): { readonly chunks: ReadonlyArray<Uint8Array>; readonly dropped: number } => {
  let held = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  let first = 0
  while (first < chunks.length - 1 && held - (chunks[first]?.length ?? 0) >= limit) {
    held -= chunks[first]?.length ?? 0
    first += 1
  }
  return { chunks: chunks.slice(first), dropped: chunks.slice(0, first).reduce((sum, chunk) => sum + chunk.length, 0) }
}
