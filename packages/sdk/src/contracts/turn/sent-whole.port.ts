import { Context } from "effect"

/**
 * A tool's word that its result reaches the model as it is stored, however
 * long: instructions the model must read in full, a page it asked for. A
 * tool carries it as an annotation, `Tool.make(…).annotate(SentWhole,
 * true)`; `callTool` reads it off the tool it runs and stores it on the
 * result (`whole`), and a memory that shortens long results (`pointed`)
 * leaves that result alone. A loop that stores a result itself passes it to
 * `toolResult(call, result, isFailure, { whole: true })`.
 *
 * @public
 */
export class SentWhole extends Context.Service<SentWhole, boolean>()("@xandreed/sdk/kernel/SentWhole") {}
