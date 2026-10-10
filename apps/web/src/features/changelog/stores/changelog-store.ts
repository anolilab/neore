import { create } from "zustand";

interface ChangelogStore {
    close: () => void;
    isOpen: boolean;
    open: () => void;
}

const useChangelogStore = create<ChangelogStore>((set) => {
    return {
        close: () => set({ isOpen: false }),
        isOpen: false,
        open: () => set({ isOpen: true }),
    };
});

export default useChangelogStore;
