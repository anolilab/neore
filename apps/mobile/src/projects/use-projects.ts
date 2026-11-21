import { useEffect, useRef, useState } from "react";

import { useAuth } from "@/auth/auth-state";
import { getClient } from "@/lib/lunora";
import { useOffline } from "@/offline/offline-context";

import type { ConfirmView } from "./confirm-project";
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

export interface ProjectConfirmState {
    /** The server says the project is gone or not shared, while the live rows still show it. Its new-chat control stays off. */
    gone: boolean;
    /** The server's refusal of the last read, while the connection is still unconfirmed. */
    refusal: string | undefined;
}

const NOT_CONFIRMED: ProjectConfirmState = { gone: false, refusal: undefined };

/**
 * Write controls wait while a reconnect is unconfirmed. A reconnect that only resumes the project's subscription never
 * answers it, so the screen asks the server about its own project once per refresh tick while it waits, and again when a
 * new token is minted (a tick can come before the renewal lands). What a read showed is kept with the scope it was read
 * for, and a "gone" answer holds only for the live rows it was read against: a newer live answer replaces it.
 */
export const useProjectConfirm = (projectId: string, liveRows: unknown): ProjectConfirmState => {
    const { hasToken, status, tokenSerial, user } = useAuth();
    const { isChecking, isOffline, refreshTick, reportRead } = useOffline();
    const scope = status === "signed-in" && hasToken && user ? `${user.id}:confirm:${projectId}` : undefined;
    const [shown, setShown] = useState<{ epoch: string; rows: unknown; scope: string; view: ConfirmView } | undefined>();
    // The read decides from the state at the tick it runs on; the tick's own render is the one that holds it.
    const connection = useRef({ isChecking, isOffline, liveRows });
    // One reconnect (a refresh tick) or one minted token. A refusal describes only the epoch it was read in.
    const epoch = `${refreshTick}:${tokenSerial}`;

    useEffect(() => {
        connection.current = { isChecking, isOffline, liveRows };
    });

    useEffect(() => {
        const { isChecking: checking, isOffline: offline, liveRows: startRows } = connection.current;

        if (scope === undefined || !checking || offline) {
            return undefined;
        }

        // The rows are those on screen when the read starts: rows that arrive while it runs are newer than its answer.
        return confirmOnTick({
            client: getClient(),
            projectId,
            reportRead,
            show: (view) => {
                setShown(view === undefined ? undefined : { epoch, rows: startRows, scope, view });
            },
        });
    }, [epoch, projectId, reportRead, scope]);

    if (shown === undefined || shown.scope !== scope) {
        return NOT_CONFIRMED;
    }

    if (shown.view.kind === "gone") {
        return { gone: shown.rows === liveRows, refusal: undefined };
    }

    // A refusal stops describing the connection once it is confirmed, or once a later reconnect or token starts a new epoch.
    return { gone: false, refusal: isChecking && shown.epoch === epoch ? shown.view.message : undefined };
};
