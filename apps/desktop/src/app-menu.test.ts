import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { AppMenuOptions } from "./app-menu.js";
import { buildAppMenuTemplate } from "./app-menu.js";

const build = (options: Partial<AppMenuOptions> = {}): MenuItemConstructorOptions[] =>
    buildAppMenuTemplate({ appName: "Neore", isPackaged: true, onCommand: () => {}, platform: "darwin", ...options });

const submenuOf = (template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] =>
    (template.find((entry) => entry.label === label || entry.role === label)?.submenu ?? []) as MenuItemConstructorOptions[];

const click = (item: MenuItemConstructorOptions | undefined): void => item?.click?.(undefined as never, undefined, undefined as never);

const roles = (items: MenuItemConstructorOptions[]): (string | undefined)[] => items.map((item) => item.role ?? item.label ?? item.type);

describe(buildAppMenuTemplate, () => {
    it("gives macOS the app menu with Settings, Services and the hide items", () => {
        const template = build();

        expect(template.map((entry) => entry.label ?? entry.role)).toStrictEqual(["Neore", "File", "Edit", "View", "window"]);
        expect(roles(submenuOf(template, "Neore"))).toStrictEqual([
            "about",
            "separator",
            "Settings…",
            "separator",
            "services",
            "separator",
            "hide",
            "hideOthers",
            "unhide",
            "separator",
            "quit",
        ]);
        expect(roles(submenuOf(template, "window"))).toStrictEqual(["minimize", "zoom", "separator", "front"]);
    });

    it("moves Settings and Quit into File elsewhere, and has no app menu", () => {
        const template = build({ platform: "win32" });
        const file = submenuOf(template, "File");

        expect(template.map((entry) => entry.label ?? entry.role)).toStrictEqual(["File", "Edit", "View", "window"]);
        expect(roles(file)).toStrictEqual(["New Chat", "separator", "Settings…", "separator", "close", "quit"]);
        expect(roles(submenuOf(template, "window"))).toStrictEqual(["minimize"]);
    });

    it("sends New Chat and Settings as commands, with their accelerators", () => {
        const onCommand = vi.fn();
        const template = build({ onCommand });
        const newChat = submenuOf(template, "File")[0];
        const settings = submenuOf(template, "Neore")[2];

        click(newChat);
        click(settings);

        expect(newChat?.accelerator).toBe("CmdOrCtrl+N");
        expect(settings?.accelerator).toBe("CmdOrCtrl+,");
        expect(onCommand.mock.calls).toStrictEqual([["new-chat"], ["settings"]]);
    });

    it("only shows New Chat's accelerator, which the site handles itself, and registers Settings'", () => {
        for (const platform of ["darwin", "linux", "win32"] as const) {
            const template = build({ platform });
            const settings = [...submenuOf(template, "Neore"), ...submenuOf(template, "File")].find((item) => item.label === "Settings…");

            expect(submenuOf(template, "File")[0]?.registerAccelerator, platform).toBe(false);
            expect(settings?.registerAccelerator, platform).toBeUndefined();
        }
    });

    it("keeps reload and the developer tools out of a packaged build", () => {
        const packaged = roles(submenuOf(build(), "View"));
        const development = roles(submenuOf(build({ isPackaged: false }), "View"));

        expect(packaged).not.toContain("toggleDevTools");
        expect(development).toEqual(expect.arrayContaining(["reload", "forceReload", "toggleDevTools"]));
    });

    it("has the standard edit roles", () => {
        const edit = roles(submenuOf(build(), "Edit"));

        expect(edit).toEqual(expect.arrayContaining(["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll"]));
    });

    it("adds Help only with a docs link", () => {
        const onOpenDocumentation = vi.fn();

        expect(build().some((entry) => entry.role === "help")).toBe(false);

        click(submenuOf(build({ onOpenDocumentation }), "help")[0]);
        expect(onOpenDocumentation).toHaveBeenCalledOnce();
    });
});
