export const sum = (xs: ReadonlyArray<number>): number => {
  const acc = { total: 0 }
  for (const x of xs) {
    acc.total += x
  }
  while (acc.total > 100) {
    acc.total -= 100
  }
  return acc.total
}
