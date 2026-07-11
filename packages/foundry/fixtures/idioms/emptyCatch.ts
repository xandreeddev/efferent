export const swallow = (run: () => void): void => {
  try {
    run()
  } catch {}
}

export const handled = (run: () => void): void => {
  try {
    run()
  } catch (error) {
    console.error(error)
  }
}
