// @vitest-environment jsdom

/**
 * In the desktop shell an untouched accent is the OS accent and an untouched font the system face
 * (`effectiveAccent` / `effectiveMainFont`), so those options carry "(default)" there, not Lime and Sans.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => {
    return { native: false, systemAccent: false };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});
vi.mock("@/lib/native/use-native-capability", () => {
    return {
        useIsNativeShell: () => shell.native,
        useNativeCapability: (capability: string) => capability === "system-accent" && shell.systemAccent,
    };
});
vi.mock("@/lib/native/system-accent", () => {
    return { watchNativeSystemAccentColor: () => () => {} };
});
vi.mock("@/features/layout/hooks/use-ui-state", () => {
    const noop = (): void => {};

    return {
        useAppearanceSettings: () => {
            return {
                accentColor: "default",
                density: "comfortable",
                explicit: {},
                mainFont: "inter",
                setAccentColor: noop,
                setCapLongCodeBlocks: noop,
                setCodeHighlightTheme: noop,
                setCodeLineNumbers: noop,
                setContrast: noop,
                setDensity: noop,
                setMainFont: noop,
                setMermaidTheme: noop,
            };
        },
        useLayoutState: () => {
            return { fontSize: "medium", setFontSize: noop };
        },
    };
});

const { default: AppearanceControls } = await import("./appearance-controls");

describe("AppearanceControls default labels", () => {
    afterEach(() => {
        shell.native = false;
        shell.systemAccent = false;
    });

    it("marks Lime and Sans as the default in a browser", () => {
        render(<AppearanceControls />);

        expect(screen.getByText("Lime (default)")).toBeDefined();
        expect(screen.getByText("Sans (default)")).toBeDefined();
        expect(screen.getByText("System UI")).toBeDefined();
        expect(screen.queryByText("System (default)")).toBeNull();
    });

    it("marks the OS accent and the system font as the default in the shell", () => {
        shell.native = true;
        shell.systemAccent = true;
        render(<AppearanceControls />);

        expect(screen.getByText("System (default)")).toBeDefined();
        expect(screen.getByText("Lime")).toBeDefined();
        expect(screen.getByText("System UI (default)")).toBeDefined();
        expect(screen.getByText("Sans")).toBeDefined();
        expect(screen.queryByText("Lime (default)")).toBeNull();
        expect(screen.queryByText("Sans (default)")).toBeNull();
    });

    it("keeps Lime the default in a shell without the OS accent", () => {
        shell.native = true;
        render(<AppearanceControls />);

        expect(screen.getByText("Lime (default)")).toBeDefined();
        expect(screen.getByText("System UI (default)")).toBeDefined();
    });
});
