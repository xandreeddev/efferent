import { Match } from "effect"
import type { CommandRun, Ran } from "./shell.entity.js"

/** A host's text as a failure repeats it: its start, and how much was left out. */
const shown = (text: string, limit: number): string => {
  if (text.length <= limit) return JSON.stringify(text)
  const end = (text.charCodeAt(limit - 1) & 0xfc00) === 0xd800 ? limit - 1 : limit
  return `${JSON.stringify(text.slice(0, end))} [… ${text.length - end} characters clipped]`
}

/** What `runCommand` answers: how the command ended, in the words its description names, and its output. */
export const commandRunOf = (ran: Ran): CommandRun => {
  const output = { stdout: ran.stdout, stderr: ran.stderr, stdoutCut: ran.stdoutCut, stderrCut: ran.stderrCut }
  return Match.valueTags(ran.ended, {
    Exited: ({ code }): CommandRun => ({ ended: "exited", exitCode: code, ...output }),
    TimedOut: (): CommandRun => ({ ended: "timed out", ...output }),
    Killed: (): CommandRun => ({ ended: "killed", ...output }),
  })
}

/** What `runCommand` answers when the shell declines the command, with the host's reason, cut if long. */
export const shellRefused = (reason: string): string =>
  `The shell declined this command: ${shown(reason, 200)}. Do not run it again unless the user asks for it.`

/** What `runCommand` answers for a command that is empty. */
export const COMMAND_EMPTY = "The command is empty: give the command to run, such as ls -la."
