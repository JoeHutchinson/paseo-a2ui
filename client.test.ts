import { describe, expect, it } from "vitest";
import { isRenderToolName, transformRenderToolCall } from "./client/transform";
import { materialise, rebase, withEdit, type LocalData } from "./shared/local-data";

describe("local data", () => {
  it("keeps user edits the agent did not touch and drops ones it did", () => {
    let local: LocalData = { base: { form: { name: "", email: "" }, total: 1 }, edits: {} };
    local = withEdit(local, "/form/name", "Ada");
    local = withEdit(local, "/form/email", "ada@x.io");
    expect(materialise(local)).toEqual({ form: { name: "Ada", email: "ada@x.io" }, total: 1 });

    const next = rebase(local, { form: { name: "", email: "agent@x.io" }, total: 2 });
    expect(materialise(next)).toEqual({ form: { name: "Ada", email: "agent@x.io" }, total: 2 });
  });

  it("lets a parent edit supersede nested edits", () => {
    let local: LocalData = { base: {}, edits: {} };
    local = withEdit(local, "/a/b", 1);
    local = withEdit(local, "/a", { c: 2 });
    expect(materialise(local)).toEqual({ a: { c: 2 } });
  });
});

describe("render tool call transform", () => {
  it("matches provider-specific tool names", () => {
    expect(isRenderToolName("a2ui_render")).toBe(true);
    expect(isRenderToolName("mcp__paseo__a2ui_render")).toBe(true);
    expect(isRenderToolName("not_a2ui_renderer")).toBe(false);
  });

  it("shows a placeholder while running, hides on success, keeps failures", () => {
    expect(transformRenderToolCall({ name: "a2ui_render", status: "running", error: null })?.items[0]).toMatchObject({
      kind: "a2ui-pending",
    });
    expect(transformRenderToolCall({ name: "a2ui_render", status: "completed", error: null })).toEqual({ items: [] });
    expect(transformRenderToolCall({ name: "a2ui_render", status: "failed", error: "x" })).toBeUndefined();
    expect(transformRenderToolCall({ name: "shell", status: "completed", error: null })).toBeUndefined();
  });
});
