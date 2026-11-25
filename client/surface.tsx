import { getPaseoClient, usePaseo, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Linking, Text, View } from "react-native";
import { resolve, resolveContext, toText, tryResolve, type EvalScope } from "../shared/expr";
import { materialise, rebase, sameJson, withEdit, type LocalData } from "../shared/local-data";
import type { Json } from "../shared/pointer";
import { formatActionPrompt, type A2uiComponent, type SurfaceSnapshot } from "../shared/protocol";
import { SurfaceContext, type SurfaceContextValue } from "./context";
import { Node } from "./node";

/** Unsent user edits, kept per client so scrolling a surface out of view does not lose them. */
const localCache = new Map<string, LocalData>();

function useLocalData(key: string, base: Json) {
  const [local, setLocal] = useState<LocalData>(() => {
    const cached = localCache.get(key);
    return cached ? rebase(cached, base) : { base, edits: {} };
  });
  let current = local;
  if (local.base !== base && !sameJson(local.base, base)) {
    current = rebase(local, base);
    setLocal(current);
  }
  useEffect(() => {
    localCache.set(key, current);
  }, [key, current]);
  const data = useMemo(() => materialise(current), [current]);
  return {
    data,
    setValue(path: string, value: Json | undefined) {
      setLocal((prev) => withEdit(prev, path, value));
    },
  };
}

export function SurfaceTimelineItem({ agentId, item, theme, layout, host }: PluginTimelineItemProps<SurfaceSnapshot>) {
  const snapshot = item.data;
  const toast = useToast();
  const fallbackPaseo = usePaseo();
  const { data, setValue } = useLocalData(`${host.id}:${agentId}:${snapshot.surfaceId}`, snapshot.dataModel);
  const [sending, setSending] = useState<string | null>(null);

  const value: SurfaceContextValue = {
    snapshot,
    data,
    setValue,
    theme,
    layout,
    sending,
    async dispatch(component: A2uiComponent, scope: EvalScope) {
      const action = component.action as
        | { event?: { name?: unknown; userMessage?: unknown; context?: unknown }; functionCall?: unknown }
        | undefined;
      if (!action) return;
      if (action.functionCall) {
        try {
          resolve(action.functionCall, { ...scope, onOpenUrl: (url) => void Linking.openURL(url) });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      const event = action.event;
      if (!event || typeof event.name !== "string") return;
      const text = formatActionPrompt({
        name: event.name,
        surfaceId: snapshot.surfaceId,
        sourceComponentId: component.id,
        timestamp: new Date().toISOString(),
        userMessage: toText(tryResolve(event.userMessage, scope, "")) || undefined,
        context: resolveContext(
          event.context && typeof event.context === "object" ? (event.context as Record<string, unknown>) : undefined,
          scope,
        ),
        dataModel: snapshot.sendDataModel ? data : undefined,
      });
      setSending(event.name);
      try {
        let agentRef: { send(text: string): Promise<void> } = fallbackPaseo.agents.ref(agentId);
        try {
          agentRef = getPaseoClient(host.id).agents.ref(agentId);
        } catch {
          // Older hosts identify the connection differently; the selected host is the agent's host.
        }
        await agentRef.send(text);
        toast.show("Sent to the agent", { variant: "success" });
      } catch (error) {
        toast.error(`Could not send: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setSending(null);
      }
    },
  };

  const frame = {
    alignSelf: "stretch" as const,
    maxWidth: layout.compact ? undefined : 720,
    marginVertical: 6,
    gap: 6,
  };

  if (snapshot.deleted) {
    return (
      <View style={[frame, { flexDirection: "row", alignItems: "center", gap: 6 }]}>
        <Icon name="PanelTopClose" size={14} color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>The agent closed this interface.</Text>
      </View>
    );
  }

  return (
    <SurfaceContext.Provider value={value}>
      <View style={frame} testID="a2ui-surface">
        {snapshot.components.root ? (
          <Node id="root" scope={{ data, scope: "/" }} depth={0} ancestry={[]} />
        ) : (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Waiting for the interface…</Text>
        )}
      </View>
    </SurfaceContext.Provider>
  );
}
