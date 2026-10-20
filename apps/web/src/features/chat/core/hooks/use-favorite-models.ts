import { useEffect, useMemo, useRef } from "react";

import { moveFavorite } from "@/components/model-picker/utilities";
import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";

const FAVORITE_MODELS_STORAGE_KEY = "neore-favorite-models";

const useFavoriteModels = () => {
    const { data: userSettings } = useUserSettings();
    const { mutate: updateUserSettings, updateLatest } = useUpdateUserSettings();
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
        updateLatest((current) => {
            const favorites = current?.favoriteModels ?? [];

            if (!isFavorite) {
                return { favoriteModels: favorites.filter((id: string) => id !== modelId) };
            }

            return { favoriteModels: favorites.includes(modelId) ? favorites : [...favorites, modelId] };
        });
    };

    /** Moves `movedId` onto `targetId`'s place in the stored list, not in a list read when the drag began. */
    const reorderFavorites = (movedId: string, targetId: string) => {
        updateLatest((current) => {
            return { favoriteModels: moveFavorite(current?.favoriteModels ?? [], movedId, targetId) };
        });
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
        reorderFavorites,
        toggleFavorite,
    };
};

export default useFavoriteModels;
