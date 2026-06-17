import * as semver from "semver";
import * as vscode from "vscode";
import { type CameraListInfo, openmv } from "./openmv";
import { toMessage } from "./utils";

class PortQuickPickItem implements vscode.QuickPickItem {
    public label: string;
    public description: string;
    public constructor(public port: CameraListInfo) {
        this.label = port.name;
        this.description = port.path;
    }
}

function checkUpdate(current: string, latest: string) {
    if (!current || !latest) return;
    if (!semver.valid(current) || !semver.valid(latest)) return;
    if (!semver.lt(current, latest)) return;
    const updateLabel = vscode.l10n.t("Update");
    vscode.window
        .showInformationMessage(
            vscode.l10n.t("New firmware available ({0})", latest),
            updateLabel,
            vscode.l10n.t("Cancel"),
        )
        .then((value) => {
            if (value === updateLabel) {
                vscode.commands.executeCommand("openmv.update");
            }
        });
}

function getCurrentEditorText(languageId = "python"): string | null {
    let editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== languageId) {
        editor = undefined;
    }
    if (!editor) {
        editor = vscode.window.visibleTextEditors.find(
            (x) => x.document.languageId === languageId,
        );
    }
    if (!editor) {
        vscode.window.showInformationMessage(
            vscode.l10n.t("Please open a Python file"),
        );
        return null;
    }
    return editor.document.getText();
}

export function initStatusBar(context: vscode.ExtensionContext) {
    const connectStatusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        20,
    );
    connectStatusBarItem.text = vscode.l10n.t("$(link) Connect");
    connectStatusBarItem.command = "openmv.connect";

    const disconnectStatusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        20,
    );
    disconnectStatusBarItem.text = vscode.l10n.t("$(sync-ignored) Disconnect");
    disconnectStatusBarItem.command = "openmv.disconnect";

    const runStatusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        10,
    );
    runStatusBarItem.text = vscode.l10n.t("$(debug-start) Run");
    runStatusBarItem.command = "openmv.runScript";

    const stopStatusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        10,
    );
    stopStatusBarItem.text = vscode.l10n.t("$(debug-stop) Stop");
    stopStatusBarItem.command = "openmv.stopScript";

    const driveStatusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        99,
    );
    driveStatusBarItem.command = "openmv.drive";

    const firmwareStatusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        98,
    );
    firmwareStatusBarItem.command = "openmv.update";

    context.subscriptions.push(connectStatusBarItem);
    context.subscriptions.push(disconnectStatusBarItem);
    context.subscriptions.push(runStatusBarItem);
    context.subscriptions.push(stopStatusBarItem);
    context.subscriptions.push(driveStatusBarItem);
    context.subscriptions.push(firmwareStatusBarItem);
    connectStatusBarItem.show();
    disconnectStatusBarItem.hide();
    runStatusBarItem.hide();
    stopStatusBarItem.hide();
    driveStatusBarItem.hide();
    firmwareStatusBarItem.hide();

    async function connectCommand() {
        const ports = await openmv.scan();
        if (ports.length === 0) {
            vscode.window.showErrorMessage(
                vscode.l10n.t("No serial port found"),
            );
            return;
        }
        if (ports.length === 1) {
            await openmv.connect(ports[0].path);
            return;
        }
        const items = ports.map((port) => new PortQuickPickItem(port));
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: vscode.l10n.t("Select a serial port"),
        });
        if (selected) {
            await openmv.connect(selected.port.path);
        }
    }

    async function disconnectCommand() {
        await openmv.disconnect();
    }

    async function runCommand() {
        if (!openmv.isConnected()) {
            vscode.window.showErrorMessage(
                vscode.l10n.t("Please connect a camera first"),
            );
            return;
        }
        const code = getCurrentEditorText();
        if (!code) {
            return;
        }
        await openmv.enableFrame(true);
        await openmv.runScript(code);
    }

    async function stopCommand() {
        if (!openmv.isConnected()) {
            vscode.window.showErrorMessage(
                vscode.l10n.t("Please connect a camera first"),
            );
            return;
        }
        await openmv.stopScript();
    }

    async function driveCommand() {
        const drive = openmv.getInfo()?.drivePath;
        if (!drive) return;
        await vscode.env.openExternal(vscode.Uri.file(drive));
    }

    context.subscriptions.push(
        vscode.commands.registerCommand("openmv.connect", connectCommand),
        vscode.commands.registerCommand("openmv.disconnect", disconnectCommand),
        vscode.commands.registerCommand("openmv.runScript", runCommand),
        vscode.commands.registerCommand("openmv.stopScript", stopCommand),
        vscode.commands.registerCommand("openmv.drive", driveCommand),
    );

    function syncButtons() {
        if (!openmv.isConnected()) {
            connectStatusBarItem.show();
            disconnectStatusBarItem.hide();
            runStatusBarItem.hide();
            stopStatusBarItem.hide();
            driveStatusBarItem.hide();
            return;
        }
        connectStatusBarItem.hide();
        disconnectStatusBarItem.show();
        if (openmv.isRunning()) {
            runStatusBarItem.hide();
            stopStatusBarItem.show();
        } else {
            runStatusBarItem.show();
            stopStatusBarItem.hide();
        }
        const drive = openmv.getInfo()?.drivePath;
        if (drive) {
            driveStatusBarItem.text = `$(file-directory) ${drive}`;
            driveStatusBarItem.show();
        } else {
            driveStatusBarItem.hide();
        }
    }

    openmv.on("connected", syncButtons);
    openmv.on("running", syncButtons);

    openmv.on("connected", (isConnected: boolean) => {
        const info = openmv.getInfo();
        if (isConnected && info) {
            firmwareStatusBarItem.text = vscode.l10n.t(
                "$(info) Firmware {0}",
                info.fwVersion,
            );
            firmwareStatusBarItem.tooltip = vscode.l10n.t(
                "Latest: {0}",
                info.latestFwVersion || vscode.l10n.t("unknown"),
            );
            firmwareStatusBarItem.show();
            checkUpdate(info.fwVersion, info.latestFwVersion);
        } else {
            firmwareStatusBarItem.hide();
        }
    });

    openmv.on("error", (err: unknown) => {
        vscode.window.showErrorMessage(
            vscode.l10n.t("OpenMV: {0}", toMessage(err)),
        );
    });
}
