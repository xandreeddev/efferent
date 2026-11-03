import { describe, expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const commit = "9b898c1bb0740d8ba71cd8429cc5b408c46755cb"
const other = "15d6dc518d5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const core = { name: "@xandreed/core", version: "0.16.0" }
const metadata = { ...core, gitHead: commit }

const runRelease = async (options: { dryRun?: boolean; status?: number; body?: unknown; remote?: string; remoteAfterPublish?: string; networkFailure?: boolean } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "efferent-release-preflight-"))
  const commands = join(root, "commands.log")
  const live = join(root, "live")
  try {
    await mkdir(join(root, "scripts"))
    await mkdir(join(root, "packages/core"), { recursive: true })
    await mkdir(join(root, ".artifacts/packages"), { recursive: true })
    await mkdir(join(root, "bin"))
    await symlink(join(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir")
    await Promise.all(["release-publish.ts", "npm-registry.ts", "publish-plan.ts"].map((name) => copyFile(join(import.meta.dir, name), join(root, "scripts", name))))
    await writeFile(join(root, "packages/core/package.json"), JSON.stringify(core))
    await writeFile(join(root, ".artifacts/packages/build.json"), JSON.stringify({ commit, dirty: false, version: core.version, packages: [{ dir: "core", ...core }] }))
    await writeFile(commands, "")
    await writeFile(join(root, "bin/git"), `#!/bin/sh
case "$1" in
  rev-parse) if [ "$2" = "-q" ]; then exit 1; else printf '%s\\n' "$RELEASE_TEST_HEAD"; fi ;;
  status) exit 0 ;;
  ls-remote) if [ -f "$RELEASE_TEST_LIVE" ]; then sha="$RELEASE_TEST_REMOTE_AFTER"; else sha="$RELEASE_TEST_REMOTE"; fi; if [ -n "$sha" ]; then printf '%s\\trefs/tags/v0.16.0\\n' "$sha"; fi ;;
  tag|push) printf 'git %s\\n' "$*" >> "$RELEASE_TEST_COMMANDS" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 })
    await writeFile(join(root, "bin/bun"), `#!/bin/sh
printf 'bun %s\\n' "$*" >> "$RELEASE_TEST_COMMANDS"
if [ "$*" = "run publish:packages --publish" ]; then touch "$RELEASE_TEST_LIVE"; fi
`, { mode: 0o755 })
    await writeFile(join(root, "registry-preload.ts"), `Object.defineProperty(process.stdin, "isTTY", { value: true });
globalThis.fetch = async () => {
  if (process.env.RELEASE_TEST_NETWORK_FAILURE === "1") throw new Error("fixture network unavailable");
  return new Response(process.env.RELEASE_TEST_BODY, { status: Number(process.env.RELEASE_TEST_STATUS) });
};
`)
    const result = Bun.spawnSync([process.execPath, "--preload", join(root, "registry-preload.ts"), join(root, "scripts/release-publish.ts"), ...(options.dryRun ? ["--dry-run"] : [])], {
      cwd: root,
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, RELEASE_TEST_HEAD: commit, RELEASE_TEST_COMMANDS: commands, RELEASE_TEST_LIVE: live,
        RELEASE_TEST_REMOTE: options.remote ?? "", RELEASE_TEST_REMOTE_AFTER: options.remoteAfterPublish ?? options.remote ?? "",
        RELEASE_TEST_STATUS: String(options.status ?? 200), RELEASE_TEST_BODY: JSON.stringify(options.body ?? metadata), RELEASE_TEST_NETWORK_FAILURE: options.networkFailure ? "1" : "0" },
      stdout: "pipe", stderr: "pipe", timeout: 5000,
    })
    return { code: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}`, commands: (await readFile(commands, "utf8")).trim().split("\n").filter(Boolean) }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("release preflight orchestration without uploads", () => {
  test("a different published core commit refuses before install or upload, including dry runs", async () => {
    const result = await runRelease({ dryRun: true, body: { ...metadata, gitHead: other } })
    expect(result.code).toBe(1)
    expect(result.output).toContain("resume from its original commit or prepare a new shared version")
    expect(result.commands).toEqual([])
  })

  test("missing npm provenance and network failures refuse before commands", async () => {
    const missing = await runRelease({ body: core })
    expect(missing.code).toBe(1)
    expect(missing.output).toContain("npm records no gitHead")
    expect(missing.commands).toEqual([])
    const unavailable = await runRelease({ networkFailure: true })
    expect(unavailable.code).toBe(1)
    expect(unavailable.output).toContain("registry release metadata could not be read")
    expect(unavailable.commands).toEqual([])
  })

  test("an existing conflicting origin tag refuses before upload", async () => {
    const result = await runRelease({ remote: other })
    expect(result.code).toBe(1)
    expect(result.output).toContain("origin's tag v0.16.0 names")
    expect(result.commands).toEqual([])
  })

  test("a new version dry-runs without uploading or tagging", async () => {
    const result = await runRelease({ dryRun: true, status: 404 })
    expect(result.code).toBe(0)
    expect(result.commands).toEqual(["bun install --frozen-lockfile --ignore-scripts", "bun run build:packages", "bun run publish:packages"])
  })

  test("a same-commit resume keeps ordered publishing and tags only afterwards", async () => {
    const result = await runRelease()
    expect(result.code).toBe(0)
    expect(result.commands).toEqual(["bun install --frozen-lockfile --ignore-scripts", "bun run build:packages", "bun run publish:packages", "bun run publish:packages --publish", "git tag v0.16.0", "git push origin refs/tags/v0.16.0"])
  })

  test("a tag changed after publishing is rechecked and never moved or pushed", async () => {
    const result = await runRelease({ remoteAfterPublish: other })
    expect(result.code).toBe(1)
    expect(result.commands.at(-1)).toBe("bun run publish:packages --publish")
    expect(result.commands.some((command) => command.startsWith("git "))).toBe(false)
  })
})
