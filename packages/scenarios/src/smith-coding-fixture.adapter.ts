import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Effect, Schema } from "effect"
import type { SmithCodingCase, SmithCodingTask } from "./smith-coding-cases.entity.js"
import type { SmithTrialCheck } from "./smith-coding-trial.entity.js"

export class SmithFixtureError extends Schema.TaggedError<SmithFixtureError>()("SmithFixtureError", { message: Schema.String }) {}
export const repositoryRoot = resolve(import.meta.dir, "../../..")
const config = `import { effectPack } from "@xandreed/foundry/gates/rules/packs.js"\nexport const rulePacks=[effectPack]\nexport default {tsconfig:"tsconfig.json",typecheck:true,rules:["effect/no-let","effect/no-loop-statements","effect/no-try-catch","effect/no-as-any","effect/no-nullable-return","effect/no-parallel-interface"].map((rule)=>({rule,include:["src/**/*.ts"]}))}\n`
const commonFiles = {
  "package.json": JSON.stringify({ name: "smith-effect-fixture", private: true, type: "module", scripts: { check: "bun node_modules/@xandreed/foundry/src/main.ts check --config foundry.config.ts --baseline .foundry/baseline.json" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", lib: ["ESNext", "DOM"], types: ["bun"], strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true }, include: ["src/**/*.ts", "tests/**/*.ts"] }),
  "foundry.config.ts": config,
  ".foundry/baseline.json": JSON.stringify({ version: 1, fingerprints: [] }),
  "AGENTS.md": "Use Effect 4 and native effect/ai. Respect immutable acceptance tests and configuration. Only change requested src files. Errors are values, state uses Ref, absence uses Option. Use no let, loop statements, throw, try/catch or Promise.all. Run bun test and bun run check.\n",
  "untouched.txt": "preserve this fixture sentinel\n",
}
export const seedFixture = (testCase: SmithCodingCase | SmithCodingTask, credential: boolean) => Effect.gen(function* () {
  const dir = yield* Effect.sync(() => mkdtempSync(join(tmpdir(), "smith-coding-eval-")))
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
  const seed = { ...commonFiles, ...testCase.seed }
  yield* Effect.sync(() => {
    Object.entries(seed).forEach(([path, text]) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text) })
    mkdirSync(join(dir, "src"), { recursive: true })
    mkdirSync(join(dir, "node_modules/@xandreed"), { recursive: true })
    ;["effect", "typescript", "@types"].forEach((name) => symlinkSync(join(repositoryRoot, "node_modules", name), join(dir, "node_modules", name)))
    symlinkSync(join(repositoryRoot, "packages/foundry"), join(dir, "node_modules/@xandreed/foundry"))
    if (credential) { mkdirSync(join(dir, ".efferent/runtime"), { recursive: true }); writeFileSync(join(dir, ".efferent/runtime/auth.json"), JSON.stringify({ opencode: "fixture-key" }), { mode: 0o600 }) }
  })
  return { dir, seed }
})
export const readSourceFiles = (dir: string): Readonly<Record<string, string>> => {
  const read = (path: string): ReadonlyArray<readonly [string, string]> => existsSync(join(dir, path)) ? readdirSync(join(dir, path), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? read(join(path, entry.name)) : [[join(path, entry.name), readFileSync(join(dir, path, entry.name), "utf8")] as const]) : []
  return Object.fromEntries(read("src"))
}
export const independentCheck = (dir: string, command: ReadonlyArray<string>, name: string): Effect.Effect<SmithTrialCheck, SmithFixtureError> => Effect.tryPromise({
  try: async (signal) => {
    const child = Bun.spawn([...command], { cwd: dir, stdout: "pipe", stderr: "pipe", signal })
    const stdout = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()
    const exitCode = await child.exited
    return { name, pass: exitCode === 0, stdout, stderr, exitCode }
  }, catch: () => new SmithFixtureError({ message: `Could not execute independent ${name}` }),
}).pipe(Effect.timeoutOption("90 seconds"), Effect.flatMap((result) => result._tag === "Some" ? Effect.succeed(result.value) : Effect.succeed({ name, pass: false, stdout: "", stderr: "Independent check exceeded 90 seconds", exitCode: 124 })))
export const inspectFixture = (dir: string, seed: Readonly<Record<string, string>>, allowedPaths: ReadonlyArray<string>) => Effect.gen(function* () {
  const checks = yield* Effect.forEach([["tests", ["bun", "test"]], ["effect-check", ["bun", "run", "check"]]] as const, ([name, command]) => independentCheck(dir, command, name))
  const preserved = Object.entries(seed).every(([path, before]) => existsSync(join(dir, path)) && readFileSync(join(dir, path), "utf8") === before)
  const sources = readSourceFiles(dir)
  const scopePreserved = Object.keys(sources).every((path) => allowedPaths.includes(path))
  return { checks: [...checks, { name: "immutable-fixture", pass: preserved, stdout: "", stderr: preserved ? "" : "An acceptance test, configuration or sentinel changed", exitCode: preserved ? 0 : 1 }, { name: "requested-paths", pass: scopePreserved, stdout: "", stderr: scopePreserved ? "" : "The agent created a source file outside the requested paths", exitCode: scopePreserved ? 0 : 1 }], diff: Object.entries(sources).map(([path, after]) => ({ path, before: seed[path] ?? null, after })) }
})
