import type { ThreadTag } from "@/features/chat/tags/thread-tag-logic";

// Type definitions for thread hierarchy
export interface BranchNode {
    branchPoint: number;
    branchType: string;
    category?: string; // AI-assigned category
    children: BranchNode[];
    createdAt: number;
    depth: number;
    expiresAt?: number; // Present if thread is temporary
    isPinned?: boolean;
    model?: string;
    order?: number;
    projectId?: string; // Project ID if thread belongs to a project
    relevantMessages?: any[]; // Messages that matched the search query
    source?: string; // "telegram" | "slack" | "discord" | undefined (web)
    statelessMode?: boolean; // Present if thread is in stateless mode
    status: string;
    tagIds?: string[]; // User-defined tag ids
    tags?: ThreadTag[]; // `tagIds` resolved against the user's tags, in display order
    threadId: string;
    title: string;
}

export interface ThreadGroup {
    groupType?: GroupType;
    isCollapsed?: boolean;
    projectColor?: string;
    projectIcon?: string;
    projectId?: string;
    threads: BranchNode[];
    title: string;
}

export type GroupType = "pinned" | "temporary" | "stateless" | "project" | "today" | "last7days" | "lastMonth" | "older" | "archived";

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
    setShowSearch: SetStateFunction<boolean>;
    showKeyboardHelp: boolean;
    threadSearchResults: any;
    toggleExpanded: (threadId: string) => void;
    toggleGroupCollapsed: (groupType: GroupType, projectId?: string) => void;
}

// Define a minimal type for threadRelationships to avoid deep type recursion
export type MinimalThreadRelationship = { parentThreadId?: string; threadId: string };
