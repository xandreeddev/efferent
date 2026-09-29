import { Layer, Logger } from "effect"

/** Effect's pretty logger on STDERR (stdout stays the program's own output),
 *  with the tracer logger kept so logs still land on spans. */
export const StderrPrettyLoggerLive = Layer.merge(
  Logger.layer([Logger.consolePretty(), Logger.tracerLogger]),
  Layer.succeed(Logger.LogToStderr, true),
)
