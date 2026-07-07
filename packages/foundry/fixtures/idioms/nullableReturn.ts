export const longest = (words: ReadonlyArray<string>): string | undefined =>
  [...words].sort((a, b) => b.length - a.length)[0]

export const firstPositive = (xs: ReadonlyArray<number>) => xs.find((x) => x > 0)

export const fine = (xs: ReadonlyArray<number>): number => xs.length
