/**
 * Whether the Guests tab may show for a thread, as `createGuestLink` decides (`chat/guest-links.ts`): only once the thread
 * is loaded and the read of its relationship has answered that it is not a worker's (`knownNotWorker`), and never for a
 * temporary, archived or host-run chat. Data still on its way is not an answer.
 */
export const canHaveGuestLink = (thread: { isTemporary?: boolean; runner?: string; status?: string } | null | undefined, knownNotWorker: boolean): boolean =>
    knownNotWorker && thread !== null && thread !== undefined && thread.runner !== "host" && thread.status !== "archived" && thread.isTemporary !== true;
