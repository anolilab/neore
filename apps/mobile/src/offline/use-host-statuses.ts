import { api } from "@neore/backend/api";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "../auth/auth-state";
import { getClient } from "../lib/lunora";
import { isNetworkFailure } from "./connectivity";
import { mergeRows } from "./merge";
import { useOffline } from "./offline-context";
import { settleQuietly } from "./quietly";
import { hostSessionToStatus, workerRunToStatus } from "./status-mapping";
import type { CachedStatus, ShownStatus, StatusRow } from "./types";

const readLiveStatuses = async (observedAt: number): Promise<CachedStatus[]> => {
    const client = getClient();
    const [sessions, workers] = await Promise.all([
        client.query(api.acp.functions.listHostSessions, {}),
        client.query(api.sub_agents.functions.listActiveWorkerRuns, {}),
    ]);

    return [...sessions.map((session) => hostSessionToStatus(session)), ...workers.map((run) => workerRunToStatus(run, observedAt))];
};

/**
 * Host sessions and worker runs by the thread they run on. The saved copy paints first, live rows replace it, and a
 * saved row never replaces a newer live one. A read that fails on the network is reported, so a dead server shows as
 * offline here too; the rows already shown stay, marked as read from the cache until a live read replaces them.
 */
export const useHostStatuses = (): Map<string, ShownStatus> => {
    const { hasToken, status } = useAuth();
    const { cache, refreshTick, reportRead } = useOffline();
    const [rows, setRows] = useState<StatusRow[]>([]);
    const [isLive, setIsLive] = useState(false);
    const hasLiveRows = useRef(false);

    useEffect(() => {
        if (status !== "signed-in") {
            return undefined;
        }

        let isCancelled = false;

        const run = async () => {
            try {
                const cached = await cache?.loadStatuses() ?? [];

                if (!isCancelled && !hasLiveRows.current && cached.length > 0) {
                    setRows((current) => mergeRows(current, cached));
                }
            } catch {
                // An unreadable cache is an empty one.
            }

            if (!hasToken) {
                return;
            }

            // Stamped when the read starts, so a slow older read cannot look newer than a later one.
            const startedAt = Date.now();

            try {
                const live = await readLiveStatuses(startedAt);

                if (!isCancelled) {
                    hasLiveRows.current = true;
                    setIsLive(true);
                    setRows(
                        live.map((row) => {
                            return { ...row, syncedAt: startedAt };
                        }),
                    );
                    settleQuietly(cache?.saveStatuses(live, { syncedAt: startedAt }));
                    reportRead("succeeded");
                }
            } catch (error: unknown) {
                // Kept as shown. Only a read the network failed is reachability news; a refusal is not.
                if (!isCancelled && isNetworkFailure(error)) {
                    reportRead("failed");
                }
            }
        };

        run();

        return () => {
            isCancelled = true;
        };
    }, [cache, hasToken, refreshTick, reportRead, status]);

    return useMemo(() => {
        const byThread = new Map<string, ShownStatus>();

        for (const row of rows) {
            if (row.threadId !== undefined) {
                byThread.set(row.threadId, { ...row, fromCache: !isLive });
            }
        }

        return byThread;
    }, [isLive, rows]);
};
