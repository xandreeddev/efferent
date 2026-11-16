// The file pane's model (lesson 15): what the pane shows of the page's
// workspace, and what a person does there. It draws the world, not the agent
// (ADR 0017): it reads the page's own `Files`, never the journal and never
// what the learner's workspace.ts wraps around it, since a person is not the
// agent. It reads the files again when a tool says it wrote one
// (`plugin.files.written`) and whenever a turn ends, Stop included: a write
// interrupted before its result says nothing, and the file is changed all
// the same. A person's Save is a compare and set against the text the pane
// loaded, so it never overwrites a change it has not shown. No DOM here:
// `panes/files.ts` draws what this gives.
import { Cause, Effect, Exit, Option, Result } from "effect"
import type { Context } from "effect"
import { dataOf, turnEndedEvent } from "@xandreed/core/kernel"
import type { KernelEvent } from "@xandreed/core/kernel"
import { APPROVAL_REFUSED, EDIT_FILE, WRITE_FILE, workspacePath, writtenEvent } from "@xandreed/sdk/kernel"
import type { Files, FilePath } from "@xandreed/sdk/kernel"
import { textOf } from "./evaluate.ts"
import type { Trace } from "./runtime.ts"

type FilesShape = Context.Service.Shape<typeof Files>

/** What the pane shows. */
export interface FileView {
  /** Every file of the workspace, by path, in the workspace's order. */
  readonly paths: ReadonlyArray<string>
  /** The file shown, if any. */
  readonly chosen: Option.Option<string>
  /** The chosen file's text as the pane last loaded it: what a Save expects the file to hold. */
  readonly loaded: string
  /** The text in the pane's editor: the loaded text, or a person's change to it. */
  readonly draft: string
  /** The file holds something else than the pane loaded, and the person's draft was kept: Save will not write it. */
  readonly changed: boolean
  /** What the pane says under the editor: empty, or the last thing that happened. */
  readonly notice: string
}

export const emptyView: FileView = { paths: [], chosen: Option.none(), loaded: "", draft: "", changed: false, notice: "" }

/** What the pane says when the file a person is editing was written by someone else: the draft is kept, and not saved. */
export const changedUnderDraft = (path: string): string =>
  `${path} was changed in the workspace while you were editing it. Your text is kept here, and Save will not write over that change.`

/** What the pane says when a Save found the file changed since it was loaded: nothing written, the file shown as it is. */
export const saveRefused = (path: string): string =>
  `${path} was changed since this pane loaded it, so your text was not saved. It is shown as it is now: make your change again.`

/** What the pane says after a Save that wrote. */
export const savedLine = (path: string): string => `Saved ${path}.`

/** Whether the person changed the text the pane loaded. */
export const dirty = (view: FileView): boolean => view.draft !== view.loaded

/**
 * Whether the page heard something after which the pane reads the workspace again: a tool said it wrote a file, or
 * a turn ended, in any session and whatever its outcome.
 */
export const rereadsOn = (trace: Trace): boolean =>
  trace._tag === "Event" && (Option.isSome(dataOf(writtenEvent, trace.event)) || (trace.event._tag === "Stored" && trace.event.name === turnEndedEvent.name))

/** A call of the workspace, run to its exit: what it gave, or how it failed. */
const ran = <A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> => Effect.runPromise(Effect.exit(effect))

/** A path the pane shows, as the workspace takes it: the pane only shows paths the workspace listed. */
const pathOf = (path: string): Option.Option<FilePath> => Result.getSuccess(workspacePath(path))

/**
 * The pane over the page's workspace: one at a time, in the order asked, each step reads the workspace and hands
 * the next view to `draw`. `settled` waits for every step asked so far.
 */
export class WorkspacePane {
  private view: FileView = emptyView
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly files: FilesShape, private readonly draw: (view: FileView) => void) {}

  /** What the pane shows now. */
  get current(): FileView {
    return this.view
  }

  /** Every step asked so far, done. */
  settled(): Promise<void> {
    return this.queue
  }

  private step(next: (view: FileView) => Promise<FileView>): Promise<void> {
    this.queue = this.queue.then(async () => {
      this.view = await next(this.view)
      this.draw(this.view)
    }).catch((error: unknown) => {
      this.view = { ...this.view, notice: `The pane could not read the workspace: ${textOf(error)}` }
      this.draw(this.view)
    })
    return this.queue
  }

  /** The workspace's paths, and the chosen file (the first, when none is) loaded or checked against the draft. */
  private async read(view: FileView, choose: Option.Option<string>): Promise<FileView> {
    const listed = await ran(this.files.list(Option.none()))
    const paths: ReadonlyArray<string> = Exit.isSuccess(listed) ? listed.value : view.paths
    const chosen = Option.orElse(Option.orElse(choose, () => view.chosen), () => Option.fromNullishOr(paths[0]))
    const path = Option.flatMap(Option.filter(chosen, (one) => paths.includes(one)), pathOf)
    if (Option.isNone(path)) return { ...view, paths, chosen: Option.none(), loaded: "", draft: "", changed: false }
    const read = await ran(this.files.read(path.value))
    if (Exit.isFailure(read)) return { ...view, paths, notice: `${path.value} could not be read.` }
    const text = read.value
    // What the person typed while the workspace was read is kept: the view as it is now, not as the read began.
    const now = { ...view, draft: this.view.draft }
    const fresh = Option.isSome(choose) || !Option.contains(view.chosen, path.value)
    // A file chosen anew, or one the person has not changed: shown as it is.
    if (fresh || !dirty(now)) return { paths, chosen: Option.some(path.value), loaded: text, draft: text, changed: false, notice: fresh ? "" : now.notice }
    // The person is editing it: the draft is kept, and the text it was loaded from too, so Save still expects that.
    const changed = text !== now.loaded
    return { ...now, paths, changed, notice: changed ? changedUnderDraft(path.value) : now.notice }
  }

  /** Read the workspace again: on a tool's write, a turn's end, or when the pane opens. */
  refresh(): Promise<void> {
    return this.step((view) => this.read(view, Option.none()))
  }

  /** Show a file: its text as the workspace holds it, the draft dropped. */
  choose(path: string): Promise<void> {
    return this.step((view) => this.read(view, Option.some(path)))
  }

  /** The person's text, as they type it. */
  edit(draft: string): void {
    this.view = { ...this.view, draft }
  }

  /**
   * Save the person's text, through the page's own workspace, expecting the file to hold what the pane loaded. When
   * it holds something else (the agent wrote it since), nothing is written: the pane says so, and shows the file as
   * it is, the draft dropped.
   */
  save(): Promise<void> {
    return this.step(async (view) => {
      const path = Option.flatMap(view.chosen, pathOf)
      if (Option.isNone(path)) return view
      const written = await ran(this.files.write(path.value, view.draft, { _tag: "Holds", text: view.loaded }))
      if (Exit.isSuccess(written)) return { ...view, loaded: view.draft, changed: false, notice: savedLine(path.value) }
      const reread = await this.read(view, Option.some(path.value))
      const changed = Option.exists(Cause.findErrorOption(written.cause), (failure) => failure._tag === "FileChanged")
      const why = Option.match(Cause.findErrorOption(written.cause), { onNone: () => "the workspace failed", onSome: textOf })
      return { ...reread, notice: changed ? saveRefused(path.value) : `${path.value} was not saved: ${why}.` }
    })
  }

  /** What the page heard: the pane reads the workspace again after a write a tool said, and after every turn's end. */
  hear(trace: Trace): Promise<void> {
    return rereadsOn(trace) ? this.refresh() : this.queue
  }
}

/**
 * What the chat's status line says of the workspace (lesson 15), in lesson 13's style, from what the page hears: a
 * write a tool said (`wrote notes/todo.md`), and a write or an edit whose result failed, so nothing was written,
 * with who said no: the person (the kernel's `APPROVAL_REFUSED`, word for word), or the workspace (the start of the
 * kernel's words for a `Files` that declines). None for anything else.
 */
export const workspaceLine = (event: KernelEvent): Option.Option<string> => {
  const written = dataOf(writtenEvent, event)
  if (Option.isSome(written)) return Option.some(`wrote ${written.value.path}`)
  if (event._tag !== "Stored" || event.message?._tag !== "ToolResult" || !event.message.isFailure) return Option.none()
  const { name, result } = event.message
  if (name !== WRITE_FILE && name !== EDIT_FILE) return Option.none()
  const who = result === APPROVAL_REFUSED ? "you refused it" : typeof result === "string" && result.startsWith(DECLINED) ? "the workspace declined it" : "it failed"
  return Option.some(`${name}: nothing written, ${who}`)
}

/** How the kernel's words start for a write a `Files` declined (`FilesRefused`): "The workspace declined this for …". */
export const DECLINED = "The workspace declined this for "
