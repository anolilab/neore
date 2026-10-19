import { useCallback, useMemo } from "react";

import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";

const NO_NICKNAMES: Readonly<Record<string, string>> = {};

/** The user's own names for models (`userSettings.modelNicknames`), model id → nickname. */
const useModelNicknames = () => {
    const { data: userSettings } = useUserSettings();
    const { mutate: updateUserSettings } = useUpdateUserSettings();

    const nicknames = useMemo<Readonly<Record<string, string>>>(() => userSettings?.modelNicknames ?? NO_NICKNAMES, [userSettings?.modelNicknames]);

    /** A blank nickname clears the entry. The server trims and drops blanks too; this keeps the optimistic row honest. */
    const setNickname = useCallback(
        (modelId: string, nickname: string) => {
            const others = Object.fromEntries(Object.entries(nicknames).filter(([id]) => id !== modelId));
            const trimmed = nickname.trim();

            updateUserSettings({ modelNicknames: trimmed === "" ? others : { ...others, [modelId]: trimmed } });
        },
        [nicknames, updateUserSettings],
    );

    return { nicknames, setNickname };
};

export default useModelNicknames;
