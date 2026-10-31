import type { ThreadTag } from "@/features/chat/tags/thread-tag-logic";

// Type definitions for thread hierarchy
export interface BranchNode {
    /** Set while the thread waits for its owner: a tool approval or a question. Owned threads only. */
    awaitingInput?: "approval" | "question";
    branchPoint: number;
    branchType: string;
    category?: string; // AI-assigned category
    children: BranchNode[];
    createdAt: number;
    depth: number;
    expiresAt?: number; // Present if thread is temporary
    isPinned?: boolean;
    lastReplyAt?: number; // When the thread last got a reply (owned threads only)
    lastViewedAt?: number; // When its owner last opened it after a reply (owned threads only)
    lockedAt?: number; // Present while the chat has a passcode
    model?: string;
    order?: number;
    projectId?: string; // Project ID if thread belongs to a project
    relevantMessages?: any[]; // Messages that matched the search query
    snoozedUntil?: number; // Hidden from the main sections until then (owned threads only)
    source?: string; // "telegram" | "slack" | "discord" | undefined (web)
    statelessMode?: boolean; // Present if thread is in stateless mode
    status: string;
    tagIds?: string[]; // User-defined tag ids
    tags?: ThreadTag[]; // `tagIds` resolved against the user's tags, in display order
    threadId: string;
    title: string;
    updatedAt?: number; // Last activity, when the row recorded it
}

export interface ThreadGroup {
    groupType?: GroupType;
    isCollapsed?: boolean;
    /** A stand-in or derived group (stored project chats before the project list answers; Needs you, Working, Snoozed): read-only, nothing in it may be reordered or moved. */
    isPlaceholder?: boolean;
    projectColor?: string;
    projectIcon?: string;
    projectId?: string;
    threads: BranchNode[];
    title: string;
}

export type GroupType =
    "needsYou" | "working" | "snoozed" | "pinned" | "temporary" | "stateless" | "project" | "today" | "last7days" | "lastMonth" | "older" | "archived";

export interface LoadingStates {
    archiving: Set<string>;
    branching: Set<string>;
    deleting: Set<string>;
    downloading: Set<string>;
    pinning: Set<string>;
    reordering: boolean;
}

// Type that accepts both direct values and functional updates (compatible with React's useState and Zustand)
type SetStateFunction<T> = (value: T | ((previous: T) => T)) => void;

export interface HierarchicalThreadListProperties {
    collapsedGroups: Set<GroupType>;
    collapsedProjects: Set<string>;
    expandedThreads: Set<string>;
    isSearchLoading: boolean;
    isSelectionMode: boolean;
    lastSelectedIndex: number;
    loadingStates: LoadingStates;
    messageSearchResults: any;
    onExitSelectionMode: () => void;
    searchQuery: string;
    searchType: "threads" | "messages";
    selectedCategory?: string;
    selectedThreadIds: Set<string>;
    setLastSelectedIndex: SetStateFunction<number>;
    setLoadingStates: React.Dispatch<React.SetStateAction<LoadingStates>>;
    setSelectedThreadIds: SetStateFunction<Set<string>>;
    setShowKeyboardHelp: SetStateFunction<boolean>;
    showKeyboardHelp: boolean;
    threadSearchResults: any;
    toggleExpanded: (threadId: string) => void;
    toggleGroupCollapsed: (groupType: GroupType, projectId?: string) => void;
}

// Define a minimal type for threadRelationships to avoid deep type recursion
export type MinimalThreadRelationship = { parentThreadId?: string; threadId: string };
