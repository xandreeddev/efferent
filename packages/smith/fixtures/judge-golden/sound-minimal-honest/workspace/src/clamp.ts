export const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x))
