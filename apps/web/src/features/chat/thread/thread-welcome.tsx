"use client";

/**
 * ThreadWelcome v2 - Welcome message for empty threads
 *
 * No assistant-ui dependencies - uses useChatIsEmpty from ChatContext.
 */

import { useLingui } from "@lingui/react/macro";
import type { FC } from "react";

import { useAuthSession } from "@/features/auth/hooks/use-auth-session";
import { useUserPreferences } from "@/features/layout/hooks/use-ui-state";

const ThreadWelcome: FC = () => {
    const { t } = useLingui();
    const { data: sessionData } = useAuthSession();
    const { hidePersonalInfo } = useUserPreferences();

    const getWelcomeMessage = () => {
        // Don't show name if hidePersonalInfo is enabled
        if (hidePersonalInfo) {
            return t`How can I help you today?`;
        }

        if (sessionData?.user?.name) {
            return t`Hello ${sessionData.user.name}! What would you like to do today?`;
        }

        return t`How can I help you today?`;
    };

    return (
        <div className="flex w-full max-w-[var(--thread-max-width)] grow flex-col dark:text-white">
            <div className="flex w-full grow flex-col items-center justify-center">
                <p className="mt-4 font-medium">{getWelcomeMessage()}</p>
            </div>
        </div>
    );
};

export default ThreadWelcome;
