import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { auditedReleaseNames, auditRelease, releaseAuditSource } from "./release-status.js"
import type { ReleaseAuditDependencies } from "./release-status.js"
import { releaseDirectories } from "./release-version-plan.js"

const version = "0.16.0"
const sha = "7eb972d259e80a0c88a99d81e84e9440aed884f0"
const other = "1111111111111111111111111111111111111111"
const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`
const metadata = (name: string, provenance = false) => ({ name, version, gitHead: sha,
  dist: { integrity, ...(provenance ? { attestations: { url: "https://registry.npmjs.org/attestation", provenance: { predicateType: "https://slsa.dev/provenance/v1" } } } : {}) },
})
const packageOf = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1)).replace(new RegExp(`/${version.replaceAll(".", "\\.")}$`), "")
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const dependencies = (fetch: ReleaseAuditDependencies["fetch"]): ReleaseAuditDependencies => ({ fetch, now: () => 0, sleep: async () => {} })

describe("public release audit", () => {
  test("audits the exact 24 framework names and landing package with six public requests at most", async () => {
    let active = 0
    let maximum = 0
    const report = await auditRelease({ version, sha }, dependencies(async (url, init) => {
      active++
      maximum = Math.max(maximum, active)
      expect(init.method).toBe("GET")
      expect(init.credentials).toBe("omit")
      expect(new Headers(init.headers).has("Authorization")).toBe(false)
      expect(init.signal).toBeDefined()
      await Bun.sleep(1)
      active--
      const name = packageOf(url)
      return json(metadata(name, name === "efferent"))
    }))
    expect(report.ok).toBe(true)
    expect(report.entries.map((entry) => entry.name)).toEqual([...auditedReleaseNames])
    expect(new Set(report.entries.map((entry) => entry.name)).size).toBe(25)
    expect(maximum).toBe(6)
    expect(report.counts).toEqual({ published: 25, missing: 0, mismatch: 0, unavailable: 0, provenance: 1 })
    expect(report.entries.every((entry) => entry.gitHead === sha && entry.integrity === integrity)).toBe(true)
  })

  test("version endpoint 404 falls back to the full package metadata during CDN propagation", async () => {
    const requests: string[] = []
    const report = await auditRelease({ version, sha }, dependencies(async (url) => {
      requests.push(url)
      const name = packageOf(url)
      if (name === auditedReleaseNames[0]) return new URL(url).pathname.endsWith(`/${version}`) ? json({}, 404) : json({ versions: { [version]: metadata(name) } })
      return json(metadata(name))
    }))
    expect(report.ok).toBe(true)
    expect(report.entries[0]?.via).toBe("packument")
    expect(requests).toHaveLength(26)
  })

  test("missing versions, immutable mismatches and unavailable metadata stay distinct", async () => {
    const report = await auditRelease({ version, sha }, dependencies(async (url) => {
      const name = packageOf(url)
      const index = auditedReleaseNames.indexOf(name)
      if (index === 0) return json({}, 404)
      if (index === 1) return new URL(url).pathname.endsWith(`/${version}`) ? json({}, 404) : json({ versions: {} })
      if (index === 2) return json({ ...metadata(name), gitHead: other })
      if (index === 3) return json({ ...metadata(name), name: "another-package" })
      if (index === 4) return json({ ...metadata(name), version: "0.15.1" })
      if (index === 5) return json({ name, version, dist: { integrity } })
      if (index === 6) return json({}, 503)
      if (index === 7) return new Response("not JSON", { status: 200 })
      if (index === 8) throw new Error("fixture network failure")
      return json(metadata(name))
    }))
    expect(report.ok).toBe(false)
    expect(report.counts).toEqual({ published: 16, missing: 2, mismatch: 4, unavailable: 3, provenance: 0 })
    expect(report.entries[2]?.reason).toContain("gitHead")
    expect(report.entries[5]?.gitHead).toBe(null)
    expect(report.entries[6]?.reason).toContain("503")
  })

  test("missing, malformed and non-SHA512 integrity are permanent mismatches", async () => {
    const invalid = [undefined, "", "sha512-fixture", `sha256-${Buffer.alloc(32).toString("base64")}`, `sha512-${Buffer.alloc(63).toString("base64")}`, `sha512-${"A".repeat(85)}B==`]
    const report = await auditRelease({ version, sha, waitSeconds: 300 }, {
      now: () => 0,
      sleep: async () => { throw new Error("Invalid integrity cannot heal through propagation") },
      fetch: async (url) => {
        const name = packageOf(url)
        const index = auditedReleaseNames.indexOf(name)
        const item = metadata(name)
        return json(index < invalid.length ? { ...item, dist: { ...item.dist, integrity: invalid[index] } } : item)
      },
    })
    expect(report.ok).toBe(false)
    expect(report.counts.mismatch).toBe(invalid.length)
    expect(report.counts.published).toBe(25 - invalid.length)
    expect(report.attempts).toBe(1)
    expect(report.entries.slice(0, invalid.length).every((entry) => !entry.retryable && entry.reason?.includes("sha512 integrity"))).toBe(true)
  })

  test("bounded waiting retries only pending packages and retains settled evidence", async () => {
    let clock = 0
    const counts = new Map<string, number>()
    const slept: number[] = []
    const report = await auditRelease({ version, sha, waitSeconds: 30 }, {
      now: () => clock, sleep: async (milliseconds) => { slept.push(milliseconds); clock += milliseconds },
      fetch: async (url) => {
        const name = packageOf(url)
        const count = (counts.get(name) ?? 0) + 1
        counts.set(name, count)
        return name === auditedReleaseNames[0] && count <= 2 ? json({}, 404) : json(metadata(name))
      },
    })
    expect(report.ok).toBe(true)
    expect(report.attempts).toBe(2)
    expect(slept).toEqual([5000])
    expect(counts.get(auditedReleaseNames[0]!)).toBe(3)
    expect(auditedReleaseNames.slice(1).every((name) => counts.get(name) === 1)).toBe(true)
  })

  test("waiting stops at the deadline and immutable source mismatches fail without sleeping", async () => {
    let clock = 0
    const slept: number[] = []
    const report = await auditRelease({ version, sha, waitSeconds: 6 }, {
      now: () => clock, sleep: async (milliseconds) => { slept.push(milliseconds); clock += milliseconds }, fetch: async () => json({}, 404),
    })
    expect(report.ok).toBe(false)
    expect(report.counts.missing).toBe(25)
    expect(report.attempts).toBe(2)
    expect(clock).toBe(6000)
    expect(slept).toEqual([5000, 1000])
    const mismatch = await auditRelease({ version, sha, waitSeconds: 300 }, {
      now: () => 0, sleep: async () => { throw new Error("An immutable mismatch must not wait") },
      fetch: async (url) => json({ ...metadata(packageOf(url)), gitHead: other }),
    })
    expect(mismatch.counts.mismatch).toBe(25)
    expect(mismatch.attempts).toBe(1)
  })

  test("provenance is informational by default and optionally required with propagation retry", async () => {
    const informational = await auditRelease({ version, sha }, dependencies(async (url) => json(metadata(packageOf(url)))))
    expect(informational.ok).toBe(true)
    expect(informational.counts.provenance).toBe(0)
    const required = await auditRelease({ version, sha, requireProvenance: true }, dependencies(async (url) => json(metadata(packageOf(url)))))
    expect(required.ok).toBe(false)
    expect(required.counts.mismatch).toBe(25)
    let clock = 0
    const propagated = await auditRelease({ version, sha, requireProvenance: true, waitSeconds: 30 }, {
      now: () => clock, sleep: async (milliseconds) => { clock += milliseconds }, fetch: async (url) => json(metadata(packageOf(url), clock > 0)),
    })
    expect(propagated.ok).toBe(true)
    expect(propagated.counts.provenance).toBe(25)
    expect(propagated.attempts).toBe(2)
  })

  test("invalid versions, SHAs and wait bounds fail before any registry request", async () => {
    const deps = dependencies(async () => { throw new Error("Must not fetch") })
    for (const options of [{ version: "0.16.1-beta", sha }, { version, sha: "main" }, { version, sha, waitSeconds: 301 }, { version, sha, waitSeconds: -1 }, { version, sha, waitSeconds: 0.5 }]) {
      await expect(auditRelease(options, deps)).rejects.toThrow("Expected a stable release version")
    }
  })
})

test("source inference validates the complete shared distribution and reads its real commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "efferent-status-source-"))
  try {
    const git = (...args: ReadonlyArray<string>) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
      if (!result.success) throw new Error(result.stderr.toString())
      return result.stdout.toString().trim()
    }
    git("init", "--initial-branch=main")
    git("config", "user.name", "Release fixture")
    git("config", "user.email", "fixture@example.invalid")
    await Promise.all(releaseDirectories.map(async (directory) => {
      await mkdir(join(root, "packages", directory), { recursive: true })
      await writeFile(join(root, "packages", directory, "package.json"), JSON.stringify({ name: `@xandreed/${directory}`, version }))
    }))
    git("add", ".")
    git("commit", "--no-verify", "-m", "release 0.16.0")
    expect(await releaseAuditSource(root)).toEqual({ version, sha: git("rev-parse", "HEAD") })
    await writeFile(join(root, "packages/core/package.json"), JSON.stringify({ name: "wrong-package", version }))
    await expect(releaseAuditSource(root)).rejects.toThrow("another package name")
    await writeFile(join(root, "packages/core/package.json"), JSON.stringify({ name: "@xandreed/core", version: "0.16.1" }))
    await expect(releaseAuditSource(root)).rejects.toThrow("All 24 source distribution packages")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the CLI emits JSON, a step summary and failing status without registry authentication", async () => {
  const root = await mkdtemp(join(tmpdir(), "efferent-status-cli-"))
  try {
    const preload = join(root, "registry.ts")
    const summary = join(root, "summary.md")
    await writeFile(preload, `globalThis.fetch = async (url, init) => {
      if (new Headers(init.headers).has("Authorization")) throw new Error("Unexpected authentication");
      const name=decodeURIComponent(new URL(url).pathname.slice(1)).replace(/\\/0\\.16\\.0$/, "");
      return new Response(JSON.stringify({name,version:"0.16.0",gitHead:${JSON.stringify(sha)},dist:{integrity:${JSON.stringify(integrity)}}}));
    };`)
    const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "release-status.ts"), "--version", version, "--sha", sha, "--require-provenance"], {
      cwd: root, env: { ...process.env, GITHUB_STEP_SUMMARY: summary }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).finally(() => child.kill())
    expect(code).toBe(1)
    expect(stderr).toBe("")
    const report = JSON.parse(stdout)
    expect(report.counts).toEqual({ published: 0, missing: 0, mismatch: 25, unavailable: 0, provenance: 0 })
    expect(report.entries.map((entry: { name: string }) => entry.name)).toEqual([...auditedReleaseNames])
    expect(await readFile(summary, "utf8")).toContain("| efferent | mismatch: Registry provenance metadata is missing")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
