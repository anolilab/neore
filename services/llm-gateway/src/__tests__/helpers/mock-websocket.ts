/**
 * WebSocket double for the realtime proxy tests.
 *
 * Cloudflare's `WebSocketPair` and its accept/send/close surface do not exist
 * in Node, so the tests stub both with this EventTarget-based stand-in.
 */
export class MockWebSocket extends EventTarget {
    readyState = 1; // OPEN

    sentMessages: (string | ArrayBuffer)[] = [];

    closed = false;

    accept() {
        /* no-op */
    }

    send(data: string | ArrayBuffer) {
        if (!this.closed) {
            this.sentMessages.push(data);
        }
    }

    close() {
        if (this.closed) {
            return;
        }

        this.closed = true;
        this.dispatchEvent(new Event("close"));
    }

    /** Test helper: simulate receiving a message from this end. */
    receive(data: string | ArrayBuffer) {
        const messageEvent = Object.assign(new Event("message"), { data }) as MessageEvent;

        this.dispatchEvent(messageEvent);
    }
}
