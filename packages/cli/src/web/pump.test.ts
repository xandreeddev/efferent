import { describe, expect, test } from "bun:test"
import { Effect, PubSub, Queue, Stream } from "effect"
import type { AgentEvent, SessionState, Workspace } from "@xandreed/sdk-core"
import { conversationSessionId, type ConversationId } from "@xandreed/sdk-core"
import { makeFragmentPump } from "./pump.js"

const CID = "11111111-1111-1111-1111-111111111111" as ConversationId
const SID = conversationSessionId(CID)

const meta = {
  sessionTitle: "test",
  workspacePath: "/tmp/w",
  model: "opencode:kimi-k2.6",
  wsUrl: "/ws",
}

/** A fake Workspace: getState returns a seeded log; subscribe tails a queue. */
const fakeWorkspace = (log: SessionState["log"], events: Queue.Queue<AgentEvent>) =>
  ({
    getState: () =>
      Effect.succeed({
        session: { id: SID, kind: "root", folder: "/tmp/w", status: "idle", parentId: null },
        log,
        busy: false,
        phase: "idle",
        queue: [],
        pendingApproval: null,
        cursor: 0,
      } as unknown as SessionState),
    subscribe: () =>
      Stream.fromQueue(events).pipe(Stream.zipWithIndex).pipe(
        Stream.map(([event, i]) => ({ seq: i + 1, event })),
      ),
  }) as unknown as ReturnType<typeof Workspace.of>

describe("fragment pump", () => {
  test("seeds from history, streams OOB fragments, fans out to N subscribers, full-render is idempotent", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<AgentEvent>()
        const ws = fakeWorkspace(
          [
            { role: "user", content: "hi there" },
            { role: "assistant", content: [{ type: "text", text: "hello!" }] },
          ] as unknown as SessionState["log"],
          events,
        )
        const pump = yield* makeFragmentPump(ws, SID, meta)

        // Initial full render carries the projected history.
        const initial = yield* pump.fullRender
        expect(initial).toContain("hi there")
        expect(initial).toContain("hello!")
        expect(initial).toContain(`hx-swap-oob="innerHTML"`)

        // Two tabs subscribe; a live event lands on both.
        const tabA = yield* PubSub.subscribe(pump.hub)
        const tabB = yield* PubSub.subscribe(pump.hub)
        yield* Queue.offer(events, {
          type: "assistant_message",
          turnIndex: 1,
          text: "streamed line",
          position: 2,
        })
        const a = yield* Queue.take(tabA).pipe(Effect.timeoutFail({ duration: "2 seconds", onTimeout: () => "tab A starved" }))
        const b = yield* Queue.take(tabB).pipe(Effect.timeoutFail({ duration: "2 seconds", onTimeout: () => "tab B starved" }))
        expect(a).toContain("streamed line")
        expect(a).toBe(b)
        // The live block landed keyed by its store position.
        expect(a).toContain(`id="blk-m_3Ap2_3Aa0"`)

        // A reconnect full render now includes the streamed tail — same keyed id.
        const resync = yield* pump.fullRender
        expect(resync).toContain("streamed line")
        expect(resync).toContain(`id="blk-m_3Ap2_3Aa0"`)

        // Local queue echo publishes a queue fragment.
        const tabC = yield* PubSub.subscribe(pump.hub)
        yield* pump.enqueueLocal("next prompt")
        const q = yield* Queue.take(tabC).pipe(Effect.timeoutFail({ duration: "2 seconds", onTimeout: () => "queue frame missing" }))
        expect(q).toContain("next prompt")
        expect(q).toContain(`id="ef-queue"`)
      }),
    )
    await Effect.runPromise(program as Effect.Effect<void, unknown, never>)
  })

  test("ui_render events land as sanitized canvas fragments", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<AgentEvent>()
        const ws = fakeWorkspace([] as unknown as SessionState["log"], events)
        const pump = yield* makeFragmentPump(ws, SID, meta)
        const tab = yield* PubSub.subscribe(pump.hub)
        yield* Queue.offer(events, {
          type: "ui_render",
          id: "quiz-1",
          title: "Quiz",
          html: `<script>alert(1)</script><form class="ef-card" hx-post="/action/ui"><input name="answer" /></form>`,
          mode: "replace",
        })
        const frame = yield* Queue.take(tab).pipe(Effect.timeoutFail({ duration: "2 seconds", onTimeout: () => "no canvas frame" }))
        expect(frame).toContain(`id="ui-quiz-1"`)
        expect(frame).not.toContain("<script>")
        expect(frame).toContain(`hx-post="/action/ui"`)
        expect(frame).toContain(`hx-swap-oob="beforeend:#ef-canvas"`)
      }),
    )
    await Effect.runPromise(program as Effect.Effect<void, unknown, never>)
  })
})
