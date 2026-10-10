import { useEffect, useMemo, useRef } from "react";

import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";

const FAVORITE_MODELS_STORAGE_KEY = "neore-favorite-models";

const useFavoriteModels = () => {
    const { data: userSettings } = useUserSettings();
    const { mutate: updateUserSettings } = useUpdateUserSettings();
    const hasMigratedRef = useRef(false);

    const favoriteModelIds = useMemo<string[]>(() => userSettings?.favoriteModels ?? [], [userSettings?.favoriteModels]);

    // Migrate localStorage data to user settings on first load
    useEffect(() => {
        if (hasMigratedRef.current || !userSettings) {
            return;
        }

        // Only migrate if user settings don't have favoriteModels yet
        if (!userSettings.favoriteModels) {
            try {
                const stored = localStorage.getItem(FAVORITE_MODELS_STORAGE_KEY);

                if (stored) {
                    const parsed = JSON.parse(stored) as string[];

                    if (Array.isArray(parsed) && parsed.length > 0) {
                        updateUserSettings({ favoriteModels: parsed });
                        // Clear localStorage after migration
                        localStorage.removeItem(FAVORITE_MODELS_STORAGE_KEY);
                    }
                }
            } catch {
                // Ignore errors during migration
            }
        }

        hasMigratedRef.current = true;
    }, [userSettings, updateUserSettings]);

    const toggleFavorite = (modelId: string, isFavorite: boolean) => {
        let newFavorites: string[];

        if (isFavorite) {
            newFavorites = favoriteModelIds.includes(modelId) ? favoriteModelIds : [...favoriteModelIds, modelId];
        } else {
            newFavorites = favoriteModelIds.filter((id: string) => id !== modelId);
        }

        updateUserSettings({ favoriteModels: newFavorites });
    };

    const addFavorite = (modelId: string) => {
        toggleFavorite(modelId, true);
    };

    const removeFavorite = (modelId: string) => {
        toggleFavorite(modelId, false);
    };

    const isFavorite = (modelId: string) => favoriteModelIds.includes(modelId);

    return {
        addFavorite,
        favoriteModelIds,
        isFavorite,
        removeFavorite,
        toggleFavorite,
    };
};

export default useFavoriteModels;
