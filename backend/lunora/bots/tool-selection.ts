/**
 * A bot's tool selection applied to a run's tools. The selector rules are in `tool-selectors.ts` (shared with the web
 * app). The selection only removes tools from a run's set: whatever org policy, connector access and the permission
 * mode removed stays removed.
 */
import type { ToolSet } from "ai";

import { applyToolAllowlist } from "../sub-agents/logic";
import type { BotToolSelection, ToolOrigin } from "./tool-selectors";
import { selectionKeeps } from "./tool-selectors";

/**
 * Narrows a run's tools to the bot's selection, through the same filter a sub-agent's allowlist uses: it only ever
 * removes. `originOf` gives a server tool's origin by its runtime name, `undefined` for a built-in.
 */
export const applyBotToolSelection = (
    tools: ToolSet,
    selection: BotToolSelection | null | undefined,
    originOf: (name: string) => ToolOrigin | undefined,
): ToolSet =>
    selection
        ? applyToolAllowlist(
              tools,
              Object.keys(tools).filter((name) => selectionKeeps(selection, name, originOf(name))),
          )
        : tools;
