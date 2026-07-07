/** Platform "open this URL" shell command (duplicated from the cli's OAuth
 *  helper — this package never imports the cli). */
export const browserCommand = (url: string): string => {
  const u = url.replace(/"/g, "%22")
  switch (process.platform) {
    case "darwin":
      return `open "${u}"`
    case "win32":
      return `start "" "${u}"`
    default:
      return `xdg-open "${u}"`
  }
}
