/**
 * One tool call of a model response, as the loop reports it: the call's id
 * (the key that pairs it with its result), the tool's name and its
 * arguments as the model sent them.
 *
 * @public
 */
export interface ToolCallSummary {
  readonly id: string
  readonly toolName: string
  readonly args: unknown
}
