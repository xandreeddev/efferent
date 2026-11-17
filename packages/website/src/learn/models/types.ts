import type { DataType } from "@huggingface/transformers"
import type { LanguageModel } from "effect/ai"

export type ModelKind = "echo" | "chrome" | "webllm" | "cpu" | "gateway"

export interface ModelChoice {
  readonly id: string
  readonly kind: ModelKind
  readonly label: string
  /** One line the picker shows: who makes it, what it is good for. */
  readonly blurb: string
  /** GPU/RAM the model needs once loaded, in MB; 0 when it needs none. */
  readonly memoryMB: number
  /** Context window in tokens, when known. */
  readonly contextTokens?: number
  /** Download size in MB for models fetched into the browser (CPU models). */
  readonly downloadMB?: number
  /** CPU models only: the Hugging Face model id and the quantisation to load. */
  readonly cpu?: { readonly id: string; readonly dtype: DataType }
  /** WebLLM only: the model ids (half-precision needs the GPU's shader-f16 feature) and the memory each needs. */
  readonly webllm?: { readonly f16: string; readonly f32: string; readonly memoryF32MB: number }
  /** Gateway only: the gateway's id of the model, and the providers asked first (others may answer when they are busy). */
  readonly gateway?: { readonly model: string; readonly order: ReadonlyArray<string> }
}

export type Availability =
  | { readonly state: "ready" }
  | { readonly state: "downloadable" }
  | { readonly state: "unavailable"; readonly reason: string }

export interface LoadProgress {
  readonly fraction: number
  readonly text: string
}

/** What the playground holds once a model is chosen and loaded. */
export interface LoadedModel {
  readonly choice: ModelChoice
  readonly model: LanguageModel.LanguageModel
  /** Interrupt generation in flight (WebLLM has no AbortSignal). Never throws. */
  readonly interrupt: () => void
  /** Frees what the model holds (the GPU, a worker). A promise when freeing takes time: wait for it before loading another. */
  readonly dispose: () => void | Promise<void>
}
