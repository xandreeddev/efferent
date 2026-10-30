import { Effect, Option, Result, Schema } from "effect"
import type { FsError } from "../domain/file-system.entity.js"
import { canonicalJson, fingerprintOf } from "../memory/memory-log.entity.functions.js"
import { FileSystem } from "../ports/file-system.port.js"
import { SkillDefinition, SkillReference } from "./capability.entity.js"
import { HarnessError } from "./plugin.entity.js"
import type { CollectSkillFilesOptions, SkillFile, SkillFileIssue, SkillFilesOptions, SkillTree, SkillTreeEntry } from "./skill-files.entity.js"

/* ── frontmatter: the YAML subset SKILL.md files use ── */

/** A frontmatter value: text, a list, or neither (a nested map, which is ignored). */
interface FieldValue {
  readonly text: Option.Option<string>
  readonly items: Option.Option<ReadonlyArray<string>>
}

interface SkillDocument {
  readonly fields: ReadonlyMap<string, FieldValue>
  readonly body: string
  /** Frontmatter lines that are not `key: value`, by their line number in the file. */
  readonly unread: ReadonlyArray<number>
}

/** One top-level key and the lines below it, until the next top-level key. */
interface Block {
  readonly key: string
  readonly inline: string
  readonly rest: ReadonlyArray<string>
}

/** Without a leading byte-order mark, and with `\n` line ends. */
const normalized = (text: string): string => text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")

const keyLine = /^([^\s#:\-][^:]*):[ \t]*(.*)$/
const blockScalar = /^([|>])[+-]?[1-9]?[+-]?$/
const isBlank = (line: string): boolean => line.trim().length === 0
const indentOf = (line: string): number => line.length - line.trimStart().length

/** A quoted value without its quotes (YAML's escapes for the common cases), or the text as it is. */
const unquoted = (value: string): string => {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1).replace(/\\(["\\nt])/g, (_, escaped: string) => escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped)
  }
  return value.length >= 2 && value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replaceAll("''", "'") : value
}

const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')(.*)$/

/** A value without a trailing ` #` comment; a quoted value ends at its closing quote. */
const withoutComment = (value: string): string => {
  if (!value.startsWith("\"") && !value.startsWith("'")) return value.replace(/(^|\s)#.*$/, "").trim()
  const found = quoted.exec(value)
  const after = (found?.[2] ?? "").trim()
  return found !== null && (after.length === 0 || after.startsWith("#")) ? found[1] ?? value : value
}

/** The lines of a block scalar, without their common indentation and the blank lines at the end. */
const dedented = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const indent = Math.min(...lines.filter((line) => !isBlank(line)).map(indentOf))
  const kept = lines.map((line) => isBlank(line) ? "" : line.slice(indent))
  const last = kept.findLastIndex((line) => line.length > 0)
  return kept.slice(0, last + 1)
}

/** `>` joins the lines of each paragraph with spaces; `|` keeps them. */
const blockText = (style: string, lines: ReadonlyArray<string>): string => {
  const content = dedented(lines)
  if (style === "|") return content.join("\n")
  return content.reduce<ReadonlyArray<ReadonlyArray<string>>>((paragraphs, line) => line.length === 0
    ? [...paragraphs, []]
    : [...paragraphs.slice(0, -1), [...(paragraphs.at(-1) ?? []), line.trim()]], [[]])
    .map((paragraph) => paragraph.join(" ")).join("\n").trim()
}

const textValue = (text: string): FieldValue => ({ text: Option.some(text), items: Option.none() })
const listValue = (items: ReadonlyArray<string>): FieldValue => ({ text: Option.none(), items: Option.some(items) })
const flowItems = (value: string): ReadonlyArray<string> =>
  value.slice(1, -1).split(",").map((item) => unquoted(item.trim())).filter((item) => item.length > 0)

/** A block's value: a block scalar, a block or flow list, a quoted or plain scalar, or (indented keys below an empty value) a nested map. */
const valueOf = (block: Block): FieldValue => {
  const inline = withoutComment(block.inline)
  const lines = block.rest.filter((line) => !isBlank(line))
  const style = blockScalar.exec(inline)
  if (style !== null) return textValue(blockText(style[1] ?? "|", block.rest))
  if (inline.length === 0) {
    if (lines.length > 0 && lines.every((line) => line.trim() === "-" || line.trim().startsWith("- "))) {
      return listValue(lines.map((line) => unquoted(withoutComment(line.trim().slice(1).trim()))).filter((item) => item.length > 0))
    }
    const nested = lines.some((line) => keyLine.test(line.trim()))
    return nested ? { text: Option.none(), items: Option.none() } : textValue(lines.map((line) => line.trim()).join(" "))
  }
  const whole = [inline, ...lines.map((line) => line.trim())].join(" ")
  if (whole.startsWith("[") && whole.endsWith("]")) return listValue(flowItems(whole))
  return textValue(unquoted(whole))
}

/**
 * A `SKILL.md` (or reference) as frontmatter fields and a body: none when the
 * text does not open with a `---` line or the fence is not closed by one.
 * The frontmatter is the YAML subset skill files use: top-level
 * `key: value` lines; quoted values; `>` and `|` block scalars; lists as
 * `- item` lines or `[a, b]`; ` #` comments. A key whose value is indented
 * keys below it (`metadata:`) is a nested map and is not read, so its keys
 * never stand in for top-level ones. A byte-order mark and `\r\n` line ends
 * are accepted.
 */
const documentOf = (text: string): Option.Option<SkillDocument> => {
  const lines = normalized(text).split("\n")
  if (lines[0]?.trimEnd() !== "---") return Option.none()
  const close = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---")
  if (close < 0) return Option.none()
  const grouped = lines.slice(1, close).reduce<{ readonly blocks: ReadonlyArray<Block>; readonly unread: ReadonlyArray<number> }>((state, line, index) => {
    const current = state.blocks.at(-1)
    const attach = (): typeof state => current === undefined ? state
      : { ...state, blocks: [...state.blocks.slice(0, -1), { ...current, rest: [...current.rest, line] }] }
    if (isBlank(line) || indentOf(line) > 0 || line.startsWith("- ") || line === "-") return attach()
    if (line.startsWith("#")) return state
    const found = keyLine.exec(line)
    if (found === null) return { ...state, unread: [...state.unread, index + 2] }
    return { ...state, blocks: [...state.blocks, { key: (found[1] ?? "").trim(), inline: (found[2] ?? "").trim(), rest: [] }] }
  }, { blocks: [], unread: [] })
  return Option.some({
    fields: new Map(grouped.blocks.map((block) => [block.key, valueOf(block)] as const)),
    body: lines.slice(close + 1).join("\n"),
    unread: grouped.unread,
  })
}

const textField = (document: SkillDocument, key: string): Option.Option<string> =>
  Option.filter(Option.flatMap(Option.fromNullishOr(document.fields.get(key)), (value) => Option.map(value.text, (text) => text.trim())), (text) => text.length > 0)

/** A list field: its items, or its text split on commas and whitespace. */
const listField = (document: SkillDocument, key: string): ReadonlyArray<string> => Option.match(Option.fromNullishOr(document.fields.get(key)), {
  onNone: () => [],
  onSome: (value) => Option.getOrElse(Option.orElse(value.items, () => Option.map(value.text, (text) => text.split(/[\s,]+/))), () => [])
    .map((item) => item.trim()).filter((item) => item.length > 0),
})

/* ── a tree of files as skills ── */

const skillFileName = "SKILL.md"
const encoder = new TextEncoder()

const segmentsOf = (path: string): ReadonlyArray<string> => path.split("/").filter((segment) => segment.length > 0 && segment !== ".")
const directoryOf = (path: string): string => segmentsOf(path).slice(0, -1).join("/")
const isSkillFile = (path: string): boolean => segmentsOf(path).at(-1) === skillFileName
const within = (directory: string, path: string): boolean => directory === "" || path.startsWith(`${directory}/`)
const relativeTo = (directory: string, path: string): string => directory === "" ? path : path.slice(directory.length + 1)
const byPath = <A extends { readonly path: string }>(left: A, right: A): number => left.path < right.path ? -1 : left.path > right.path ? 1 : 0

const issue = (path: string, severity: SkillFileIssue["severity"], message: string): SkillFileIssue => ({ path, severity, message })

/** Text as one line: each run of whitespace, line ends included, is one space. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()

/** The first `# ` heading of a markdown body that has text. */
const headingOf = (body: string): Option.Option<string> =>
  Option.fromNullishOr(body.split("\n").filter((line) => line.startsWith("# ")).map((line) => line.slice(2).trim()).find((title) => title.length > 0))

/**
 * One reference of a skill: its id is its path below the skill's directory,
 * its text the file's (a markdown file's body, without frontmatter), its
 * title (one line) the markdown's `title` field or first `# ` heading, else
 * the id. A reference that is not a valid `SkillReference` (its path below
 * the skill's directory starts or ends with a space) is a warning, and the
 * skill loads without it.
 */
const referenceOf = (directory: string, file: SkillFile): Result.Result<SkillReference, SkillFileIssue> => {
  const id = relativeTo(directory, file.path)
  const text = normalized(file.text)
  const markdown = /\.(md|markdown)$/i.test(id)
  const document = markdown ? documentOf(text) : Option.none()
  const body = Option.match(document, { onNone: () => text, onSome: (found) => found.body })
  const title = Option.orElse(Option.flatMap(document, (found) => textField(found, "title")), () => markdown ? headingOf(body) : Option.none())
  return Result.mapError(Schema.decodeUnknownResult(SkillReference)({ id, title: oneLine(Option.getOrElse(title, () => id)), text: body.trim() }),
    (error) => issue(file.path, "warning", `left out: not a valid reference: ${oneLine(error.message)}`))
}

interface SkillRead {
  readonly entry: Option.Option<SkillTreeEntry>
  readonly issues: ReadonlyArray<SkillFileIssue>
}

/**
 * One reference of a skill, or the warning that leaves it out: over
 * `maxReferenceBytes`, not read (a `size` and no text), or not valid.
 */
const ownedOf = (directory: string, file: SkillFile, limit: Option.Option<number>): Result.Result<SkillReference, SkillFileIssue> => {
  const unread = Option.fromNullishOr(file.size)
  const bytes = Option.getOrElse(unread, () => encoder.encode(file.text).length)
  return Option.match(Option.filter(limit, (max) => bytes > max), {
    onSome: (max) => Result.fail(issue(file.path, "warning", `left out: ${bytes} bytes, more than the ${max}-byte reference limit (maxReferenceBytes)`)),
    onNone: () => Option.isSome(unread)
      ? Result.fail(issue(file.path, "warning", `left out: ${bytes} bytes, too large to be read (maxFileBytes)`))
      : referenceOf(directory, file),
  })
}

/**
 * One skill from its `SKILL.md` and the files it owns. The id is the
 * frontmatter `id`, else `name`, else the directory's path below the tree's
 * root, else (a `SKILL.md` at the root) `rootName`. The summary is
 * `summary`, else `description`, as one line. `version` defaults to a
 * fingerprint of the skill as read, so it changes whenever its `SKILL.md`
 * or a reference it serves does.
 */
const skillOf = (skillFile: SkillFile, owned: ReadonlyArray<SkillFile>, options: SkillFilesOptions): SkillRead => {
  const directory = directoryOf(skillFile.path)
  const failed = (message: string): SkillRead => ({ entry: Option.none(), issues: [issue(skillFile.path, "error", message)] })
  const unread = Option.fromNullishOr(skillFile.size)
  if (Option.isSome(unread)) return failed(`not read: ${unread.value} bytes, too large to be read (maxFileBytes)`)
  return Option.match(documentOf(skillFile.text), {
    onNone: () => failed("no frontmatter: a SKILL.md opens with a --- fence holding at least a description"),
    onSome: (document) => {
      const fallbackId = directory === "" ? Option.fromNullishOr(options.rootName) : Option.some(directory)
      const id = Option.orElse(Option.orElse(textField(document, "id"), () => textField(document, "name")), () => fallbackId)
      const summary = Option.orElse(textField(document, "summary"), () => textField(document, "description"))
      if (Option.isNone(id)) return failed("a SKILL.md at the root names its skill: give it an id or a name")
      if (Option.isNone(summary)) return failed("no description: the frontmatter needs a description (or summary)")
      const always = textField(document, "always").pipe(Option.map((value) => value.toLowerCase()))
      const parts = owned.map((file) => ownedOf(directory, file, Option.fromNullishOr(options.maxReferenceBytes)))
      const references = parts.flatMap((part) => Option.toArray(Result.getSuccess(part)))
      const warnings: ReadonlyArray<SkillFileIssue> = [
        ...document.unread.map((line) => issue(skillFile.path, "warning", `frontmatter line ${line} is not \`key: value\` and was not read`)),
        ...(Option.isSome(always) && always.value !== "true" && always.value !== "false"
          ? [issue(skillFile.path, "warning", `always is true or false, not "${always.value}"; read as false`)] : []),
        ...parts.flatMap((part) => Option.toArray(Result.getFailure(part))),
      ]
      const read = {
        id: id.value,
        summary: oneLine(summary.value),
        instructions: normalized(document.body).trim(),
        tools: (options.tools ?? "declared") === "ignore" ? [] : listField(document, "tools"),
        always: Option.contains(always, "true"),
        permissions: listField(document, "permissions"),
        references,
      }
      const version = Option.getOrElse(textField(document, "version"), () => fingerprintOf(canonicalJson(read)))
      return Result.match(Schema.decodeUnknownResult(SkillDefinition)({ ...read, version }), {
        onFailure: (error) => ({ entry: Option.none(), issues: [...warnings, issue(skillFile.path, "error", error.message)] }),
        onSuccess: (skill) => ({ entry: Option.some({ directory, skill }), issues: warnings }),
      })
    },
  })
}

/**
 * Skills from a tree of files (paths relative to the tree's root, as
 * `collectSkillFiles` reads them). Never fails: what cannot be read is an
 * issue, and the rest loads.
 *
 * - Every `SKILL.md`, at any depth, is a skill, and its directory is the
 *   skill's. A file belongs to the deepest skill directory it is in; a
 *   nested skill's files are its own, never its parent's. Files outside every
 *   skill directory are not read.
 * - A `SKILL.md` opens with `---` frontmatter (see the fields below); its
 *   body is the skill's instructions (what `load_skill` returns).
 * - Every other file of a skill is a reference (what `read_skill_reference`
 *   serves), its id the path below the skill's directory
 *   (`references/formats.md`, `scripts/check.sh`).
 *
 * Fields: `id` (else `name`, else the directory's path below the root, else
 * for a `SKILL.md` at the root `options.rootName`), `summary` (else
 * `description`; required; its whitespace and line ends collapsed to one
 * line, the catalogue's), `version` (default: a fingerprint of the skill as
 * read, its `SKILL.md` and the references it serves), `tools` and
 * `permissions` (a list, or text split on commas and whitespace), `always`
 * (`true` or `false`, any case). Other fields (`license`, `metadata`,
 * `allowed-tools`, ...) are ignored. A second skill with an id already used
 * is left out with an error; a reference that cannot be served (over
 * `maxReferenceBytes`, not read, a path that is not a valid id) is left out
 * with a warning.
 */
export const readSkillFiles = (files: ReadonlyArray<SkillFile>, options: SkillFilesOptions = {}): SkillTree => {
  const sorted = files.map((file) => ({ ...file, path: segmentsOf(file.path).join("/") })).toSorted(byPath)
  const skillFiles = sorted.filter((file) => isSkillFile(file.path))
  const directories = skillFiles.map((file) => directoryOf(file.path))
  /** The deepest skill directory a file is in. */
  const ownerOf = (path: string): Option.Option<string> => Option.fromNullishOr(directories.filter((directory) => within(directory, path))
    .reduce<string | undefined>((deepest, directory) => deepest === undefined || directory.length > deepest.length ? directory : deepest, undefined))
  const owners = new Map(sorted.map((file) => [file, ownerOf(file.path)] as const))
  const read = skillFiles.map((skillFile) => {
    const directory = directoryOf(skillFile.path)
    const owned = sorted.filter((file) => file !== skillFile && Option.contains(owners.get(file) ?? Option.none(), directory))
    return { path: skillFile.path, ...skillOf(skillFile, owned, options) }
  })
  return read.reduce<SkillTree>((tree, { path, entry, issues }) => Option.match(entry, {
    onNone: () => ({ ...tree, issues: [...tree.issues, ...issues] }),
    onSome: (found) => {
      const taken = tree.skills.find((other) => other.skill.id === found.skill.id)
      return taken === undefined
        ? { skills: [...tree.skills, found], issues: [...tree.issues, ...issues] }
        : { ...tree, issues: [...tree.issues, ...issues, issue(path, "error", `the skill id ${found.skill.id} is already used by ${taken.directory === "" ? "" : `${taken.directory}/`}${skillFileName}`)] }
    },
  }), { skills: [], issues: [] })
}

/** Issues as one message: `<path>: <message>` each, in order. */
export const skillIssuesText = (issues: ReadonlyArray<SkillFileIssue>): string =>
  issues.map((found) => `${found.path}: ${found.message}`).join("; ")

/**
 * `readSkillFiles`, strict: any issue, error or warning, fails with
 * `skills.files` naming each one, so nothing is left out silently.
 *
 * @public
 */
export const skillsFromFiles = (files: ReadonlyArray<SkillFile>, options: SkillFilesOptions = {}): Effect.Effect<ReadonlyArray<SkillDefinition>, HarnessError> => {
  const tree = readSkillFiles(files, options)
  return tree.issues.length > 0
    ? Effect.fail(new HarnessError({ code: "skills.files", message: skillIssuesText(tree.issues) }))
    : Effect.succeed(tree.skills.map((entry) => entry.skill))
}

/* ── reading a directory through the FileSystem port ── */

/** How much of each file is read first to tell text from binary. */
const probeBytes = 8_192
const limited = (message: string) => new HarnessError({ code: "skills.limit", message })
const under = (root: string, path: string): string => root.endsWith("/") ? `${root}${path}` : `${root}/${path}`

/** UTF-8 text, or none for bytes that are not (a binary file: a NUL byte, or not UTF-8). */
const textOf = (bytes: Uint8Array): Option.Option<string> => bytes.includes(0) ? Option.none()
  : Result.getSuccess(Result.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes), catch: () => "not UTF-8" }))

/** Whether the first bytes of a file can begin UTF-8 text: no NUL byte and no invalid sequence (one cut off at the end is fine). */
const beginsText = (bytes: Uint8Array): boolean => !bytes.includes(0)
  && Result.isSuccess(Result.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true }), catch: () => "not UTF-8" }))

interface Collected {
  readonly files: ReadonlyArray<SkillFile>
  readonly bytes: number
}

/**
 * The text files under `root` (an absolute directory), as `readSkillFiles`
 * takes them: paths relative to `root`, in `glob` order. The walk is the
 * port's `glob("**\/*")`: links are not entered, entries whose name starts
 * with a dot and `node_modules` directories are skipped. A binary file (a
 * NUL byte or bytes that are not UTF-8) is left out and does not count
 * toward `maxBytes`, told by its first 8 KB or, once read whole, by all of
 * it; without `maxFileBytes`, one whose first sign of binary lies past what
 * the budget has left fails it. A file other than a `SKILL.md` larger than
 * `maxFileBytes` is not read: it is collected with its `size` and no text,
 * and does not count toward `maxBytes` either.
 * More than `maxFiles` files, or more than `maxBytes` bytes of text, fails
 * with `skills.limit`. A file gone between the walk and its read is skipped;
 * any other read failure, or a `root` that cannot be listed, is the
 * `FsError`. The collection is one span, `skills.collect`.
 */
export const collectSkillFiles = Effect.fn("skills.collect")(function* (root: string, options: CollectSkillFilesOptions): Effect.fn.Return<ReadonlyArray<SkillFile>, FsError | HarnessError, FileSystem> {
  const fs = yield* FileSystem
  const found = yield* fs.glob("**/*", { cwd: root, onlyFiles: true, exclude: ["node_modules"], limit: options.maxFiles })
  if (found.truncated) return yield* Effect.fail(limited(`${root} holds more than ${options.maxFiles} files (maxFiles)`))
  const overBudget = limited(`the text files under ${root} hold more than ${options.maxBytes} bytes (maxBytes)`)
  const collected = yield* Effect.reduce(found.paths, (): Collected => ({ files: [], bytes: 0 }), (state, path) => {
    const full = under(root, path)
    const remaining = options.maxBytes - state.bytes
    // A SKILL.md is read whatever its size; any other file up to maxFileBytes.
    const cap = isSkillFile(path) ? Option.none<number>() : Option.fromNullishOr(options.maxFileBytes)
    const unread = (size: number): Collected => ({ ...state, files: [...state.files, { path, text: "", size }] })
    /** The file's first bytes: all of them when `complete`, else (no cap) more than `remaining`. */
    const add = (content: Uint8Array, complete: boolean): Effect.Effect<Collected, HarnessError> => {
      if (!complete) return beginsText(content) ? Effect.fail(overBudget) : Effect.succeed(state)
      return Option.match(textOf(content), {
        onNone: () => Effect.succeed(state),
        onSome: (text) => content.length > remaining ? Effect.fail(overBudget)
          : Effect.succeed({ files: [...state.files, { path, text }], bytes: state.bytes + content.length }),
      })
    }
    return fs.readBytes(full, { length: probeBytes }).pipe(
      Effect.flatMap((probe): Effect.Effect<Collected, FsError | HarnessError> => {
        if (!beginsText(probe)) return Effect.succeed(state)
        if (probe.length < probeBytes) {
          return Option.isSome(Option.filter(cap, (max) => probe.length > max)) ? Effect.succeed(unread(probe.length)) : add(probe, true)
        }
        const asked = Option.getOrElse(cap, () => remaining) + 1
        return Effect.flatMap(fs.readBytes(full, { length: asked }), (bytes): Effect.Effect<Collected, FsError | HarnessError> => Option.isSome(Option.filter(cap, (max) => bytes.length > max))
          ? Effect.map(fs.stat(full), (info) => unread(info.size))
          : add(bytes, bytes.length < asked))
      }),
      Effect.catchTag("FsError", (error) => error.reason === "NotFound" ? Effect.succeed(state) : Effect.fail(error)),
    )
  })
  return collected.files
})
