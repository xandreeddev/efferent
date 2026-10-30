import { describe, expect, test } from "bun:test"
import * as ts from "typescript"
import {
  contextTagsLiveInPorts,
  contractsContainNoBehavior,
  layersLiveAtEdges,
  noRawPromiseCore,
  noRuntimeImportsCore,
  roleSuffixRequired,
} from "./effectArchitecture.js"

const source = (name: string, text: string): ts.SourceFile =>
  ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const run = (
  rule: typeof noRawPromiseCore,
  name: string,
  text: string,
): ReadonlyArray<string> =>
  rule
    .check({ sourceFile: source(name, text), checker: {} as ts.TypeChecker, workspace: { rootDir: "/", sourceFiles: [] } })
    .map((match) => match.message)

describe("the Effect architecture pack", () => {
  test("Promise orchestration is rejected in core functions but ignored at adapters", () => {
    const body = "export const load = async (): Promise<number> => await Promise.resolve(1)"
    expect(run(noRawPromiseCore, "/src/load-issue.usecase.functions.ts", body).length).toBeGreaterThan(0)
    expect(run(noRawPromiseCore, "/src/http-issue.adapter.ts", body)).toEqual([])
  })

  test("runtime imports are rejected in the core", () => {
    expect(
      run(
        noRuntimeImportsCore,
        "/src/issue.entity.functions.ts",
        'import { readFile } from "node:fs/promises"',
      )[0],
    ).toContain("runtime import")
  })

  test("schema contract files reject exported behavior", () => {
    expect(
      run(
        contractsContainNoBehavior,
        "/src/issue.entity.ts",
        "export const close = () => true",
      ),
    ).toHaveLength(1)
    expect(
      run(
        contractsContainNoBehavior,
        "/src/issue.entity.ts",
        "export const Issue = Schema.Struct({ id: Schema.String })",
      ),
    ).toEqual([])
  })

  test("every file names its role; a bare name or a functions file without its entity does not", () => {
    const roled = [
      "/src/issue.entity.ts", "/src/issue.entity.functions.ts", "/src/close.usecase.ts", "/src/close.usecase.functions.ts",
      "/src/repo.port.ts", "/src/http.adapter.ts", "/src/log.memory.adapter.ts", "/src/repo.conformance.ts",
      "/src/index.ts", "/src/main.ts", "/src/loop.test.ts", "/src/view.test.tsx", "/src/fold.bench.ts", "/src/testing.ts", "/src/fixture.testing.ts",
    ]
    expect(roled.flatMap((name) => run(roleSuffixRequired, name, "export const a = 1"))).toEqual([])
    expect(run(roleSuffixRequired, "/src/loop.ts", "export const a = 1")).toEqual(["`loop.ts` has no role suffix"])
    expect(run(roleSuffixRequired, "/src/cli.functions.ts", "export const a = 1")).toEqual(["`cli.functions.ts` has no role suffix"])
    expect(run(roleSuffixRequired, "/src/myindex.ts", "export const a = 1")).toHaveLength(1)
  })

  test("Context.Service (and v3's Context.Tag) and Layer construction are confined to their file roles", () => {
    expect(
      run(contextTagsLiveInPorts, "/src/repository.ts", "class Repo extends Context.Tag(\"Repo\")<Repo, {}>() {}"),
    ).toHaveLength(1)
    expect(
      run(contextTagsLiveInPorts, "/src/repository.ts", "class Repo extends Context.Service<Repo, {}>()(\"Repo\") {}"),
    ).toHaveLength(1)
    expect(
      run(contextTagsLiveInPorts, "/src/repository.port.ts", "class Repo extends Context.Service<Repo, {}>()(\"Repo\") {}"),
    ).toEqual([])
    expect(
      run(contextTagsLiveInPorts, "/src/repository.port.ts", "class Repo extends Context.Tag(\"Repo\")<Repo, {}>() {}"),
    ).toEqual([])
    expect(run(layersLiveAtEdges, "/src/repository.usecase.functions.ts", "const Live = Layer.succeed(Tag, impl)")).toHaveLength(1)
    expect(run(layersLiveAtEdges, "/src/repository.adapter.ts", "const Live = Layer.succeed(Tag, impl)")).toEqual([])
  })
})
