import { describe, expect, test } from "bun:test"
import * as ts from "typescript"
import {
  contextTagsLiveInPorts,
  contractsContainNoBehavior,
  layersLiveAtEdges,
  noRawPromiseCore,
  noRuntimeImportsCore,
} from "./effectArchitecture.js"

const source = (name: string, text: string): ts.SourceFile =>
  ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const run = (
  rule: typeof noRawPromiseCore,
  name: string,
  text: string,
): ReadonlyArray<string> =>
  rule
    .check({ sourceFile: source(name, text), checker: {} as ts.TypeChecker })
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

  test("Context.Tag and Layer construction are confined to their file roles", () => {
    expect(
      run(contextTagsLiveInPorts, "/src/repository.ts", "class Repo extends Context.Tag(\"Repo\")<Repo, {}>() {}"),
    ).toHaveLength(1)
    expect(
      run(contextTagsLiveInPorts, "/src/repository.port.ts", "class Repo extends Context.Tag(\"Repo\")<Repo, {}>() {}"),
    ).toEqual([])
    expect(run(layersLiveAtEdges, "/src/repository.usecase.functions.ts", "const Live = Layer.succeed(Tag, impl)")).toHaveLength(1)
    expect(run(layersLiveAtEdges, "/src/repository.adapter.ts", "const Live = Layer.succeed(Tag, impl)")).toEqual([])
  })
})
