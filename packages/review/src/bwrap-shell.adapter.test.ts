import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Result } from "effect"
import type { Ran } from "@xandreed/sdk"
import { bwrapHost, bwrapShell } from "./bwrap-shell.adapter.js"
import { ETC_ALWAYS } from "./sandbox.entity.js"
import type { HostLayout, SandboxPlan } from "./sandbox.entity.js"
import { probeArgv } from "./sandbox.entity.functions.js"

const SECRET = "review-probe-secret-7d1f"
process.env["REVIEW_PROBE_SECRET"] = SECRET
const PATH = process.env["PATH"] ?? "/usr/bin:/bin"
const host = await Effect.runPromise(Effect.result(bwrapHost(PATH)))
const layout: HostLayout | undefined = Result.isSuccess(host) ? host.success : undefined
/**
 * Where bwrap or user namespaces are missing the probe is skipped, but never in CI: the workflow installs bubblewrap
 * and allows unprivileged user namespaces, so a skip there would hide a sandbox that no longer isolates.
 */
const skip = layout === undefined && process.env["CI"] === undefined

const root = mkdtempSync(join(tmpdir(), "review-sandbox-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const work = (name: string): string => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

const inSandbox = (plan: SandboxPlan, command: string, timeoutMs = 20_000): Promise<Ran> => {
  if (layout === undefined) return Promise.reject(new Error(`no sandbox: ${Result.isFailure(host) ? host.failure.message : ""}`))
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const shell = yield* bwrapShell({ layout, plan })
    return yield* shell.run({ command, timeoutMs })
  })))
}

const offline = (workDir: string): SandboxPlan => ({ workDir, network: false, binds: [] })
const exitOf = (ran: Ran): number | string => ran.ended._tag === "Exited" ? ran.ended.code : ran.ended._tag

describe("bwrapShell, the isolation probe", () => {
  test("the host can make a sandbox (where it cannot, outside CI, the probe is skipped)", () => {
    if (process.env["CI"] !== undefined) expect(Result.isSuccess(host) ? "available" : host.failure.message).toBe("available")
    expect(typeof skip).toBe("boolean")
  })

  test.skipIf(skip)("a secret of the host's process is in no process's environment; spawned with it, bwrap would show it", async () => {
    const ran = await inSandbox(offline(work("env")), "for f in /proc/[0-9]*/environ; do tr '\\0' '\\n' < $f; done; echo; env")
    expect(exitOf(ran)).toBe(0)
    expect(ran.stdout).not.toContain(SECRET)
    expect(ran.stdout).toContain("HOME=/tmp/home")
    // The control: bwrap started with the secret in its own environment keeps it for its first process inside.
    if (layout === undefined) return
    const leaked = execFileSync(layout.bwrap, [...probeArgv(layout).slice(0, -2), "--", "/bin/sh", "-c", "tr '\\0' '\\n' < /proc/1/environ"], { env: { REVIEW_PROBE_SECRET: SECRET } }).toString()
    expect(leaked).toContain(SECRET)
  })

  test.skipIf(skip)("no /home, no host /tmp, and no folder of the host's outside the work folder (a mirror's .git)", async () => {
    const mirror = work("mirror.git")
    writeFileSync(join(mirror, "HEAD"), "ref: refs/heads/main\n")
    const ran = await inSandbox(offline(work("see")), `test -e /home && echo home; test -e ${mirror}/HEAD && echo mirror; test -e ${root} && echo root; ls /`)
    expect(exitOf(ran)).toBe(0)
    const top = (layout?.top ?? []).map((entry) => entry.path.slice(1))
    const etc = (layout?.etc ?? []).some((file) => (ETC_ALWAYS as ReadonlyArray<string>).includes(file.path)) ? ["etc"] : []
    expect(ran.stdout.split("\n").filter((line) => line.length > 0).sort()).toEqual(["dev", "opt", "proc", "tmp", "usr", "work", ...top, ...etc].sort())
  })

  test.skipIf(skip)("no network: DNS fails and a server on the host's loopback is out of reach; shared, the same server answers", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reached") })
    afterAll(() => server.stop(true))
    const probe = `getent hosts example.com || echo no-dns; bun -e "console.log(await (await fetch('http://127.0.0.1:${server.port}')).text())" 2>/dev/null || echo no-loopback`
    const off = await inSandbox(offline(work("net-off")), probe)
    expect(off.stdout).toBe("no-dns\nno-loopback\n")
    const on = await inSandbox({ workDir: work("net-on"), network: true, binds: [] }, `bun -e "console.log(await (await fetch('http://127.0.0.1:${server.port}')).text())"`)
    expect(on.stdout).toBe("reached\n")
  })

  test.skipIf(skip)("writes land in the work folder only; quotes, ;, $() and backticks run inside and leave no marker outside", async () => {
    const dir = work("write")
    const outside = join(root, "outside-marker")
    const commands = [
      `touch /usr/x /x /opt/tool/x ${outside} 2>/dev/null; touch /work/plain`,
      `echo "a'b"; touch ${outside}; touch /work/semi`,
      `echo $(touch ${outside}; touch /work/sub)`,
      `echo \`touch ${outside}; touch /work/tick\``,
      `echo '"; touch ${outside}; echo "'; touch /work/quoted`,
    ]
    for (const command of commands) await inSandbox(offline(dir), command)
    expect(existsSync(outside)).toBe(false)
    expect(["plain", "semi", "sub", "tick", "quoted"].map((name) => existsSync(join(dir, name)))).toEqual([true, true, true, true, true])
  })

  test.skipIf(skip)("a starting folder outside the work folder is refused", async () => {
    if (layout === undefined) return
    const { refused, ran } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const shell = yield* bwrapShell({ layout, plan: offline(work("cwd")) })
      const refused = [yield* Effect.exit(shell.run({ command: "pwd", cwd: "/etc" })), yield* Effect.exit(shell.run({ command: "pwd", cwd: "../x" }))]
      return { refused, ran: yield* shell.run({ command: "pwd", cwd: "." }) }
    })))
    expect(refused.map((exit) => Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail" ? exit.cause.reasons[0].error._tag : "ran")).toEqual(["ShellRefused", "ShellRefused"])
    expect(ran.stdout).toBe("/work\n")
  })

  test.skipIf(skip)("an install with --ignore-scripts does not run the package's postinstall; without it, it would", async () => {
    const dir = work("install")
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }))
    expect(exitOf(await inSandbox(offline(dir), "bun install"))).toBe(0)
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { postinstall: "touch postinstall-ran" } }))
    const ignored = await inSandbox(offline(dir), "bun install --frozen-lockfile --ignore-scripts")
    expect(exitOf(ignored)).toBe(0)
    expect(existsSync(join(dir, "postinstall-ran"))).toBe(false)
    await inSandbox(offline(dir), "bun install --frozen-lockfile")
    expect(existsSync(join(dir, "postinstall-ran"))).toBe(true)
    // HOME is the sandbox's own /tmp: what bun caches there never lands in the clone.
    expect(existsSync(join(dir, ".bun"))).toBe(false)
  })

  test.skipIf(skip)("a timeout stops every process the command started, one in a session of its own too, and so does the command's return", async () => {
    const dir = work("kill")
    const beat = (name: string) => `setsid sh -c 'while :; do date +%s%N > /work/${name}; sleep 0.05; done' > /dev/null 2>&1 &`
    const timedOut = await inSandbox(offline(dir), `${beat("timed")} sleep 100`, 800)
    expect(timedOut.ended._tag).toBe("TimedOut")
    await inSandbox(offline(dir), `${beat("returned")} sleep 0.3`)
    const first = ["timed", "returned"].map((name) => readFileSync(join(dir, name), "utf8"))
    await Bun.sleep(400)
    expect(["timed", "returned"].map((name) => readFileSync(join(dir, name), "utf8"))).toEqual(first)
  })

  test.skipIf(skip)("each command runs under its limits: no core files and the file size bounded; the address space only when a host sets it", async () => {
    const ran = await inSandbox(offline(work("limits")), "ulimit -c; ulimit -v; ulimit -f")
    expect(ran.stdout).toBe(`0\nunlimited\n${4 * 1024 * 1024}\n`)
    if (layout === undefined) return
    const bounded = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const shell = yield* bwrapShell({ layout, plan: offline(work("limits")), limits: { memoryBytes: 8 * 1024 ** 3, fileBytes: 1024 ** 3 } })
      return yield* shell.run({ command: "ulimit -v; ulimit -f" })
    })))
    expect(bounded.stdout).toBe(`${8 * 1024 * 1024}\n${2 * 1024 * 1024}\n`)
  })
})
