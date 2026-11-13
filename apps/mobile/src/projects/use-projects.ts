import { api } from "@neore/backend/api";
import { useEffect, useState } from "react";

import { useAuth } from "@/auth/auth-state";
import { getClient } from "@/lib/lunora";
import { useOffline } from "@/offline/offline-context";

import type { Live, OwnSubscription, Scoped } from "./live-follow";
import { EMPTY_LIVE, followLive, liveFor, ownSyncState, subscriptionIdOf } from "./live-follow";
import type { ProjectRow, ProjectThreadRow } from "./projects-api";
import { watchProject, watchProjects, watchProjectThreads } from "./projects-api";

/**
 * Follows one live query while the user is signed in with a token; the subscription ends with the screen. A start that
 * is still confirming the stored user holds none yet, and a subscription opened without one would be refused. Its answers
 * count as successful reads, so a project screen opened on its own gets its write controls back after a reconnect.
 */
/** A query reference's path, as the client's debug snapshot names its subscriptions. */
// eslint-disable-next-line no-underscore-dangle -- `__lunoraRef` is the Lunora reference's path, not a private field
const functionPathOf = (reference: unknown): string => (reference as { __lunoraRef: string }).__lunoraRef;

const useLive = <T>(
    watch: (onRows: (rows: T[]) => void, onError: (message: string) => void) => () => void,
    key: string,
    functionPath: string,
): Live<T> => {
    const { hasToken, status, user } = useAuth();
    const { reportRead } = useOffline();
    const scope = status === "signed-in" && hasToken && user ? `${user.id}:${key}` : undefined;
    const [live, setLive] = useState<Scoped<T>>({ ...EMPTY_LIVE, scope: "" });

    useEffect(() => {
        if (scope === undefined) {
            setLive({ ...EMPTY_LIVE, scope: "" });

            return undefined;
        }

        // The client's sync status also reports an answer that calls no rows callback (a reconnect's `resume` frame). It is
        // judged on this screen's own subscription (`ownSyncState`): by its `id`, read from the client's debug snapshot
        // around the subscribe call (`subscriptionIdOf`), so another project's subscription to the same query never blocks it.
        let own: OwnSubscription = { functionPath };
        const watchOwn: typeof watch = (onRows, onError) => {
            const before = getClient().debug().subscriptions;
            const stop = watch(onRows, onError);
            const id = subscriptionIdOf(before, getClient().debug().subscriptions, functionPath);

            own = id === undefined ? { functionPath } : { functionPath, id };

            return stop;
        };

        return followLive(
            scope,
            watchOwn,
            setLive,
            () => reportRead("succeeded"),
            (listener) =>
                getClient().onSyncStatus((syncStatus) => {
                    listener(ownSyncState(syncStatus, getClient().debug().subscriptions, own));
                }),
        );
        // `scope` stands for the user and everything `watch` and `functionPath` close over; `reportRead` is stable.
    }, [functionPath, reportRead, scope]);

    return liveFor(live, scope);
};

export const useProjects = (): Live<ProjectRow> => useLive((onRows, onError) => watchProjects(getClient(), onRows, onError), "projects", functionPathOf(api.projects.functions.listProjects));

/** One project by id, so its model is known even past the first page of the list. `rows` is `[]` once it is known to be missing. */
export const useProject = (projectId: string): Live<ProjectRow> =>
    useLive((onRows, onError) => watchProject(getClient(), projectId, onRows, onError), `project:${projectId}`, functionPathOf(api.projects.functions.getProject));

export const useProjectThreads = (projectId: string): Live<ProjectThreadRow> =>
    useLive(
        (onRows, onError) => watchProjectThreads(getClient(), projectId, onRows, onError),
        `threads:${projectId}`,
        functionPathOf(api.projects.functions.listThreadsByProject),
    );
