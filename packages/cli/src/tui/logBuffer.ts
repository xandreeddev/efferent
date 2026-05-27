/**
 * Bounded ring buffer of log lines for the TUI's right pane. Lines are
 * pushed by the file logger and rendered as a live feed; the file logger
 * also persists them to disk so `tail -f ~/.agent/agent.log` keeps
 * working outside the TUI.
 */
export class LogBuffer {
  private readonly capacity: number
  private lines: string[] = []

  constructor(capacity = 1000) {
    this.capacity = capacity
  }

  push(line: string): void {
    this.lines.push(line)
    if (this.lines.length > this.capacity) {
      this.lines = this.lines.slice(this.lines.length - this.capacity)
    }
  }

  /** Return the last `n` lines in order (oldest → newest). */
  tail(n: number): ReadonlyArray<string> {
    return this.lines.slice(Math.max(0, this.lines.length - n))
  }

  size(): number {
    return this.lines.length
  }

  clear(): void {
    this.lines = []
  }
}
