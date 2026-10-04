import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Effect, Option, Ref, Semaphore } from "effect"
import { FileSystem, fingerprintOf, HarnessError } from "@xandreed/core"
import { spawnBounded } from "@xandreed/plugin-tools-local"
import { changeOf, changed } from "./edit.entity.functions.js"
import { EditProposal, EditReceipt, ProposalId } from "./edit.entity.js"
import type { ProposedChange, WorkOrder } from "./edit.entity.js"
import type { EditOverlay } from "./editing.port.js"

const invalid = (code: string, message: string) => new HarnessError({ code: `smith.${code}`, message })
const protectedPath = (path: string) => path.split("/").some((part) => [".git", ".efferent", ".foundry"].includes(part)) || path === "foundry.config.ts"
const outside = (path: string) => path === ".." || path.startsWith("../") || isAbsolute(path)
const ancestors = (path: string): ReadonlyArray<string> => dirname(path) === path ? [path] : [path, ...ancestors(dirname(path))]
// Every Smith handle in this process validates and applies proposals under the same lock.
const workspaceWrites = Semaphore.makeUnsafe(1)
const skippedSearchPath = (path: string) => path.split("/").some((part) => ["node_modules", ".git", ".efferent", ".foundry", "__pycache__"].includes(part))
interface IgnoreRule { readonly base: string; readonly pattern: Bun.Glob; readonly basename: boolean; readonly include: boolean }
const ignoreRules = (text: string, base: string) => Effect.forEach(text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#")), (line) => {
  const include = line.startsWith("!")
  const pattern = (include ? line.slice(1) : line).replace(/^\//, "").replace(/\/$/, "")
  return Effect.try({ try: () => new Bun.Glob(pattern), catch: () => "invalid ignore pattern" }).pipe(Effect.map((glob) => Option.some<IgnoreRule>({ base, pattern: glob, basename: !pattern.includes("/") && !(include ? line.slice(1) : line).startsWith("/"), include })), Effect.orElseSucceed(() => Option.none<IgnoreRule>()))
}).pipe(Effect.map((rules) => rules.flatMap(Option.toArray)))
const ignored = (path: string, rules: ReadonlyArray<IgnoreRule>) => rules.reduce((ignore, rule) => {
  const local = relative(rule.base || ".", path)
  const matches = !outside(local) && (rule.basename ? local.split("/").some((part) => rule.pattern.match(part)) : rule.pattern.match(local))
  return matches ? !rule.include : ignore
}, false)

/** Canonical checks happen for reads, staging and again immediately before application. */
export const makeWorkspace = (workspace: string) => Effect.gen(function* () {
  const fs = yield* FileSystem
  const root = yield* fs.realPath(resolve(workspace)).pipe(Effect.mapError((error) => invalid("workspace", error.message)))
  const pathOf = (path: string, writing = false) => Effect.gen(function* () {
    const target = resolve(root, path)
    const local = relative(root, target)
    if (outside(local) || local.split("/").some((part) => [".git", ".efferent", ".foundry"].includes(part)) || (writing && (local === "" || protectedPath(local)))) return yield* Effect.fail(invalid("path", `Refusing ${writing ? "write" : "read"} of ${path}`))
    const ancestor = yield* Effect.reduce(ancestors(target), () => Option.none<{ readonly lexical: string; readonly canonical: string }>(), (known, candidate) => Option.isSome(known)
      ? Effect.succeed(known)
      : fs.exists(candidate).pipe(Effect.flatMap((exists) => exists ? fs.realPath(candidate).pipe(Effect.map((canonical) => Option.some({ lexical: candidate, canonical }))) : Effect.succeed(Option.none()))))
    if (Option.isNone(ancestor)) return yield* Effect.fail(invalid("path", `Cannot resolve ${path}`))
    const canonical = join(ancestor.value.canonical, relative(ancestor.value.lexical, target))
    const canonicalLocal = relative(root, canonical)
    if (outside(canonicalLocal) || canonicalLocal.split("/").some((part) => [".git", ".efferent", ".foundry"].includes(part)) || (writing && protectedPath(canonicalLocal))) return yield* Effect.fail(invalid("path", `Refusing symlink escape or protected state: ${path}`))
    return { target: canonical, local: canonicalLocal }
  }).pipe(Effect.mapError((error) => error instanceof HarnessError ? error : invalid("path", error.message)))
  const readOriginal = (target: string) => fs.exists(target).pipe(Effect.flatMap((exists) => exists ? fs.read(target).pipe(Effect.map(Option.some)) : Effect.succeed(Option.none<string>())), Effect.mapError((error) => invalid("read", error.message)))
  const fallbackPaths = Effect.gen(function* () {
    const addRules = (directory: string, inherited: ReadonlyArray<IgnoreRule>) => Effect.forEach([".gitignore", ".ignore"], (name) => fs.read(join(root, directory, name)).pipe(Effect.flatMap((text) => ignoreRules(text, directory)), Effect.orElseSucceed(() => [] as ReadonlyArray<IgnoreRule>))).pipe(Effect.map((groups) => [...inherited, ...groups.flat()]))
    const initial = yield* fs.list(root).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
    interface Directory { readonly local: string; readonly entries: ReadonlyArray<string>; readonly rules: ReadonlyArray<IgnoreRule> }
    const walk = (pending: ReadonlyArray<Directory>, found: ReadonlyArray<string>, visited: number): Effect.Effect<ReadonlyArray<string>> => Effect.gen(function* () {
      const next = pending[0]
      if (next === undefined || found.length >= 5000 || visited >= 1000) return found.slice(0, 5000)
      const rules = yield* addRules(next.local, next.rules)
      const children = yield* Effect.forEach(next.entries.slice(0, 5000).sort(), (name) => Effect.gen(function* () {
        const local = join(next.local, name)
        if (skippedSearchPath(local) || ignored(local, rules)) return { files: [] as ReadonlyArray<string>, directories: [] as ReadonlyArray<Directory> }
        const checked = yield* Effect.result(pathOf(local))
        if (checked._tag === "Failure" || checked.success.target !== resolve(root, local)) return { files: [] as ReadonlyArray<string>, directories: [] as ReadonlyArray<Directory> }
        const listed = yield* Effect.result(fs.list(checked.success.target))
        return listed._tag === "Success" ? { files: [], directories: [{ local, entries: listed.success, rules }] }
          : { files: listed.failure.message.includes("ENOTDIR") ? [local] : [], directories: [] }
      }), { concurrency: 4 })
      return yield* walk([...pending.slice(1), ...children.flatMap((child) => child.directories)], [...found, ...children.flatMap((child) => child.files)], visited + 1)
    })
    return yield* walk([{ local: "", entries: initial, rules: [] }], [], 0)
  })
  // Git applies nested ignore files before it descends into ignored infrastructure.
  const paths = spawnBounded(["git", "-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], root, 10_000).pipe(
    Effect.flatMap((result) => result.exitCode === 0 ? Effect.succeed(result.stdout.split("\0").filter((path) => path.length > 0 && !skippedSearchPath(path))) : fallbackPaths),
    Effect.catch(() => fallbackPaths), Effect.map((all) => [...new Set(all)].sort().slice(0, 5000)),
  )
  const files = {
    read: (path: string) => pathOf(path).pipe(Effect.flatMap(({ target }) => fs.read(target)), Effect.mapError((error) => error instanceof HarnessError ? error : invalid("read", error.message))),
    list: (path: string) => pathOf(path).pipe(Effect.flatMap(({ target }) => fs.list(target)), Effect.mapError((error) => error instanceof HarnessError ? error : invalid("list", error.message))),
    glob: (pattern: string) => Effect.try({ try: () => new Bun.Glob(pattern), catch: (error) => invalid("search", String(error)) }).pipe(Effect.flatMap((glob) => paths.pipe(Effect.map((all) => all.filter((path) => glob.match(path)).slice(0, 200))))),
    grep: (pattern: string) => Effect.try({ try: () => new RegExp(pattern), catch: (error) => invalid("search", String(error)) }).pipe(Effect.flatMap((regex) => paths.pipe(Effect.flatMap((all) => Effect.forEach(all, (path) => pathOf(path).pipe(Effect.flatMap(({ target }) => fs.read(target)), Effect.map((text) => text.includes("\0") ? [] : text.split("\n").flatMap((line, index) => regex.test(line) ? [`${path}:${index + 1}:${line.slice(0, 300)}`] : [])), Effect.orElseSucceed(() => [] as ReadonlyArray<string>)), { concurrency: 4 })), Effect.map((all) => all.flat().slice(0, 200).join("\n"))))),
  }
  const overlay = (workOrder: WorkOrder): Effect.Effect<EditOverlay> => Effect.gen(function* () {
    const entries = yield* Ref.make(new Map<string, ProposedChange>())
    const submitted = yield* Ref.make(Option.none<EditProposal>())
    const mutations = yield* Semaphore.make(1)
    const scopedPath = (path: string) => pathOf(path, true).pipe(Effect.flatMap((checked) => workOrder.paths.some((allowed) => {
      const local = relative(resolve(root, allowed), checked.target)
      return !outside(local)
    }) ? Effect.succeed(checked) : Effect.fail(invalid("edit.scope", `${path} is outside the work order's file scope`))))
    const current = (path: string) => pathOf(path).pipe(Effect.flatMap(({ target, local }) => Ref.get(entries).pipe(Effect.flatMap((all) => {
      const known = all.get(local)
      return known === undefined ? readOriginal(target) : Effect.succeed(known.content)
    }))))
    const stage = (path: string, content: Option.Option<string>) => Effect.gen(function* () {
      const checked = yield* scopedPath(path)
      if (Option.exists(content, (text) => text.length > 250_000)) return yield* Effect.fail(invalid("edit.size", "A staged file cannot exceed 250000 characters"))
      if (Option.isSome(yield* Ref.get(submitted))) return yield* Effect.fail(invalid("edit.closed", "This proposal was submitted; start another work order to revise it"))
      const all = yield* Ref.get(entries)
      if (all.size >= 50 && !all.has(checked.local)) return yield* Effect.fail(invalid("edit.size", "A work order can change at most 50 files"))
      const known = all.get(checked.local)
      const original = known === undefined ? yield* readOriginal(checked.target) : known.original
      yield* Ref.set(entries, new Map([...all, [checked.local, changeOf(checked.local, original, content)]]))
    })
    const read = (path: string) => current(path).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.fail(invalid("read", `${path} does not exist in this edit overlay`)), onSome: Effect.succeed })))
    return {
      workOrder,
      files: { ...files, read },
      proposal: Ref.get(submitted),
      editor: {
        write: (path, content) => mutations.withPermits(1)(stage(path, Option.some(content))),
        remove: (path) => mutations.withPermits(1)(current(path).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.fail(invalid("edit.missing", `${path} does not exist`)), onSome: () => stage(path, Option.none()) })))),
        edit: (path, oldText, newText) => mutations.withPermits(1)(read(path).pipe(Effect.flatMap((text) => {
          const matches = oldText.length === 0 ? 0 : text.split(oldText).length - 1
          return matches !== 1 ? Effect.fail(invalid("edit.match", `oldText must match exactly once in ${path}; found ${matches}`)) : stage(path, Option.some(text.replace(oldText, newText)))
        }))),
        submit: (summary) => mutations.withPermits(1)(Ref.get(submitted).pipe(Effect.flatMap(Option.match({ onSome: Effect.succeed, onNone: () => Ref.get(entries).pipe(Effect.flatMap((all) => {
          const proposal = new EditProposal({ id: ProposalId.make(crypto.randomUUID()), workOrderId: workOrder.id, summary, changes: [...all.values()].filter(changed).sort((left, right) => left.path.localeCompare(right.path)) })
          return Ref.set(submitted, Option.some(proposal)).pipe(Effect.as(proposal))
        })) })))),
      },
    }
  })
  const put = (target: string, content: Option.Option<string>) => Option.match(content, {
    onNone: () => fs.remove(target),
    onSome: (text) => fs.mkdir(dirname(target)).pipe(Effect.andThen(fs.write(target, text))),
  }).pipe(Effect.mapError((error) => invalid("write", error.message)))
  const apply = (proposal: EditProposal) => workspaceWrites.withPermits(1)(Effect.gen(function* () {
    const prepared = yield* Effect.forEach(proposal.changes, (change) => pathOf(change.path, true).pipe(Effect.flatMap(({ target }) => readOriginal(target).pipe(Effect.flatMap((actual) => {
      const matches = Option.makeEquivalence((left: string, right: string) => left === right)(actual, change.original)
      return matches && Option.makeEquivalence((left: string, right: string) => left === right)(Option.map(actual, fingerprintOf), change.originalFingerprint)
        ? Effect.succeed({ target, change }) : Effect.fail(invalid("edit.conflict", `${change.path} changed since the editor read it; delegate a fresh edit`))
    })))))
    const completed = yield* Ref.make<ReadonlyArray<{ readonly target: string; readonly change: ProposedChange }>>([])
    yield* Effect.forEach(prepared, (item) => put(item.target, item.change.content).pipe(Effect.andThen(Ref.update(completed, (all) => [...all, item]))), { discard: true }).pipe(Effect.catch((error) => Ref.get(completed).pipe(Effect.flatMap((all) => Effect.forEach([...all].reverse(), (item) => readOriginal(item.target).pipe(Effect.flatMap((actual) =>
      Option.makeEquivalence((left: string, right: string) => left === right)(actual, item.change.content) ? put(item.target, item.change.original) : Effect.void)), { discard: true })), Effect.andThen(Effect.fail(error)))))
    return new EditReceipt({ proposalId: proposal.id, paths: prepared.map(({ change }) => change.path), status: prepared.length === 0 ? "empty" : "applied" })
  }).pipe(Effect.uninterruptible))
  const instructions = (scope: ReadonlyArray<string>) => Effect.forEach([...new Set(scope.flatMap((path) => ancestors(resolve(root, path)).filter((parent) => !outside(relative(root, parent))).flatMap((parent) => [join(parent, "AGENTS.md"), join(parent, "CLAUDE.md")])))].reverse(), (path) => fs.exists(path).pipe(Effect.flatMap((exists) => exists ? pathOf(path).pipe(Effect.flatMap(({ target }) => fs.read(target)), Effect.map((text) => `## Workspace instructions: ${relative(root, path)}\n${text.slice(0, 8000)}`)) : Effect.succeed("")), Effect.orElseSucceed(() => "")), { concurrency: 4 }).pipe(Effect.map((blocks) => blocks.filter((block) => block.length > 0).join("\n\n")))
  return { files, pathOf, overlay, apply, instructions }
})
