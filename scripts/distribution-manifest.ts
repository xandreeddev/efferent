/**
 * The dependencies a published package declares, from its source manifest (scripts/build-packages.ts
 * writes them; distribution-manifest.test.ts covers them). Each `workspace:*` package is a caret range
 * of its version, and `effect` a caret-range peer dependency, never exact pins: a host on another
 * patch of a package or of Effect then installs ONE copy of `@xandreed/core` and of `effect`, which
 * the framework needs, since two copies split the classes and services the packages share.
 */

/** The dependency fields of a source package.json the build reads. */
export interface SourceDependencies {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
}

/** The packages every installed package must share a single copy of with the host. */
const PEERS: ReadonlyArray<string> = ["effect"]

/** `4.0.7` becomes `^4.0.7`; a range is kept as it is. */
const caret = (version: string): string => /^\d/.test(version) ? `^${version}` : version

/**
 * The published `dependencies` and `peerDependencies`: workspace packages at `^<version>` (from
 * `versions`, by package name), `effect` moved to the peers at a caret range, everything else as the
 * source declares it. A workspace package `versions` does not know is the caller's to refuse.
 */
export const distributionDependencies = (source: SourceDependencies, versions: ReadonlyMap<string, string>): {
  readonly dependencies: Record<string, string>
  readonly peerDependencies: Record<string, string>
} => {
  const declared = Object.entries(source.dependencies ?? {})
  return {
    dependencies: Object.fromEntries(declared.filter(([name]) => !PEERS.includes(name)).map(([name, value]) =>
      [name, value.startsWith("workspace:") ? caret(versions.get(name) ?? value) : value])),
    peerDependencies: {
      ...source.peerDependencies,
      ...Object.fromEntries(declared.filter(([name]) => PEERS.includes(name)).map(([name, value]) => [name, caret(value)])),
    },
  }
}
