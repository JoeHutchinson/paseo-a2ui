import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";

type TransformResult = ReturnType<PluginTimelineTransformerContribution<"tool_call">["transform"]>;

export const PENDING_KIND = "a2ui-pending";

/** Provider-specific tool names, e.g. `a2ui_render` or `mcp__paseo__a2ui_render`. */
export function isRenderToolName(name: string): boolean {
  return /(^|[^a-z0-9])a2ui_render$/.test(name);
}

/**
 * The surface itself arrives as its own timeline row, so the raw tool call (a wall of JSON) is
 * noise. Show a small placeholder while it runs, hide it once it succeeded, keep it on failure.
 */
export function transformRenderToolCall(item: {
  name: string;
  status: string;
  error: unknown;
}): TransformResult {
  if (!isRenderToolName(item.name)) return undefined;
  if (item.status === "running") {
    return { items: [{ type: "plugin", kind: PENDING_KIND, version: 1, data: {} }] };
  }
  if (item.status === "completed" && !item.error) return { items: [] };
  return undefined;
}
