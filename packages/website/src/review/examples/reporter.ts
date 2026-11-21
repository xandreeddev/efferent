import type { ReviewReport } from "@xandreed/review"

// A reporter is any function of the report: reviewPullRequest returns it as a value, and the command line's
// reportText is one rendering of it. This one writes a Markdown list, confirmed findings first, then the unsettled.
export const markdownOf = (report: ReviewReport): string => {
  const line = (finding: ReviewReport["reported"][number]) =>
    `- \`${finding.path}:${finding.line}\` **${finding.severity}** ${finding.kind}: ${finding.claim}`
  const confirmed = report.reported.map(line)
  const unsettled = report.unsettled.map(line)
  return [
    `### Review of #${report.number} at ${report.at.sha.slice(0, 7)}`,
    ...(confirmed.length === 0 ? ["No confirmed findings."] : confirmed),
    ...(unsettled.length === 0 ? [] : ["", "Unsettled, worth a read:", ...unsettled]),
  ].join("\n")
}
