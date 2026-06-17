import type * as vscode from "vscode";
import { initExamples } from "./examples";
import { initFirmware } from "./firmware";
import { initFrameView } from "./frame";
import { openmv } from "./openmv";
import { ensureResources } from "./resource";
import { ensureServer } from "./server-process";
import { initStatusBar } from "./status-bar";
import { initTerminal } from "./terminal";

export async function activate(context: vscode.ExtensionContext) {
    openmv.init(context.extension.packageJSON.version);
    await ensureResources(context);
    await ensureServer(context);
    initStatusBar(context);
    initTerminal(context);
    initFrameView(context);
    initFirmware(context);
    initExamples(context);
}

export function deactivate() {}
