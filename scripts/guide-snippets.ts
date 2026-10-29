/**
 * The guides' code is regions of test files that run (`// #region <name>`
 * … `// #endregion <name>`). These helpers read a region, dedented, and
 * the import lines its code needs, taken from the test file's own imports,
 * so a snippet in a guide imports exactly what it uses.
 * `scripts/sync-guides.ts` copies the regions into the guides;
 * `scripts/verify-packages.ts` composes the HTTP recipe's regions into a
 * module it runs against the packed packages.
 */

/** One name a test file imports, as written (`type X`, `X as Y`) and as the code calls it. */
export interface ImportedName {
  readonly written: string
  readonly local: string
}

/** One `import { … } from "…"` declaration of a test file. */
export interface ImportDeclaration {
  readonly from: string
  readonly typeOnly: boolean
  readonly names: ReadonlyArray<ImportedName>
}

const importPattern = /^import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/gm

/** The named imports of a source file, in order (namespace and default imports are not read). */
export const importsOf = (source: string): ReadonlyArray<ImportDeclaration> =>
  Array.from(source.matchAll(importPattern), (match) => ({
    from: match[3] ?? "",
    typeOnly: match[1] !== undefined,
    names: (match[2] ?? "").split(",").map((part) => part.trim()).filter((part) => part.length > 0).map((written) => ({
      written,
      local: written.replace(/^type\s+/, "").split(/\s+as\s+/).at(-1)?.trim() ?? "",
    })),
  }))

const regionPattern = /^[ \t]*\/\/ #region ([\w-]+)[ \t]*\n([\s\S]*?)^[ \t]*\/\/ #endregion(?: ([\w-]+))?[ \t]*$/gm

const dedent = (text: string): string => {
  const lines = text.replace(/\s+$/, "").split("\n")
  const indent = Math.min(...lines.filter((line) => line.trim().length > 0).map((line) => line.length - line.trimStart().length))
  return lines.map((line) => line.slice(Math.min(indent, line.length - line.trimStart().length))).join("\n")
}

/** A source file's regions by name, dedented, in order; a region closed under another name, or named twice, is a problem. */
export const regionsOf = (source: string): { readonly regions: ReadonlyMap<string, string>; readonly problems: ReadonlyArray<string> } => {
  const found = Array.from(source.matchAll(regionPattern), (match) => ({ name: match[1] ?? "", closer: match[3], code: dedent(match[2] ?? "") }))
  const names = found.map((region) => region.name)
  return {
    regions: new Map(found.map((region) => [region.name, region.code])),
    problems: [
      ...found.filter((region) => region.closer !== undefined && region.closer !== region.name).map((region) => `#region ${region.name} is closed as #endregion ${region.closer}`),
      ...names.filter((name, index) => names.indexOf(name) !== index).map((name) => `#region ${name} appears twice`),
      ...found.filter((region) => region.code.includes("// #region")).map((region) => `#region ${region.name} holds another region`),
    ],
  }
}

/**
 * The names code uses: identifiers outside comments and string literals
 * (a template literal's `${…}` counts), not after a `.`.
 */
const namesUsedBy = (code: string): ReadonlySet<string> => {
  const bare = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, (token) =>
    token.startsWith("`") ? Array.from(token.matchAll(/\$\{([^}]*)\}/g), (match) => match[1] ?? "").join(" ") : " ")
  return new Set(Array.from(bare.matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g), (match) => match[0]))
}

/** Where a snippet may import from: public packages only, never a relative path, a test runner or test scaffolding. */
const publicSource = (from: string): boolean =>
  !from.startsWith(".") && !from.startsWith("bun:") && !/(^|[/.-])testing(\.port)?($|[/.])/.test(from)

/**
 * The import lines `code` needs, from `imports` (a test file's), in the
 * file's order, with a problem for every name it would take from somewhere
 * a reader cannot import from.
 */
export const importsFor = (imports: ReadonlyArray<ImportDeclaration>, code: string): { readonly lines: ReadonlyArray<string>; readonly problems: ReadonlyArray<string> } => {
  const used = namesUsedBy(code)
  const needed = imports.map((declaration) => ({ ...declaration, names: declaration.names.filter((name) => used.has(name.local)) }))
    .filter((declaration) => declaration.names.length > 0)
  return {
    lines: needed.map((declaration) =>
      `import ${declaration.typeOnly ? "type " : ""}{ ${declaration.names.map((name) => name.written).join(", ")} } from ${JSON.stringify(declaration.from)}`),
    problems: needed.filter((declaration) => !publicSource(declaration.from))
      .map((declaration) => `uses ${declaration.names.map((name) => name.local).join(", ")} from ${declaration.from}, which a reader cannot import`),
  }
}

/** A snippet as a guide shows it: its imports, a blank line, then its code. */
export const snippetOf = (imports: ReadonlyArray<ImportDeclaration>, code: string) => {
  const { lines, problems } = importsFor(imports, code)
  return { text: lines.length === 0 ? code : `${lines.join("\n")}\n\n${code}`, problems }
}
