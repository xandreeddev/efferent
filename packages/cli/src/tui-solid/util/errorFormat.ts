import { inspect } from "node:util"

/**
 * Render an unknown error into a human message + a deep inspection tail.
 * Lifted verbatim from the old TUI driver (`tui.ts:476`) so the Solid TUI
 * surfaces agent failures identically.
 */
export const formatFullError = (err: unknown): string => {
  const message =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err)
  const details = inspect(err, {
    depth: 10,
    maxArrayLength: 200,
    maxStringLength: 100_000,
    breakLength: 120,
  })
  return details === message ? message : `${message}\n\n${details}`
}
