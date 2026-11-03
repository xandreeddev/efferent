import { expect, test } from "bun:test"
import { Result, Schema } from "effect"

const Strings = Schema.Record(Schema.String, Schema.String)
const Step = Schema.Struct({
  name: Schema.optionalKey(Schema.String), id: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String), uses: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Strings), with: Schema.optionalKey(Schema.JsonObject),
})
const Job = Schema.Struct({
  if: Schema.optionalKey(Schema.String), needs: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  permissions: Strings, steps: Schema.Array(Step), env: Schema.optionalKey(Strings),
})
const Workflow = Schema.Struct({
  permissions: Strings, jobs: Schema.Record(Schema.String, Job),
  on: Schema.JsonObject,
})
type Workflow = typeof Workflow.Type
type Job = typeof Job.Type
const read = async (name: string): Promise<Workflow> => {
  const decoded = Schema.decodeUnknownResult(Workflow)(Bun.YAML.parse(await Bun.file(new URL(`../.github/workflows/${name}.yml`, import.meta.url)).text()))
  if (Result.isFailure(decoded)) throw decoded.failure
  return decoded.success
}
const job = (workflow: Workflow, name: string): Job => {
  const selected = workflow.jobs[name]
  if (selected === undefined) throw new Error(`Missing workflow job ${name}`)
  return selected
}
const step = (selected: Job, id: string) => {
  const selectedStep = selected.steps.find((entry) => entry.id === id)
  if (selectedStep === undefined) throw new Error(`Missing workflow step ${id}`)
  return selectedStep
}

test("release publication receives npm credentials only after read-only source and CI verification", async () => {
  const workflow = await read("release")
  expect(workflow.permissions).toEqual({ contents: "read" })
  const target = job(workflow, "target")
  expect(target.permissions).toEqual({ contents: "read", actions: "read", checks: "read" })
  expect(target.env).toBeUndefined()
  expect(target.steps.some((entry) => Object.values(entry.env ?? {}).some((value) => value.includes("secrets.")))).toBe(false)
  expect(target.if?.replace(/\s+/g, " ").trim()).toBe("github.repository == 'xandreeddev/efferent' && ((github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.head_repository.full_name == github.repository))")
  expect(step(target, "target").run).toContain("scripts/release-target.ts")
  const publish = job(workflow, "publish")
  expect(publish.needs).toBe("target")
  expect(publish.if).toBe("needs.target.outputs.eligible == 'true'")
  expect(publish.permissions).toEqual({ contents: "write", actions: "write", "id-token": "write" })
  expect(step(publish, "publish").run).toBe('bun pipeline/scripts/release-publish.ts --ci --root "$GITHUB_WORKSPACE/source" --verify')
  expect(step(publish, "publish").env).toEqual({ NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" })
  const source = publish.steps.find((entry) => entry.with?.path === "source")
  expect(source?.with?.ref).toBe("${{ needs.target.outputs.sha }}")
})

test("GitHub release and explicit docs dispatch follow successful npm publication", async () => {
  const publish = job(await read("release"), "publish")
  const publication = publish.steps.findIndex((entry) => entry.id === "publish")
  const release = publish.steps.findIndex((entry) => entry.run?.includes("gh release create"))
  const docs = publish.steps.findIndex((entry) => entry.run?.includes("gh workflow run docs.yml"))
  expect(publication).toBeGreaterThanOrEqual(0)
  expect(release).toBeGreaterThan(publication)
  expect(docs).toBeGreaterThan(release)
  expect(publish.steps[release]?.run).toContain('test "$RELEASE_SHA" = "$EXPECTED_SHA"')
  expect(publish.steps[docs]?.run).toBe('gh workflow run docs.yml --repo "$GITHUB_REPOSITORY" --ref "$RELEASE_TAG"')
  expect(publish.steps[docs]?.env?.RELEASE_TAG).toBe("${{ steps.publish.outputs.tag }}")
})

test("the documentation-only npm landing page uses the verified source after framework publication", async () => {
  const landing = job(await read("release"), "landing")
  expect(landing.needs).toEqual(["target", "publish"])
  expect(landing.if).toBe("needs.target.outputs.eligible == 'true'")
  expect(landing.permissions).toEqual({ contents: "read", "id-token": "write" })
  const source = landing.steps.find((entry) => entry.with?.path === "source")
  expect(source?.with?.ref).toBe("${{ needs.target.outputs.sha }}")
  expect(source?.with?.["persist-credentials"]).toBe(false)
  expect(step(landing, "landing").run).toBe('bun pipeline/scripts/publish-npm-landing.ts --ci --root "$GITHUB_WORKSPACE/source" --publish')
  expect(step(landing, "landing").env).toEqual({ NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" })
})

test("release PRs consume changesets and explicitly dispatch the required CI check", async () => {
  const workflow = await read("release-pr")
  const version = job(workflow, "version")
  expect(workflow.permissions).toEqual({ contents: "read" })
  expect(version.permissions).toEqual({ contents: "write", "pull-requests": "write", actions: "write" })
  expect(version.if).toBe("github.repository == 'xandreeddev/efferent' && github.ref == 'refs/heads/main'")
  expect(step(version, "version").run).toBe("bun run release:version")
  expect(step(version, "pr").with?.branch).toBe("changeset-release/main")
  expect(step(version, "pr").with?.author).toBe("Xand Reed <xandreed@proton.me>")
  expect(version.steps.some((entry) => entry.run === 'gh workflow run ci.yml --repo "$GITHUB_REPOSITORY" --ref changeset-release/main')).toBe(true)
  const ci = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text())
  const triggers = Schema.decodeUnknownResult(Schema.Struct({ on: Schema.JsonObject }))(ci)
  if (Result.isFailure(triggers)) throw triggers.failure
  expect(Object.hasOwn(triggers.success.on, "workflow_dispatch")).toBe(true)
})
