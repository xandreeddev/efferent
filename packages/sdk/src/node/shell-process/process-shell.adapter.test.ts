import { describe, expect, test } from "bun:test"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import type { ConformanceCheck } from "@xandreed/core"
import { Shell, shellConformance } from "../../index.js"
import type { ShellSubject } from "../../index.js"
import { scratch } from "../testing.js"
import { processShell } from "./process-shell.adapter.js"
import { keptOf, tailOf } from "./process-shell.entity.functions.js"

/*
 * The shell on this machine: the kit (each `*-kills` check proves the whole
 * process group is stopped), the environment it gives a command and no more,
 * and what it refuses. Node runs the same kit from the packed package
 * (`scripts/kernel-consumer.fixture.mjs`).
 */

const ENV = { KIT_GIVEN: "given value", PATH: "/usr/bin:/bin" }
const OUTPUT_BYTES = 1000

/** A shell over a fresh folder, built in the scope. */
const shellIn = (folder: string, options: { readonly env?: Readonly<Record<string, string>>; readonly outputBytes?: number; readonly shell?: string } = {}) =>
  Effect.map(Effect.orDie(Layer.build(processShell({ cwd: folder, env: options.env ?? ENV, outputBytes: options.outputBytes ?? OUTPUT_BYTES, ...(options.shell === undefined ? {} : { shell: options.shell }) }))), (services) => Context.get(services, Shell))

const run = (check: ConformanceCheck) => Effect.runPromise(Effect.result(check.run))

describe("processShell", () => {
  const folder = Effect.flatMap(scratch, (made) => Effect.promise(() => realpath(made)))

  for (const id of ["exit", "output", "bounded", "cwd", "environment", "timeout", "timeout-kills", "return-kills", "interrupt-kills", "close-kills"]) {
    test(`passes the shell kit's ${id} check`, async () => {
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const at = yield* folder
        const subject: ShellSubject = { open: shellIn(at), folder: at, env: ENV, outputBytes: OUTPUT_BYTES }
        const check = shellConformance(subject).find((one) => one.id === id)
        return check === undefined ? "no such check" : yield* Effect.promise(() => run(check))
      })))
      expect(result).toMatchObject({ _tag: "Success" })
    }, 40_000)
  }

  test("a variable of the host's process that the shell was not given never reaches a command", async () => {
    process.env["KERNEL_SHELL_SENTINEL"] = "the host's own"
    const out = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const shell = yield* shellIn(yield* folder, { env: {} })
      return yield* shell.run({ command: "env; printf '%s' \"${KERNEL_SHELL_SENTINEL-unset}\"" })
    }))).finally(() => { delete process.env["KERNEL_SHELL_SENTINEL"] })
    expect(out.stdout.endsWith("unset")).toBe(true)
    // With no variable given, a command sees only what the shell sets for itself.
    const names = out.stdout.slice(0, -"unset".length).split("\n").filter((line) => line.includes("=")).map((line) => line.slice(0, line.indexOf("="))).toSorted()
    expect(names.every((name) => ["OLDPWD", "PWD", "SHLVL", "_"].includes(name))).toBe(true)
  })

  test("a relative folder is read against the shell's own, and a timeout of the request is its own", async () => {
    const out = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const at = yield* folder
      const shell = yield* shellIn(at)
      yield* shell.run({ command: "mkdir -p inner" })
      const inner = yield* shell.run({ command: "pwd -P", cwd: "inner" })
      const ended = yield* shell.run({ command: "sleep 5", timeoutMs: 100 })
      return { inner: inner.stdout.trim() === join(at, "inner"), ended: ended.ended }
    })))
    expect(out).toEqual({ inner: true, ended: { _tag: "TimedOut", afterMs: 100 } })
  })

  test("a command killed by a signal it did not get from the shell ends Killed", async () => {
    const out = await Effect.runPromise(Effect.scoped(Effect.flatMap(Effect.flatMap(folder, (at) => shellIn(at)), (shell) => shell.run({ command: "kill -TERM $$" }))))
    expect(out.ended).toEqual({ _tag: "Killed", signal: "SIGTERM" })
  })

  test("a starting folder that is not one, and a shell that is not there, fail with ShellUnavailable", async () => {
    const out = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const at = yield* folder
      const shell = yield* shellIn(at)
      const noFolder = yield* Effect.flip(shell.run({ command: "true", cwd: "missing" }))
      const noShell = yield* Effect.flip((yield* shellIn(at, { shell: join(at, "no-shell") })).run({ command: "true" }))
      return [noFolder, noShell].map((error) => [error._tag, error.message.replaceAll(at, "<folder>")])
    })))
    expect(out[0]?.[0]).toBe("ShellUnavailable")
    expect(out[0]?.[1]).toStartWith("the folder <folder>/missing cannot be used: ")
    expect(out[1]?.[0]).toBe("ShellUnavailable")
    expect(out[1]?.[1]).toStartWith("<folder>/no-shell could not be started: ")
  })

  test("options that are none fail the layer where it is built", async () => {
    const built = (options: Parameters<typeof processShell>[0]) => Effect.runPromise(Effect.scoped(Effect.flip(Effect.sandbox(Layer.build(processShell(options))))))
    expect(String(await built({ cwd: "relative" }))).toContain("processShell: cwd must be an absolute folder")
    expect(String(await built({ cwd: "/", shell: "sh" }))).toContain("processShell: shell must be an absolute path")
    expect(String(await built({ cwd: "/", outputBytes: 0 }))).toContain("processShell: outputBytes must be a whole number of at least 1")
    expect(String(await built({ cwd: "/", timeoutMs: 1.5 }))).toContain("processShell: timeoutMs must be a whole number of at least 1")
  })
})

describe("a stream's end", () => {
  const bytes = (text: string) => new TextEncoder().encode(text)

  test("keeps the last bytes, starting at a character, and counts what it left out", () => {
    expect(tailOf([bytes("abc"), bytes("def")], 10)).toEqual({ text: "abcdef", cut: 0 })
    expect(tailOf([bytes("abc"), bytes("def")], 4)).toEqual({ text: "cdef", cut: 2 })
    // "é" is two bytes: a cut inside it leaves its second byte out too.
    expect(tailOf([bytes("aéé")], 3)).toEqual({ text: "é", cut: 3 })
    expect(tailOf([bytes("aéé")], 4)).toEqual({ text: "éé", cut: 1 })
    // A byte that is no UTF-8 reads as U+FFFD.
    expect(tailOf([new Uint8Array([0x61, 0xff, 0x62])], 10)).toEqual({ text: "a�b", cut: 0 })
  })

  test("drops whole chunks older than the bound as they come, keeping enough for it", () => {
    expect(keptOf([bytes("aaaa"), bytes("bbbb"), bytes("cc")], 5)).toEqual({ chunks: [bytes("bbbb"), bytes("cc")], dropped: 4 })
    expect(keptOf([bytes("aaaa"), bytes("bbbb"), bytes("cc")], 6)).toEqual({ chunks: [bytes("bbbb"), bytes("cc")], dropped: 4 })
    expect(keptOf([bytes("aaaa"), bytes("bbbb"), bytes("cc")], 7)).toEqual({ chunks: [bytes("aaaa"), bytes("bbbb"), bytes("cc")], dropped: 0 })
    expect(keptOf([bytes("aaaaaaaa")], 2)).toEqual({ chunks: [bytes("aaaaaaaa")], dropped: 0 })
  })
})
