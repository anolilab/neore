import { useEffect, useState } from "react";

import { useAuth } from "@/auth/auth-state";
import { getClient } from "@/lib/lunora";

import type { Live, Scoped } from "./live-follow";
import { EMPTY_LIVE, followLive, liveFor } from "./live-follow";
import type { ProjectRow, ProjectThreadRow } from "./projects-api";
import { watchProject, watchProjects, watchProjectThreads } from "./projects-api";

/** Follows one live query while the user is signed in; the subscription ends with the screen. */
const useLive = <T>(watch: (onRows: (rows: T[]) => void, onError: (message: string) => void) => () => void, key: string): Live<T> => {
    const { status, user } = useAuth();
    const scope = status === "signed-in" && user ? `${user.id}:${key}` : undefined;
    const [live, setLive] = useState<Scoped<T>>({ ...EMPTY_LIVE, scope: "" });

    useEffect(() => {
        if (scope === undefined) {
            setLive({ ...EMPTY_LIVE, scope: "" });

            return undefined;
        }

        return followLive(scope, watch, setLive);
        // `scope` stands for the user and everything `watch` closes over.
    }, [scope]);

    return liveFor(live, scope);
};

export const useProjects = (): Live<ProjectRow> => useLive((onRows, onError) => watchProjects(getClient(), onRows, onError), "projects");

/** One project by id, so its model is known even past the first page of the list. `rows` is `[]` once it is known to be missing. */
export const useProject = (projectId: string): Live<ProjectRow> =>
    useLive((onRows, onError) => watchProject(getClient(), projectId, onRows, onError), `project:${projectId}`);

export const useProjectThreads = (projectId: string): Live<ProjectThreadRow> =>
    useLive((onRows, onError) => watchProjectThreads(getClient(), projectId, onRows, onError), `threads:${projectId}`);

/** True while the client has no connection. Writes are refused then, never queued. */
export const useIsOffline = (): boolean => {
    const [isOffline, setIsOffline] = useState(false);

    useEffect(() => getClient().onConnectionStatus((status) => setIsOffline(status === "offline")), []);

    return isOffline;
};
