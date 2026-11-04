import { Result, Schema } from "effect"

export const referenceStart = "<!-- plugin-reference:start -->"
export const referenceEnd = "<!-- plugin-reference:end -->"

const GuideMetadata = Schema.Struct({
  title: Schema.String,
  description: Schema.String,
  pluginId: Schema.String,
})
export type GuideMetadata = typeof GuideMetadata.Type

export interface PluginReference {
  readonly id: string
  readonly version: string
  readonly apiVersion: number
  readonly scope: string
  readonly provides: ReadonlyArray<string>
  readonly requires: ReadonlyArray<string>
  readonly optional: ReadonlyArray<string>
  readonly contributes: ReadonlyArray<string>
  readonly defaults: unknown
  readonly schema: unknown
}

export const pluginSlug = (id: string): string => {
  if (!/^@xandreed\/plugin-[a-z0-9-]+(?:\/[a-z0-9-]+)?$/.test(id)) throw new Error(`Invalid first-party plugin id: ${id}`)
  return id.replace("@xandreed/plugin-", "").replaceAll("/", "-")
}

export const guideMetadata = (source: string, expectedId: string): GuideMetadata => {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  if (frontmatter?.[1] === undefined) throw new Error(`${expectedId}: plugin guide needs YAML frontmatter`)
  const decoded = Schema.decodeUnknownResult(GuideMetadata)(Bun.YAML.parse(frontmatter[1]))
  if (Result.isFailure(decoded)) throw new Error(`${expectedId}: plugin guide needs title, description and pluginId`)
  const metadata = decoded.success
  if (metadata.pluginId !== expectedId) throw new Error(`${expectedId}: guide belongs to ${metadata.pluginId}`)
  if (metadata.title.trim().length === 0 || metadata.description.trim().length === 0) throw new Error(`${expectedId}: guide title and description must be nonempty`)
  return metadata
}

const keys = (values: ReadonlyArray<string>): string => values.map((value) => `\`${value}\``).join(", ") || "none"

export const pluginReference = (plugin: PluginReference): string => `## Generated configuration reference

This section is generated from the exported plugin definition by \`bun run docs:generate\`.

Plugin: \`${plugin.id}\` · Version **${plugin.version}** · Plugin API **${plugin.apiVersion}** · Scope **${plugin.scope}**

| Contract | Services |
| --- | --- |
| Provides | ${keys(plugin.provides)} |
| Requires | ${keys(plugin.requires)} |
| Uses when available | ${keys(plugin.optional)} |
| Contributes | ${keys(plugin.contributes)} |

### Default options

\`\`\`json
${JSON.stringify(plugin.defaults, null, 2)}
\`\`\`

### Options schema

<details>
<summary>Show the full configuration schema</summary>

\`\`\`json
${JSON.stringify(plugin.schema, null, 2)}
\`\`\`

</details>`

export const updatePluginGuide = (source: string, plugin: PluginReference): string => {
  guideMetadata(source, plugin.id)
  if (source.split(referenceStart).length !== 2 || source.split(referenceEnd).length !== 2) {
    throw new Error(`${plugin.id}: guide needs exactly one plugin-reference:start/end marker pair`)
  }
  const start = source.indexOf(referenceStart) + referenceStart.length
  const end = source.indexOf(referenceEnd)
  if (end < start) throw new Error(`${plugin.id}: plugin reference markers are reversed`)
  return `${source.slice(0, start)}\n\n${pluginReference(plugin)}\n\n${source.slice(end)}`
}

export const pluginGroup = (id: string): string => {
  if (/\/plugin-(models|agent-loop|tool-discovery|tasks)(\/|$)/.test(id)) return "Models & execution"
  if (/\/plugin-session/.test(id)) return "Session plugins"
  if (/\/plugin-memory-(window|summary|digest)$/.test(id)) return "Context plugins"
  if (/\/plugin-(memory|rag|knowledge-postgres)(\/|$)/.test(id)) return "Knowledge plugins"
  if (/\/plugin-workspace\//.test(id)) return "Workspace plugins"
  if (/\/plugin-(render|telemetry)(\/|$)/.test(id)) return "Rendering & telemetry"
  return "Other plugins"
}

export const pluginGroups = ["Models & execution", "Session plugins", "Context plugins", "Knowledge plugins", "Workspace plugins", "Rendering & telemetry", "Other plugins"] as const
