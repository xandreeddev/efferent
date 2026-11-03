import { Result, Schema } from "effect"
import ts from "typescript"

/** Keep this group equal to the distribution builder's explicit list. */
export const releaseDirectories = [
  "core", "runtime", "sdk", "process-host", "evals", "evals-cli", "evals-langfuse", "evals-langsmith",
  "plugin-agent-loop", "plugin-memory-window", "plugin-memory-summary", "plugin-memory-digest", "plugin-memory", "plugin-rag", "plugin-knowledge-postgres", "plugin-tool-discovery", "plugin-models",
  "plugin-session-files", "plugin-session-sqlite", "plugin-sessions", "plugin-tasks", "plugin-render", "plugin-workspace", "plugin-telemetry",
] as const
export const releaseNames: ReadonlyArray<string> = releaseDirectories.map((name) => `@xandreed/${name}`)
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const isReleaseVersion = (value: string): boolean => stableVersion.test(value) && value.split(".").every((part) => Number.isSafeInteger(Number(part)))
const order = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const sameNames = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) => JSON.stringify([...left].sort(order)) === JSON.stringify([...right].sort(order))
const failure = (message: string) => Result.fail(message)
const json = <A, I>(schema: Schema.Codec<A, I>, text: string): Result.Result<A, string> => Result.mapError(Schema.decodeUnknownResult(Schema.fromJsonString(schema))(text), (error) => error.message)

export const SourceManifest = Schema.Struct({ name: Schema.String, version: Schema.String, private: Schema.Boolean })
export type SourceManifest = typeof SourceManifest.Type
export const readSourceManifest = (text: string) => json(SourceManifest, text)
const Configuration = Schema.Struct({
  fixed: Schema.Array(Schema.Array(Schema.String)), linked: Schema.Array(Schema.Array(Schema.String)),
  privatePackages: Schema.Struct({ version: Schema.Boolean, tag: Schema.Boolean }),
  changelog: Schema.Literal(false), commit: Schema.Literal(false), ignore: Schema.Array(Schema.String), baseBranch: Schema.Literal("main"),
})
export const validateReleaseConfiguration = (text: string, buildSource: string): Result.Result<void, string> => Result.flatMap(json(Configuration, text), (config) => {
  if (config.fixed.length !== 1 || !sameNames(config.fixed[0] ?? [], releaseNames) || config.linked.length !== 0 || !config.privatePackages.version || config.privatePackages.tag || !sameNames(config.ignore, ["@xandreed/foundry", "@xandreed/website"])) return failure("Changesets must version precisely the distribution packages as one fixed group, without private tags")
  const file = ts.createSourceFile("build-packages.ts", buildSource, ts.ScriptTarget.Latest, true)
  const declarations: ts.VariableDeclaration[] = []
  const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "names") declarations.push(node); ts.forEachChild(node, visit) }
  visit(file)
  const initializer = declarations[0]?.initializer
  const directories = initializer && ts.isArrayLiteralExpression(initializer) && initializer.elements.every(ts.isStringLiteral) ? initializer.elements.flatMap((element) => ts.isStringLiteral(element) ? [element.text] : []) : []
  return sameNames(directories, releaseDirectories) ? Result.succeed(undefined) : failure("The Changesets fixed group and release directory list must match scripts/build-packages.ts")
})
export const sharedReleaseVersion = (manifests: ReadonlyArray<SourceManifest>): Result.Result<string, string> => {
  const version = manifests[0]?.version ?? ""
  return sameNames(manifests.map((manifest) => manifest.name), releaseNames) && isReleaseVersion(version) && manifests.every((manifest) => manifest.version === version && manifest.private)
    ? Result.succeed(version) : failure("All 24 source distribution packages must be private and share one stable semantic version")
}
const NoteRelease = Schema.Struct({ name: Schema.String, type: Schema.Literals(["major", "minor", "patch"]) })
const CliPlan = Schema.Struct({
  changesets: Schema.Array(Schema.Struct({ id: Schema.String, summary: Schema.String, releases: Schema.Array(NoteRelease) })),
  releases: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.Literals(["major", "minor", "patch", "none"]), oldVersion: Schema.String, newVersion: Schema.String })),
  preState: Schema.optionalKey(Schema.Json),
})
export interface ReleaseVersionPlan { readonly hasChanges: boolean; readonly version: string; readonly summaries: ReadonlyArray<string> }
export const releaseVersionPlan = (text: string, current: string): Result.Result<ReleaseVersionPlan, string> => Result.flatMap(json(CliPlan, text), (plan): Result.Result<ReleaseVersionPlan, string> => {
  if (plan.preState !== undefined) return failure("Prerelease mode is not supported by the shared stable release workflow")
  const notes = plan.changesets.filter((note) => note.releases.length > 0)
  if (notes.some((note) => note.releases.some((release) => !releaseNames.includes(release.name)))) return failure("A release note names a package outside the distribution group")
  if (notes.length === 0 && plan.releases.length === 0) return Result.succeed({ hasChanges: false, version: current, summaries: [] })
  const next = plan.releases[0]?.newVersion ?? ""
  const parts = (value: string) => value.split(".").map(Number)
  const newer = parts(next).some((part, index) => part > (parts(current)[index] ?? 0) && parts(next).slice(0, index).every((prior, previous) => prior === parts(current)[previous]))
  if (notes.length === 0 || !sameNames(plan.releases.map((release) => release.name), releaseNames) || !isReleaseVersion(next) || !newer || plan.releases.some((release) => release.oldVersion !== current || release.newVersion !== next || release.type === "none")) return failure("Changesets must advance every distribution package to exactly one new stable version")
  if (notes.some((note) => note.summary.trim().length === 0)) return failure("Every release note needs a nonempty summary")
  return Result.succeed({ hasChanges: true, version: next, summaries: [...new Set(notes.map((note) => note.summary.trim()))] })
})

interface Edit { readonly start: number; readonly end: number; readonly text: string }
const edited = (source: string, edits: ReadonlyArray<Edit>) => [...edits].sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)
const property = (object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined => object.properties.find((entry): entry is ts.PropertyAssignment => ts.isPropertyAssignment(entry) && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) && entry.name.text === name)
/** Update only literal versions on definePlugin calls; prompt/schema versions remain untouched. */
export const pluginVersionText = (source: string, previous: string, next: string): Result.Result<string, string> => {
  const file = ts.createSourceFile("plugin.ts", source, ts.ScriptTarget.Latest, true)
  const edits: Edit[] = []
  const problems: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "definePlugin") {
      const argument = node.arguments[0]
      const version = argument && ts.isObjectLiteralExpression(argument) ? property(argument, "version")?.initializer : undefined
      const id = argument && ts.isObjectLiteralExpression(argument) ? property(argument, "id")?.initializer : undefined
      const firstParty = id && ts.isStringLiteral(id) && id.text.startsWith("@xandreed/plugin-")
      const internalProtocol = !firstParty && version && ts.isStringLiteral(version) && /^\d+$/.test(version.text)
      if (!internalProtocol) {
        if (!version || !ts.isStringLiteral(version) || version.text !== previous) problems.push("Every released definePlugin call must declare the current shared version as a string literal")
        else edits.push({ start: version.getStart(file), end: version.end, text: JSON.stringify(next) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return problems.length ? failure(problems[0]!) : Result.succeed(edited(source, edits))
}
/** Preserve Bun's JSONC formatting and external resolutions, changing only workspace version strings. */
export const lockVersionText = (source: string, previous: string, next: string): Result.Result<string, string> => {
  const file = ts.parseJsonText("bun.lock", source)
  const statement = file.statements[0]
  const root = statement && ts.isExpressionStatement(statement) && ts.isObjectLiteralExpression(statement.expression) ? statement.expression : undefined
  const workspaces = root && property(root, "workspaces")?.initializer
  if (!workspaces || !ts.isObjectLiteralExpression(workspaces)) return failure("bun.lock must contain workspace metadata")
  const edits: Edit[] = []
  for (const directory of releaseDirectories) {
    const workspace = property(workspaces, `packages/${directory}`)?.initializer
    const name = workspace && ts.isObjectLiteralExpression(workspace) ? property(workspace, "name")?.initializer : undefined
    const version = workspace && ts.isObjectLiteralExpression(workspace) ? property(workspace, "version")?.initializer : undefined
    if (!name || !ts.isStringLiteral(name) || name.text !== `@xandreed/${directory}` || !version || !ts.isStringLiteral(version) || (version.text !== previous && version.text !== next)) return failure(`bun.lock has missing or unexpected workspace metadata for ${directory}`)
    edits.push({ start: version.getStart(file), end: version.end, text: JSON.stringify(next) })
  }
  return Result.succeed(edited(source, edits))
}
export const changelogVersionText = (source: string, version: string, day: string, summaries: ReadonlyArray<string>): Result.Result<string, string> => {
  if (!isReleaseVersion(version) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return failure("The release version or date is invalid")
  if (new RegExp(`^## ${version.replaceAll(".", "\\.")}(?:[ 	—-]|$)`, "m").test(source)) return failure(`CHANGELOG.md already records ${version}; release history cannot be replaced`)
  const marker = /^## Unreleased[ \t]*\r?$/m.exec(source)
  if (!marker) return failure("CHANGELOG.md needs an Unreleased heading")
  const start = marker.index + marker[0].length
  const following = /^## /m.exec(source.slice(start))
  const end = following ? start + following.index : source.length
  const body = source.slice(start, end).trim()
  const extra = [...new Set(summaries.map((summary) => summary.trim()))].filter((summary) => summary.length > 0 && !body.includes(summary))
  const notes = extra.length ? `### Changes\n\n${extra.map((summary) => `- ${summary.replaceAll("\n", "\n  ")}`).join("\n\n")}` : ""
  return Result.succeed(`${source.slice(0, marker.index)}## Unreleased\n\n## ${version} — ${day}\n\n${[body, notes].filter(Boolean).join("\n\n")}\n\n${source.slice(end)}`)
}
export const publishedVersionText = (name: string, source: string, previous: string, next: string): Result.Result<string, string> => {
  // These guides contain current-release examples, sometimes several or none when the prose is generic.
  if (["CONTRIBUTING.md", "docs/roadmap.md", ".agents/skills/add-plugin/SKILL.md"].includes(name)) {
    const version = previous.replaceAll(".", "\\.")
    return Result.succeed(source.replace(new RegExp(`(?<![0-9.])${version}(?![0-9]|\\.[0-9])`, "g"), next))
  }
  const markers: Readonly<Record<string, string>> = {
    "README.md": `Workspace packages share version \`${previous}\``,
    "packages/website/src/content/docs/getting-started.md": `This guide follows version \`${previous}\``,
    "packages/website/src/pages/index.astro": `${previous} on npm`,
  }
  const marker = markers[name]
  if (marker === undefined || source.split(marker).length !== 2) return failure(`Expected one published-version marker in ${name}`)
  return Result.succeed(source.replace(marker, marker.replace(previous, next)))
}
export const versionOutputs = (plan: Pick<ReleaseVersionPlan, "hasChanges" | "version">): string => {
  if (!isReleaseVersion(plan.version)) throw new Error("Refusing an invalid release version in workflow output")
  return `has_changes=${plan.hasChanges}\nversion=${plan.version}\n`
}
