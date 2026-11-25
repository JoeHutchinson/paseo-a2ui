import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text } from "react-native";
import { z } from "zod";
import { MOVED_KIND, movedSchema, surfaceSnapshotSchema, TIMELINE_KIND, TIMELINE_VERSION } from "./shared/protocol";
import { SurfaceTimelineItem } from "./client/surface";
import { PENDING_KIND, transformRenderToolCall } from "./client/transform";

function PendingRow({ theme }: PluginTimelineItemProps<Record<string, never>>) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginVertical: 4 }}>Building interface…</Text>;
}

/** A moved row's surface sits right below the reply, so it draws nothing; a superseded one says so. */
function MovedRow({ theme, item }: PluginTimelineItemProps<z.output<typeof movedSchema>>) {
  if (item.data.reason !== "superseded") return null;
  return (
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginVertical: 4 }}>
      This interface was updated later in the conversation.
    </Text>
  );
}

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addTimelineRenderer({
      kind: TIMELINE_KIND,
      version: TIMELINE_VERSION,
      schema: surfaceSnapshotSchema,
      Component: SurfaceTimelineItem,
    }),
    client.addTimelineRenderer({
      kind: PENDING_KIND,
      version: 1,
      schema: z.object({}).strict(),
      Component: PendingRow,
    }),
    client.addTimelineRenderer({
      kind: MOVED_KIND,
      version: 1,
      schema: movedSchema,
      Component: MovedRow,
    }),
    client.addTimelineTransformer({
      id: "hide-render-tool-call",
      query: { itemType: "tool_call" },
      transform: ({ item }) => transformRenderToolCall(item),
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
