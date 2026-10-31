import { useFeatureFlagEnabled } from "posthog-js/react";

/** The Chat | Code switch and the /code shell are behind the `code-mode` flag; development always has it. `undefined` = not loaded yet. */
export const useCodeModeEnabled = (): boolean | undefined => {
    const flag = useFeatureFlagEnabled("code-mode");

    return import.meta.env.DEV ? true : flag;
};
