import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { HTMLProps, ReactNode } from "react";
import { createContext, use, useMemo } from "react";

import cn from "../utils/cn";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

/*
Example Usage:

<ShortcutsProvider os="mac">
  <h3 className="font-semibold">Keyboard Shortcuts</h3>
  <div className="flex justify-between">
    <p>Undo</p>
    <KeyCombo keyNames={[Keys.Command, "z"]} />
  </div>
  <div className="flex justify-between">
    <p>Redo</p>
    <KeyCombo keyNames={[Keys.Command, Keys.Shift, "z"]} />
  </div>
  <div className="flex justify-between">
    <p>Clear Selection</p>
    <KeySymbol keyName={Keys.Escape} />
  </div>
</ShortcutsProvider>;
*/

interface KeyData {
    /** A descriptor for a descriptive name ("Arrow Down"); a plain string for a key's own name ("Shift"). */
    label: string | MessageDescriptor;
    symbols: {
        default: string;
        mac?: string;
        windows?: string;
    };
}

/**
 * Key identifiers used by {@link KeyCombo} and {@link KeySymbol}.
 *
 * A frozen object rather than an `enum` so this file's only type-level export
 * is a component's — `react-refresh/only-export-components` counts an `enum` as
 * a non-component export even when the name is allow-listed.
 */
export const Keys = {
    Alt: "Alt",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    ArrowUp: "ArrowUp",
    Backspace: "Backspace",
    CapsLock: "CapsLock",
    Command: "Command",
    Control: "Control",
    Delete: "Delete",
    End: "End",
    Enter: "Enter",
    Escape: "Escape",
    Function_: "Fn",
    Home: "Home",
    Insert: "Insert",
    PageDown: "PageDown",
    PageUp: "PageUp",
    Pause: "Pause",
    PrintScreen: "PrintScreen",
    Shift: "Shift",
    Space: "Space",
    Tab: "Tab",
} as const;

const DEFAULT_KEY_MAPPINGS: Record<string, KeyData> = {
    [Keys.Alt]: {
        label: "Alt/Option",
        symbols: { default: "Alt", mac: "⌥" },
    },
    [Keys.ArrowDown]: {
        label: msg`Arrow Down`,
        symbols: { default: "↓" },
    },
    [Keys.ArrowLeft]: {
        label: msg`Arrow Left`,
        symbols: { default: "←" },
    },
    [Keys.ArrowRight]: {
        label: msg`Arrow Right`,
        symbols: { default: "→" },
    },
    [Keys.ArrowUp]: {
        label: msg`Arrow Up`,
        symbols: { default: "↑" },
    },
    [Keys.Backspace]: {
        label: "Backspace",
        symbols: { default: "⟵", mac: "⌫" },
    },
    [Keys.CapsLock]: {
        label: msg`Caps Lock`,
        symbols: { default: "⇪" },
    },
    [Keys.Command]: {
        label: "Command",
        symbols: { default: "Command", mac: "⌘", windows: "⊞ Win" },
    },
    [Keys.Control]: {
        label: "Control",
        symbols: { default: "Ctrl", mac: "⌃" },
    },
    [Keys.Delete]: {
        label: "Delete",
        symbols: { default: "Del", mac: "⌦" },
    },
    [Keys.End]: {
        label: "End",
        symbols: { default: "End", mac: "↘" },
    },
    [Keys.Enter]: {
        label: "Enter",
        symbols: { default: "↵", mac: "↩" },
    },
    [Keys.Escape]: {
        label: "Escape",
        symbols: { default: "Esc", mac: "⎋" },
    },
    [Keys.Function_]: {
        label: "Fn",
        symbols: { default: "Fn" }, // mac symbol for Fn not universally recognized
    },
    [Keys.Home]: {
        label: "Home",
        symbols: { default: "Home", mac: "↖" },
    },
    [Keys.Insert]: {
        label: "Insert",
        symbols: { default: "Ins" },
    },
    [Keys.PageDown]: {
        label: msg`Page Down`,
        symbols: { default: "PgDn", mac: "⇟" },
    },
    [Keys.PageUp]: {
        label: msg`Page Up`,
        symbols: { default: "PgUp", mac: "⇞" },
    },
    [Keys.Pause]: {
        label: "Pause/Break",
        symbols: { default: "Pause", mac: "⎉" },
    },
    [Keys.PrintScreen]: {
        label: msg`Print Screen`,
        symbols: { default: "PrtSc" },
    },
    [Keys.Shift]: {
        label: "Shift",
        symbols: { default: "Shift", mac: "⇧" },
    },
    [Keys.Space]: {
        label: msg`Space`,
        symbols: { default: "␣" },
    },
    [Keys.Tab]: {
        label: "Tab",
        symbols: { default: "⭾", mac: "⇥" },
    },
};

interface ShortcutsContextData {
    keyMappings: Record<string, KeyData>;
    os: "mac" | "windows";
}

const ShortcutsContext = createContext<ShortcutsContextData>({
    keyMappings: DEFAULT_KEY_MAPPINGS,
    os: "mac",
});

const useShortcutsContext = () => use(ShortcutsContext);

interface ShortcutsProviderProperties {
    children: ReactNode;
    keyMappings?: Record<
        string,
        {
            label?: string;
            symbols?: {
                default?: string;
                mac?: string;
                windows?: string;
            };
        }
    >;
    os?: ShortcutsContextData["os"];
}

const EMPTY_KEY_MAPPINGS: NonNullable<ShortcutsProviderProperties["keyMappings"]> = {};

export const ShortcutsProvider = ({ children, keyMappings = EMPTY_KEY_MAPPINGS, os }: ShortcutsProviderProperties) => {
    const resolvedOs = os ?? detectOS();

    const contextValue = useMemo(() => {
        return { keyMappings: defaultsDeep({}, keyMappings, DEFAULT_KEY_MAPPINGS), os: resolvedOs };
    }, [keyMappings, resolvedOs]);

    return (
        <TooltipProvider>
            <ShortcutsContext value={contextValue}>{children}</ShortcutsContext>
        </TooltipProvider>
    );
};

interface KeySymbolProperties extends HTMLProps<HTMLDivElement> {
    disableTooltip?: boolean;
    keyName: string;
}

export const KeySymbol = ({ className, disableTooltip = false, keyName, ...otherProperties }: KeySymbolProperties) => {
    const { i18n } = useLingui();
    const context = useShortcutsContext();
    const { keyMappings } = context;
    const os = context.os || "default";
    const keyData = keyMappings[keyName];
    const symbol = keyData?.symbols?.[os] ?? keyData?.symbols?.default ?? keyName;
    const rawLabel = keyData?.label ?? keyName;
    const label = typeof rawLabel === "string" ? rawLabel : i18n._(rawLabel);

    return (
        <Tooltip delayDuration={300}>
            <TooltipTrigger>
                <div
                    className={cn(
                        "border-foreground/20 text-foreground/50 flex h-5 w-fit min-w-[1.25rem] items-center justify-center rounded-md border px-1 text-xs",
                        className,
                    )}
                    {...otherProperties}
                >
                    <span>{symbol}</span>
                </div>
            </TooltipTrigger>
            {!disableTooltip && label !== symbol && <TooltipContent className="px-2 py-1">{label}</TooltipContent>}
        </Tooltip>
    );
};

interface KeyComboProperties extends HTMLProps<HTMLDivElement> {
    disableTooltips?: boolean;
    keyNames: string[];
}

export const KeyCombo = ({ className, disableTooltips = false, keyNames, ...otherProperties }: KeyComboProperties) => (
    <div className={cn("flex gap-1", className)} {...otherProperties}>
        {keyNames.map((keyName) => (
            <KeySymbol disableTooltip={disableTooltips} key={keyName} keyName={keyName} />
        ))}
    </div>
);

// Simple utility to merge objects deeply (replaces lodash.defaultsdeep)
const defaultsDeep = (target: any, ...sources: any[]): any => {
    if (sources.length === 0) {
        return target;
    }

    const source = sources.shift();

    if (isObject(target) && isObject(source)) {
        for (const [key, value] of Object.entries(source)) {
            if (isObject(value)) {
                if (!target[key]) Object.assign(target, { [key]: {} });

                defaultsDeep(target[key], value);
            } else {
                Object.assign(target, { [key]: value });
            }
        }
    }

    return defaultsDeep(target, ...sources);
};

const isObject = (item: any): boolean => item && typeof item === "object" && !Array.isArray(item);

// Utility to detect OS
const detectOS = (): "mac" | "windows" => {
    if (globalThis.window === undefined) {
        return "mac"; // Default for SSR;
    }

    const platform = navigator.platform.toLowerCase();

    return platform.includes("mac") ? "mac" : "windows";
};
