import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_BASE_URL } from "./server-process";

export type CameraListInfo = {
    path: string;
    name: string;
    connected: boolean;
};

export type CameraInfo = {
    cameraPath: string;
    drivePath: string;
    boardId: string;
    boardType: string;
    name: string;
    sensor: string;
    fwVersion: string;
    latestFwVersion: string;
    protocolVersion: number;
};

class OpenMV extends EventEmitter {
    #connectedPath: string | null = null;
    #connected = false;
    #running = false;
    #info: CameraInfo | null = null;
    #statusAbort: AbortController | null = null;
    #client!: Client;
    #ready: Promise<void> | null = null;

    init(version: string) {
        this.#client = new Client({ name: "openmv-vscode", version });
    }

    isConnected(): boolean {
        return this.#connected;
    }

    isRunning(): boolean {
        return this.#running;
    }

    getConnectedPath(): string | null {
        return this.#connectedPath;
    }

    #ensureReady(): Promise<void> {
        if (!this.#ready) {
            this.#ready = this.#client
                .connect(
                    new StreamableHTTPClientTransport(
                        new URL(`${MCP_BASE_URL}/mcp`),
                    ),
                )
                .catch((e) => {
                    this.#ready = null;
                    throw e;
                });
        }
        return this.#ready;
    }

    async #callTool<T>(
        name: string,
        args: Record<string, unknown> = {},
    ): Promise<T> {
        await this.#ensureReady();
        const result = (await this.#client.callTool(
            { name, arguments: args },
            undefined,
            { timeout: 30000 },
        )) as {
            content?: Array<{ type: string; text?: string }>;
            isError?: boolean;
        };
        const content = result.content;
        if (result.isError) {
            const msg =
                Array.isArray(content) && content[0]?.text
                    ? content[0].text
                    : "tool error";
            throw new Error(`${name}: ${msg}`);
        }
        if (Array.isArray(content) && content.length > 0) {
            const first = content[0];
            if (first.type === "text" && typeof first.text === "string") {
                try {
                    return JSON.parse(first.text) as T;
                } catch {
                    return first.text as unknown as T;
                }
            }
            if (first.type === "image") {
                return first as unknown as T;
            }
        }
        return result as T;
    }

    async scan(): Promise<CameraListInfo[]> {
        return await this.#callTool<CameraListInfo[]>("camera_list", {});
    }

    getInfo(): CameraInfo | null {
        return this.#info;
    }

    async connect(path: string) {
        await this.#callTool("camera_connect", { cameraPath: path });
        this.#closeStatusStream();
        this.#connectedPath = path;
        this.#info = await this.#callTool<CameraInfo>("camera_info", {
            cameraPath: path,
        });
        void this.#openStatusStream();
    }

    async disconnect() {
        const p = this.#connectedPath;
        if (!p) return;
        await this.#callTool("camera_disconnect", { cameraPath: p });
        this.#closeStatusStream();
        this.#setConnected(false);
    }

    async boot() {
        const p = this.#connectedPath;
        if (!p) throw new Error("camera not connected");
        await this.#callTool("camera_boot", { cameraPath: p });
        this.#closeStatusStream();
        this.#setConnected(false);
    }

    async runScript(script: string) {
        const p = this.#connectedPath;
        if (!p) throw new Error("camera not connected");
        await this.#callTool("script_run", { cameraPath: p, script });
    }

    async stopScript() {
        const p = this.#connectedPath;
        if (!p) throw new Error("camera not connected");
        await this.#callTool("script_stop", { cameraPath: p });
    }

    async enableFrame(enable: boolean) {
        const p = this.#connectedPath;
        if (!p) throw new Error("camera not connected");
        await this.#callTool("frame_enable", { cameraPath: p, enable });
    }

    async captureFrame(): Promise<string | null> {
        const p = this.#connectedPath;
        if (!p) return null;
        const result = await this.#callTool<{ type?: string; data?: string }>(
            "frame_capture",
            { cameraPath: p },
        );
        return result?.data ?? null;
    }

    #setConnected(connected: boolean) {
        if (this.#connected !== connected) {
            this.#connected = connected;
            this.emit("connected", connected);
        }
        if (!connected) {
            this.#setRunning(false);
            this.#info = null;
        }
    }

    #setRunning(running: boolean) {
        if (this.#running !== running) {
            this.#running = running;
            this.emit("running", running);
        }
    }

    async #openStatusStream() {
        if (!this.#connectedPath) return;
        const cameraPath = this.#connectedPath;
        const ctrl = new AbortController();
        this.#statusAbort = ctrl;
        const url = `${MCP_BASE_URL}/stream/status?camera=${encodeURIComponent(cameraPath)}`;
        try {
            const res = await fetch(url, {
                headers: { Accept: "text/event-stream" },
                signal: ctrl.signal,
            });
            if (!res.ok || !res.body) {
                throw new Error(`status stream HTTP ${res.status}`);
            }
            const handleEvent = (block: string) => {
                const dataLines: string[] = [];
                for (const line of block.split("\n")) {
                    if (line.startsWith("data:")) {
                        dataLines.push(line.slice(5).replace(/^ /, ""));
                    }
                }
                if (dataLines.length === 0) return;
                const msg = JSON.parse(dataLines.join("\n"));
                if (msg.error) {
                    throw new Error(msg.error);
                }
                if (typeof msg.connected === "boolean") {
                    if (!msg.connected) {
                        this.#closeStatusStream();
                    }
                    this.#setConnected(msg.connected);
                }
                if (typeof msg.script_running === "boolean") {
                    this.#setRunning(msg.script_running);
                }
            };
            const decoder = new TextDecoder();
            const reader = res.body.getReader();
            try {
                let buf = "";
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });
                    while (true) {
                        const idx = buf.search(/\r?\n\r?\n/);
                        if (idx === -1) break;
                        const block = buf.slice(0, idx);
                        buf = buf.slice(idx + (buf[idx] === "\r" ? 4 : 2));
                        if (block.length > 0) handleEvent(block);
                    }
                }
            } finally {
                reader.releaseLock();
            }
        } catch (e) {
            if (e instanceof Error && e.name === "AbortError") return;
            if (this.#statusAbort === ctrl) {
                if (this.#connectedPath === cameraPath) {
                    this.#closeStatusStream();
                    this.#setConnected(false);
                }
            }
            this.emit("error", e);
            return;
        }
        if (this.#statusAbort === ctrl) {
            this.#statusAbort = null;
            if (this.#connectedPath === cameraPath) this.#closeStatusStream();
        }
    }

    #closeStatusStream() {
        const ctrl = this.#statusAbort;
        this.#statusAbort = null;
        this.#connectedPath = null;
        try {
            ctrl?.abort();
        } catch {}
    }
}

export const openmv = new OpenMV();
