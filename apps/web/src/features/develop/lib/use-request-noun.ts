import { useLingui } from "@lingui/react/macro";

import type { HostInfo } from "../components/host-info";

/** The host's word for a change, in the reader's language: the backend names it, the client translates it. */
export const useRequestNoun = (requestNoun: HostInfo["requestNoun"]): string => {
    const { t } = useLingui();
    const nouns: Record<HostInfo["requestNoun"], string> = { "merge request": t`merge request`, "pull request": t`pull request` };

    return nouns[requestNoun];
};
