"use client";

import type { RiveParameters } from "@rive-app/react-webgl2";
import { useRive, useViewModel, useViewModelInstance, useViewModelInstanceColor } from "@rive-app/react-webgl2";
import cn from "@ui/utils/cn";
import type { FC, ReactNode } from "react";
import { memo, useEffect, useRef, useState } from "react";

export type PersonaState = "idle" | "listening" | "thinking" | "speaking" | "asleep";

interface PersonaProps {
    className?: string;
    onLoad?: RiveParameters["onLoad"];
    onLoadError?: RiveParameters["onLoadError"];
    onPause?: RiveParameters["onPause"];
    onPlay?: RiveParameters["onPlay"];
    onReady?: () => void;
    onStop?: RiveParameters["onStop"];
    state: PersonaState;
    variant?: keyof typeof sources;
}

// The state machine name is always 'default' for Elements AI visuals
const stateMachine = "default";

/** The machine's boolean inputs, one per non-idle state; the one matching `state` is on, the rest off (all off when idle). */
const PERSONA_STATE_INPUTS: ReadonlySet<string> = new Set<PersonaState>(["asleep", "listening", "speaking", "thinking"]);

const sources = {
    command: {
        dynamicColor: true,
        hasModel: true,
        source: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/command-2.0.riv",
    },
    glint: {
        dynamicColor: true,
        hasModel: true,
        source: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/glint-2.0.riv",
    },
    halo: {
        dynamicColor: true,
        hasModel: true,
        source: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/halo-2.0.riv",
    },
    mana: {
        dynamicColor: false,
        hasModel: true,
        source: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/mana-2.0.riv",
    },
    obsidian: {
        dynamicColor: true,
        hasModel: true,
        source: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/obsidian-2.0.riv",
    },
    opal: {
        dynamicColor: false,
        hasModel: false,
        source: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/orb-1.2.riv",
    },
};

const getCurrentTheme = (): "light" | "dark" => {
    if (typeof window !== "undefined") {
        if (document.documentElement.classList.contains("dark")) {
            return "dark";
        }

        if (globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches) {
            return "dark";
        }
    }

    return "light";
};

const useTheme = (enabled: boolean) => {
    const [theme, setTheme] = useState<"light" | "dark">(getCurrentTheme);

    useEffect(() => {
        // Skip if not enabled (avoids unnecessary observers for non-dynamic-color variants)
        if (!enabled) {
            return undefined;
        }

        // Watch for classList changes
        const observer = new MutationObserver(() => {
            setTheme(getCurrentTheme());
        });

        observer.observe(document.documentElement, {
            attributeFilter: ["class"],
            attributes: true,
        });

        // Watch for OS-level theme changes
        let mql: MediaQueryList | null = null;
        const handleMediaChange = () => {
            setTheme(getCurrentTheme());
        };

        if (typeof matchMedia === "function") {
            mql = matchMedia("(prefers-color-scheme: dark)");
            mql.addEventListener("change", handleMediaChange);
        }

        return () => {
            observer.disconnect();

            if (mql) {
                mql.removeEventListener("change", handleMediaChange);
            }
        };
    }, [enabled]);

    return theme;
};

interface PersonaWithModelProps {
    children: React.ReactNode;
    rive: ReturnType<typeof useRive>["rive"];
    source: (typeof sources)[keyof typeof sources];
}

const PersonaWithModel = memo(({ children, rive, source }: PersonaWithModelProps) => {
    const theme = useTheme(source.dynamicColor);
    const viewModel = useViewModel(rive, { useDefault: true });
    const viewModelInstance = useViewModelInstance(viewModel, {
        rive,
        useDefault: true,
    });
    const viewModelInstanceColor = useViewModelInstanceColor("color", viewModelInstance);

    useEffect(() => {
        if (!(viewModelInstanceColor && source.dynamicColor)) {
            return;
        }

        const [r, g, b] = theme === "dark" ? [255, 255, 255] : [0, 0, 0];

        viewModelInstanceColor.setRgb(r, g, b);
    }, [viewModelInstanceColor, theme, source.dynamicColor]);

    return children;
});

interface PersonaWithoutModelProps {
    children: ReactNode;
}

const PersonaWithoutModel = memo(({ children }: PersonaWithoutModelProps) => children);

const Persona: FC<PersonaProps> = memo(({ className, onLoad, onLoadError, onPause, onPlay, onReady, onStop, state = "idle", variant = "obsidian" }) => {
    const source = sources[variant];

    if (!source) {
        throw new Error(`Invalid variant: ${variant}`);
    }

    // Stabilize callbacks to prevent useRive from reinitializing
    const callbacksRef = useRef({
        onLoad,
        onLoadError,
        onPause,
        onPlay,
        onReady,
        onStop,
    });

    // Refs are written after commit, never during render (React Compiler rule).
    useEffect(() => {
        callbacksRef.current = {
            onLoad,
            onLoadError,
            onPause,
            onPlay,
            onReady,
            onStop,
        };
    }, [onLoad, onLoadError, onPause, onPlay, onReady, onStop]);

    // Lazy state rather than `useMemo([])`: it is a guaranteed-stable box, and
    // `useRive` must not be re-initialised when a caller passes new callbacks.
    // The wrappers read `callbacksRef` only when Rive calls them, not in render.
    const [stableCallbacks] = useState(() => {
        return {
            onLoad: ((loadedRive) => callbacksRef.current.onLoad?.(loadedRive)) as RiveParameters["onLoad"],
            onLoadError: ((err) => callbacksRef.current.onLoadError?.(err)) as RiveParameters["onLoadError"],
            onPause: ((event) => callbacksRef.current.onPause?.(event)) as RiveParameters["onPause"],
            onPlay: ((event) => callbacksRef.current.onPlay?.(event)) as RiveParameters["onPlay"],
            onReady: () => callbacksRef.current.onReady?.(),
            onStop: ((event) => callbacksRef.current.onStop?.(event)) as RiveParameters["onStop"],
        };
    });

    const { rive, RiveComponent } = useRive({
        autoplay: true,
        onLoad: stableCallbacks.onLoad,
        onLoadError: stableCallbacks.onLoadError,
        onPause: stableCallbacks.onPause,
        onPlay: stableCallbacks.onPlay,
        onRiveReady: stableCallbacks.onReady,
        onStop: stableCallbacks.onStop,
        src: source.source,
        stateMachines: stateMachine,
    });

    // The state machine's boolean inputs, set imperatively (Rive inputs are live
    // handles). Looked up from `rive` inside the effect rather than through
    // `useStateMachineInput`: a hook's return value may not be mutated (React
    // Compiler). Re-runs when a (re)loaded `rive` arrives and when `state` changes.
    useEffect(() => {
        const inputs = rive?.stateMachineInputs(stateMachine) ?? [];

        for (const input of inputs) {
            if (PERSONA_STATE_INPUTS.has(input.name)) {
                input.value = input.name === state;
            }
        }
    }, [rive, state]);

    const Component = source.hasModel ? PersonaWithModel : PersonaWithoutModel;

    return (
        <Component rive={rive} source={source}>
            <RiveComponent className={cn("size-16 shrink-0", className)} />
        </Component>
    );
});

export default Persona;
