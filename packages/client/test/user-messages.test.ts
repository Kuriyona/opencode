import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData } from "../src/solid"
import { OpenCode, type SessionMessageInfo } from "../src/promise"

const user = (id: string) => ({ id, type: "user", text: id, time: { created: 1 } }) as const
const compacted = {
  id: "msg_compaction",
  type: "compaction",
  status: "completed",
  reason: "manual",
  summary: "Summary",
  recent: "",
  time: { created: 2 },
} as const

function fixture(
  read: (
    query: URLSearchParams,
  ) =>
    | { data: SessionMessageInfo[]; cursor: { next?: string } }
    | Promise<{ data: SessionMessageInfo[]; cursor: { next?: string } }>,
) {
  const requests: URLSearchParams[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const query = new URL((input instanceof Request ? input : new Request(input, init)).url).searchParams
      requests.push(query)
      return Response.json(await read(query))
    },
  })
  const root = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event: { on: () => () => {}, listen: () => () => {} } }),
    dispose,
  }))
  return { data: root.data, requests, [Symbol.dispose]: root.dispose }
}

test("filtered user history keeps its cursors and sparse rows out of the transcript cache", async () => {
  using setup = fixture((query) => {
    if (!query.has("type"))
      return query.has("cursor")
        ? { data: [user("msg_old")], cursor: {} }
        : { data: [compacted], cursor: { next: "transcript-older" } }
    expect(query.get("type")).toBe("user")
    return query.has("cursor")
      ? { data: [user("msg_z_oldest")], cursor: {} }
      : { data: [user("msg_a_newest")], cursor: { next: "users-older" } }
  })
  await setup.data.session.message.sync("ses_history")
  expect((await setup.data.session.message.users("ses_history")).map((message) => message.id)).toEqual([
    "msg_z_oldest",
    "msg_a_newest",
  ])
  expect(setup.requests.map((query) => [query.get("type"), query.get("cursor")])).toEqual([
    [null, null],
    ["user", null],
    ["user", "users-older"],
  ])
  expect(setup.data.session.message.list("ses_history")).toEqual([compacted])
  expect(setup.data.session.message.get("ses_history", "msg_z_oldest")).toBeUndefined()
  await setup.data.session.message.loadMore("ses_history")
  expect(setup.requests.at(-1)?.get("cursor")).toBe("transcript-older")
})

test.each(["before", "after"] as const)("finds users %s a boundary across filtered pages", async (direction) => {
  using setup = fixture((query) => {
    expect(query.get("type")).toBe("user")
    if (!query.has("cursor")) {
      expect(query.get("order")).toBe(direction === "before" ? "desc" : "asc")
      return { data: [user("msg_other")], cursor: { next: "boundary" } }
    }
    expect(query.has("order")).toBe(false)
    if (query.get("cursor") === "boundary")
      return { data: [user("msg_boundary"), user("msg_z")], cursor: { next: "more" } }
    return { data: [user("msg_a"), user("msg_excess")], cursor: { next: "unused" } }
  })
  const messages = await setup.data.session.message.users("ses_history", {
    boundary: { messageID: "msg_boundary", direction },
    limit: 2,
  })
  expect(messages.map((message) => message.id)).toEqual(
    direction === "before" ? ["msg_a", "msg_z"] : ["msg_z", "msg_a"],
  )
  expect(setup.requests).toHaveLength(3)
  expect(setup.data.session.message.list("ses_history")).toEqual([])
})

test("a missing boundary does not undo a newer message and a newest lookup stays bounded", async () => {
  using setup = fixture(() => ({ data: [user("msg_new")], cursor: {} }))
  expect(
    await setup.data.session.message.users("ses_history", {
      boundary: { messageID: "msg_missing", direction: "before" },
      limit: 1,
    }),
  ).toEqual([])
  expect(await setup.data.session.message.users("ses_history", { limit: 1 })).toEqual([user("msg_new")])
  expect(setup.requests.at(-1)?.get("limit")).toBe("1")
})

test("loads the contiguous transcript through a selected message without exhausting older history", async () => {
  using setup = fixture((query) => {
    expect(query.has("type")).toBe(false)
    const cursor = query.get("cursor")
    if (!cursor) return { data: [compacted], cursor: { next: "recent" } }
    expect(query.get("limit")).toBe("200")
    if (cursor === "recent") return { data: [user("msg_recent")], cursor: { next: "target" } }
    return { data: [user("msg_target")], cursor: { next: "unused" } }
  })
  await setup.data.session.message.sync("ses_history")
  let publications = 0
  await setup.data.session.message.loadMore("ses_history", { until: "msg_target", beforePublish: () => publications++ })
  expect(publications).toBe(1)
  expect(setup.data.session.message.list("ses_history").map((message) => message.id)).toEqual([
    "msg_target",
    "msg_recent",
    "msg_compaction",
  ])
  expect(setup.data.session.message.get("ses_history", "msg_target")).toEqual(user("msg_target"))
  expect(setup.data.session.message.more("ses_history")).toBe(true)
  await setup.data.session.message.loadMore("ses_history", { until: "msg_target" })
  expect(setup.requests).toHaveLength(3)
})

test("cancelling a filtered read prevents further pages and cache writes", async () => {
  const response = Promise.withResolvers<{ data: SessionMessageInfo[]; cursor: { next: string } }>()
  using setup = fixture(() => response.promise)
  const request = new AbortController()
  const pending = setup.data.session.message.users("ses_history", { signal: request.signal })
  const rejected = pending.then(
    () => undefined,
    (error) => error,
  )
  request.abort()
  response.resolve({ data: [user("msg_new")], cursor: { next: "unused" } })
  expect(await rejected).toBeDefined()
  expect(setup.requests).toHaveLength(1)
  expect(setup.data.session.message.list("ses_history")).toEqual([])
})
