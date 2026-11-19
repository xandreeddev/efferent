/** One argument for `sh -c`: as it is when it holds only safe characters, else in single quotes, a quote as `'\''`. */
export const quoted = (argument: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", "'\\''")}'`

/** A command line for `sh -c`, each argument quoted: nothing in an argument is read by the shell. */
export const commandLine = (args: ReadonlyArray<string>): string => args.map(quoted).join(" ")
