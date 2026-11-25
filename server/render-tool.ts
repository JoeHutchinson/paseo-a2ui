import { defineAgentTool, type AgentToolContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  applyMessages,
  MAX_SNAPSHOT_BYTES,
  messageSchema,
  MOVED_KIND,
  snapshotBytes,
  surfaceSnapshotSchema,
  TIMELINE_KIND,
  TIMELINE_VERSION,
  type A2uiMessage,
  type SurfaceSnapshot,
} from "../shared/protocol";
import { RENDER_TOOL_DESCRIPTION } from "./description";

export const RENDER_TOOL_NAME = "a2ui_render";

type Paseo = AgentToolContext["paseo"];

/**
 * Per-agent state.
 *
 * Paseo folds a finished turn behind a summary row and leaves only the agent's last reply in view,
 * so a surface rendered mid-turn would disappear into the fold. Each surface therefore gets a
 * "live" row while the turn runs. When the turn ends, its latest state is re-appended after the
 * reply (where it stays visible), the live row shrinks to a pointer, and the previous turn's copy
 * of the same surface is retired so only one interactive copy exists.
 */
interface AgentState {
  surfaces: Map<string, SurfaceSnapshot>;
  generation: number;
  /** surfaceId -> live row id for surfaces touched in the current turn. */
  live: Map<string, string>;
  /** surfaceId -> id of the row currently showing the settled surface. */
  settled: Map<string, string>;
}

const states = new Map<string, Promise<AgentState>>();
/** Serialises tool calls and turn settling per agent; tool calls in one batch can run in parallel. */
const queues = new Map<string, Promise<unknown>>();

function exclusive<T>(agentId: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(agentId) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    agentId,
    next.catch(() => undefined),
  );
  return next;
}

export function forgetAgent(agentId: string) {
  states.delete(agentId);
  queues.delete(agentId);
}

function loadState(paseo: Paseo, agentId: string): Promise<AgentState> {
  let pending = states.get(agentId);
  if (!pending) {
    pending = rebuildState(paseo, agentId);
    states.set(agentId, pending);
  }
  return pending;
}

/** Rebuilds state from the agent's timeline, so a plugin or daemon restart loses nothing. */
async function rebuildState(paseo: Paseo, agentId: string): Promise<AgentState> {
  const state: AgentState = { surfaces: new Map(), generation: Date.now(), live: new Map(), settled: new Map() };
  const rowsBySurface = new Map<string, string[]>();
  try {
    const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 500 });
    const entries = (page as { entries?: Array<{ item?: unknown }> }).entries ?? [];
    for (const entry of entries) {
      const item = entry.item as { type?: string; kind?: string; id?: string; data?: unknown } | undefined;
      if (item?.type !== "plugin" || item.kind !== TIMELINE_KIND) continue;
      const parsed = surfaceSnapshotSchema.safeParse(item.data);
      if (!parsed.success) continue;
      state.surfaces.set(parsed.data.surfaceId, parsed.data);
      const ids = rowsBySurface.get(parsed.data.surfaceId) ?? [];
      if (typeof item.id === "string") ids.push(item.id);
      rowsBySurface.set(parsed.data.surfaceId, ids);
    }
  } catch (error) {
    console.error("a2ui: could not rebuild surfaces from the timeline", error);
  }
  // The newest row of each surface is its current copy. A newest row that is still "live" means
  // the daemon stopped mid-turn; settle it at the next turn end like any other live row.
  for (const [surfaceId, ids] of rowsBySurface) {
    const newest = ids[ids.length - 1];
    if (!newest) continue;
    if (newest.startsWith("live:")) state.live.set(surfaceId, newest);
    else state.settled.set(surfaceId, newest);
  }
  return state;
}

async function appendMoved(paseo: Paseo, agentId: string, rowId: string, surfaceId: string, reason: "moved" | "superseded") {
  await paseo.agents.ref(agentId).timeline.append({
    type: "plugin",
    id: rowId,
    kind: MOVED_KIND,
    version: 1,
    data: { surfaceId, reason },
  });
}

export function settleTurn(agentId: string, paseo: Paseo): Promise<void> {
  if (!states.has(agentId)) return Promise.resolve();
  return exclusive(agentId, async () => {
    const state = await loadState(paseo, agentId);
    if (state.live.size === 0) return;
    const live = [...state.live];
    state.live = new Map();
    const generation = state.generation;
    state.generation += 1;
    const timeline = paseo.agents.ref(agentId).timeline;
    for (const [surfaceId, liveRowId] of live) {
      const snapshot = state.surfaces.get(surfaceId);
      if (!snapshot) continue;
      const finalRowId = `final:${generation}:${surfaceId}`;
      try {
        await timeline.append({ type: "plugin", id: finalRowId, kind: TIMELINE_KIND, version: TIMELINE_VERSION, data: snapshot });
        await appendMoved(paseo, agentId, liveRowId, surfaceId, "moved");
        const previous = state.settled.get(surfaceId);
        if (previous && previous !== finalRowId) await appendMoved(paseo, agentId, previous, surfaceId, "superseded");
        state.settled.set(surfaceId, finalRowId);
      } catch (error) {
        console.error(`a2ui: could not settle surface ${surfaceId}`, error);
      }
    }
  });
}

/** Accepts an array, a JSON array string, or JSONL, because models produce all three. */
const messagesInput = z.union([z.array(z.unknown()), z.string()]);

function normaliseMessages(raw: unknown[] | string): unknown[] {
  if (Array.isArray(raw)) return raw;
  const text = raw.trim();
  if (text.startsWith("[")) return JSON.parse(text) as unknown[];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(message)"}: ${issue.message}`)
    .join("; ");
}

async function render(raw: unknown[] | string, agentId: string, paseo: Paseo) {
  let candidates: unknown[];
  try {
    candidates = normaliseMessages(raw);
  } catch (error) {
    return { isError: true, text: `messages is not valid JSON: ${(error as Error).message}` };
  }

  const errors: string[] = [];
  const messages: A2uiMessage[] = [];
  candidates.forEach((candidate, index) => {
    const parsed = messageSchema.safeParse(candidate);
    if (parsed.success) messages.push(parsed.data);
    else errors.push(`message ${index} is not a valid A2UI message: ${describeIssues(parsed.error)}`);
  });

  const state = await loadState(paseo, agentId);
  const before = new Map(state.surfaces);
  const applied = applyMessages(state.surfaces, messages);
  errors.push(...applied.errors);

  const rendered: string[] = [];
  const timeline = paseo.agents.ref(agentId).timeline;
  for (const surfaceId of applied.changed) {
    const snapshot = state.surfaces.get(surfaceId);
    if (!snapshot) continue;
    const bytes = snapshotBytes(snapshot);
    if (bytes > MAX_SNAPSHOT_BYTES) {
      errors.push(
        `surface "${surfaceId}" is ${bytes} bytes; the limit is ${MAX_SNAPSHOT_BYTES}. Split it into smaller surfaces or trim the data model.`,
      );
      const previous = before.get(surfaceId);
      if (previous) state.surfaces.set(surfaceId, previous);
      else state.surfaces.delete(surfaceId);
      continue;
    }
    let liveRowId = state.live.get(surfaceId);
    if (!liveRowId) {
      liveRowId = `live:${state.generation}:${surfaceId}`;
      state.live.set(surfaceId, liveRowId);
    }
    try {
      await timeline.append({ type: "plugin", id: liveRowId, kind: TIMELINE_KIND, version: TIMELINE_VERSION, data: snapshot });
      rendered.push(snapshot.deleted ? `${surfaceId} (deleted)` : `${surfaceId} (revision ${snapshot.revision})`);
    } catch (error) {
      errors.push(`surface "${surfaceId}" could not be shown: ${(error as Error).message}`);
    }
  }

  const lines = [
    rendered.length > 0 ? `Rendered: ${rendered.join(", ")}.` : "Nothing was rendered.",
    ...errors.map((e) => `Error: ${e}`),
    ...applied.warnings.map((w) => `Warning: ${w}`),
  ];
  if (rendered.length > 0) {
    lines.push(
      "The user sees the surface now. If it has buttons with event actions, their presses arrive as a later user message containing an <a2ui-action> block; end your turn rather than waiting.",
    );
  }
  return {
    text: lines.join("\n"),
    structuredContent: { rendered, errors, warnings: applied.warnings },
    isError: rendered.length === 0 && errors.length > 0,
  };
}

export const renderTool = defineAgentTool({
  name: RENDER_TOOL_NAME,
  title: "Render A2UI",
  description: RENDER_TOOL_DESCRIPTION,
  input: z.object({
    messages: messagesInput.describe("A2UI v1.0 agent-to-renderer messages, applied in order."),
  }),
  execute({ messages }, { agent, paseo }) {
    return exclusive(agent.id, () => render(messages, agent.id, paseo));
  },
});
