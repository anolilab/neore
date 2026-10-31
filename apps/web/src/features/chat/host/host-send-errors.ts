"use client";

import { useLingui } from "@lingui/react/macro";

import type { HostSendError } from "./host-send";

/** What each refusal of `/hosts/send` says to the person. */
const useHostSendErrorMessages = (): Record<HostSendError, string> => {
    const { t } = useLingui();

    return {
        busy: t`Your computer is busy. Try again in a moment.`,
        locked: t`This chat is locked. Unlock it to send.`,
        not_authenticated: t`Sign in again to send.`,
        not_found: t`This chat could not be found.`,
        offline: t`Your computer is offline. Open Neore on it and try again.`,
        rate_limited: t`You are sending too fast. Wait a moment.`,
        session_ended: t`This session has ended. Start a new one from the desktop app.`,
        too_large: t`That message is too long to send from here.`,
        turn_running: t`The agent is still working on the last message.`,
        unreachable: t`Could not reach the server. Try again.`,
        worker_thread: t`This chat belongs to a worker. Send it messages from its own message box.`,
    };
};

export default useHostSendErrorMessages;
