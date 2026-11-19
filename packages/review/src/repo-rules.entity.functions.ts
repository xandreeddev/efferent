import { RULE_FILES } from "./repo-rules.entity.js"

/**
 * The instruction files to look for along the changed paths: each of `RULE_FILES` at the root, then in each folder
 * that holds a changed path or is an ancestor of one, folders in the order first met walking each path from the root.
 * Each path once; whether a file is there is the checkout's to say.
 */
export const rulesAlong = (changedPaths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const folders: Array<string> = [""]
  for (const path of changedPaths) {
    const parts = path.split("/").slice(0, -1)
    for (let depth = 1; depth <= parts.length; depth++) {
      const folder = parts.slice(0, depth).join("/")
      if (!folders.includes(folder)) folders.push(folder)
    }
  }
  return folders.flatMap((folder) => RULE_FILES.map((name) => (folder === "" ? name : `${folder}/${name}`)))
}
