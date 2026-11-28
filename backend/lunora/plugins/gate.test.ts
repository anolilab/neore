import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pluginFeatureOn, pluginKillSwitch, requirePluginFeature } from "./gate";

const variables = env as Record<string, string | undefined>;
const NAMES = ["PLUGINS_ALLOWED_USERS", "PLUGIN_UI_ALLOWED_USERS", "PLUGIN_SERVICES_ALLOWED_USERS", "PLUGIN_AUTHORING_ALLOWED_USERS", "PLUGINS_KILL_SWITCH"];

describe("plugin feature gate", () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const name of NAMES) {
            saved[name] = variables[name];
            delete variables[name];
        }
    });

    afterEach(() => {
        for (const name of NAMES) {
            if (saved[name] === undefined) {
                delete variables[name];
            } else {
                variables[name] = saved[name];
            }
        }
    });

    it("is off when nothing is set or the list is empty", () => {
        expect(pluginFeatureOn("u1", "plugins")).toBe(false);
        variables.PLUGINS_ALLOWED_USERS = "  ";
        expect(pluginFeatureOn("u1", "plugins")).toBe(false);
        expect(() => requirePluginFeature("u1", "plugins")).toThrow("Plugins are not available for this account yet");
    });

    it("allows only listed users, with whitespace trimmed", () => {
        variables.PLUGINS_ALLOWED_USERS = " u1 , u2,";
        expect(pluginFeatureOn("u1", "plugins")).toBe(true);
        expect(pluginFeatureOn("u2", "plugins")).toBe(true);
        expect(pluginFeatureOn("u3", "plugins")).toBe(false);
        expect(pluginFeatureOn("", "plugins")).toBe(false);
        expect(() => requirePluginFeature("u3", "plugins")).toThrow();
        expect(() => requirePluginFeature("u1", "plugins")).not.toThrow();
    });

    it("lets every user in on `*`", () => {
        variables.PLUGINS_ALLOWED_USERS = "*";
        expect(pluginFeatureOn("anyone", "plugins")).toBe(true);
    });

    it("keeps each feature on its own list", () => {
        variables.PLUGINS_ALLOWED_USERS = "u1";
        variables.PLUGIN_UI_ALLOWED_USERS = "u2";
        variables.PLUGIN_SERVICES_ALLOWED_USERS = "u3";
        variables.PLUGIN_AUTHORING_ALLOWED_USERS = "*";
        expect(pluginFeatureOn("u1", "plugin-ui")).toBe(false);
        expect(pluginFeatureOn("u2", "plugin-ui")).toBe(true);
        expect(pluginFeatureOn("u2", "plugins")).toBe(false);
        expect(pluginFeatureOn("u3", "plugin-services")).toBe(true);
        expect(pluginFeatureOn("u9", "plugin-authoring")).toBe(true);
    });

    it("turns every feature off under the kill switch", () => {
        variables.PLUGINS_ALLOWED_USERS = "*";
        variables.PLUGIN_AUTHORING_ALLOWED_USERS = "u1";
        variables.PLUGINS_KILL_SWITCH = "on";
        expect(pluginKillSwitch()).toBe(true);
        expect(pluginFeatureOn("u1", "plugins")).toBe(false);
        expect(pluginFeatureOn("u1", "plugin-authoring")).toBe(false);
        variables.PLUGINS_KILL_SWITCH = "off";
        expect(pluginKillSwitch()).toBe(false);
        expect(pluginFeatureOn("u1", "plugins")).toBe(true);
    });
});
