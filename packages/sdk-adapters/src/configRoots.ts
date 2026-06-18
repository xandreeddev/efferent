import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Where a scoped write lands: machine-wide vs this folder. */
export type ConfigScope = "global" | "local"

/**
 * The resolved config/auth directories for a session.
 *
 * - **`EFFERENT_HOME` set** → a single, flat source at `$EFFERENT_HOME/.efferent`:
 *   the real `~/.efferent` and the cwd are never read or written, and there is no
 *   global/local split or merge. This is the test sandbox — blank when the folder
 *   is empty, knowing nothing of any real setup.
 * - **else** → `global` = `~/.efferent`, `local` = `<cwd>/.efferent`; reads merge
 *   `local` over `global`, writes target the chosen scope, and the local files
 *   (`auth.json`, `config.json`, the db) are gitignored.
 */
export interface ConfigRoots {
  /** Single-source sandbox mode (EFFERENT_HOME set): no global/local split. */
  readonly single: boolean
  /** The `.efferent` dir for the global tier (or the sole dir when `single`). */
  readonly global: string
  /** The `.efferent` dir for the local tier; `undefined` when `single`. */
  readonly local: string | undefined
}

/**
 * Resolve the config/auth roots for a workspace `cwd`. Reads `EFFERENT_HOME`
 * (single-source sandbox when set). `homeDir` overrides where the *global* tier
 * lives in scoped mode (defaults to the OS home) — the driver passes the real
 * home; tests pass a temp dir to stay hermetic.
 */
export const resolveConfigRoots = (cwd: string, homeDir?: string): ConfigRoots => {
  const override = process.env.EFFERENT_HOME
  if (override !== undefined && override.length > 0) {
    return { single: true, global: join(override, ".efferent"), local: undefined }
  }
  return {
    single: false,
    global: join(homeDir ?? homedir(), ".efferent"),
    local: join(cwd, ".efferent"),
  }
}

/** The `.efferent` dir a write of the given scope targets. In single-source mode
 *  every write goes to the one dir regardless of scope. */
export const dirForScope = (roots: ConfigRoots, scope: ConfigScope): string =>
  roots.single || scope === "global" ? roots.global : (roots.local ?? roots.global)

const LOCAL_GITIGNORE = `# efferent — personal, per-folder config & credentials (do not commit).
# Shareable assets like skills/ are NOT ignored.
auth.json
config.json
*.db
*.db-shm
*.db-wal
`

/**
 * Ensure a `<cwd>/.efferent/.gitignore` exists so a local-scope setup never leaks
 * credentials or personal config into the repo. Write-if-absent (never clobbers a
 * user's own file); best-effort — a failure here must not break a write.
 */
export const ensureLocalGitignore = (efferentDir: string): void => {
  try {
    const p = join(efferentDir, ".gitignore")
    if (existsSync(p)) return
    mkdirSync(efferentDir, { recursive: true })
    writeFileSync(p, LOCAL_GITIGNORE)
  } catch {
    /* best-effort */
  }
}
