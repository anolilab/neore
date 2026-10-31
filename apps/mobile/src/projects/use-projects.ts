import { useEffect, useState } from "react";

import { useAuth } from "@/auth/auth-state";
import { getClient } from "@/lib/lunora";

import type { ProjectRow, ProjectThreadRow } from "./projects-api";
import { watchProjects, watchProjectThreads } from "./projects-api";

interface Live<T> {
    error: string | undefined;
    /** `undefined` until the first answer. */
    rows: T[] | undefined;
}

/** Follows one live query while the user is signed in; the subscription ends with the screen. */
const useLive = <T>(watch: ((onRows: (rows: T[]) => void, onError: (message: string) => void) => () => void) | undefined, key: string): Live<T> => {
    const { status } = useAuth();
    const [live, setLive] = useState<Live<T>>({ error: undefined, rows: undefined });

    useEffect(() => {
        if (status !== "signed-in" || !watch) {
            return undefined;
        }

        return watch(
            (rows) => setLive({ error: undefined, rows }),
            (message) =>
                setLive((current) => {
                    return { ...current, error: message };
                }),
        );
        // `key` stands for everything `watch` closes over.
    }, [key, status]);

    return live;
};

export const useProjects = (): Live<ProjectRow> => useLive((onRows, onError) => watchProjects(getClient(), onRows, onError), "projects");

export const useProjectThreads = (projectId: string): Live<ProjectThreadRow> =>
    useLive((onRows, onError) => watchProjectThreads(getClient(), projectId, onRows, onError), `threads:${projectId}`);

/** True while the client has no connection. Writes are refused then, never queued. */
export const useIsOffline = (): boolean => {
    const [isOffline, setIsOffline] = useState(false);

    useEffect(() => getClient().onConnectionStatus((status) => setIsOffline(status === "offline")), []);

    return isOffline;
};
