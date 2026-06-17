import * as vscode from "vscode";
import { openmv } from "./openmv";
import { MCP_BASE_URL } from "./server-process";

let currentStreamUrl: string | null = null;
let selectedFolder: vscode.Uri | null = null;

async function selectFrameSaveFolder() {
    const uris = await vscode.window.showOpenDialog({
        defaultUri: vscode.workspace.workspaceFolders?.[0].uri,
        canSelectMany: false,
        canSelectFiles: false,
        canSelectFolders: true,
    });
    if (!uris) return;
    selectedFolder = uris[0];
}

async function saveFrame() {
    if (!selectedFolder) {
        vscode.window.showErrorMessage(
            vscode.l10n.t("Please select a folder first"),
            { modal: true },
        );
        return;
    }
    const base64 = await openmv.captureFrame();
    if (!base64) {
        vscode.window.showErrorMessage(vscode.l10n.t("No frame available"), {
            modal: true,
        });
        return;
    }
    const content = new Uint8Array(Buffer.from(base64, "base64"));
    const file = vscode.Uri.joinPath(selectedFolder, `${Date.now()}.jpeg`);
    await vscode.workspace.fs.writeFile(file, content);
}

function renderHtml(streamUrl: string | null): string {
    if (!streamUrl) {
        return `<!doctype html><html><head><style>html,body{margin:0!important;padding:0!important;width:100%;height:100%;background:#000}</style></head><body></body></html>`;
    }
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https:; style-src 'unsafe-inline'"><style>html,body{margin:0!important;padding:0!important;width:100%;height:100%;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden}</style></head><body><img src="${streamUrl}" style="width:100%;height:100%;object-fit:contain;display:block"/></body></html>`;
}

class FrameWebviewViewProvider implements vscode.WebviewViewProvider {
    public view: vscode.WebviewView | null = null;

    resolveWebviewView(webviewView: vscode.WebviewView) {
        webviewView.webview.options = { enableScripts: false };
        webviewView.webview.html = renderHtml(currentStreamUrl);
        this.view = webviewView;
    }

    refresh() {
        if (this.view) {
            this.view.webview.html = renderHtml(currentStreamUrl);
        }
    }
}

export function initFrameView(context: vscode.ExtensionContext) {
    const provider = new FrameWebviewViewProvider();
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider("openmv-frameView", provider),
        vscode.commands.registerCommand(
            "openmv.selectFrameSaveFolder",
            selectFrameSaveFolder,
        ),
        vscode.commands.registerCommand("openmv.saveFrame", saveFrame),
    );

    openmv.on("connected", (isConnected: boolean) => {
        if (!isConnected) return;
        const path = openmv.getConnectedPath();
        if (!path) return;
        currentStreamUrl = `${MCP_BASE_URL}/stream/frame?camera=${encodeURIComponent(path)}`;
        provider.refresh();
    });

    openmv.on("running", (isRunning: boolean) => {
        if (isRunning) {
            provider.view?.show(true);
        }
    });
}
