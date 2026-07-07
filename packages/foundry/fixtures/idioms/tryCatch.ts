export const risky = (input: string): number => {
  try {
    return Number(JSON.parse(input))
  } catch {
    return 0
  }
}

export const explode = (): never => {
  throw new Error("boom")
}

export const swallowed = Promise.resolve(1).catch(() => 0)
