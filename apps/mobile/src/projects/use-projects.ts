import { useEffect, useRef, useState } from "react";

import { useAuth } from "@/auth/auth-state";
import { getClient } from "@/lib/lunora";
import { useOffline } from "@/offline/offline-context";

import { confirmOnTick } from "./confirm-project";
import type { Live, Scoped } from "./live-follow";
import { EMPTY_LIVE, followLive, liveFor } from "./live-follow";
import type { ProjectRow, ProjectThreadRow } from "./projects-api";
import { watchProject, watchProjects, watchProjectThreads } from "./projects-api";

/**
 * Follows one live query while the user is signed in with a token; the subscription ends with the screen. A start that
 * is still confirming the stored user holds none yet, and a subscription opened without one would be refused. Its answers
 * count as successful reads, so a screen whose subscription answers gets its write controls back after a reconnect.
 * A reconnect that only resumes the subscription is covered by `useProjectConfirm`.
 */
const useLive = <T>(watch: (onRows: (rows: T[]) => void, onError: (message: string) => void) => () => void, key: string): Live<T> => {
    const { hasToken, status, user } = useAuth();
    const { reportRead } = useOffline();
    const scope = status === "signed-in" && hasToken && user ? `${user.id}:${key}` : undefined;
    const [live, setLive] = useState<Scoped<T>>({ ...EMPTY_LIVE, scope: "" });

    useEffect(() => {
        if (scope === undefined) {
            setLive({ ...EMPTY_LIVE, scope: "" });

            return undefined;
        }

        return followLive(scope, watch, setLive, () => reportRead("succeeded"));
        // `scope` stands for the user and everything `watch` closes over; `reportRead` is stable.
    }, [reportRead, scope]);

    return liveFor(live, scope);
};

export const useProjects = (): Live<ProjectRow> => useLive((onRows, onError) => watchProjects(getClient(), onRows, onError), "projects");

/** One project by id, so its model is known even past the first page of the list. `rows` is `[]` once it is known to be missing. */
export const useProject = (projectId: string): Live<ProjectRow> =>
    useLive((onRows, onError) => watchProject(getClient(), projectId, onRows, onError), `project:${projectId}`);

export const useProjectThreads = (projectId: string): Live<ProjectThreadRow> =>
    useLive((onRows, onError) => watchProjectThreads(getClient(), projectId, onRows, onError), `threads:${projectId}`);

/**
 * Write controls wait while a reconnect is unconfirmed. A reconnect that only resumes the project's subscription never
 * answers it, so the screen asks the server about its own project once per refresh tick while it waits. The tick, not
 * the connection state, starts the read: the refresh that follows a reconnect renews the token first, and a read sent
 * before then could go out on a lapsed one. Returns the refusal the server gave, while the connection is unconfirmed.
 */
export const useProjectConfirm = (projectId: string): string | undefined => {
    const { hasToken, status, user } = useAuth();
    const { isChecking, isOffline, refreshTick, reportRead } = useOffline();
    const scope = status === "signed-in" && hasToken && user ? `${user.id}:confirm:${projectId}` : undefined;
    const [refusal, setRefusal] = useState<string | undefined>();
    // The read decides from the state at the tick it runs on; the tick's own render is the one that holds it.
    const connection = useRef({ isChecking, isOffline });

    useEffect(() => {
        connection.current = { isChecking, isOffline };
    });

    useEffect(() => {
        const { isChecking: checking, isOffline: offline } = connection.current;

        if (scope === undefined || !checking || offline) {
            return undefined;
        }

        return confirmOnTick({ client: getClient(), projectId, reportRead, showRefusal: setRefusal });
    }, [projectId, refreshTick, reportRead, scope]);

    // Once the connection is confirmed, by this read or by a live answer, an old refusal no longer describes it.
    return isChecking ? refusal : undefined;
};
