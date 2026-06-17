import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { getResourcesPath } from "./resource";

class ExampleItem extends vscode.TreeItem {
    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly filePath: string,
        command?: vscode.Command,
    ) {
        super(label, collapsibleState);
        this.tooltip = filePath;
        this.command = command;
    }
}

class ExamplesProvider implements vscode.TreeDataProvider<ExampleItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<
        ExampleItem | undefined
    >();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly root: string) {}

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: ExampleItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ExampleItem): ExampleItem[] {
        const dir = element ? element.filePath : this.root;
        return this.readDir(dir);
    }

    private readDir(dir: string): ExampleItem[] {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return [];
        }
        entries = entries.filter((e) => e.name !== "index.csv");
        entries.sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) {
                return a.isDirectory() ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });
        return entries.map((entry) => {
            const filePath = path.join(dir, entry.name);
            const isDir = entry.isDirectory();
            const state = isDir
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None;
            const command = isDir
                ? undefined
                : {
                      command: "openmv.openExample",
                      title: "Open Example",
                      arguments: [filePath],
                  };
            return new ExampleItem(entry.name, state, filePath, command);
        });
    }
}

interface SearchResultItem extends vscode.QuickPickItem {
    filePath: string;
}

async function collectPyFiles(root: string): Promise<string[]> {
    const results: string[] = [];
    async function walk(dir: string) {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else if (entry.isFile() && entry.name.endsWith(".py")) {
                results.push(full);
            }
        }
    }
    await walk(root);
    return results;
}

async function openExample(filePath: string) {
    const content = await fs.promises.readFile(filePath, { encoding: "utf-8" });
    const document = await vscode.workspace.openTextDocument({
        content: `# ${path.basename(filePath)}\n\n${content}`,
        language: "python",
    });
    await vscode.window.showTextDocument(document);
}

async function searchExample(root: string) {
    const files = await collectPyFiles(root);
    const contents = await Promise.all(
        files.map(async (file) => ({
            file,
            content: await fs.promises.readFile(file, { encoding: "utf-8" }),
        })),
    );

    const quickPick = vscode.window.createQuickPick<SearchResultItem>();
    quickPick.canSelectMany = false;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.placeholder = vscode.l10n.t("Search examples...");
    quickPick.items = contents.map((item) => ({
        label: path.basename(item.file),
        description: path.relative(root, item.file),
        detail: "",
        filePath: item.file,
    }));
    quickPick.onDidChangeValue((value) => {
        const needle = value.toLowerCase();
        quickPick.items = contents.map((item) => {
            const matched = item.content
                .split(/\r?\n/)
                .filter((line) => line.toLowerCase().includes(needle))
                .map((line) => line.trim());
            return {
                label: path.basename(item.file),
                description: path.relative(root, item.file),
                detail: matched.join(" | "),
                filePath: item.file,
            };
        });
    });
    quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0];
        if (selected) openExample(selected.filePath);
        quickPick.hide();
    });
    quickPick.onDidHide(() => quickPick.dispose());
    quickPick.show();
}

export function initExamples(context: vscode.ExtensionContext) {
    const root = path.join(getResourcesPath(), "examples");
    const provider = new ExamplesProvider(root);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider("openmv-exampleView", provider),
        vscode.commands.registerCommand("openmv.openExample", openExample),
        vscode.commands.registerCommand("openmv.searchExample", () =>
            searchExample(root),
        ),
    );
}
