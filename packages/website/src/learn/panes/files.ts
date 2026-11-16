// The Files tab (lesson 16): the page's workspace as it is. A list of the
// files, and the chosen one's text in an editor a person can change and
// save. It draws what `WorkspacePane` gives (workspace-pane.ts) and hands it
// what the person does; it reads no journal and knows no agent. The file's
// text is a text area's value, never markup.
import { Option } from "effect"
import type { FileView } from "../workspace-pane.ts"

export interface FilesPane {
  /** Draw the pane's view. */
  readonly render: (view: FileView) => void
}

export interface FilesHandlers {
  readonly choose: (path: string) => void
  readonly edit: (draft: string) => void
  readonly save: () => void
}

export const mountFiles = (host: HTMLElement, handlers: FilesHandlers): FilesPane => {
  const find = <T extends HTMLElement>(selector: string): T => {
    const found = host.querySelector<T>(selector)
    if (!found) throw new Error(`the Files tab is missing ${selector}`)
    return found
  }
  const list = find("[data-ws-list]")
  const path = find("[data-ws-path]")
  const text = find<HTMLTextAreaElement>("[data-ws-text]")
  const save = find<HTMLButtonElement>("[data-ws-save]")
  const notice = find("[data-ws-notice]")
  let shown: FileView | undefined

  text.addEventListener("input", () => {
    handlers.edit(text.value)
    save.disabled = shown === undefined || Option.isNone(shown.chosen) || text.value === shown.loaded
  })
  save.addEventListener("click", () => handlers.save())

  const render = (view: FileView) => {
    shown = view
    list.replaceChildren(...view.paths.map((one) => {
      const item = document.createElement("li")
      const button = document.createElement("button")
      button.type = "button"
      button.textContent = one
      if (Option.contains(view.chosen, one)) button.setAttribute("aria-current", "true")
      button.addEventListener("click", () => handlers.choose(one))
      item.append(button)
      return item
    }))
    path.textContent = Option.getOrElse(view.chosen, () => "No file")
    // The person's text is put back only when the view holds another: what they are typing is not replaced under them.
    if (text.value !== view.draft) text.value = view.draft
    text.disabled = Option.isNone(view.chosen)
    save.disabled = Option.isNone(view.chosen) || view.draft === view.loaded
    notice.textContent = view.notice
    notice.dataset.state = view.changed ? "changed" : ""
  }
  return { render }
}
