import * as fs from "node:fs";
import * as path from "node:path";
import { execa } from "execa";
import type * as vscode from "vscode";

export const MCP_HOST = "127.0.0.1";
export const MCP_PORT = 15257;
export const MCP_BASE_URL = `http://${MCP_HOST}:${MCP_PORT}`;
const START_TIMEOUT_MS = 5000;

function bundledServerPath(context: vscode.ExtensionContext): string {
    const exe =
        process.platform === "win32"
            ? "openmv_mcp_server.exe"
            : "openmv_mcp_server";
    const target = `${process.platform}-${process.arch}`;
    return path.join(
        context.extensionUri.fsPath,
        "tools",
        "mcp-server",
        target,
        exe,
    );
}

export async function ensureServer(
    context: vscode.ExtensionContext,
): Promise<void> {
    const bin = bundledServerPath(context);
    if (!fs.existsSync(bin)) {
        throw new Error(
            `bundled openmv_mcp_server missing for ${process.platform}-${process.arch}: ${bin}`,
        );
    }

    await execa(bin, ["--port", String(MCP_PORT)], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: START_TIMEOUT_MS,
        windowsHide: true,
    });
}
