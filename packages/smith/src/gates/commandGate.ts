import { Array as Arr, Effect, Option } from "effect"
import { Finding, GateCrash, GateName, RuleId, SourceLocation, WorkspacePath } from "@xandreed/foundry"
import type { Gate, GateKind, Workspace } from "@xandreed/foundry"
import { workspacePath } from "@xandreed/providers"

const DEFAULT_TIMEOUT_MS = 5 * 60_000
/** Findings parsed from `file:line` markers, at most. */
const MAX_LOCATED_FINDINGS = 10
/** Chars of combined output kept in the fallback finding. */
const MAX_OUTPUT_CHARS = 2_000

const FILE_LINE = /([\w@./-]+\.(?:tsx?|jsx?|mjs|cjs)):(\d+)/
/** The shell's missing/not-executable signatures behind exit 127/126. */
const MISSING_TOOL = /command not found|No such file or directory|Permission denied/

interface CommandRun {
  readonly exitCode: number
  readonly output: string
  readonly timedOut: boolean
}

const runCommand = (
  argv: ReadonlyArray<string>,
  cwd: string,
  timeoutMs: number,
): Effect.Effect<CommandRun, GateCrash> =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn([...argv], {
        cwd,
        // The workspace's portable toolchain prefix, SAME as the coder's
        // shell: a tool the coder provisioned into <ws>/.local/bin must
        // count for the verdict — the zig run's coder built its own
        // toolchain there and every gate still 127'd because the gate env
        // diverged from the coder env (the oracle and the worker must
        // share reality).
        env: { ...process.env, PATH: workspacePath(cwd) },
        stdout: "pipe",
        stderr: "pipe",
      })
      const state = { timedOut: false }
      const killer = setTimeout(() => {
        state.timedOut = true
        proc.kill()
      }, timeoutMs)
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      clearTimeout(killer)
      return {
        exitCode,
        output: `${stdout}\n${stderr}`.trim(),
        timedOut: state.timedOut,
      }
    },
    catch: (cause) =>
      new GateCrash({
        gate: GateName.make("command"),
        message: `could not run ${argv.join(" ")}: ${String(cause)}`,
      }),
  })

/** The `path:line` findings in the output — one per distinct location. */
const locatedFindings = (output: string, rule: RuleId): ReadonlyArray<Finding> => {
  const lines = output.split("\n")
  const hits = Arr.filterMap(lines, (line) =>
    Option.fromNullable(FILE_LINE.exec(line)).pipe(
      Option.map((m) => ({
        file: m[1] ?? "",
        line: Number(m[2] ?? "1"),
        text: line.trim(),
      })),
    ),
  )
  const distinct = hits.filter(
    (hit, index) =>
      hits.findIndex((h) => h.file === hit.file && h.line === hit.line) === index,
  )
  return distinct.slice(0, MAX_LOCATED_FINDINGS).map(
    (hit) =>
      new Finding({
        rule,
        severity: "error",
        message: hit.text.slice(0, 300),
        location:
          hit.file.startsWith("/") || hit.line < 1
            ? Option.none()
            : Option.some(
                new SourceLocation({
                  file: WorkspacePath.make(hit.file),
                  line: hit.line,
                  column: 1,
                }),
              ),
        fixHint: Option.none(),
      }),
  )
}

/**
 * A rank-2 (`test`) gate that runs a command in the workspace and converts a
 * non-zero exit into error findings — `file:line` markers become located
 * findings where the output carries them, else ONE finding with the clipped
 * output tail. A command that cannot run at all (unspawnable, timeout) is a
 * `GateCrash`, which the pipeline folds fail-closed.
 */
export const makeCommandGate = (options: {
  readonly name: string
  readonly argv: Arr.NonEmptyReadonlyArray<string>
  readonly timeoutMs?: number
  readonly kind?: Extract<GateKind, "test" | "eval">
}): Gate<never> => {
  const gateName = GateName.make(options.name)
  const kind = options.kind ?? "test"
  const rule = RuleId.make(`${kind}/${options.name}`)
  const command = options.argv.join(" ")
  return {
    name: gateName,
    kind,
    deterministic: true,
    run: (workspace: Workspace) =>
      Effect.gen(function* () {
        const run = yield* runCommand(
          options.argv,
          workspace.rootDir,
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        )
        if (run.timedOut) {
          return yield* Effect.fail(
            new GateCrash({ gate: gateName, message: `\`${command}\` timed out` }),
          )
        }
        if (run.exitCode === 0) return []
        const tail = run.output.slice(-MAX_OUTPUT_CHARS)
        // Exit 127/126 with a not-found/not-executable signature is an
        // ENVIRONMENT failure, not a code failure — the old fixHint ("make
        // it pass") sent the zig run's coder chasing an unfixable finding
        // for two attempts. Name the class and the actual fix.
        if (
          (run.exitCode === 127 || run.exitCode === 126) &&
          MISSING_TOOL.test(run.output)
        ) {
          return [
            new Finding({
              rule: RuleId.make(`env/${options.name}`),
              severity: "error",
              message: `ENVIRONMENT: \`${command}\` exited ${run.exitCode} — its tool is missing from PATH:\n${tail.length > 0 ? tail : "(no output)"}`,
              location: Option.none(),
              fixHint: Option.some(
                `editing code cannot fix this — provision the missing tool into <workspace>/.local/bin (your shell AND the gates see it there) or have it installed on the host`,
              ),
            }),
          ]
        }
        const located = locatedFindings(run.output, rule)
        const summary = new Finding({
          rule,
          severity: "error",
          message: `\`${command}\` exited ${run.exitCode}:\n${tail.length > 0 ? tail : "(no output)"}`,
          location: Option.none(),
          fixHint: Option.some(`make \`${command}\` pass`),
        })
        return [...located, summary]
      }),
  }
}
