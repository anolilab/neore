import { api } from "@neore/backend/api";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "../auth/auth-state";
import { getClient } from "../lib/lunora";
import { mergeRows } from "./merge";
import { useOffline } from "./offline-context";
import { settleQuietly } from "./quietly";
import { hostSessionToStatus, workerRunToStatus } from "./status-mapping";
import type { CachedStatus, StatusRow } from "./types";

const readLiveStatuses = async (): Promise<CachedStatus[]> => {
    const client = getClient();
    const [sessions, workers] = await Promise.all([
        client.query(api.acp.functions.listHostSessions, {}),
        client.query(api.sub_agents.functions.listActiveWorkerRuns, {}),
    ]);

    return [...sessions.map((session) => hostSessionToStatus(session)), ...workers.map((run) => workerRunToStatus(run))];
};

/**
 * Host sessions and worker runs by the thread they run on. The saved copy paints first, live rows replace it, and a
 * saved row never replaces a newer live one. A failed read keeps what is shown: reachability is the thread list's to report.
 */
export const useHostStatuses = (): Map<string, StatusRow> => {
    const { hasToken, status } = useAuth();
    const { cache, refreshTick } = useOffline();
    const [rows, setRows] = useState<StatusRow[]>([]);
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

            try {
                const live = await readLiveStatuses();

                if (!isCancelled) {
                    hasLiveRows.current = true;
                    setRows(
                        live.map((row) => {
                            return { ...row, syncedAt: Date.now() };
                        }),
                    );
                    settleQuietly(cache?.saveStatuses(live));
                }
            } catch {
                // Kept as shown.
            }
        };

        run();

        return () => {
            isCancelled = true;
        };
    }, [cache, hasToken, refreshTick, status]);

    return useMemo(() => {
        const byThread = new Map<string, StatusRow>();

        for (const row of rows) {
            if (row.threadId !== undefined) {
                byThread.set(row.threadId, row);
            }
        }

        return byThread;
    }, [rows]);
};
