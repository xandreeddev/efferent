// Convention: kebab-case file names; every module has a sibling *.test.ts.
export const titleCase = (s: string): string =>
  s.replace(/\b\w/g, (ch) => ch.toUpperCase())
