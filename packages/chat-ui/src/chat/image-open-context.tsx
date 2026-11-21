import { createContext, use } from "react";

/**
 * Opens the thread's image gallery at the image with this key (`utils/thread-images.ts`). Provided by the app; without
 * a provider, tool images render as plain images.
 */
export const ImageOpenContext = createContext<((key: string) => void) | null>(null);

/** The gallery opener, or `null` when the app shows no gallery. */
export const useImageOpener = (): ((key: string) => void) | null => use(ImageOpenContext);
