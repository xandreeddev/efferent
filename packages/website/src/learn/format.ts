// "Format" for the editable code: Prettier, loaded only when the button is used
// (about 170 kB gzipped, so it is not part of the page).

export type Formatted = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string }

/** The repo's own style: no semicolons, double quotes, trailing commas. */
const STYLE = { parser: "babel", semi: false, singleQuote: false, printWidth: 100, trailingComma: "all" } as const

/**
 * Format `text`, which is not a whole file: `prefix` is the code that
 * precedes it (`const Agent = `), so Prettier sees a valid program, and is
 * cut off again afterwards. A syntax error comes back as a message.
 */
export const formatRegion = async (text: string, prefix: string): Promise<Formatted> => {
  try {
    const [prettier, babel, estree] = await Promise.all([
      import("prettier/standalone"),
      import("prettier/plugins/babel"),
      import("prettier/plugins/estree"),
    ])
    const out = await prettier.format(`${prefix}${text}`, { ...STYLE, plugins: [babel, estree] })
    if (!out.startsWith(prefix)) return { ok: false, message: "Could not format this code." }
    return { ok: true, text: out.slice(prefix.length).replace(/;?\s*$/, "") }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Prettier's message carries a code frame; its first line says what is wrong.
    return { ok: false, message: message.split("\n")[0]?.replace(/\s*\(\d+:\d+\)$/, "") ?? "Could not format this code." }
  }
}
