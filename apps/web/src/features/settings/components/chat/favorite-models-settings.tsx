"use client";

import { useLingui } from "@lingui/react/macro";
import type { GatewayModel } from "@neore/ai/models";
import { ProviderIcon } from "@neore/ui/components/ai-elements/provider-icon";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Input } from "@neore/ui/components/input";
import { Sortable, SortableContent, SortableItem, SortableItemHandle, SortableOverlay } from "@neore/ui/components/ui/sortable";
import { GripVertical } from "lucide-react";
import type { FC } from "react";
import { useMemo, useState } from "react";

import { getModelLabel, moveFavorite } from "@/components/model-picker/utilities";
import useFavoriteModels from "@/features/chat/core/hooks/use-favorite-models";
import useModelNicknames from "@/features/chat/core/hooks/use-model-nicknames";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";

// Matches `MAX_MODEL_NICKNAME_LENGTH` in `backend/lunora/auth/lib/model-nicknames.ts`.
const NICKNAME_MAX_LENGTH = 60;

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
    const models = useFeatureFlaggedModels();
    const { favoriteModelIds, reorderFavorites } = useFavoriteModels();
    const { nicknames, setNickname } = useModelNicknames();

    // Favourites the catalog still offers, in the user's order. A hidden or retired favourite keeps its place in the stored list.
    const favorites = useMemo(() => {
        const byId = new Map(models.map((model) => [model.id, model]));

        return favoriteModelIds.flatMap((id) => {
            const model = byId.get(id);

            return model ? [model] : [];
        });
    }, [favoriteModelIds, models]);

    // A nickname outlives the star, so it must stay editable here.
    const nicknamedOthers = useMemo(() => {
        const starred = new Set(favoriteModelIds);

        return models.filter((model) => nicknames[model.id] && !starred.has(model.id));
    }, [favoriteModelIds, models, nicknames]);

    const visibleIds = favorites.map((model) => model.id);

    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-muted-foreground text-[10px] font-semibold tracking-widest uppercase">{t`Favourite models`}</CardTitle>
                <CardDescription className="text-muted-foreground mt-1 text-xs">
                    {t`Order the models you starred in the model picker and give them your own names. A nickname shows in the picker, the composer and on replies.`}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {favorites.length === 0 ? (
                    <p className="text-muted-foreground text-xs">{t`Star a model in the model picker and it shows up here.`}</p>
                ) : (
                    <Sortable
                        onMove={({ activeIndex, overIndex }) => {
                            const moved = visibleIds[activeIndex];
                            const target = visibleIds[overIndex];

                            if (moved && target) {
                                reorderFavorites(moveFavorite(favoriteModelIds, moved, target));
                            }
                        }}
                        value={visibleIds}
                    >
                        <SortableContent render={<ul className="space-y-1" />}>
                            {favorites.map((model) => (
                                <SortableItem
                                    className="bg-background flex items-center gap-2 rounded-md border px-2 py-1.5"
                                    key={model.id}
                                    render={<li />}
                                    value={model.id}
                                >
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

                {nicknamedOthers.length > 0 ? (
                    <div className="space-y-1">
                        <p className="text-muted-foreground text-xs font-medium">{t`Other models with a nickname`}</p>
                        <ul className="space-y-1">
                            {nicknamedOthers.map((model) => (
                                <li className="bg-background flex items-center gap-2 rounded-md border px-2 py-1.5" key={model.id}>
                                    <ModelName model={model} nickname={nicknames[model.id]} />
                                    <NicknameField model={model} nickname={nicknames[model.id]} onCommit={setNickname} />
                                </li>
                            ))}
                        </ul>
                    </div>
                ) : null}
            </CardContent>
        </Card>
    );
};

export default FavoriteModelsSettings;
