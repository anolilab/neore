"use client";

import { useLingui } from "@lingui/react/macro";
import type { GatewayModel } from "@neore/ai/models";
import { ProviderIcon } from "@neore/ui/components/ai-elements/provider-icon";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Sortable, SortableContent, SortableItem, SortableItemHandle, SortableOverlay } from "@neore/ui/components/ui/sortable";
import { GripVertical } from "lucide-react";
import type { FC } from "react";
import { useMemo, useState } from "react";

import { getModelLabel } from "@/components/model-picker/utilities";
import SettingsCard from "@/components/settings/settings-card";
import useFavoriteModels from "@/features/chat/core/hooks/use-favorite-models";
import useModelNicknames from "@/features/chat/core/hooks/use-model-nicknames";
import useCustomModels from "@/features/settings/hooks/use-custom-models";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

// Matches `MAX_MODEL_NICKNAME_LENGTH` in `backend/lunora/auth/lib/model-nicknames.ts`.
const NICKNAME_MAX_LENGTH = 60;

/** A flat row of a list in a settings box: a hairline above all but the first. */
const ROW_CLASS = "not-first:border-border/50 flex items-center gap-2 py-2 not-first:border-t";

interface NicknameFieldProps {
    model: GatewayModel;
    nickname: string | undefined;
    onCommit: (modelId: string, nickname: string) => void;
}

/** Edits a draft and saves it when the field is left, so a keystroke is not a write. */
const NicknameField: FC<NicknameFieldProps> = ({ model, nickname, onCommit }) => {
    const { t } = useLingui();
    const [draft, setDraft] = useState<string | undefined>();
    const label = getModelLabel(model);

    return (
        <Input
            aria-label={t`Nickname for ${label}`}
            className="w-40"
            maxLength={NICKNAME_MAX_LENGTH}
            onBlur={() => {
                if (draft !== undefined && draft.trim() !== (nickname ?? "")) {
                    onCommit(model.id, draft);
                }

                setDraft(undefined);
            }}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
                if (event.key === "Enter") {
                    event.currentTarget.blur();
                }
            }}
            placeholder={t`Nickname`}
            value={draft ?? nickname ?? ""}
        />
    );
};

const ModelName: FC<{ model: GatewayModel; nickname: string | undefined }> = ({ model, nickname }) => (
    <div className="flex min-w-0 flex-1 items-center gap-2">
        <ProviderIcon
            aria-hidden="true"
            className="size-4 shrink-0"
            provider={model.provider || model.displayProvider || ""}
            providerIcon={model.id.split("/", 1)[0] || model.displayProvider || ""}
        />
        <div className="min-w-0">
            <p className="truncate text-sm font-medium">{nickname || getModelLabel(model)}</p>
            {nickname ? <p className="text-muted-foreground truncate text-xs">{getModelLabel(model)}</p> : null}
        </div>
    </div>
);

const FavoriteModelsSettings: FC = () => {
    const { t } = useLingui();
    // Custom endpoint models too: a starred custom model is stored like any other id.
    const models = useFeatureFlaggedModels();
    const customModels = useCustomModels();
    const catalog = useMemo(() => [...models, ...customModels], [models, customModels]);
    const { favoriteModelIds, reorderFavorites } = useFavoriteModels();
    const { nicknames, setNickname } = useModelNicknames();

    // Favorites the catalog still offers, in the user's order. A hidden or retired favorite keeps its place in the stored list.
    const favorites = useMemo(() => {
        const byId = new Map(catalog.map((model) => [model.id, model]));

        return favoriteModelIds.flatMap((id) => {
            const model = byId.get(id);

            return model ? [model] : [];
        });
    }, [favoriteModelIds, catalog]);

    // A nickname outlives the star, so it must stay editable here.
    const nicknamedOthers = useMemo(() => {
        const starred = new Set(favoriteModelIds);

        return catalog.filter((model) => nicknames[model.id] && !starred.has(model.id));
    }, [favoriteModelIds, catalog, nicknames]);

    // A nickname for a model the catalog no longer lists still counts toward the saved cap, so it is listed by id to be cleared.
    // Only once the gateway catalog has loaded: while it is empty (loading, or the fetch failed) every nickname would look retired.
    const retiredNicknames = useMemo(() => {
        if (models.length === 0) {
            return [];
        }

        const listed = new Set(catalog.map((model) => model.id));

        return Object.entries(nicknames).filter(([id]) => !listed.has(id));
    }, [models, catalog, nicknames]);

    const visibleIds = favorites.map((model) => model.id);

    return (
        <SettingsCard
            description={t`Order the models you starred in the model picker and give them your own names. A nickname shows in the picker, the composer and on replies.`}
            title={t`Favorite models`}
        >
            {favorites.length === 0 ? (
                <p className="text-muted-foreground py-3 text-sm">{t`Star a model in the model picker and it shows up here.`}</p>
            ) : (
                <Sortable
                    onMove={({ activeIndex, overIndex }) => {
                        const moved = visibleIds[activeIndex];
                        const target = visibleIds[overIndex];

                        if (moved && target) {
                            reorderFavorites(moved, target);
                        }
                    }}
                    value={visibleIds}
                >
                    <SortableContent render={<ul />}>
                        {favorites.map((model) => (
                            <SortableItem className={ROW_CLASS} key={model.id} render={<li />} value={model.id}>
                                <SortableItemHandle
                                    render={
                                        <Button
                                            aria-label={t`Reorder ${getModelLabel(model, nicknames)}`}
                                            className="size-8 shrink-0"
                                            size="icon"
                                            variant="ghost"
                                        >
                                            <GripVertical aria-hidden="true" />
                                        </Button>
                                    }
                                />
                                <ModelName model={model} nickname={nicknames[model.id]} />
                                <NicknameField model={model} nickname={nicknames[model.id]} onCommit={setNickname} />
                            </SortableItem>
                        ))}
                    </SortableContent>
                    <SortableOverlay>
                        <div className="bg-primary/10 h-11 rounded-md" />
                    </SortableOverlay>
                </Sortable>
            )}

            {nicknamedOthers.length > 0 || retiredNicknames.length > 0 ? (
                <div className="border-border/50 border-t py-3">
                    <p className="text-muted-foreground text-xs font-medium">{t`Other models with a nickname`}</p>
                    <ul>
                        {nicknamedOthers.map((model) => (
                            <li className={ROW_CLASS} key={model.id}>
                                <ModelName model={model} nickname={nicknames[model.id]} />
                                <NicknameField model={model} nickname={nicknames[model.id]} onCommit={setNickname} />
                            </li>
                        ))}
                        {retiredNicknames.map(([id, nickname]) => (
                            <li className={ROW_CLASS} key={id}>
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium">{nickname}</p>
                                    <p className="text-muted-foreground truncate font-mono text-xs">{id}</p>
                                </div>
                                <Button aria-label={t`Remove nickname for ${id}`} onClick={() => setNickname(id, "")} size="sm" variant="ghost">
                                    {t`Remove`}
                                </Button>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </SettingsCard>
    );
};

export default FavoriteModelsSettings;
