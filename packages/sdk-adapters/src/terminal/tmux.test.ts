import { describe, expect, it } from "bun:test"
import { Shell, type ShellExecInput, TerminalSession } from "@xandreed/sdk-core"
import { Effect, Exit, Layer } from "effect"
import { NoopTerminalSessionLive, TmuxTerminalSessionLive } from "./tmux.js"

/** A Shell that records every command and returns a canned exit/stdout. */
const recordingShell = (stdoutFor: (cmd: string) => { stdout?: string; exitCode?: number } = () => ({})) => {
  const commands: Array<string> = []
  const layer = Layer.succeed(
    Shell,
    Shell.of({
      exec: ({ command }: ShellExecInput) => {
        commands.push(command)
        const r = stdoutFor(command)
        return Effect.succeed({
          exitCode: r.exitCode ?? 0,
          stdout: r.stdout ?? "",
          stderr: "",
          durationMs: 1,
          timedOut: false,
        })
      },
    } as never),
  )
  return { commands, layer }
}

const withTmux = <A, E>(
  shellLayer: Layer.Layer<Shell>,
  program: Effect.Effect<A, E, TerminalSession>,
) => Effect.runPromise(program.pipe(Effect.provide(TmuxTerminalSessionLive.pipe(Layer.provide(shellLayer)))))

describe("TmuxTerminalSession — argv", () => {
  it("start issues `tmux new-session -d -s <id> -c <cwd>` (+ the command)", async () => {
    const { commands, layer } = recordingShell()
    const r = await withTmux(
      layer,
      Effect.gen(function* () {
        return yield* (yield* TerminalSession).start({ cwd: "/w", name: "demo", command: "agy" })
      }),
    )
    expect(r.sessionId.startsWith("efferent-")).toBe(true)
    const cmd = commands.find((c) => c.includes("new-session"))
    expect(cmd).toBeDefined()
    expect(cmd).toContain("tmux new-session -d -s")
    expect(cmd).toContain("-c '/w'")
    expect(cmd).toContain("'agy'")
  })

  it("send issues send-keys then an Enter (unless enter:false)", async () => {
    const { commands, layer } = recordingShell()
    await withTmux(
      layer,
      Effect.gen(function* () {
        yield* (yield* TerminalSession).send({ sessionId: "efferent-s-1", keys: "ls" })
      }),
    )
    const sends = commands.filter((c) => c.includes("send-keys"))
    expect(sends.length).toBe(2) // the keys, then Enter
    expect(sends[0]).toContain("send-keys -t 'efferent-s-1' 'ls'")
    expect(sends[1]).toContain("Enter")

    const { commands: c2, layer: l2 } = recordingShell()
    await withTmux(
      l2,
      Effect.gen(function* () {
        yield* (yield* TerminalSession).send({ sessionId: "s", keys: "q", enter: false })
      }),
    )
    expect(c2.filter((c) => c.includes("send-keys")).length).toBe(1) // no Enter
  })

  it("read issues capture-pane -p (with scrollback when lines given)", async () => {
    const { commands, layer } = recordingShell(() => ({ stdout: "SCREEN" }))
    const r = await withTmux(
      layer,
      Effect.gen(function* () {
        return yield* (yield* TerminalSession).read({ sessionId: "s", lines: 50 })
      }),
    )
    expect(r.screen).toBe("SCREEN")
    const cmd = commands.find((c) => c.includes("capture-pane"))
    expect(cmd).toContain("capture-pane -t 's' -p")
    expect(cmd).toContain("-S -50")
  })

  it("a non-zero tmux exit surfaces as a TerminalSessionError", async () => {
    const { layer } = recordingShell(() => ({ exitCode: 1 }))
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* (yield* TerminalSession).read({ sessionId: "missing" })
      }).pipe(Effect.provide(TmuxTerminalSessionLive.pipe(Layer.provide(layer)))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("available reflects `tmux -V` exit code", async () => {
    const present = recordingShell(() => ({ exitCode: 0 }))
    const absent = recordingShell(() => ({ exitCode: 127 }))
    expect(
      await withTmux(present.layer, Effect.flatMap(TerminalSession, (s) => s.available)),
    ).toBe(true)
    expect(
      await withTmux(absent.layer, Effect.flatMap(TerminalSession, (s) => s.available)),
    ).toBe(false)
  })
})

describe("NoopTerminalSession", () => {
  it("reports unavailable and fails start with a clear message", async () => {
    const avail = await Effect.runPromise(
      Effect.flatMap(TerminalSession, (s) => s.available).pipe(
        Effect.provide(NoopTerminalSessionLive),
      ),
    )
    expect(avail).toBe(false)
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* (yield* TerminalSession).start({ cwd: "/w" })
      }).pipe(Effect.provide(NoopTerminalSessionLive)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
