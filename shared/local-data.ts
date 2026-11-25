import { getAt, setAt, type Json } from "./pointer";

/**
 * The renderer's local data model: the agent's latest model plus the user's unsent edits.
 * When the agent sends a new model, an edit survives only if the agent left that path alone.
 */
export interface LocalData {
  base: Json;
  edits: Record<string, Json | undefined>;
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function rebase(local: LocalData, nextBase: Json): LocalData {
  const edits: Record<string, Json | undefined> = {};
  for (const [path, value] of Object.entries(local.edits)) {
    if (sameJson(getAt(local.base, path), getAt(nextBase, path))) edits[path] = value;
  }
  return { base: nextBase, edits };
}

export function withEdit(local: LocalData, path: string, value: Json | undefined): LocalData {
  const edits = { ...local.edits };
  // A new edit supersedes edits nested below it.
  for (const key of Object.keys(edits)) if (key.startsWith(`${path}/`)) delete edits[key];
  edits[path] = value;
  return { base: local.base, edits };
}

export function materialise(local: LocalData): Json {
  let data = local.base;
  for (const path of Object.keys(local.edits).sort((a, b) => a.length - b.length)) {
    data = setAt(data, path, local.edits[path]);
  }
  return data;
}
