export const count = (words: ReadonlyArray<string>): number => {
  let total = 0
  for (const word of words) {
    total += word.length
  }
  return total
}
