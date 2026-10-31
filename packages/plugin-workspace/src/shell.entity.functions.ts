/** One literal POSIX shell argument, including quotes, newlines and metacharacters. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
