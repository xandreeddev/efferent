/**
 * The dependencies a published package declares, from its source manifest (scripts/build-packages.ts
 * writes them; distribution-manifest.test.ts covers them). Each `workspace:*` package is a caret range
 * of its version, and `@xandreed/core` and `effect` caret-range peer dependencies, never exact pins:
 * a host on another patch of a package or of Effect then installs ONE copy of `@xandreed/core` and of
 * `effect`, which the framework needs, since two copies split the classes and services the packages
 * share, and a host whose dependencies ask for two gets a peer conflict from its package manager
 * instead of a second, silent copy. verify-packages.ts checks the packed consumer installed one copy
 * of each (`installedCopies`).
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"

/** The dependency fields of a source package.json the build reads. */
export interface SourceDependencies {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
}

/** The packages every installed package must share a single copy of with the host. */
export const PEERS: ReadonlyArray<string> = ["@xandreed/core", "effect"]

/** `4.0.7` becomes `^4.0.7`; a range is kept as it is. */
const caret = (version: string): string => /^\d/.test(version) ? `^${version}` : version

/**
 * The published `dependencies` and `peerDependencies`: workspace packages at `^<version>` (from
 * `versions`, by package name), the `PEERS` moved to the peers at a caret range, everything else as
 * the source declares it. A workspace package `versions` does not know is the caller's to refuse.
 */
export const distributionDependencies = (source: SourceDependencies, versions: ReadonlyMap<string, string>): {
  readonly dependencies: Record<string, string>
  readonly peerDependencies: Record<string, string>
} => {
  const declared = Object.entries(source.dependencies ?? {}).map(([name, value]): readonly [string, string] =>
    [name, value.startsWith("workspace:") ? caret(versions.get(name) ?? value) : value])
  return {
    dependencies: Object.fromEntries(declared.filter(([name]) => !PEERS.includes(name))),
    peerDependencies: {
      ...source.peerDependencies,
      ...Object.fromEntries(declared.filter(([name]) => PEERS.includes(name)).map(([name, value]) => [name, caret(value)])),
    },
  }
}

/** Whether `path` is a directory, following a symbolic link (a package an isolated install links in). */
const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory()

/** The package folders directly in a `node_modules` folder: `name` and `@scope/name`, and those of an isolated install's store (`.bun/<id>/node_modules`). */
const packagesIn = (modules: string): ReadonlyArray<string> =>
  readdirSync(modules).filter((name) => name !== ".bin" && isDirectory(join(modules, name))).flatMap((name) =>
    name === ".bun" ? readdirSync(join(modules, name)).map((id) => join(modules, name, id, "node_modules")).filter(isDirectory).flatMap(packagesIn)
      : name.startsWith("@") ? readdirSync(join(modules, name)).map((child) => join(modules, name, child)).filter(isDirectory)
      : name.startsWith(".") ? []
      : [join(modules, name)])

/**
 * Every installed copy of each package of `names` under the `node_modules` folder `modules`, nested
 * `node_modules` folders and an isolated install's store included: the real folders, by package
 * name, each once however many links reach it.
 */
export const installedCopies = (modules: string, names: ReadonlyArray<string>): ReadonlyMap<string, ReadonlyArray<string>> => {
  const walk = (folder: string, seen: ReadonlySet<string>): ReadonlySet<string> => packagesIn(folder).reduce((found, dir) => {
    const real = realpathSync(dir)
    const nested = join(real, "node_modules")
    return found.has(real) ? found : isDirectory(nested) ? walk(nested, new Set([...found, real])) : new Set([...found, real])
  }, seen)
  const nameOf = (dir: string): string => {
    const manifest = join(dir, "package.json")
    return existsSync(manifest) ? String((JSON.parse(readFileSync(manifest, "utf8")) as { readonly name?: unknown }).name) : ""
  }
  const real = Array.from(isDirectory(modules) ? walk(modules, new Set()) : [])
  return new Map(names.map((name) => [name, real.filter((dir) => nameOf(dir) === name).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)]))
}
