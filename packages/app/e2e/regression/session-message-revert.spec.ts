import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client/promise"
import { base64Encode } from "@opencode/util/encode"
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/SessionMessageRevert"
const projectID = "proj_session_message_revert"
const sessionID = "ses_session_message_revert"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const messages = [
  { id: "msg_first", type: "user", text: "First prompt", time: { created: 1 } },
  {
    id: "msg_first_reply",
    type: "assistant",
    agent: "build",
    model: { id: "test", providerID: "opencode" },
    content: [{ type: "text", text: "First reply" }],
    time: { created: 2, completed: 3 },
  },
  { id: "msg_second", type: "user", text: "Second prompt", time: { created: 4 } },
] satisfies SessionMessageInfo[]
const session = {
  id: sessionID,
  slug: "session-message-revert",
  projectID,
  directory,
  title: "Session message revert",
  agent: "build",
  model: { id: "test", providerID: "opencode" },
  version: "dev",
  time: { created: 1, updated: 4 },
}
const fixture = {
  directory,
  project: {
    id: projectID,
    worktree: directory,
    canonical: directory,
    vcs: "git",
    name: "session-message-revert",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  },
  provider: {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: { test: { id: "test", name: "Test", variants: {}, limit: { context: 200_000 } } },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "test" },
  },
  pageMessages: () => ({ items: messages }),
}

test("reverts directly to the selected user message", async ({ page }) => {
  const staged: { sessionID: string; messageID: string }[] = []
  await mockOpenCodeServer(page, {
    ...fixture,
    sessions: [session],
    onRevertStage: (input) => staged.push(input),
  })
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, "Session message revert")

  const message = page.locator('[data-message-id="msg_second"]')
  await message.hover()
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/session/${sessionID}/revert/stage`,
  )
  await message.getByRole("button", { name: "Revert message" }).click()
  expect((await response).ok()).toBe(true)

  await expect(page.getByRole("textbox", { name: "Prompt" })).toHaveText("Second prompt")
  expect(staged).toEqual([{ sessionID, messageID: "msg_second" }])
})

test("hides revert actions in a child session", async ({ page }) => {
  await mockOpenCodeServer(page, {
    ...fixture,
    sessions: [
      { ...session, id: "ses_parent", slug: "parent", title: "Parent session" },
      { ...session, parentID: "ses_parent" },
    ],
  })
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, "Session message revert")

  const message = page.locator('[data-message-id="msg_second"]')
  await message.hover()
  await expect(message.getByRole("button", { name: "Revert message" })).toHaveCount(0)
})

for (const action of ["undo", "undo-staged", "fork"]) {
  test(`${action} finds prompts outside the loaded transcript using filtered history`, async ({ page }) => {
    const third = { id: "msg_third", type: "user", text: "Third prompt", time: { created: 5 } } as const
    const users = [messages[0], messages[2], third]
    const current = { ...session, revert: action === "undo-staged" ? { messageID: String(third.id) } : undefined }
    const forked = { ...session, id: "ses_filtered_fork", title: "Forked history" }
    const staged: string[] = []
    const events: OpenCodeEvent[] = []
    const reads: (string | null)[] = []
    const history = Promise.withResolvers<void>()
    let olderResponses = 0
    page.once("close", () => history.resolve())
    page.on("request", (request) => {
      const url = new URL(request.url())
      if (url.pathname === `/api/session/${sessionID}/message`) reads.push(url.searchParams.get("type"))
    })
    await mockOpenCodeServer(page, {
      ...fixture,
      sessions: [current, forked],
      beforeMessagesResponse: async ({ before }) => {
        if (before) await history.promise
      },
      onMessages: ({ before, phase }) => {
        if (before && phase === "end") olderResponses++
      },
      pageMessages: (id, _limit, before) => {
        if (id === forked.id) return { items: [] }
        if (before) return { items: [...messages, third] }
        if (action === "fork")
          return {
            items: [
              third,
              {
                id: "msg_third_reply",
                type: "assistant",
                agent: "build",
                model: session.model,
                content: [
                  {
                    type: "text",
                    text: Array.from({ length: 40 }, (_, i) => `Latest answer paragraph ${i}`).join("\n\n"),
                  },
                ],
                time: { created: 6, completed: 7 },
              },
            ],
            cursor: "transcript-older",
          }
        return {
          items: [
            {
              id: "msg_z_compaction",
              type: "compaction",
              status: "completed",
              reason: "manual",
              summary: "Compacted history",
              recent: "",
              time: { created: 10 },
            },
          ],
          cursor: "transcript-older",
        }
      },
      onRevertStage: (input) => {
        staged.push(input.messageID)
        current.revert = { messageID: input.messageID }
        events.push({
          id: `evt_revert_${staged.length}`,
          created: 11,
          type: "session.revert.staged",
          durable: { aggregateID: sessionID, seq: staged.length, version: 1 },
          data: { sessionID, revert: { messageID: input.messageID } },
        })
      },
      events: () => events.splice(0),
    })
    await page.route(`**/api/session/${sessionID}/message?*`, async (route) => {
      const query = new URL(route.request().url()).searchParams
      if (!query.has("type")) return route.fallback()
      expect(query.get("type")).toBe("user")
      const asc = query.get("order") === "asc" || query.get("cursor") === "asc-next"
      const ordered = asc ? users : users.toReversed()
      await route.fulfill({
        json: {
          data: query.has("cursor") ? ordered.slice(1) : ordered.slice(0, 1),
          cursor: query.has("cursor") ? {} : { next: asc ? "asc-next" : "desc-next" },
        },
      })
    })
    const forks: string[] = []
    await page.route(`**/api/session/${sessionID}/fork`, async (route) => {
      forks.push(route.request().postDataJSON().boundary.messageID)
      await route.fulfill({
        json: {
          data: {
            ...forked,
            location: { directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      })
    })
    await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
    await expectSessionTitle(page, session.title)
    const editor = page.getByRole("textbox", { name: "Prompt", exact: true })
    await expect(editor).toBeEditable()
    await editor.fill(action === "fork" ? "/fork" : "/undo")
    const suggestion = page.locator(`[data-suggestion-id="session.${action === "fork" ? "fork" : "undo"}"]`)
    await expect(suggestion).toBeVisible()
    await suggestion.click()
    if (action === "fork") {
      const dialog = page.getByRole("dialog")
      await expect(dialog.getByText("Second prompt", { exact: true })).toBeVisible()
      expect(olderResponses).toBe(0)
      expect(reads.filter((type) => type === "user")).toHaveLength(2)
      await page.screenshot({ path: test.info().outputPath("filtered-fork.png") })
      await dialog.getByText("Second prompt", { exact: true }).click()
      await expect(page).toHaveURL(`/server/${base64Encode(server)}/session/${forked.id}`)
      await expect(editor).toHaveText("Second prompt")
      expect(forks).toEqual(["msg_second"])
      expect(olderResponses).toBe(0)
      history.resolve()
      return
    }
    history.resolve()
    await expect(editor).toHaveText(action === "undo" ? "Third prompt" : "Second prompt")
    expect(staged).toEqual([action === "undo" ? "msg_third" : "msg_second"])
    expect(reads.filter((type) => type === "user")).toHaveLength(2)
    expect(olderResponses).toBe(1)
    await page.screenshot({ path: test.info().outputPath("filtered-undo.png") })
    if (action === "undo-staged") {
      await editor.fill("/redo")
      const redo = page.locator('[data-suggestion-id="session.redo"]')
      await expect(redo).toBeVisible()
      await redo.click()
      await expect(editor).toHaveText("Third prompt")
      expect(staged).toEqual(["msg_second", "msg_third"])
      expect(reads.filter((type) => type === "user")).toHaveLength(4)
      expect(olderResponses).toBe(1)
    }
  })
}
