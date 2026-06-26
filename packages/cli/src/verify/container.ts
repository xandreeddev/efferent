import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { check, type CheckOutcome } from "./check.js"
import type { CheckResult, Tier } from "./report.js"
import type { VerifyCtx } from "./context.js"

/**
 * The release/npm clean-room battery. Builds `test/docker/Dockerfile.npm` for
 * the published spec, runs the container, copies the in-repo `run.sh` in (the
 * one already wired for the curl/daemon turns), execs it, and maps its
 * `ok`/`FAIL`/`soft` lines into the typed report. This validates the *published
 * artifact installs and runs* — exactly what the release target is for. Tier-A
 * UI-flow tests need a source tree, so they're absent here (reported by run.ts).
 */

const dockerDir = (): string | undefined => {
  const here = dirname(fileURLToPath(import.meta.url)) // …/packages/cli/src/verify
  const root = join(here, "..", "..", "..", "..")
  const dir = join(root, "test/docker")
  return existsSync(join(dir, "Dockerfile.npm")) ? dir : undefined
}

const run = (cmd: ReadonlyArray<string>): Effect.Effect<{ ok: boolean; stdout: string }> =>
  Effect.tryPromise(async () => {
    const proc = Bun.spawn([...cmd], { stdout: "pipe", stderr: "pipe", env: process.env })
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    return { ok: exitCode === 0, stdout }
  }).pipe(Effect.orElseSucceed(() => ({ ok: false, stdout: "" })))

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

const SECTION_TIER = (header: string): Tier =>
  /in-process|daemon/i.test(header) ? "B" : "A"

/** Parse run.sh's coloured output into per-check rows. */
const parseRunSh = (stdout: string): ReadonlyArray<CheckResult> => {
  const rows: CheckResult[] = []
  let tier: Tier = "A"
  for (const raw of stdout.split("\n")) {
    const line = stripAnsi(raw)
    const sec = /^===\s*(.+?)\s*===$/.exec(line.trim())
    if (sec) {
      tier = SECTION_TIER(sec[1]!)
      continue
    }
    const m = /^\s*(ok|FAIL|soft)\s+(.*)$/.exec(line)
    if (!m) continue
    const status = m[1] === "ok" ? "pass" : m[1] === "FAIL" ? "fail" : "soft"
    rows.push({ name: m[2]!.slice(0, 48), tier, status, ms: 0 })
  }
  return rows
}

export const runContainerBattery = (
  spec: string,
  expectVersion: string | undefined,
  ctx: VerifyCtx,
): Effect.Effect<ReadonlyArray<CheckResult>> =>
  Effect.gen(function* () {
    const dir = dockerDir()
    if (dir === undefined) {
      return [yield* check("container", "A", Effect.succeed({ status: "fail", detail: "release/npm target needs a source checkout for the Dockerfile" } as CheckOutcome))]
    }

    const tag = `efferent-verify:${spec.replace(/[^a-z0-9.]/gi, "-")}`
    const name = `efferent-verify-${Date.now()}`
    const authSrc = join(homedir(), ".efferent", "auth.json")

    return yield* Effect.gen(function* () {
      // build + start (Dockerfile.npm = clean-room npm install of the spec)
      const built = yield* run([
        "docker", "build", "-f", join(dir, "Dockerfile.npm"),
        "--build-arg", `SPEC=${spec}`, "-t", tag, dir,
      ])
      if (!built.ok) return [bootFail("docker build failed")]
      const started = yield* run(["docker", "run", "-d", "--name", name, tag])
      if (!started.ok) return [bootFail("docker run failed")]

      // copy the battery script in; copy auth (keyed) if present
      yield* run(["docker", "cp", join(dir, "run.sh"), `${name}:/verify-run.sh`])
      if (ctx.hasKey && existsSync(authSrc)) {
        yield* run(["docker", "exec", name, "mkdir", "-p", "/root/.efferent"])
        yield* run(["docker", "cp", authSrc, `${name}:/root/.efferent/auth.json`])
      }

      // exec the battery, pinning the cheap model + the expected version
      const execArgs = ["docker", "exec",
        "-e", `EFFERENT_MODEL=${ctx.model}`,
        ...(expectVersion ? ["-e", `EXPECT_VERSION=${expectVersion}`] : []),
        name, "bash", "/verify-run.sh"]
      const res = yield* run(execArgs)
      const rows = parseRunSh(res.stdout)
      return rows.length > 0 ? rows : [bootFail("no parsable output from the container battery")]
    }).pipe(
      Effect.ensuring(run(["docker", "rm", "-f", name]).pipe(Effect.asVoid)),
    )
  })

const bootFail = (detail: string): CheckResult => ({ name: "container", tier: "A", status: "fail", detail, ms: 0 })
