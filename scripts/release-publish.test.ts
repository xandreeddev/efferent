import { describe, expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const commit = "9b898c1bb0740d8ba71cd8429cc5b408c46755cb"
const other = "15d6dc518d5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const core = { name: "@xandreed/core", version: "0.16.0" }
const metadata = { ...core, gitHead: commit }

const runRelease = async (options: { dryRun?: boolean; verify?: boolean; status?: number; body?: unknown; remote?: string; remoteAfterPublish?: string; networkFailure?: boolean; ci?: boolean; sourceRoot?: boolean; publisher?: boolean; tty?: boolean; env?: Record<string, string>; account?: string; dirty?: boolean; builtHead?: string; certificateSha?: string } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "efferent-release-preflight-"))
  const commands = join(root, "commands.log")
  const live = join(root, "live")
  const source = options.sourceRoot ? join(root, "old-source") : root
  const output = join(root, "github-output")
  const npmContext = join(root, "npm-context")
  try {
    await mkdir(join(root, "scripts"))
    await mkdir(join(source, "packages/core"), { recursive: true })
    await mkdir(join(source, ".artifacts/packages/core"), { recursive: true })
    await mkdir(join(root, "bin"))
    await symlink(join(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir")
    await Promise.all(["release-publish.ts", "publish-packages.ts", "npm-registry.ts", "publish-plan.ts"].map((name) => copyFile(join(import.meta.dir, name), join(root, "scripts", name))))
    await writeFile(join(source, "packages/core/package.json"), JSON.stringify(core))
    await writeFile(join(source, ".artifacts/packages/core/package.json"), JSON.stringify({ ...core, gitHead: options.builtHead ?? commit, description: "Preserve unrelated distribution fields", exports: { ".": "./dist/index.js" } }))
    await writeFile(join(source, ".artifacts/packages/build.json"), JSON.stringify({ commit, dirty: options.dirty ?? false, version: core.version, packages: [{ dir: "core", ...core }] }))
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
if [ "$PWD" != "$RELEASE_TEST_SOURCE" ]; then exit 98; fi
printf 'bun %s\\n' "$*" >> "$RELEASE_TEST_COMMANDS"
case "$*" in *--publish) touch "$RELEASE_TEST_LIVE" ;; esac
`, { mode: 0o755 })
    await writeFile(join(root, "bin/npm"), `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$RELEASE_TEST_COMMANDS"
if [ "$1" = whoami ]; then printf '%s\\n' "$RELEASE_TEST_ACCOUNT"; fi
if [ -n "$RELEASE_TEST_EXPECT_OIDC_TOKEN" ] && [ "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" != "$RELEASE_TEST_EXPECT_OIDC_TOKEN" ]; then exit 99; fi
if [ "$1" = publish ]; then
  printf '%s\\n' "$GITHUB_SHA" "$GITHUB_WORKFLOW_SHA" "$GITHUB_WORKFLOW_REF" "$GITHUB_RUN_ID" "$ACTIONS_ID_TOKEN_REQUEST_URL" > "$RELEASE_TEST_NPM_CONTEXT"
  if [ -n "$RELEASE_TEST_CERTIFICATE_SHA" ] && [ "$GITHUB_SHA" != "$RELEASE_TEST_CERTIFICATE_SHA" ]; then
    printf '%s\\n' 'E422: provenance gitCommit does not match certificate SourceRepositoryDigest' >&2
    exit 42
  fi
fi
`, { mode: 0o755 })
    await writeFile(join(root, "registry-preload.ts"), `Object.defineProperty(process.stdin, "isTTY", { value: ${options.tty ?? true} });
const originalWorkflowSha = process.env.GITHUB_SHA;
process.on("exit", () => { if (process.env.GITHUB_SHA !== originalWorkflowSha) process.exitCode = 97; });
globalThis.fetch = async () => {
  if (process.env.RELEASE_TEST_NETWORK_FAILURE === "1") throw new Error("fixture network unavailable");
  return new Response(process.env.RELEASE_TEST_BODY, { status: Number(process.env.RELEASE_TEST_STATUS) });
};
`)
    const result = Bun.spawnSync([process.execPath, "--preload", join(root, "registry-preload.ts"), join(root, options.publisher ? "scripts/publish-packages.ts" : "scripts/release-publish.ts"), ...(options.ci ? ["--ci"] : []), ...(options.sourceRoot ? ["--root", source] : []), ...(options.verify ? ["--verify"] : []), ...(!options.publisher && options.dryRun ? ["--dry-run"] : [])], {
      cwd: root,
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, RELEASE_TEST_HEAD: commit, RELEASE_TEST_COMMANDS: commands, RELEASE_TEST_LIVE: live, RELEASE_TEST_SOURCE: source, RELEASE_TEST_NPM_CONTEXT: npmContext, RELEASE_TEST_CERTIFICATE_SHA: options.certificateSha ?? "",
        RELEASE_TEST_REMOTE: options.remote ?? "", RELEASE_TEST_REMOTE_AFTER: options.remoteAfterPublish ?? options.remote ?? "",
        RELEASE_TEST_STATUS: String(options.status ?? 200), RELEASE_TEST_BODY: JSON.stringify(options.body ?? metadata), RELEASE_TEST_NETWORK_FAILURE: options.networkFailure ? "1" : "0", RELEASE_TEST_ACCOUNT: options.account ?? "xandreed", RELEASE_TEST_EXPECT_OIDC_TOKEN: options.env?.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "",
        GITHUB_ACTIONS: "", GITHUB_REPOSITORY: "", ACTIONS_ID_TOKEN_REQUEST_URL: "", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "", NODE_AUTH_TOKEN: "", GITHUB_OUTPUT: output, ...options.env },
      stdout: "pipe", stderr: "pipe", timeout: 5000,
    })
    return { code: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}`, commands: (await readFile(commands, "utf8")).trim().split("\n").filter(Boolean).map((command) => command.replaceAll(root, "<fixture>")),
      manifest: JSON.parse(await readFile(join(source, ".artifacts/packages/core/package.json"), "utf8")), sourceManifest: JSON.parse(await readFile(join(source, "packages/core/package.json"), "utf8")), completion: await Bun.file(output).exists() ? await readFile(output, "utf8") : "", npmContext: await Bun.file(npmContext).exists() ? await readFile(npmContext, "utf8") : "" }
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
    expect(result.commands).toEqual(["bun install --frozen-lockfile --ignore-scripts", "bun run build:packages", "bun run publish:packages", "bun run publish:packages --publish", "git tag v0.16.0", "git push origin refs/tags/v0.16.0:refs/tags/v0.16.0"])
  })

  test("a tag changed after publishing is rechecked and never moved or pushed", async () => {
    const result = await runRelease({ remoteAfterPublish: other })
    expect(result.code).toBe(1)
    expect(result.commands.at(-1)).toBe("bun run publish:packages --publish")
    expect(result.commands.some((command) => command.startsWith("git "))).toBe(false)
  })
})

const github = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "xandreeddev/efferent" }
const oidc = { ...github, ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example.invalid/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-oidc-request" }

describe("CI release source isolation", () => {
  test("CI refuses an untrusted context before commands even without a terminal", async () => {
    const result = await runRelease({ ci: true, tty: false })
    expect(result.code).toBe(1)
    expect(result.commands).toEqual([])
  })

  test("a noninteractive old source checkout uses the pipeline publisher and emits the source release identity", async () => {
    const result = await runRelease({ ci: true, tty: false, sourceRoot: true, env: oidc })
    expect(result.code).toBe(0)
    expect(result.commands).toEqual(["bun install --frozen-lockfile --ignore-scripts", "bun run build:packages", "bun <fixture>/scripts/publish-packages.ts --ci --root <fixture>/old-source", "bun <fixture>/scripts/publish-packages.ts --ci --root <fixture>/old-source --publish", "git tag v0.16.0", "git push origin refs/tags/v0.16.0:refs/tags/v0.16.0"])
    expect(result.completion).toBe(`version=0.16.0\ntag=v0.16.0\nsha=${commit}\n`)
  })

  test("CI dry run uses the current publisher without uploads, tags or completion outputs", async () => {
    const result = await runRelease({ ci: true, tty: false, sourceRoot: true, dryRun: true, verify: true, env: oidc })
    expect(result.code).toBe(0)
    expect(result.commands[2]).toBe("bun run verify:packages")
    expect(result.commands.at(-1)).toBe("bun <fixture>/scripts/publish-packages.ts --ci --root <fixture>/old-source")
    expect(result.completion).toBe("")
  })

  test("OIDC publication skips whoami, adds provenance and overlays only built repository metadata", async () => {
    const result = await runRelease({ ci: true, publisher: true, sourceRoot: true, status: 404, env: oidc })
    expect(result.code).toBe(0)
    expect(result.commands).toHaveLength(1)
    expect(result.commands[0]).toContain("npm publish ./.artifacts/packages/core")
    expect(result.commands[0]).toContain("--provenance --dry-run")
    expect(result.manifest).toMatchObject({ ...metadata, description: "Preserve unrelated distribution fields", exports: { ".": "./dist/index.js" }, repository: { type: "git", url: "git+https://github.com/xandreeddev/efferent.git", directory: "packages/core" } })
    expect(result.sourceManifest).toEqual(core)
  })

  test("a supplied CI token retains the publisher account guard", async () => {
    const beforeBuild = await runRelease({ ci: true, tty: false, env: { ...github, NODE_AUTH_TOKEN: "fixture-token" }, account: "another-account" })
    expect(beforeBuild.code).toBe(1)
    expect(beforeBuild.commands).toEqual(["npm whoami --registry https://registry.npmjs.org"])
    const wrong = await runRelease({ ci: true, publisher: true, sourceRoot: true, status: 404, env: { ...oidc, NODE_AUTH_TOKEN: "fixture-token" }, account: "another-account" })
    expect(wrong.code).toBe(1)
    expect(wrong.output).toContain("published only as xandreed")
    expect(wrong.commands).toEqual(["npm whoami --registry https://registry.npmjs.org"])
    const valid = await runRelease({ ci: true, publisher: true, sourceRoot: true, status: 404, env: { ...github, NODE_AUTH_TOKEN: "fixture-token" } })
    expect(valid.code).toBe(0)
    expect(valid.commands[0]).toBe("npm whoami --registry https://registry.npmjs.org")
    expect(valid.commands[1]).toContain("--provenance")
  })

  test("CI still refuses dirty builds and mismatching source commit metadata", async () => {
    const dirty = await runRelease({ ci: true, publisher: true, status: 404, env: oidc, dirty: true })
    expect(dirty.code).toBe(1)
    expect(dirty.commands).toEqual([])
    const stale = await runRelease({ ci: true, publisher: true, status: 404, env: oidc, builtHead: other })
    expect(stale.code).toBe(1)
    expect(stale.output).toContain("gitHead different from the source checkout")
    expect(stale.commands).toEqual([])
  })

  test("npm provenance retains the signed pipeline identity while gitHead names the verified source", async () => {
    const workflow = "xandreeddev/efferent/.github/workflows/release.yml@refs/heads/main"
    const result = await runRelease({ ci: true, publisher: true, sourceRoot: true, status: 404, certificateSha: other,
      env: { ...oidc, GITHUB_SHA: other, GITHUB_WORKFLOW_SHA: other, GITHUB_WORKFLOW_REF: workflow, GITHUB_RUN_ID: "fixture-run-123" } })
    expect(result.code).toBe(0)
    expect(result.npmContext).toBe(`${other}\n${other}\n${workflow}\nfixture-run-123\n${oidc.ACTIONS_ID_TOKEN_REQUEST_URL}\n`)
    expect(result.manifest.gitHead).toBe(commit)
  })

  test("the registry fixture rejects a provenance SHA that differs from the signing certificate", async () => {
    const result = await runRelease({ ci: true, publisher: true, sourceRoot: true, status: 404, certificateSha: commit,
      env: { ...oidc, GITHUB_SHA: other, GITHUB_WORKFLOW_SHA: other } })
    expect(result.code).toBe(1)
    expect(result.output).toContain("provenance gitCommit does not match certificate SourceRepositoryDigest")
    expect(result.manifest.gitHead).toBe(commit)
  })
})
