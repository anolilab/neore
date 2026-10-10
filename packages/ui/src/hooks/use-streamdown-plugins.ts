import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { useEffect, useState } from "react";
import type { PluginConfig } from "streamdown";

/**
 * Streamdown plugins, with the heavy two loaded on demand.
 *
 * `@streamdown/math` pulls in KaTeX and `@streamdown/mermaid` pulls in Mermaid —
 * together most of a megabyte of JS. Every markdown renderer used to import
 * them statically, which put both on the startup path of every chat page (and
 * made the one lazy loader in `@neore/chat-ui` ineffective, since a module
 * imported statically anywhere cannot be split out). They are now only ever
 * reached through `import()` below, the first time a message actually contains
 * math or a mermaid block. Keep it that way: a single static import of either
 * package anywhere in the app brings them back to startup.
 */
export const BASIC_STREAMDOWN_PLUGINS: PluginConfig = { cjk, code };

/** Inline math like `$x$`. */
const INLINE_MATH_PATTERN = /\$[^\s$]/;

export const needsHeavyStreamdownPlugins = (text: string): boolean =>
    text.includes("```mermaid") || text.includes("$$") || text.includes(String.raw`\(`) || text.includes(String.raw`\[`) || INLINE_MATH_PATTERN.test(text);

// Held on an object so the loader mutates a property rather than rebinding a
// module-level `let` from inside a function.
const heavy: { cached: PluginConfig | null; loading: Promise<PluginConfig> | null } = { cached: null, loading: null };

export const loadHeavyStreamdownPlugins = (): Promise<PluginConfig> => {
    if (heavy.cached) {
        return Promise.resolve(heavy.cached);
    }

    heavy.loading ??= Promise.all([import("@streamdown/mermaid"), import("@streamdown/math")])
        .then(([mermaidModule, mathModule]) => {
            heavy.cached = { ...BASIC_STREAMDOWN_PLUGINS, math: mathModule.math, mermaid: mermaidModule.mermaid };

            return heavy.cached;
        })
        .catch((error: unknown) => {
            // Let a later message retry a failed chunk load.
            heavy.loading = null;
            throw error;
        });

    return heavy.loading;
};

/**
 * The plugins to render `text` with: the basic set until the text needs math
 * or mermaid, then the full set once it has loaded (and from then on for every
 * renderer, since the modules are cached).
 */
const useStreamdownPlugins = (text: unknown): PluginConfig => {
    const [plugins, setPlugins] = useState<PluginConfig>(() => heavy.cached ?? BASIC_STREAMDOWN_PLUGINS);
    const needsHeavy = typeof text === "string" && needsHeavyStreamdownPlugins(text);

    useEffect(() => {
        if (!needsHeavy || plugins !== BASIC_STREAMDOWN_PLUGINS) {
            return undefined;
        }

        let cancelled = false;

        loadHeavyStreamdownPlugins()
            .then((loaded) => {
                if (!cancelled) {
                    setPlugins(loaded);
                }

                return undefined;
            })
            // A failed chunk load leaves the basic plugins in place: the text still
            // renders, only without math/diagram rendering.
            .catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, [needsHeavy, plugins]);

    return plugins;
};

export default useStreamdownPlugins;
