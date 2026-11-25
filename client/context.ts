import type { PluginHostProps } from "@getpaseo/plugin/client";
import { createContext, useContext } from "react";
import type { EvalScope } from "../shared/expr";
import type { Json } from "../shared/pointer";
import type { A2uiComponent, SurfaceSnapshot } from "../shared/protocol";

export interface SurfaceContextValue {
  snapshot: SurfaceSnapshot;
  data: Json;
  setValue(path: string, value: Json | undefined): void;
  theme: PluginHostProps["theme"];
  layout: PluginHostProps["layout"];
  /** Dispatches a Button action. Resolves once an event reached the agent. */
  dispatch(component: A2uiComponent, scope: EvalScope): Promise<void>;
  /** Event names already sent from this surface in this client session. */
  sending: string | null;
}

export const SurfaceContext = createContext<SurfaceContextValue | null>(null);

export function useSurface(): SurfaceContextValue {
  const value = useContext(SurfaceContext);
  if (!value) throw new Error("A2UI component rendered outside a surface");
  return value;
}

/** Text colour override for content drawn on an accent fill (primary buttons). */
export const TextColorContext = createContext<string | null>(null);

/** When set, a Button inside a Modal trigger opens the modal instead of running its action. */
export const TriggerContext = createContext<(() => void) | null>(null);
