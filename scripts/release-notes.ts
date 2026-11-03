/** Extract one release's central changelog entry for its GitHub release. */
export const releaseNotes = (text: string, version: string): string => {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("The release version must be a stable semantic version")
  }
  const lines = text.split(/\r?\n/)
  const header = new RegExp(`^## ${version.replaceAll(".", "\\.")} — \\d{4}-\\d{2}-\\d{2}$`)
  const start = lines.findIndex((line) => header.test(line))
  if (start < 0) throw new Error(`The changelog has no dated entry for ${version}`)
  const next = lines.findIndex((line, index) => index > start && /^## (?:Unreleased|\d+\.\d+\.\d+(?: — \d{4}-\d{2}-\d{2})?)$/.test(line))
  const body = lines.slice(start + 1, next < 0 ? undefined : next).join("\n").trim()
  if (body.length === 0) throw new Error(`The changelog entry for ${version} is empty`)
  return `${body}\n`
}

if (import.meta.main) {
  const [path, version, ...extra] = process.argv.slice(2)
  if (path === undefined || version === undefined || extra.length > 0) {
    console.error("Usage: bun scripts/release-notes.ts <CHANGELOG.md> <version>")
    process.exit(2)
  }
  console.log(releaseNotes(await Bun.file(path).text(), version).trimEnd())
}
