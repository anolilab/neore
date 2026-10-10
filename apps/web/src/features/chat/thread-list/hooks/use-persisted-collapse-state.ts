import { useLocalstorageState } from "rooks";

import type { GroupType } from "../types";

const COLLAPSED_GROUPS_STORAGE_KEY = "neore-collapsed-groups";
const COLLAPSED_PROJECTS_STORAGE_KEY = "neore-collapsed-projects";

/**
 * Hook to persist collapse state of thread groups and projects to localStorage
 * Uses rooks' useLocalstorageState with Set/Array conversion.
 */
const usePersistedCollapseState = () => {
    // Store as arrays in localStorage, convert to Sets for use
    // Default: archived group is collapsed by default
    const [collapsedGroupsArray, setCollapsedGroupsArray] = useLocalstorageState<GroupType[]>(COLLAPSED_GROUPS_STORAGE_KEY, ["archived"]);

    const [collapsedProjectsArray, setCollapsedProjectsArray] = useLocalstorageState<string[]>(COLLAPSED_PROJECTS_STORAGE_KEY, []);

    // Convert arrays to Sets for use
    const collapsedGroups = new Set(collapsedGroupsArray);
    const collapsedProjects = new Set(collapsedProjectsArray);

    // Wrapper functions to convert Set operations to array operations
    // Optimized to avoid unnecessary updates when values haven't changed
    const setCollapsedGroups = (value: Set<GroupType> | ((previous: Set<GroupType>) => Set<GroupType>)) => {
        if (typeof value === "function") {
            setCollapsedGroupsArray((previous) => {
                const previousSet = new Set(previous);
                const nextSet = value(previousSet);

                // Only update if actually changed
                if (previousSet.size === nextSet.size && [...previousSet].every((x) => nextSet.has(x))) {
                    return previous;
                }

                return [...nextSet];
            });
        } else {
            // Check if arrays are equal before updating
            const currentArray = collapsedGroupsArray;

            if (currentArray.length === value.size && currentArray.every((x) => value.has(x))) {
                return;
            }

            setCollapsedGroupsArray([...value]);
        }
    };

    const setCollapsedProjects = (value: Set<string> | ((previous: Set<string>) => Set<string>)) => {
        if (typeof value === "function") {
            setCollapsedProjectsArray((previous) => {
                const previousSet = new Set(previous);
                const nextSet = value(previousSet);

                // Only update if actually changed
                if (previousSet.size === nextSet.size && [...previousSet].every((x) => nextSet.has(x))) {
                    return previous;
                }

                return [...nextSet];
            });
        } else {
            // Check if arrays are equal before updating
            const currentArray = collapsedProjectsArray;

            if (currentArray.length === value.size && currentArray.every((x) => value.has(x))) {
                return;
            }

            setCollapsedProjectsArray([...value]);
        }
    };

    return {
        collapsedGroups,
        collapsedProjects,
        setCollapsedGroups,
        setCollapsedProjects,
    };
};

export default usePersistedCollapseState;
