import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";

import type { ModelId } from "../stores/model-store";
import { useModelStore } from "../stores/model-store";

/**
 * Hook to get the current selected model from the store, falling back to DEFAULT_CHAT_MODEL.
 */
const useCurrentModel = (): ModelId => {
    const selectedModel = useModelStore((state) => state.selectedModel);

    return selectedModel || DEFAULT_CHAT_MODEL;
};

export default useCurrentModel;
