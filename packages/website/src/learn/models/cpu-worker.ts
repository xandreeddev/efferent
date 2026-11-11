/// <reference lib="webworker" />
// CPU model worker: Transformers.js on WebAssembly. It runs off the main thread so
// the page stays responsive, and runs requests strictly one at a time: a request
// carries an id, every reply carries it back, so a stale reply can never be taken
// for a newer request's.
//
// On the CPU each token is computed synchronously, so the worker would never
// read a Stop message until the whole answer was done. It therefore generates a
// few tokens at a time (reusing the model's KV cache between chunks) and yields
// to the event loop between chunks: a Stop lands within a chunk.
import { AutoModelForCausalLM, AutoTokenizer, TextStreamer } from "@huggingface/transformers"

type Message = { role: string; content: string }
type In =
  | { type: "load"; id: string; dtype: string }
  | { type: "generate"; id: number; messages: Message[]; maxNewTokens: number }
  | { type: "interrupt"; id: number }

const CHUNK_TOKENS = 6

// The library's own types for these are broad; the worker uses the small slice below.
type Tokenizer = { apply_chat_template: (messages: Message[], options: object) => { input_ids: unknown; attention_mask: unknown } }
type Model = {
  generate: (options: object) => Promise<{ sequences: { dims: number[]; tolist: () => number[][] }; past_key_values: { dispose?: () => void } }>
  generation_config?: { eos_token_id?: number | number[] }
}

let tokenizer: Tokenizer | undefined
let model: Model | undefined
const cancelled = new Set<number>()
let running: number | undefined
let queue: Promise<void> = Promise.resolve()
const send = (message: unknown) => postMessage(message)
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const eosOf = (): ReadonlyArray<number> => {
  const eos = model?.generation_config?.eos_token_id
  return eos === undefined ? [] : Array.isArray(eos) ? eos : [eos]
}

const generate = async (message: Extract<In, { type: "generate" }>) => {
  if (tokenizer === undefined || model === undefined) { send({ type: "error", id: message.id, message: "The model is not loaded." }); return }
  if (cancelled.delete(message.id)) { send({ type: "done", id: message.id, tokens: 0 }); return }
  running = message.id
  let past: { dispose?: () => void } | undefined
  try {
    const encoded = tokenizer.apply_chat_template(message.messages, { add_generation_prompt: true, return_dict: true })
    let inputIds = encoded.input_ids
    let attention = encoded.attention_mask
    let produced = 0
    let finished = false
    while (!finished && produced < message.maxNewTokens && !cancelled.has(message.id)) {
      // A new streamer per chunk: it skips the prompt it is first handed (all tokens so far) and streams only the new ones.
      const streamer = new TextStreamer(tokenizer as never, {
        skip_prompt: true, skip_special_tokens: true,
        callback_function: (text: string) => send({ type: "token", id: message.id, text }),
      })
      const before = (inputIds as { dims: number[] }).dims[1] ?? 0
      const out = await model.generate({
        input_ids: inputIds, attention_mask: attention, past_key_values: past,
        max_new_tokens: Math.min(CHUNK_TOKENS, message.maxNewTokens - produced), do_sample: false,
        streamer, return_dict_in_generate: true,
      })
      past = out.past_key_values
      const sequence = out.sequences.tolist()[0] ?? []
      produced += sequence.length - before
      const last = sequence[sequence.length - 1]
      // Fewer new tokens than asked for, or an end token, means the answer is complete.
      finished = sequence.length - before < CHUNK_TOKENS || (last !== undefined && eosOf().includes(last))
      const T = (inputIds as { constructor: new (type: string, data: BigInt64Array, dims: number[]) => unknown }).constructor
      inputIds = new T("int64", BigInt64Array.from(sequence.map(BigInt)), [1, sequence.length])
      attention = new T("int64", BigInt64Array.from(sequence.map(() => 1n)), [1, sequence.length])
      await yieldToEventLoop()
    }
    send({ type: "done", id: message.id, tokens: produced })
  } catch (error) {
    send({ type: "error", id: message.id, message: error instanceof Error ? error.message : String(error) })
  } finally {
    past?.dispose?.()
    running = undefined
    cancelled.delete(message.id)
  }
}

self.onmessage = (event: MessageEvent<In>) => {
  const message = event.data
  if (message.type === "interrupt") {
    // Not queued: it acts at the next chunk boundary on the request it names (running, or still waiting its turn).
    cancelled.add(message.id)
  } else if (message.type === "generate") {
    queue = queue.then(() => generate(message))
  } else if (message.type === "load") {
    queue = queue.then(async () => {
      try {
        const progress_callback = (progress: unknown) => send({ type: "progress", progress })
        tokenizer = (await AutoTokenizer.from_pretrained(message.id, { progress_callback })) as unknown as Tokenizer
        model = (await AutoModelForCausalLM.from_pretrained(message.id, { dtype: message.dtype as never, device: "wasm", progress_callback })) as unknown as Model
        send({ type: "ready" })
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) })
      }
    })
  }
}
