import type { Doc } from "../../_generated/dataModel";
import type { AcpCallResult } from "../../devices/lib/acp-call";
import { sha256Hex } from "../../lib/crypto";

type Offer = NonNullable<Doc<"devices">["acpOffers"]>[number];

/** The offer of `device` for an (agent, folder) pair, or undefined: the pair the user approved in the desktop's local window. */
export const offerOf = (device: Pick<Doc<"devices">, "acpOffers"> | null, agentKey: string, folderId: string): Offer | undefined =>
    device?.acpOffers?.find((candidate) => candidate.agentKey === agentKey && candidate.folderId === folderId);

/**
 * The session id a start made from the web gets: a retry of the same click is the same session, whatever it became since.
 * A switch is keyed by the thread it was clicked on as well: the client id is client-chosen and only unique per thread
 * (`claimKeyOf`), and two sessions with one id on a computer cannot be told apart.
 */
export const webSessionId = async (
    userId: string,
    clientId: string,
    scope: { kind: "fork"; threadId: string } | { kind: "start" } | { kind: "switch"; threadId: string },
): Promise<string> => {
    // A fork is keyed by the chat it forks and has a namespace of its own: no client id of an ordinary start can be one a fork replays.
    if (scope.kind === "fork") {
        return `web-fork-${await sha256Hex(`${userId}:${scope.threadId}:${clientId}`)}`;
    }

    return scope.kind === "switch"
        ? `web-switch-${await sha256Hex(`${userId}:${scope.threadId}:${clientId}`)}`
        : `web-${await sha256Hex(`${userId}:${clientId}`)}`;
};

/** What a person is told when their computer runs a Neore build older than this backend serves. */
export const OUTDATED_NOTICE = "The Neore app on that computer is out of date. Update it, then try again.";

/**
 * `error.data.code` of a start refused because the computer is limited to some projects and the start is in none of them
 * (`remote.ts#startHostSessionFor`), so a caller can tell it from a busy or offline computer.
 */
export const HOST_START_OUT_OF_SCOPE = "HOST_START_OUT_OF_SCOPE";

/** Whether `error` is the refusal {@link HOST_START_OUT_OF_SCOPE} names. */
export const isOutOfScopeStart = (error: unknown): boolean => (error as { data?: { code?: unknown } } | null)?.data?.code === HOST_START_OUT_OF_SCOPE;

/** What a refused `acp_start` call tells the person who asked. */
export const startFailureMessage = (error: Extract<AcpCallResult, { error: string }>["error"]): string => {
    if (error === "busy") {
        return "That computer is busy. Try again in a moment.";
    }

    return error === "outdated" ? OUTDATED_NOTICE : "That computer cannot start an agent right now.";
};
