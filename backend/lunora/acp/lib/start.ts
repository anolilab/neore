import type { Doc, Id } from "../../_generated/dataModel";
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
export const webSessionId = async (userId: string, clientId: string, scope: { kind: "start" } | { kind: "switch"; threadId: string }): Promise<string> =>
    scope.kind === "switch" ? `web-switch-${await sha256Hex(`${userId}:${scope.threadId}:${clientId}`)}` : `web-${await sha256Hex(`${userId}:${clientId}`)}`;

/** What a refused `acp_start` call tells the person who asked. */
export const startFailureMessage = (error: Extract<AcpCallResult, { error: string }>["error"]): string =>
    error === "busy" ? "That computer is busy. Try again in a moment." : "That computer cannot start an agent right now.";
