import { LunoraError } from "lunorash/server";

import { env } from "cloudflare:workers";

/**
 * The server-side feature gate for plugins. Each feature has an allowlist of user ids in a variable (comma-separated;
 * `*` alone means every signed-in user); unset or empty means off. `PLUGINS_KILL_SWITCH=on` turns every feature off.
 */
export type PluginFeature = "plugin-authoring" | "plugin-services" | "plugin-ui" | "plugins";

const ALLOWLIST_VARIABLE: Record<PluginFeature, string> = {
    "plugin-authoring": "PLUGIN_AUTHORING_ALLOWED_USERS",
    "plugin-services": "PLUGIN_SERVICES_ALLOWED_USERS",
    "plugin-ui": "PLUGIN_UI_ALLOWED_USERS",
    plugins: "PLUGINS_ALLOWED_USERS",
};

/** The Worker's own `env` first (a bound variable), then `process.env`, which a Worker may or may not carry. */
const read = (name: string): string => {
    const bound = (env as Record<string, unknown>)[name];
    const value = typeof bound === "string" ? bound : process.env[name];

    return value?.trim() ?? "";
};

/** Whether the kill switch is on: every plugin feature is off, whatever the allowlists say. */
export const pluginKillSwitch = (): boolean => read("PLUGINS_KILL_SWITCH").toLowerCase() === "on";

export const pluginFeatureOn = (userId: string, feature: PluginFeature): boolean => {
    if (pluginKillSwitch()) {
        return false;
    }

    const list = read(ALLOWLIST_VARIABLE[feature]);

    if (list === "*") {
        return true;
    }

    return userId !== "" && list.split(",").some((entry) => entry.trim() === userId);
};

/** Refuses the call unless the account is on the feature's allowlist. */
export const requirePluginFeature = (userId: string, feature: PluginFeature): void => {
    if (!pluginFeatureOn(userId, feature)) {
        throw new LunoraError("FORBIDDEN", "Plugins are not available for this account yet");
    }
};
