import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

const earlier = { id: "msg_0001", type: "user", text: "Earlier request", time: { created: 1 } } as const
const boundary = { id: "msg_0090", type: "user", text: "Already undone", time: { created: 90 } } as const
const compacted = {
  id: "msg_0080",
  type: "compaction",
  status: "completed",
  summary: "Compacted conversation",
  time: { created: 80 },
} as const

test.each(["undo", "timeline", "fork"])(
  "%s uses filtered user history beyond the transcript window",
  async (command) => {
    await using state = await tmpdir()
    const session = {
      id: `ses_history_${command}`,
      title: "Compacted history",
      projectID: "project",
      location: { directory },
      agent: "build",
      model: { providerID: "fixture", id: "model" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 100 },
    }
    let revert = command === "undo" ? { messageID: boundary.id } : undefined
    const requests: { type: string | null; cursor: string | null }[] = []
    const staged: string[] = []
    const forked: string[] = []
    await using setup = await createAppFixture({
      state: state.path,
      args: { sessionID: session.id },
      config: { animations: false, tabs: { enabled: false }, session: { sidebar: "hide" } },
      fetch: async (url, request) => {
        if (url.pathname === `/api/session/${session.id}`) return json({ data: { ...session, revert } })
        if (url.pathname === `/api/session/${session.id}/message`) {
          const type = url.searchParams.get("type")
          const cursor = url.searchParams.get("cursor")
          requests.push({ type, cursor })
          if (type === "user")
            return cursor
              ? json({ data: [earlier], cursor: {} })
              : json({
                  data: command === "undo" ? [boundary] : [{ ...earlier, id: "msg_0002", text: "Recent request" }],
                  cursor: { next: "users-older" },
                })
          if (cursor) {
            expect(cursor).toBe("transcript-older")
            return json({ data: [earlier], cursor: {} })
          }
          return json({
            data: [
              ...(command === "undo" ? [boundary] : []),
              compacted,
              ...Array.from({ length: 18 }, (_, index) => ({
                id: `msg_00${60 - index}`,
                type: "assistant",
                agent: session.agent,
                model: session.model,
                content: [{ type: "text", text: `Assistant step ${index}` }],
                time: { created: 60 - index, completed: 61 - index },
                finish: "stop",
                cost: 0,
                tokens: session.tokens,
              })),
            ],
            cursor: { next: "transcript-older" },
          })
        }
        if (url.pathname === `/api/session/${session.id}/revert/stage`) {
          const body = await request.json()
          staged.push(body.messageID)
          revert = { messageID: body.messageID }
          setup.events.emit({
            id: "evt_revert",
            created: 100,
            type: "session.revert.staged",
            durable: { aggregateID: session.id, seq: 1, version: 1 },
            data: { sessionID: session.id, revert },
          })
          return json({ data: revert })
        }
        if (url.pathname === `/api/session/${session.id}/interrupt`) return json({ interrupted: false })
        if (url.pathname === `/api/session/${session.id}/wait`) return new Response(null, { status: 204 })
        if (url.pathname === `/api/session/${session.id}/fork`) {
          const body = await request.json()
          forked.push(body.boundary.messageID)
          return json({ data: { ...session, id: "ses_history_forked", title: "Forked copy" } })
        }
        if (url.pathname === "/api/session/ses_history_forked")
          return json({ data: { ...session, id: "ses_history_forked", title: "Forked copy" } })
        if (url.pathname === "/api/session/ses_history_forked/message") return json({ data: [], cursor: {} })
        if (url.pathname.endsWith("/inbox") || url.pathname.endsWith("/permission")) return json({ data: [] })
        return undefined
      },
    })

    await setup.waitForFrame((frame) => frame.includes("ctrl+p commands") && frame.includes("Build"))
    await setup.mockInput.typeText(`/${command}`)
    await setup.waitForFrame((frame) =>
      frame.includes(
        command === "undo" ? "Undo previous message" : command === "timeline" ? "Jump to message" : "Fork session",
      ),
    )
    setup.mockInput.pressEnter()

    if (command === "undo") {
      const frame = await setup.waitForFrame((frame) => frame.includes(earlier.text))
      expect(staged).toEqual([earlier.id])
      expect(frame).not.toContain("Nothing to undo")
      expect(requests).toEqual([
        { type: null, cursor: null },
        { type: "user", cursor: null },
        { type: "user", cursor: "users-older" },
        { type: null, cursor: "transcript-older" },
      ])
      return
    }

    await setup.waitForFrame((frame) => frame.includes(earlier.text))
    expect(requests.filter((request) => request.type === null)).toHaveLength(1)
    await setup.mockInput.typeText(earlier.text)
    await setup.waitForFrame((frame) => frame.includes(earlier.text) && !frame.includes("Recent request"))
    setup.mockInput.pressEnter()
    if (command === "timeline") {
      await setup.waitForFrame((frame) => frame.includes("Message Actions"))
      expect(requests.filter((request) => request.type === null)).toHaveLength(1)
      setup.mockInput.pressEnter()
      await setup.waitForFrame((frame) => !frame.includes("Message Actions") && frame.includes(earlier.text))
      expect(requests.at(-1)).toEqual({ type: null, cursor: "transcript-older" })
      return
    }
    await setup.waitForFrame((frame) => frame.includes("Forked session") && frame.includes(earlier.text))
    expect(forked).toEqual([earlier.id])
    expect(requests.filter((request) => request.type === null)).toHaveLength(1)
  },
)
