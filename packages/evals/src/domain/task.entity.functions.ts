import type { Schema } from "effect"
import { EvalId } from "./identity.entity.js"
import type { Task } from "./task.entity.js"
import type { Dataset } from "../assessment.usecase.js"

export const tasksFromDataset = <I extends Schema.Json, Ref>(dataset: Dataset<I, Ref>, options: { readonly runnable: string; readonly graders: Task["graders"] }): ReadonlyArray<Task> => dataset.cases.map((entry) => ({
  id: EvalId.make(entry.id), version: dataset.version, runnable: options.runnable,
  dataset: dataset.id, datasetVersion: dataset.version, family: entry.family, split: entry.split,
  review: entry.review, input: entry.input, reference: entry.reference,
  graders: options.graders, provenance: entry.provenance,
}))
