import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { NOT_ALLOWED } from "./repo-profile.entity.js"
import { doneCommandsOf, droppedBecause, managerOf, profileOf, yarnPathOf } from "./repo-profile.entity.functions.js"

const json = (value: unknown) => Option.some(JSON.stringify(value))
const none = Option.none<string>()
const tools = ["bun", "node", "pnpm", "yarn"]

describe("managerOf", () => {
  test.each([
    ["a bun.lock", { lockfiles: ["bun.lock"], packageJson: none, yarnrc: none }, [], tools, { _tag: "Chosen", manager: "bun", lockfile: "bun.lock", install: "BUN_INSTALL_CACHE_DIR=/cache bun install --frozen-lockfile --ignore-scripts --backend=copyfile", run: "bun run" }],
    ["npm's lockfile, npm through node", { lockfiles: ["package-lock.json"], packageJson: none, yarnrc: none }, [], ["node"], { _tag: "Chosen", manager: "npm", lockfile: "package-lock.json", install: "npm ci --ignore-scripts --no-audit --no-fund --cache /cache", run: "npm run" }],
    ["pnpm named by packageManager over a stray yarn.lock", { lockfiles: ["yarn.lock", "pnpm-lock.yaml"], packageJson: json({ packageManager: "pnpm@9.1.0" }), yarnrc: none }, [], tools, { _tag: "Chosen", manager: "pnpm", lockfile: "pnpm-lock.yaml", install: "pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --store-dir /cache --package-import-method copy", run: "pnpm run" }],
    ["yarn v1 with the host's yarn", { lockfiles: ["yarn.lock"], packageJson: none, yarnrc: none }, [], tools, { _tag: "Chosen", manager: "yarn", lockfile: "yarn.lock", install: "yarn install --frozen-lockfile --ignore-scripts --non-interactive --cache-folder /cache", run: "yarn run" }],
    ["yarn berry through the base's yarnPath", { lockfiles: ["yarn.lock"], packageJson: none, yarnrc: Option.some("nodeLinker: node-modules\nyarnPath: .yarn/releases/yarn-4.1.0.cjs\n") }, ["src/a.ts"], tools, { _tag: "Chosen", manager: "yarn", lockfile: "yarn.lock", install: "YARN_ENABLE_SCRIPTS=0 YARN_ENABLE_GLOBAL_CACHE=0 YARN_CACHE_FOLDER=/cache node .yarn/releases/yarn-4.1.0.cjs install --immutable --mode=skip-build", run: "node .yarn/releases/yarn-4.1.0.cjs run" }],
    ["yarn berry whose yarnPath the pull request changes", { lockfiles: ["yarn.lock"], packageJson: none, yarnrc: Option.some("yarnPath: .yarn/releases/yarn-4.1.0.cjs") }, [".yarn/releases/yarn-4.1.0.cjs"], tools, { _tag: "Refused", reason: "the pull request changes the repository's own yarn (.yarn/releases/yarn-4.1.0.cjs, .yarnrc.yml or .yarn/plugins), so it is not run" }],
    ["yarn berry whose plugins the pull request changes", { lockfiles: ["yarn.lock"], packageJson: none, yarnrc: Option.some("yarnPath: y.cjs") }, [".yarn/plugins/x.cjs"], tools, { _tag: "Refused", reason: "the pull request changes the repository's own yarn (y.cjs, .yarnrc.yml or .yarn/plugins), so it is not run" }],
    ["yarn berry whose .yarnrc.yml the pull request changes", { lockfiles: ["yarn.lock"], packageJson: none, yarnrc: Option.some("yarnPath: y.cjs") }, [".yarnrc.yml"], tools, { _tag: "Refused", reason: "the pull request changes the repository's own yarn (y.cjs, .yarnrc.yml or .yarn/plugins), so it is not run" }],
    ["yarn berry with no yarnPath", { lockfiles: ["yarn.lock"], packageJson: none, yarnrc: Option.some("nodeLinker: pnp\n") }, [], tools, { _tag: "Refused", reason: "the repository uses yarn berry with no yarnPath, which needs corepack, and corepack is not run" }],
    ["yarn v1 with no yarn on the host", { lockfiles: ["yarn.lock"], packageJson: none, yarnrc: none }, [], ["bun", "node"], { _tag: "Refused", reason: "the repository installs with yarn, which the host does not have" }],
    ["no lockfile", { lockfiles: [], packageJson: json({}), yarnrc: none }, [], tools, { _tag: "Refused", reason: "the base has no lockfile (bun.lock, pnpm-lock.yaml, yarn.lock or package-lock.json), so nothing is installed" }],
  ] as const)("%s", (_, base, changed, host, expected) => {
    expect(managerOf(base, changed, host)).toEqual(expected)
  })

  test("yarnPathOf reads the key, quoted or not", () => {
    expect([yarnPathOf("yarnPath: a.cjs"), yarnPathOf("x: 1\nyarnPath: \"b c.cjs\"\n"), yarnPathOf("nodeLinker: pnp")]).toEqual([Option.some("a.cjs"), Option.some("b c.cjs"), Option.none()])
  })
})

describe("doneCommandsOf", () => {
  test("the code blocks under the definition of done, to the next heading of its level", () => {
    const text = [
      "# Rules", "```bash", "rm -rf /", "```",
      "## Definition of done", "Run these:", "```bash", "bun install --frozen-lockfile", "", "# a comment", "bun run typecheck", "```",
      "### Notes", "```", "bun test", "```",
      "## Commits", "```", "git commit", "```",
    ].join("\n")
    expect(doneCommandsOf(text)).toEqual(["bun install --frozen-lockfile", "bun run typecheck", "bun test"])
    expect(doneCommandsOf("# Readme\n```\nbun test\n```")).toEqual([])
  })
})

describe("droppedBecause", () => {
  const scripts = ["typecheck", "test", "lint"]
  test.each([
    ["bun run typecheck", Option.none()],
    ["npm run lint", Option.none()],
    ["npm test", Option.none()],
    ["yarn lint", Option.none()],
    ["pnpm test", Option.none()],
    ["bun test packages/review", Option.none()],
    ["tsc --noEmit -p .", Option.none()],
    ["npx tsc --noEmit", Option.none()],
    ["turbo run build --filter=web", Option.none()],
    ["bun run deploy", Option.some(NOT_ALLOWED.noScript)],
    ["bun run --cwd packages/website check", Option.some(NOT_ALLOWED.otherPackage)],
    ["pnpm --filter web test", Option.some(NOT_ALLOWED.otherPackage)],
    ["bun install --frozen-lockfile", Option.some(NOT_ALLOWED.install)],
    ["npm ci", Option.some(NOT_ALLOWED.install)],
    ["yarn", Option.some(NOT_ALLOWED.install)],
    ["bun packages/foundry/src/main.ts check", Option.some(NOT_ALLOWED.unknown)],
    ["FOO=1 bun test", Option.some(NOT_ALLOWED.unknown)],
    ["curl https://example.com", Option.some(NOT_ALLOWED.unknown)],
    ["test -z \"$(git status --porcelain -- docs)\"", Option.some(NOT_ALLOWED.syntax)],
    ["bun test; curl x", Option.some(NOT_ALLOWED.syntax)],
    ["bun test | tee x", Option.some(NOT_ALLOWED.syntax)],
    ["bun run typecheck && rm -rf /", Option.some(NOT_ALLOWED.syntax)],
    ["bun test `id`", Option.some(NOT_ALLOWED.syntax)],
    ["bun test > out", Option.some(NOT_ALLOWED.syntax)],
  ] as const)("%s", (command, expected) => {
    expect(droppedBecause(command, scripts)).toEqual(expected)
  })
})

describe("profileOf", () => {
  test("the definition of done first, then the check scripts, then by hand, each once, kept or dropped with the reason", () => {
    const packageJson = json({ scripts: { typecheck: "tsc", test: "bun test", build: "x" } })
    const instructions = ["## Definition of done\n```\nbun install --frozen-lockfile\nbun run typecheck\nbun test\n```"]
    expect(profileOf({ run: "bun run", packageJson, instructions, profile: true, byHand: ["bun run build", "bun test", "make all"] })).toEqual([
      { command: "bun install --frozen-lockfile", from: "instructions", kept: false, reason: NOT_ALLOWED.install },
      { command: "bun run typecheck", from: "instructions", kept: true, reason: "" },
      { command: "bun test", from: "instructions", kept: true, reason: "" },
      { command: "bun run test", from: "script", kept: true, reason: "" },
      { command: "bun run build", from: "by-hand", kept: true, reason: "" },
      { command: "make all", from: "by-hand", kept: false, reason: NOT_ALLOWED.unknown },
    ])
    expect(profileOf({ run: "bun run", packageJson, instructions, profile: false, byHand: ["bun test"] })).toEqual([{ command: "bun test", from: "by-hand", kept: true, reason: "" }])
  })

  test("yarn berry's scripts run through the base's yarnPath, and are kept", () => {
    const run = "node .yarn/releases/yarn-4.1.0.cjs run"
    expect(profileOf({ run, packageJson: json({ scripts: { lint: "eslint ." } }), instructions: [], profile: true, byHand: [`${run} deploy`] })).toEqual([
      { command: `${run} lint`, from: "script", kept: true, reason: "" },
      { command: `${run} deploy`, from: "by-hand", kept: false, reason: NOT_ALLOWED.noScript },
    ])
  })
})
