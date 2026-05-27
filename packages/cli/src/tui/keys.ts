/**
 * Parse raw stdin bytes into a stream of discriminated key events.
 *
 * Supports:
 *   - plain printable chars
 *   - Ctrl-<letter> (0x01–0x1A)
 *   - Backspace (0x7F)
 *   - Enter (\r or \n)
 *   - Tab (\t)
 *   - Escape and CSI escape sequences (arrows, shift+arrow, F-keys minimal)
 *   - Bracketed paste (\x1b[200~ ... \x1b[201~) reported as a single event
 *
 * Not exhaustive — covers what the input editor + slash palette need.
 */

export type ArrowDir = "up" | "down" | "left" | "right"

export type Key =
  | { readonly type: "char"; readonly char: string }
  | { readonly type: "ctrl"; readonly char: string }
  | { readonly type: "arrow"; readonly dir: ArrowDir; readonly shift: boolean }
  | { readonly type: "enter" }
  | { readonly type: "tab" }
  | { readonly type: "shiftTab" }
  | { readonly type: "backspace" }
  | { readonly type: "escape" }
  | { readonly type: "paste"; readonly text: string }
  | { readonly type: "delete" }
  | { readonly type: "home" }
  | { readonly type: "end" }
  | { readonly type: "pageUp" }
  | { readonly type: "pageDown" }

const PASTE_START = "\x1b[200~"
const PASTE_END = "\x1b[201~"

export class KeyParser {
  private buf = ""
  private pasting = false
  private pasteBuf = ""

  feed(chunk: string | Buffer | Uint8Array): Key[] {
    const s =
      typeof chunk === "string"
        ? chunk
        : new TextDecoder().decode(chunk as Uint8Array)
    this.buf += s
    const out: Key[] = []
    while (this.buf.length > 0) {
      if (this.pasting) {
        const end = this.buf.indexOf(PASTE_END)
        if (end === -1) {
          this.pasteBuf += this.buf
          this.buf = ""
          return out
        }
        this.pasteBuf += this.buf.slice(0, end)
        this.buf = this.buf.slice(end + PASTE_END.length)
        out.push({ type: "paste", text: this.pasteBuf })
        this.pasteBuf = ""
        this.pasting = false
        continue
      }
      if (this.buf.startsWith(PASTE_START)) {
        this.buf = this.buf.slice(PASTE_START.length)
        this.pasting = true
        continue
      }
      const consumed = this.parseOne(out)
      if (consumed === 0) {
        // Incomplete escape sequence — wait for more bytes.
        return out
      }
    }
    return out
  }

  private parseOne(out: Key[]): number {
    const b = this.buf
    const c = b.charCodeAt(0)

    // Escape sequences
    if (c === 0x1b) {
      if (b.length === 1) return 0 // wait
      if (b[1] !== "[" && b[1] !== "O") {
        // Lone escape
        out.push({ type: "escape" })
        this.buf = b.slice(1)
        return 1
      }
      // CSI / SS3 — find the terminator (letter or '~')
      let i = 2
      while (i < b.length) {
        const ch = b[i]
        if (
          ch !== undefined &&
          ((ch >= "A" && ch <= "Z") ||
            (ch >= "a" && ch <= "z") ||
            ch === "~")
        ) {
          break
        }
        i++
      }
      if (i >= b.length) return 0 // wait
      const seq = b.slice(0, i + 1)
      this.buf = b.slice(i + 1)
      const key = parseCsi(seq)
      if (key !== undefined) out.push(key)
      return seq.length
    }

    // Enter
    if (c === 0x0d || c === 0x0a) {
      out.push({ type: "enter" })
      this.buf = b.slice(1)
      return 1
    }

    // Tab
    if (c === 0x09) {
      out.push({ type: "tab" })
      this.buf = b.slice(1)
      return 1
    }

    // Backspace (0x7F is what most terminals send; 0x08 is Ctrl-H)
    if (c === 0x7f || c === 0x08) {
      out.push({ type: "backspace" })
      this.buf = b.slice(1)
      return 1
    }

    // Ctrl-<letter>
    if (c >= 0x01 && c <= 0x1a) {
      out.push({ type: "ctrl", char: String.fromCharCode(c + 0x60) })
      this.buf = b.slice(1)
      return 1
    }

    // Printable
    out.push({ type: "char", char: b[0]! })
    this.buf = b.slice(1)
    return 1
  }
}

const parseCsi = (seq: string): Key | undefined => {
  // SS3 sequences like ESC O A (some terminals for arrows)
  if (seq.startsWith("\x1bO")) {
    const last = seq[seq.length - 1]
    switch (last) {
      case "A":
        return { type: "arrow", dir: "up", shift: false }
      case "B":
        return { type: "arrow", dir: "down", shift: false }
      case "C":
        return { type: "arrow", dir: "right", shift: false }
      case "D":
        return { type: "arrow", dir: "left", shift: false }
    }
    return undefined
  }
  // CSI
  const inner = seq.slice(2, -1) // strip ESC[ ... terminator
  const final = seq[seq.length - 1]
  const params = inner.split(";")
  const shift = params.length > 1 && params[1] === "2"
  switch (final) {
    case "A":
      return { type: "arrow", dir: "up", shift }
    case "B":
      return { type: "arrow", dir: "down", shift }
    case "C":
      return { type: "arrow", dir: "right", shift }
    case "D":
      return { type: "arrow", dir: "left", shift }
    case "Z":
      return { type: "shiftTab" }
    case "H":
      return { type: "home" }
    case "F":
      return { type: "end" }
    case "~": {
      const n = parseInt(params[0] ?? "", 10)
      switch (n) {
        case 1:
        case 7:
          return { type: "home" }
        case 4:
        case 8:
          return { type: "end" }
        case 3:
          return { type: "delete" }
        case 5:
          return { type: "pageUp" }
        case 6:
          return { type: "pageDown" }
      }
      return undefined
    }
  }
  return undefined
}
