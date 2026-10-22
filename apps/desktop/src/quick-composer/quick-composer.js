// The Quick Composer is a LOCAL page: it hands the text to the main process,
// which shows the main window and has the web app open a new chat with it.
// Its preload exposes exactly `quickCompose` and `closeQuickComposer`.
const { closeQuickComposer, quickCompose } = globalThis.neoreQuickComposer;

const form = document.querySelector("#composer");
const prompt = document.querySelector("#prompt");
const status = document.querySelector("#status");

const send = async () => {
    const text = prompt.value.trim();

    if (!text) {
        return;
    }

    try {
        await quickCompose(text);
        prompt.value = "";
        status.textContent = "";
    } catch (error) {
        status.textContent = String(error instanceof Error ? error.message : error);
    }
};

form.addEventListener("submit", (event) => {
    event.preventDefault();
    send();
});

prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send();
    } else if (event.key === "Escape") {
        closeQuickComposer();
    }
});

// The window is hidden, not destroyed, between uses.
window.addEventListener("focus", () => prompt.focus());
