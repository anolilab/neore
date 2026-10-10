// The Quick Composer is a LOCAL page: it hands the text to Rust, which shows
// the main window and has the web app open a new chat with it. Its capability
// grants exactly `quick_compose` and `close_quick_composer`.
const { invoke } = window.__TAURI__.core;

const form = document.querySelector("#composer");
const prompt = document.querySelector("#prompt");
const status = document.querySelector("#status");

const send = async () => {
    const text = prompt.value.trim();

    if (!text) {
        return;
    }

    try {
        await invoke("quick_compose", { text });
        prompt.value = "";
        status.textContent = "";
    } catch (error) {
        status.textContent = String(error);
    }
};

form.addEventListener("submit", (event) => {
    event.preventDefault();
    void send();
});

prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void send();
    } else if (event.key === "Escape") {
        void invoke("close_quick_composer");
    }
});

// The window is hidden, not destroyed, between uses.
window.addEventListener("focus", () => prompt.focus());
