import * as vscode from "vscode";
import { openmv } from "./openmv";
import { MCP_BASE_URL } from "./server-process";

export function initTerminal(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel("OpenMV", "Log");
    context.subscriptions.push(outputChannel);

    let abort: AbortController | null = null;

    async function startStream(cameraPath: string, ctrl: AbortController) {
        const url = `${MCP_BASE_URL}/stream/terminal?camera=${encodeURIComponent(cameraPath)}`;
        try {
            const res = await fetch(url, { signal: ctrl.signal });
            if (!res.ok || !res.body) {
                throw new Error(`terminal stream HTTP ${res.status}`);
            }
            const decoder = new TextDecoder();
            const reader = res.body.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const text = decoder.decode(value, { stream: true });
                    if (text) {
                        outputChannel.append(text);
                        outputChannel.show(true);
                    }
                }
            } finally {
                reader.releaseLock();
            }
        } catch (e) {
            if (e instanceof Error && e.name === "AbortError") return;
            openmv.emit("error", e);
        }
    }

    openmv.on("connected", (isConnected: boolean) => {
        abort?.abort();
        abort = null;
        if (!isConnected) return;
        const cameraPath = openmv.getConnectedPath();
        if (!cameraPath) return;
        const ctrl = new AbortController();
        abort = ctrl;
        void startStream(cameraPath, ctrl);
    });
}
