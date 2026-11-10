import { useLingui } from "@lingui/react/macro";
import type { FC } from "react";
import { createContext, useContext, useEffect, useState } from "react";

import type { ToolOutputRef } from "../types/message";

/** Fetches one left-out tool output. The app supplies it, since only the app knows its backend. */
export type ToolOutputLoader = (ref: ToolOutputRef) => Promise<unknown>;

const ToolOutputLoaderContext = createContext<ToolOutputLoader | null>(null);

/** Gives every tool view below it the loader for outputs the thread page left out. */
export const ToolOutputLoaderProvider = ToolOutputLoaderContext.Provider;

type LoadState = { output: unknown; status: "loaded" } | { status: "error" } | { status: "loading" };

/** The output of a tool result the page left out, fetched when the tool view is expanded. */
export const TrimmedToolOutput: FC<{ outputRef: ToolOutputRef }> = ({ outputRef }) => {
    const { t } = useLingui();
    const load = useContext(ToolOutputLoaderContext);
    const [state, setState] = useState<LoadState>({ status: "loading" });
    const { messageId, threadId, toolCallId } = outputRef;

    useEffect(() => {
        if (!load) {
            return;
        }

        let active = true;

        const run = async (): Promise<void> => {
            try {
                const output = await load({ messageId, threadId, toolCallId });

                if (active) {
                    setState({ output, status: "loaded" });
                }
            } catch {
                if (active) {
                    setState({ status: "error" });
                }
            }
        };

        void run();

        return () => {
            active = false;
        };
    }, [load, messageId, threadId, toolCallId]);

    if (!load) {
        return <p className="text-xs opacity-80 dark:opacity-100">{t`Output is not loaded in this view.`}</p>;
    }

    if (state.status === "loading") {
        return <p className="text-xs opacity-80 dark:opacity-100">{t`Loading output...`}</p>;
    }

    if (state.status === "error") {
        return <p className="text-xs text-red-700 dark:text-red-400">{t`Output could not be loaded.`}</p>;
    }

    return (
        <pre className="mt-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap">
            {String(typeof state.output === "string" ? state.output : JSON.stringify(state.output, null, 2))}
        </pre>
    );
};
