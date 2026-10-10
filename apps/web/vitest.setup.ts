import { afterEach, beforeEach, vi } from "vitest";

// Conditionally import browser cleanup only in browser mode
// Unit tests run in node/jsdom mode and don't need browser cleanup
const isBrowserMode = globalThis.window !== undefined && process.env.VITEST_BROWSER === "true";

if (isBrowserMode) {
    try {
        // Dynamic import for browser-only code
        const { cleanup } = await import("vitest-browser-react");

        afterEach(() => {
            cleanup();
        });
    } catch {
        // Ignore if not available (unit test mode)
    }
}

// jsdom provides native localStorage, but it may not be initialized when setup runs
// Provide a localStorage mock that works with jsdom's implementation
// The mock will be used until jsdom initializes, then jsdom's localStorage takes over
(function setUpLocalStorageMock() {
    // Skip if localStorage is already available and functional
    if (globalThis.window !== undefined && globalThis.localStorage && typeof localStorage.setItem === "function") {
        return;
    }

    if (globalThis.localStorage !== undefined && typeof localStorage.setItem === "function") {
        return;
    }

    // Create a simple localStorage mock
    const storage: Record<string, string> = {};
    const localStorageMock = {
        clear: () => {
            Object.keys(storage).forEach((key) => delete storage[key]);
        },
        getItem: (key: string) => storage[key] || null,
        key: (index: number) => Object.keys(storage)[index] || null,
        get length() {
            return Object.keys(storage).length;
        },
        removeItem: (key: string) => {
            delete storage[key];
        },
        setItem: (key: string, value: string) => {
            storage[key] = value;
        },
    };

    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: localStorageMock,
        writable: true,
    });

    if (globalThis.window !== undefined) {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            value: localStorageMock,
            writable: true,
        });
    }
})();

// Mock global objects that might not be available in test environment
beforeEach(() => {
    // Mock ResizeObserver, IntersectionObserver and matchMedia
    Object.defineProperties(globalThis, {
        IntersectionObserver: {
            configurable: true,
            value: vi.fn().mockImplementation(() => {
                return {
                    disconnect: vi.fn(),
                    observe: vi.fn(),
                    unobserve: vi.fn(),
                };
            }),
            writable: true,
        },
        matchMedia: {
            configurable: true,
            value: vi.fn().mockImplementation((query) => {
                return {
                    addEventListener: vi.fn(),
                    addListener: vi.fn(), // deprecated
                    dispatchEvent: vi.fn(),
                    matches: false,
                    media: query,
                    onchange: null,
                    removeEventListener: vi.fn(),
                    removeListener: vi.fn(), // deprecated
                };
            }),
            writable: true,
        },
        ResizeObserver: {
            configurable: true,
            value: vi.fn().mockImplementation(() => {
                return {
                    disconnect: vi.fn(),
                    observe: vi.fn(),
                    unobserve: vi.fn(),
                };
            }),
            writable: true,
        },
    });

    // Mock scrollTo
    if (globalThis.window !== undefined) {
        Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: vi.fn(), writable: true });
    }
});
