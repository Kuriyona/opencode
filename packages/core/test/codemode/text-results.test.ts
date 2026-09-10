import { describe, expect, test } from "bun:test"
import { CodeModeTool } from "@opencode/core/codemode/tool"
import type { Context, Info, Result } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"

// Runs `tools.probe({})` and returns what the program saw as [typeof value, value].
const run = async (output: Info["output"], result: Result) => {
  const tool: Info = {
    name: "probe",
    description: "probe",
    input: Schema.Struct({}),
    execute: () => Effect.succeed(result),
    ...(output === undefined ? {} : { output }),
  }
  const execute = CodeModeTool.create({ tools: new Map([["probe", tool]]) }, () => Effect.succeed(result))
  const context = { progress: () => Effect.void } as unknown as Context
  const executed = await Effect.runPromise(
    execute.execute({ code: "const r = await tools.probe({}); return [typeof r, r]" }, context),
  )
  return JSON.parse(executed.output.output)
}

// An MCP-shaped result: text content, output mirrors the text, and `{}` for a missing outputSchema.
const mcp = (text: string) => ({ output: text, content: [{ type: "text" as const, text }] })

describe("code mode parses JSON text results from MCP tools without an outputSchema", () => {
  test("one JSON object or array text block becomes a value", async () => {
    expect(await run({}, mcp('{"issues":[{"id":1}]}'))).toEqual(["object", { issues: [{ id: 1 }] }])
    expect(await run({}, mcp(" [1, 2]"))).toEqual(["object", [1, 2]])
  })

  test("structuredContent is untouched", async () => {
    expect(await run({}, { output: { a: 1 }, content: [{ type: "text", text: "ignored" }] })).toEqual([
      "object",
      { a: 1 },
    ])
  })

  test("a declared output schema is never second-guessed", async () => {
    expect(await run({ type: "string" }, mcp('{"a":1}'))).toEqual(["string", '{"a":1}'])
    expect(await run(Schema.String, mcp('{"a":1}'))).toEqual(["string", '{"a":1}'])
  })

  test("tools without any output schema keep their advertised string result", async () => {
    expect(await run(undefined, { content: [{ type: "text", text: '{"a":1}' }] })).toEqual(["string", '{"a":1}'])
  })

  test("primitives and prose stay strings", async () => {
    expect(await run({}, mcp("42"))).toEqual(["string", "42"])
    expect(await run({}, mcp("null"))).toEqual(["string", "null"])
    expect(await run({}, mcp("[INFO] started"))).toEqual(["string", "[INFO] started"])
    expect(await run({}, mcp("{not json"))).toEqual(["string", "{not json"])
  })

  test("multiple text blocks are joined, not parsed", async () => {
    const content = [
      { type: "text" as const, text: "Result:" },
      { type: "text" as const, text: '{"a":1}' },
    ]
    expect(await run({}, { output: 'Result:\n{"a":1}', content })).toEqual(["string", 'Result:\n{"a":1}'])
  })
})
