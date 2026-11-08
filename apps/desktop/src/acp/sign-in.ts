/**
 * Whether a coding agent on this computer is signed in to its own account, and signing it out.
 *
 * Neore keeps no credential: the agent's sign-in stays in its own store. The state is asked of the agent itself, by
 * opening a session (`session/new`) on a short-lived connection that sends no prompt: `AUTH_REQUIRED` means signed
 * out, a session id means signed in, anything else is unknown, with the agent's own error text. The session is
 * opened in one stable private folder per agent, because some agents keep a record per folder they were opened in,
 * and a new folder per check would add one each time. A sign-out is the agent's own `logout`, and ends every open
 * session of that agent first, since they ran under the account that is going away.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { AcpManager } from "./manager";
import { logout, newSession } from "./protocol";
import { AgentSignedOutError } from "./signed-out";

export type SignInState = "signed_in" | "signed_out" | "unknown";

export interface SignInStatus {
    agentKey: string;
    /** The agent advertised `logout`. */
    canSignOut: boolean;
    checkedAt: number;
    /** For `unknown`: why, in the agent's words with the user's secret values masked. */
    detail: string;
    state: SignInState;
}

/** The core's agent keys; a key outside them cannot name a folder outside the checks' folder. */
const AGENT_KEY = /^[a-z0-9-]{1,40}$/u;

/** How long the check waits for the agent to open (or refuse) the session. */
const CHECK_TIMEOUT_MS = 20_000;

export interface SignInOptions {
    agents: Pick<AcpManager, "closeAgent" | "holdingAgent" | "withAgent">;
    /** The folder the checks of all agents are opened in: one subfolder per agent, made private. */
    folder: string;
    now?: () => number;
    timeoutMs?: number;
}

export class AgentSignIn {
    private readonly now: () => number;

    public constructor(private readonly options: SignInOptions) {
        this.now = options.now ?? Date.now;
    }

    public async status(agentKey: string): Promise<SignInStatus> {
        const folder = await this.folderOf(agentKey);
        const { timeoutMs = CHECK_TIMEOUT_MS } = this.options;
        let canSignOut = false;

        try {
            return await this.options.agents.withAgent(agentKey, null, {}, async ({ connection, handshake, scrub }) => {
                canSignOut = handshake.canLogout;

                try {
                    await newSession(connection, folder, timeoutMs);

                    return this.result(agentKey, "signed_in", canSignOut);
                } catch (error) {
                    if (error instanceof AgentSignedOutError) {
                        return this.result(agentKey, "signed_out", canSignOut);
                    }

                    return this.result(agentKey, "unknown", canSignOut, scrub((error as Error).message));
                }
            });
        } catch (error) {
            // The agent did not start or did not finish the handshake; `withAgent` already masked its words.
            return this.result(agentKey, "unknown", canSignOut, (error as Error).message);
        }
    }

    /**
     * Ends the agent's open sessions, asks it to sign out, then checks again: the answer is what the agent says now. No
     * session of the agent can start meanwhile, and an agent that cannot sign out is refused before any session ends.
     */
    public async signOut(agentKey: string): Promise<SignInStatus> {
        const { agents } = this.options;

        return await agents.holdingAgent(agentKey, async () => {
            await agents.withAgent(agentKey, null, {}, async ({ connection, handshake }) => {
                if (!handshake.canLogout) {
                    throw new Error("this agent cannot be signed out from Neore. Use the agent's own sign-out");
                }

                await agents.closeAgent(agentKey);
                await logout(connection, this.options.timeoutMs ?? CHECK_TIMEOUT_MS);
            });

            return await this.status(agentKey);
        });
    }

    private result(agentKey: string, state: SignInState, canSignOut: boolean, detail = ""): SignInStatus {
        return { agentKey, canSignOut, checkedAt: this.now(), detail, state };
    }

    private async folderOf(agentKey: string): Promise<string> {
        // The folder is made before the core refuses an unknown agent, and the window's key is only length-checked: a key
        // with `/` or `..` would otherwise name a folder outside this one.
        if (!AGENT_KEY.test(agentKey)) {
            throw new Error("that agent is not registered");
        }

        const folder = path.join(this.options.folder, agentKey);

        await mkdir(folder, { mode: 0o700, recursive: true });

        return folder;
    }
}
