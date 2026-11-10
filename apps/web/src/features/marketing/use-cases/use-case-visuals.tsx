import type { ComponentType } from "react";

import type { UseCaseSlug } from "./use-case-data";
import { ApprovalsVisual } from "./visuals/approvals-visual";
import { GroupChatsVisual } from "./visuals/group-chats-visual";
import { MemoryVisual } from "./visuals/memory-visual";
import { MessagingVisual } from "./visuals/messaging-visual";
import { RoutinesVisual } from "./visuals/routines-visual";

/** The animated visual for each use case. Typed per slug, so a new use case cannot ship without one. */
export const USE_CASE_VISUALS: Record<UseCaseSlug, ComponentType> = {
    approvals: ApprovalsVisual,
    "group-chats": GroupChatsVisual,
    memory: MemoryVisual,
    messaging: MessagingVisual,
    routines: RoutinesVisual,
};
