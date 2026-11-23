/**
 * Whether the viewer sent a user message, as the server decides it (`vault/site-login-turn.ts#pathRowRefusal`): a
 * collaborator's turn in a shared chat runs, and saves its prompt, as the collaborator, so a saved row names its sender in
 * `userId`. A saved row naming nobody, or anyone while the viewer is not known yet, is not provably the viewer's; only the
 * composer's own unsaved send (`pending`, no `userId` yet) is theirs without a name.
 */
export const isViewersOwnMessage = (message: { status?: string; userId?: string }, viewerId: string | undefined): boolean =>
    message.userId === undefined ? message.status === "pending" : viewerId !== undefined && message.userId === viewerId;
