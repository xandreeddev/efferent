import { ansi, padRight, truncate, visibleLength } from "./terminal.js"

export interface ModalState {
  readonly visible: boolean
  readonly title: string
  readonly body: string
  readonly yes: string
  readonly no: string
}

export const hiddenModal: ModalState = {
  visible: false,
  title: "",
  body: "",
  yes: "y",
  no: "n",
}

const wrap = (text: string, width: number): string[] => {
  const out: string[] = []
  for (const para of text.split("\n")) {
    if (para.length === 0) {
      out.push("")
      continue
    }
    let line = ""
    for (const word of para.split(" ")) {
      if (line.length === 0) {
        line = word
        continue
      }
      if (visibleLength(line) + 1 + visibleLength(word) > width) {
        out.push(line)
        line = word
      } else {
        line += " " + word
      }
    }
    if (line.length > 0) out.push(line)
  }
  return out
}

/**
 * Render the modal as a centered box. Returns a layered overlay: array
 * of `{ row, content }` pairs that the renderer should paint over the
 * underlying frame.
 */
export interface OverlayLine {
  readonly row: number
  readonly col: number
  readonly content: string
}

export const renderModal = (
  state: ModalState,
  termRows: number,
  termCols: number,
): OverlayLine[] => {
  if (!state.visible) return []
  const boxWidth = Math.min(80, termCols - 4)
  const innerWidth = boxWidth - 4
  const bodyLines = wrap(state.body, innerWidth)
  const totalLines = bodyLines.length + 4 // title + sep + body + footer
  const top = Math.max(1, Math.floor((termRows - totalLines) / 2))
  const left = Math.max(1, Math.floor((termCols - boxWidth) / 2))

  const out: OverlayLine[] = []
  const horiz = "─".repeat(boxWidth - 2)
  const fmt = (s: string): string =>
    `${ansi.bgDarkGray}${ansi.fgWhite}${padRight(s, boxWidth)}${ansi.reset}`

  out.push({ row: top, col: left, content: fmt(`╭${horiz}╮`) })
  out.push({
    row: top + 1,
    col: left,
    content: fmt(
      `│ ${ansi.bold}${ansi.fgBrightYellow}${truncate(
        state.title,
        innerWidth,
      )}${ansi.reset}${ansi.bgDarkGray}${ansi.fgWhite}${" ".repeat(
        Math.max(0, innerWidth - visibleLength(state.title)),
      )} │`,
    ),
  })
  out.push({
    row: top + 2,
    col: left,
    content: fmt(`├${horiz}┤`),
  })
  for (let i = 0; i < bodyLines.length; i++) {
    out.push({
      row: top + 3 + i,
      col: left,
      content: fmt(`│ ${padRight(bodyLines[i] ?? "", innerWidth)} │`),
    })
  }
  out.push({
    row: top + 3 + bodyLines.length,
    col: left,
    content: fmt(
      `│ ${ansi.fgGray}[${state.yes}] yes  [${state.no}] no${ansi.reset}${ansi.bgDarkGray}${ansi.fgWhite}${" ".repeat(
        Math.max(0, innerWidth - 18),
      )} │`,
    ),
  })
  out.push({
    row: top + 4 + bodyLines.length,
    col: left,
    content: fmt(`╰${horiz}╯`),
  })
  return out
}
