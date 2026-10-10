// Preload functions — call the same import paths as lazy() in canvas-panel.tsx to warm the module cache.
// Kept in a standalone file so consumers (e.g. document-artifact) don't pull in the full canvas-panel module graph.
export default function preloadCodemirrorEditor() {
    return import("./editors/canvas-codemirror-editor");
}
