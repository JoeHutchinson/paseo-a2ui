import type { PluginServerContext } from "@getpaseo/plugin/server";
import { forgetAgent, renderTool, settleTurn } from "./server/render-tool";

const SYSTEM_HINT =
  "When a form, a choice between options, or a structured summary would serve the user better than prose, you can show interactive UI in the chat with the a2ui_render tool. Button presses come back to you as a user message containing an <a2ui-action> block.";

/** Set this label to "false" on an agent to keep the tool away from it. */
const OPT_OUT_LABEL = "a2ui/enabled";

export default function contribute(server: PluginServerContext) {
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.background || request.purpose !== "interactive") return;
    if (request.labels[OPT_OUT_LABEL] === "false") return;
    return {
      ...request,
      tools: [...request.tools, renderTool],
      appendSystemPrompt: [...(request.appendSystemPrompt ?? []), SYSTEM_HINT],
    };
  });
  server.addHook("agent.turn.after", async ({ agent }, { paseo }) => {
    await settleTurn(agent.id, paseo);
  });
  server.addHook("agent.archive.after", async ({ agent }) => {
    forgetAgent(agent.id);
  });
  return () => {};
}
