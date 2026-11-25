import { z } from "zod";
import { setAt, type Json } from "./pointer";
import { compileSafePattern } from "./regex-safety";

export const BASIC_CATALOG_ID = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";

export const TIMELINE_KIND = "a2ui-surface";
export const TIMELINE_VERSION = 1;
/**
 * A surface row that no longer shows the surface: "moved" for a mid-turn row whose final state
 * was re-appended after the reply, "superseded" for an older copy replaced by a later turn.
 */
export const MOVED_KIND = "a2ui-moved";
export const movedSchema = z.object({
  surfaceId: z.string(),
  reason: z.enum(["moved", "superseded"]).optional(),
});
/** Paseo rejects plugin timeline rows above 64 KiB; keep headroom for the envelope. */
export const MAX_SNAPSHOT_BYTES = 60 * 1024;

const json: z.ZodType<Json> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(json), z.record(z.string(), json)]),
);

export const componentSchema = z
  .object({
    id: z.string().min(1),
    component: z.string().min(1),
  })
  .catchall(json);
export type A2uiComponent = z.output<typeof componentSchema>;

const surfaceId = z.string().min(1).max(128);

export const messageSchema = z.union([
  z.object({
    version: z.string().optional(),
    createSurface: z.object({
      surfaceId,
      catalogId: z.string().optional(),
      sendDataModel: z.boolean().optional(),
      components: z.array(componentSchema).optional(),
      dataModel: json.optional(),
      metadata: json.optional(),
    }),
  }),
  z.object({
    version: z.string().optional(),
    updateComponents: z.object({ surfaceId, components: z.array(componentSchema) }),
  }),
  z.object({
    version: z.string().optional(),
    // value is required by the spec; only an explicit null deletes.
    updateDataModel: z.object({ surfaceId, path: z.string().optional(), value: json }),
  }),
  z.object({
    version: z.string().optional(),
    deleteSurface: z.object({ surfaceId }),
  }),
]);
export type A2uiMessage = z.output<typeof messageSchema>;

/** The renderer payload stored in one Paseo timeline row per surface. */
export const surfaceSnapshotSchema = z.object({
  surfaceId: z.string(),
  catalogId: z.string().optional(),
  sendDataModel: z.boolean(),
  components: z.record(z.string(), componentSchema),
  dataModel: json,
  revision: z.number().int(),
  deleted: z.boolean(),
});
export type SurfaceSnapshot = z.output<typeof surfaceSnapshotSchema>;

export interface ApplyResult {
  /** Surfaces whose snapshot changed, in first-touched order. */
  changed: string[];
  errors: string[];
  warnings: string[];
}

/**
 * Applies agent-to-renderer messages to a surface map in place. Returns which surfaces changed
 * and any problems worth reporting back to the agent.
 */
export function applyMessages(
  surfaces: Map<string, SurfaceSnapshot>,
  messages: A2uiMessage[],
): ApplyResult {
  const changed: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const touch = (id: string) => {
    if (!changed.includes(id)) changed.push(id);
  };

  messages.forEach((message, index) => {
    const where = `message ${index}`;
    if ("createSurface" in message) {
      const m = message.createSurface;
      const previous = surfaces.get(m.surfaceId);
      if (previous && !previous.deleted) {
        warnings.push(
          `${where}: surface "${m.surfaceId}" already existed; it was replaced. Use updateComponents/updateDataModel to change an existing surface.`,
        );
      }
      const components: Record<string, A2uiComponent> = {};
      for (const c of m.components ?? []) components[c.id] = c;
      surfaces.set(m.surfaceId, {
        surfaceId: m.surfaceId,
        catalogId: m.catalogId,
        sendDataModel: m.sendDataModel ?? false,
        components,
        dataModel: m.dataModel ?? {},
        revision: (previous?.revision ?? 0) + 1,
        deleted: false,
      });
      touch(m.surfaceId);
      return;
    }

    const id =
      "updateComponents" in message
        ? message.updateComponents.surfaceId
        : "updateDataModel" in message
          ? message.updateDataModel.surfaceId
          : message.deleteSurface.surfaceId;
    const surface = surfaces.get(id);
    if (!surface || surface.deleted) {
      errors.push(
        `${where}: surface "${id}" does not exist (or was deleted). Send createSurface first.`,
      );
      return;
    }

    if ("updateComponents" in message) {
      const components = { ...surface.components };
      for (const c of message.updateComponents.components) components[c.id] = c;
      surfaces.set(id, { ...surface, components, revision: surface.revision + 1 });
    } else if ("updateDataModel" in message) {
      const { path, value } = message.updateDataModel;
      const dataModel = setAt(surface.dataModel, path ?? "/", value === null ? undefined : value);
      // A value of undefined cannot reach here: the schema requires it.
      surfaces.set(id, { ...surface, dataModel, revision: surface.revision + 1 });
    } else {
      surfaces.set(id, { ...surface, deleted: true, revision: surface.revision + 1 });
    }
    touch(id);
  });

  for (const id of changed) {
    const surface = surfaces.get(id);
    if (!surface || surface.deleted) continue;
    warnings.push(...checkStructure(surface));
  }
  return { changed, errors, warnings };
}

const KNOWN_COMPONENTS = new Set([
  "Text", "Image", "Icon", "Video", "AudioPlayer", "Row", "Column", "List", "Card", "Tabs",
  "Divider", "Modal", "Button", "CheckBox", "TextField", "DateTimeInput", "ChoicePicker", "Slider",
]);

export function childRefs(component: A2uiComponent): string[] {
  const refs: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string") refs.push(v);
  };
  add(component.child);
  add(component.trigger);
  add(component.content);
  const children = component.children;
  if (Array.isArray(children)) children.forEach(add);
  else if (children && typeof children === "object" && !Array.isArray(children)) {
    add((children as Record<string, unknown>).componentId);
  }
  if (Array.isArray(component.tabs)) {
    for (const tab of component.tabs) {
      if (tab && typeof tab === "object" && !Array.isArray(tab)) add((tab as Record<string, unknown>).child);
    }
  }
  return refs;
}

function checkStructure(surface: SurfaceSnapshot): string[] {
  const warnings: string[] = [];
  const s = `surface "${surface.surfaceId}"`;
  if (!surface.components.root) {
    warnings.push(`${s}: no component with id "root" yet, so nothing renders.`);
  }
  for (const component of Object.values(surface.components)) {
    if (!KNOWN_COMPONENTS.has(component.component)) {
      warnings.push(`${s}: component "${component.id}" has unknown type "${component.component}".`);
    }
    if (component.component === "Slider" && typeof component.steps === "number") {
      const min = typeof component.min === "number" ? component.min : 0;
      const max = typeof component.max === "number" ? component.max : min;
      if (component.steps < 2 && max - min > 1) {
        warnings.push(
          `${s}: Slider "${component.id}" has steps ${component.steps}, so it can only be ${min} or ${max}. steps is the number of divisions; use ${max - min} for whole numbers or omit it.`,
        );
      }
    }
    for (const pattern of regexPatterns(component)) {
      const compiled = compileSafePattern(pattern);
      if (!compiled.ok) {
        warnings.push(
          `${s}: component "${component.id}" uses regex ${JSON.stringify(pattern)}, which the renderer rejects (${compiled.reason}); that check always fails. Use simpler, non-nested quantifiers.`,
        );
      }
    }
    for (const ref of childRefs(component)) {
      if (!surface.components[ref]) {
        warnings.push(`${s}: component "${component.id}" references missing component "${ref}".`);
      }
    }
  }
  return warnings;
}

/** Literal patterns of every `regex` call anywhere inside a component. */
function regexPatterns(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) regexPatterns(v, found);
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj["@call"] === "regex" && obj.args && typeof obj.args === "object") {
      const pattern = (obj.args as Record<string, unknown>).pattern;
      if (typeof pattern === "string") found.push(pattern);
    }
    for (const v of Object.values(obj)) regexPatterns(v, found);
  }
  return found;
}

export function snapshotBytes(snapshot: SurfaceSnapshot): number {
  return new TextEncoder().encode(JSON.stringify(snapshot)).length;
}

/** The text an A2UI `action` turns into when sent back to the agent as a prompt. */
export function formatActionPrompt(action: {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  timestamp: string;
  userMessage?: string;
  context: Record<string, unknown>;
  dataModel?: unknown;
}): string {
  const { userMessage, dataModel, ...rest } = action;
  const envelope: Record<string, unknown> = {
    version: "1.0",
    action: userMessage ? { ...rest, userMessage } : rest,
  };
  if (dataModel !== undefined) envelope.metadata = { a2uiClientDataModel: dataModel };
  const heading = userMessage ? userMessage : `Pressed "${action.name}" on ${action.surfaceId}`;
  const summary = summariseContext(action.context);
  const visible = summary ? `${heading}\n${summary}` : heading;
  return `${visible}\n\n<a2ui-action>\n${JSON.stringify(envelope, null, 2)}\n</a2ui-action>`;
}

function summariseValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (Array.isArray(value)) return value.length ? value.map(summariseValue).join(", ") : "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** One readable line of the action context for the chat bubble; the JSON block stays canonical. */
export function summariseContext(context: Record<string, unknown>, limit = 240): string {
  const text = Object.entries(context)
    .map(([key, value]) => `${key}: ${summariseValue(value)}`)
    .join(" · ");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
