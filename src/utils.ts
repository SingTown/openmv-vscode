import * as crypto from "node:crypto";
import * as vscode from "vscode";

export async function downloadToBuffer(
    url: string,
    title: string,
): Promise<Buffer> {
    return await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title,
            cancellable: false,
        },
        async (progress) => {
            const res = await fetch(url);
            if (!res.ok || !res.body) {
                throw new Error(`download failed: HTTP ${res.status}`);
            }
            const total = Number(res.headers.get("content-length")) || 0;
            let received = 0;
            let lastPct = 0;
            const chunks: Buffer[] = [];
            for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
                chunks.push(Buffer.from(chunk));
                received += chunk.byteLength;
                if (total > 0) {
                    const pct = Math.floor((received / total) * 100);
                    if (pct > lastPct) {
                        progress.report({
                            increment: pct - lastPct,
                            message: `${pct}%`,
                        });
                        lastPct = pct;
                    }
                } else {
                    progress.report({
                        message: `${(received / 1024 / 1024).toFixed(1)} MB`,
                    });
                }
            }
            return Buffer.concat(chunks);
        },
    );
}

export function tempSuffix(): string {
    return `${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
}

export function toMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
