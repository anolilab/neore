/**
 * Importing the sessions an agent keeps (plans/acp-agent-host.md S6), from the local window only.
 *
 * - **Only what the agent advertised.** `session/list` is sent only when the handshake said the agent lists
 * sessions, `session/load` only when it said it loads them (`capabilities.ts`, read through the shared rules of
 * `@neore/ai/capabilities`). The check is here, in the main process, not in the window that hides the button: a
 * request from the window for an agent that did not advertise it is refused before any frame is sent.
 * - **Only the approved folder.** The core's spawn plan refuses an agent or folder the user has not approved, and the
 * list keeps only sessions of that folder.
 * - **One thread per agent session.** The backend answers whether the session is already there (imported before, or
 * run here); then nothing is sent. The transcript is collected first, so a session that cannot be loaded leaves no
 * empty thread behind.
 */
import { createHash } from "node:crypto";

import type { CapabilityReport } from "@neore/ai/capabilities";
import { capabilityOf, isAvailable } from "@neore/ai/capabilities";

import { capSessionInfo } from "./host-events";
import type { ImportIo } from "./import-post";
import { postImport } from "./import-post";
import type { AcpManager } from "./manager";
import { listSessions, loadSession, METHOD } from "./protocol";
import { ReplayCollector } from "./replay";
import type { ImportSummary, NativeSessionView } from "./types";

const MAX_TITLE_CHARS = 200;

export interface ImporterOptions {
    /** The label the user gave the agent; undefined for one that is not registered. */
    agentLabel: (agentKey: string) => string | undefined;
    agents: Pick<AcpManager, "withAgent">;
    /** The label of the folder the user approved for this agent (never its path); undefined when it is not approved. */
    hostInfo: (agentKey: string, folder: string) => { folderId: string; folderLabel: string } | undefined;
    io: ImportIo;
}

/** A host session id both sides can compute, so a second attempt resumes the first. */
export const hostSessionIdOf = (agentKey: string, nativeSessionId: string): string =>
    `import-${createHash("sha256").update(`${agentKey}\n${nativeSessionId}`).digest("hex").slice(0, 32)}`;

const requireAdvertised = (report: CapabilityReport, key: "sessions.listNative" | "sessions.load", what: string): void => {
    if (!isAvailable(capabilityOf(report, key))) {
        throw new Error(`this agent does not ${what}`);
    }
};

const firstWords = (text: string): string => text.trim().replaceAll(/\s+/gu, " ").slice(0, 80);

export class AcpImporter {
    public constructor(private readonly options: ImporterOptions) {}

    /** The agent's saved sessions for this folder, newest first. */
    public async list(agentKey: string, folder: string): Promise<NativeSessionView[]> {
        return await this.options.agents.withAgent(agentKey, folder, {}, async ({ connection, plan, report }) => {
            requireAdvertised(report, "sessions.listNative", "list its saved sessions");

            const sessions = await listSessions(connection, plan.cwd);

            return sessions.map((session) => {
                return { sessionId: session.sessionId, title: session.title.slice(0, MAX_TITLE_CHARS), updatedAt: session.updatedAt };
            });
        });
    }

    public async import(agentKey: string, folder: string, nativeSessionId: string, title?: string): Promise<ImportSummary> {
        const label = this.options.agentLabel(agentKey);

        if (label === undefined) {
            throw new Error("that agent is not registered");
        }

        if (this.options.io.deviceId() === undefined) {
            throw new Error("pair this computer with your account first: imported sessions are saved in your Neore account");
        }

        let collector: ReplayCollector | undefined;

        return await this.options.agents.withAgent(
            agentKey,
            folder,
            { notification: (method, params) => method === METHOD.sessionUpdate && collector?.update(params) },
            async ({ connection, plan, report, scrub, secretLength }) => {
                requireAdvertised(report, "sessions.load", "load its saved sessions");
                requireAdvertised(report, "sessions.listNative", "list its saved sessions");

                const approved = this.options.hostInfo(agentKey, plan.cwd);

                if (approved === undefined) {
                    throw new Error("approve this folder for the agent first");
                }

                // Only a session of the approved folder: the id comes from the window, the agent loads whatever it is given.
                const listed = await listSessions(connection, plan.cwd);

                if (listed.every((session) => session.sessionId !== nativeSessionId)) {
                    throw new Error("that session is not one of this folder's saved sessions");
                }

                collector = new ReplayCollector(nativeSessionId, scrub, undefined, secretLength);

                await loadSession(connection, nativeSessionId, plan.cwd);

                const replay = collector.result();

                if (replay.turns.length === 0) {
                    throw new Error("that session has no saved messages to import");
                }

                const name = title?.trim() ? title : firstWords(replay.turns[0]?.user ?? "");
                // The replay took a while: the folder may have been withdrawn since it was checked.
                const stillApproved = this.options.hostInfo(agentKey, plan.cwd);

                if (stillApproved === undefined) {
                    throw new Error("approve this folder for the agent first");
                }

                const target = { ...capSessionInfo({ agentKey, agentLabel: label, capabilities: report, ...stillApproved, nativeSessionId }), nativeSessionId, title: scrub(name).slice(0, MAX_TITLE_CHARS) };
                const outcome = await postImport(this.options.io, hostSessionIdOf(agentKey, nativeSessionId), target, replay.turns);

                return outcome.status === "already"
                    ? { status: "already" }
                    : { droppedTurns: replay.droppedTurns, shortenedTurns: replay.shortenedTurns, status: "imported", turns: outcome.turns };
            },
        );
    }
}
