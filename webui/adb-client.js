// ADB over a byte pipe. The libraries and the WebSocket are passed in rather than imported so this
// module resolves in a browser tab (CDN ESM + browser WebSocket) and in node (node_modules + global
// WebSocket) without a bundler or a build step. That is what lets the page be tested headlessly.

export function webSocketStreams(socket) {
    // A browser gives no raw TCP, so the relay's WebSocket stands in for the socket.
    socket.binaryType = "arraybuffer";
    const readable = new ReadableStream({
        start(controller) {
            socket.onmessage = (event) => controller.enqueue(new Uint8Array(event.data));
            socket.onclose = () => controller.close();
            socket.onerror = () => controller.error(new Error("the connection to the relay dropped"));
        },
    });
    const writable = new WritableStream({
        write(chunk) {
            if (socket.readyState !== WebSocket.OPEN) {
                throw new Error("the connection to the relay closed");
            }
            socket.send(chunk);
        },
    });
    return { readable, writable, socket };
}

function opened(socket, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer from the relay within ${timeoutMs / 1000}s`)), timeoutMs);
        socket.onopen = () => {
            clearTimeout(timer);
            resolve();
        };
        socket.onerror = () => {
            clearTimeout(timer);
            reject(new Error("the relay refused the connection — a wrong token, a blocked origin or a stopped relay all look like this"));
        };
    });
}

export async function openAdb({ lib, stream, url, credentialManager, serial = "", onEvent = () => {}, socketFactory = (target) => new WebSocket(target) }) {
    const socket = socketFactory(url);
    socket.binaryType = "arraybuffer";
    await opened(socket, 10000);
    const { readable, writable } = webSocketStreams(socket);
    const connection = {
        readable: readable.pipeThrough(new stream.StructDeserializeStream(lib.AdbPacket)),
        writable: (() => {
            const framed = new lib.AdbPacketSerializeStream();
            framed.readable.pipeTo(new stream.Consumable.WrapWritableStream(writable)).catch(() => {});
            return framed.writable;
        })(),
    };
    const transport = await lib.adbDaemonAuthenticate({
        serial,
        connection,
        credentialManager,
        // These fire from the device's own auth replies, so the page can report "approve it on the TV" at
        // the moment the TV is asked instead of guessing after a timer. `waiting-for-tv` is emitted right
        // before the public key is offered, which is exactly when adbd raises the Allow dialog.
        onKeyLoadError: (error) => onEvent({ type: "key-error", message: error?.message || String(error) }),
        onSignatureAuthentication: (key) => onEvent({ type: "signing", ...key }),
        onSignatureRejected: (key) => onEvent({ type: "rejected", ...key }),
        onPublicKeyAuthentication: (key) => onEvent({ type: "waiting-for-tv", ...key }),
    });
    const adb = new lib.Adb(transport);
    return { adb, close: () => socket.close() };
}

// One string handed to /system/bin/sh on the TV, like `adb shell <cmd>`. The `exec:` service is what
// `adb exec-out` uses: same command execution, no pty, so no CR bytes to strip and the library hands
// back decoded text. (`shell:exec-out …` does NOT work — the TV then runs a binary named exec-out.)
export function shellFor(adb) {
    return (command) => adb.createSocketAndWait(`exec:${command}`);
}
