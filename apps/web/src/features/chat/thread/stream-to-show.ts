/**
 * Which stream the message list's placeholder renders.
 *
 * The live `activeStreamId` once it reports one; until then the stream this
 * client just started (`pendingStreamId`, from the `/v1/chat` response), so the
 * gateway stream opens as soon as the start request answers instead of after
 * the live query catches up — for a new thread, a whole subscription seed after
 * the navigation. Never over a settled reply: a stream that finished before the
 * live query ever saw it must not linger.
 */
export const selectStreamIdToShow = (
    activeStreamId: string | null,
    pendingStreamId: string | null | undefined,
    lastMessage: { role: string; status?: string } | undefined,
): string | null => {
    if (activeStreamId) {
        return activeStreamId;
    }

    const isLastReplySettled = lastMessage?.role === "assistant" && (lastMessage.status === "success" || lastMessage.status === "failed");

    return isLastReplySettled ? null : (pendingStreamId ?? null);
};

/**
 * The gateway token for the stream being shown. A token is minted for ONE
 * stream (it signs the stream id), so the one `/v1/chat` returned is only
 * handed out for that stream — never for a different live stream (a regenerate,
 * another tab, a collaborator), which the gateway would refuse or, worse, the
 * placeholder would render under the wrong reply.
 */
export const selectStreamTokenFor = (
    streamIdToShow: string | null,
    pendingStreamId: string | null | undefined,
    pendingStreamToken: string | null | undefined,
): string | null => (streamIdToShow !== null && streamIdToShow === pendingStreamId ? (pendingStreamToken ?? null) : null);
