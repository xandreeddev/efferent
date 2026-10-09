/** Average precision over the observed relevant passages, preserving retrieval order. */
export const contextualPrecision = (relevant: ReadonlyArray<boolean>): number => {
  const count = relevant.filter(Boolean).length
  return count ? relevant.reduce((sum, value, index) => sum + (value ? relevant.slice(0, index + 1).filter(Boolean).length / (index + 1) : 0), 0) / count : 0
}
