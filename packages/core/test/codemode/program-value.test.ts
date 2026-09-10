import { describe, expect, test } from "bun:test"
import { CodeModeTool } from "@opencode/core/codemode/tool"
import type { Info } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"

const tool = (output: Info["output"]): Info => ({
  name: "probe",
  description: "probe",
  input: Schema.Struct({}),
  execute: () => Effect.succeed({}),
  ...(output === undefined ? {} : { output }),
})

const text = (value: string) => [{ type: "text" as const, text: value }]

describe("CodeModeTool.programValue", () => {
  test("structured output is returned as-is", () => {
    const structured = { issues: [1] }
    expect(CodeModeTool.programValue(tool({}), structured, text("ignored"))).toBe(structured)
  })

  test("one JSON text block without an output schema is parsed", () => {
    expect(CodeModeTool.programValue(tool({}), '{"issues":[{"id":1}]}', text('{"issues":[{"id":1}]}'))).toEqual({
      issues: [{ id: 1 }],
    })
    expect(CodeModeTool.programValue(tool(undefined), undefined, text("  [1, 2]"))).toEqual([1, 2])
  })

  test("a declared output schema is never second-guessed", () => {
    expect(CodeModeTool.programValue(tool(Schema.String), '{"a":1}', text('{"a":1}'))).toBe('{"a":1}')
    expect(CodeModeTool.programValue(tool({ type: "string" }), '{"a":1}', text('{"a":1}'))).toBe('{"a":1}')
  })

  test("JSON primitives and prose stay strings", () => {
    expect(CodeModeTool.programValue(tool({}), "42", text("42"))).toBe("42")
    expect(CodeModeTool.programValue(tool({}), "null", text("null"))).toBe("null")
    expect(CodeModeTool.programValue(tool({}), "[INFO] started", text("[INFO] started"))).toBe("[INFO] started")
    expect(CodeModeTool.programValue(tool({}), "{not json", text("{not json"))).toBe("{not json")
  })

  test("multiple text blocks are joined, not parsed", () => {
    const content = [...text("Result:"), ...text('{"a":1}')]
    expect(CodeModeTool.programValue(tool({}), 'Result:\n{"a":1}', content)).toBe('Result:\n{"a":1}')
    expect(CodeModeTool.programValue(tool(undefined), undefined, content)).toBe('Result:\n{"a":1}')
  })

  test("no output and no text is null", () => {
    expect(CodeModeTool.programValue(tool(undefined), undefined, [])).toBeNull()
    expect(
      CodeModeTool.programValue(tool(undefined), undefined, [{ type: "file", uri: "data:x;base64,AA==", mime: "x" }]),
    ).toBeNull()
  })
})
