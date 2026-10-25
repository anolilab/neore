import { useEffect, useState } from "react";

/**
 * Loads a text file for a preview. A deadline and the unmount both abort the
 * request, so a stalled URL cannot hold a preview forever. Each result is kept
 * with the URL it answers, so a changed URL reads as loading until its own
 * request settles.
 */

export type FetchedText = { status: "error" } | { status: "loading" } | { status: "ready"; text: string };

const TEXT_FETCH_TIMEOUT_MS = 30_000;
const LOADING: FetchedText = { status: "loading" };

const readText = async (url: string, signal: AbortSignal): Promise<FetchedText> => {
    try {
        const response = await fetch(url, { signal });

        if (!response.ok) {
            return { status: "error" };
        }

        return { status: "ready", text: await response.text() };
    } catch {
        return { status: "error" };
    }
};

export const useFetchedText = (url: string): FetchedText => {
    const [result, setResult] = useState<{ state: FetchedText; url: string }>();

    useEffect(() => {
        const controller = new AbortController();
        const deadline = setTimeout(() => {
            controller.abort();
        }, TEXT_FETCH_TIMEOUT_MS);
        let cancelled = false;

        const load = async (): Promise<void> => {
            const state = await readText(url, controller.signal);

            if (!cancelled) {
                setResult({ state, url });
            }
        };

        load();

        return () => {
            cancelled = true;
            clearTimeout(deadline);
            controller.abort();
        };
    }, [url]);

    return result?.url === url ? result.state : LOADING;
};
