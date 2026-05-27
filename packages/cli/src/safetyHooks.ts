import { Effect } from "effect"
import type {
  AgentBeforeToolCallEvent,
  BeforeToolCallDecision,
} from "@agent/core"

/**
 * Returns an `onBeforeToolCall` implementation that, when the model wants
 * to run `bash`, defers to a prompter (e.g. a TUI modal) for y/n. The
 * prompter receives the resolved command + cwd and returns true/false.
 * Non-bash tools always pass through.
 */
export const bashConfirmHook =
  <R = never>(
    prompt: (cmd: string, cwd: string) => Effect.Effect<boolean, never, R>,
    cwd: string,
  ): ((event: AgentBeforeToolCallEvent) => Effect.Effect<BeforeToolCallDecision, never, R>) =>
  (event) => {
    if (event.toolName !== "bash") {
      return Effect.succeed({ action: "continue" as const })
    }
    const command =
      typeof event.args === "object" &&
      event.args !== null &&
      "command" in event.args
        ? String((event.args as { command: unknown }).command)
        : "<unknown>"
    return prompt(command, cwd).pipe(
      Effect.map((ok) =>
        ok
          ? ({ action: "continue" as const } satisfies BeforeToolCallDecision)
          : ({
              action: "block" as const,
              reason:
                "user denied execution of this command in the TUI confirm prompt",
            } satisfies BeforeToolCallDecision),
      ),
    )
  }

/**
 * Returns an `onBeforeToolCall` that blocks every `bash` call unless
 * `allowBash` is true. Used by non-interactive modes (print / json / rpc)
 * where there's no user available to confirm.
 */
export const denyBashHook =
  <R = never>(
    allowBash: boolean,
  ): ((event: AgentBeforeToolCallEvent) => Effect.Effect<BeforeToolCallDecision, never, R>) =>
  (event) => {
    if (allowBash || event.toolName !== "bash") {
      return Effect.succeed({ action: "continue" as const })
    }
    return Effect.succeed({
      action: "block" as const,
      reason:
        "bash execution is disabled in this mode — re-run with --allow-bash to enable",
    })
  }
