import * as fs from "node:fs";
import * as path from "node:path";
import AdmZip from "adm-zip";
import * as semver from "semver";
import * as vscode from "vscode";
import { downloadToBuffer, tempSuffix } from "./utils";

const VERSION_URL =
    "https://raw.githubusercontent.com/openmv/openmv-ide-version/main/openmv-ide-resources-version-v2.txt";
const RELEASE_BASE_URL =
    "https://github.com/openmv/openmv-ide/releases/download";

let resourcesPath: string | null = null;

export function getResourcesPath(): string {
    if (!resourcesPath) {
        throw new Error("resources not initialized");
    }
    return resourcesPath;
}

export async function ensureResources(
    context: vscode.ExtensionContext,
): Promise<void> {
    const resourcesDir = path.join(
        context.globalStorageUri.fsPath,
        "resources",
    );

    let latest: string | null = null;
    try {
        latest = await fetchLatestVersion();
    } catch (e) {
        console.warn(
            `openmv resources: version fetch failed (${(e as Error).message}), falling back to local copy`,
        );
    }

    const effective = latest ?? findLatestLocalVersion(resourcesDir);
    if (!effective) {
        throw new Error(
            "could not fetch latest OpenMV resources version and no local copy is available",
        );
    }
    const versionDir = path.join(resourcesDir, effective);

    if (!fs.existsSync(versionDir)) {
        fs.mkdirSync(resourcesDir, { recursive: true });
        const downloadingDir = `${versionDir}.downloading.${tempSuffix()}`;
        try {
            const url = `${RELEASE_BASE_URL}/v${effective}/openmv-ide-resources-${effective}.zip`;
            const buf = await downloadToBuffer(
                url,
                vscode.l10n.t("Downloading OpenMV resources {0}", effective),
            );
            new AdmZip(buf).extractAllTo(downloadingDir, true);
            try {
                fs.renameSync(downloadingDir, versionDir);
            } catch (err) {
                // Another window may have won the race. On Windows `rename`
                // fails if the target exists; on POSIX it replaces atomically
                // so this branch only fires on real errors.
                fs.rmSync(downloadingDir, { recursive: true, force: true });
                if (!fs.existsSync(versionDir)) throw err;
            }
        } catch (e) {
            fs.rmSync(downloadingDir, { recursive: true, force: true });
            throw e;
        }
    }

    pruneOldVersions(resourcesDir, effective);
    resourcesPath = versionDir;
}

async function fetchLatestVersion(): Promise<string> {
    const res = await fetch(VERSION_URL, {
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
        throw new Error(`version fetch HTTP ${res.status}`);
    }
    const raw = (await res.text()).trim();
    const version = semver.clean(raw, { loose: true });
    if (!version) {
        throw new Error(`unexpected version format: ${raw}`);
    }
    return version;
}

function findLatestLocalVersion(resourcesDir: string): string | null {
    let entries: string[];
    try {
        entries = fs.readdirSync(resourcesDir);
    } catch {
        return null;
    }
    const versions = entries.filter((e) => semver.valid(e));
    if (versions.length === 0) return null;
    versions.sort(semver.rcompare);
    return versions[0];
}

function pruneOldVersions(resourcesDir: string, keep: string): void {
    let entries: string[];
    try {
        entries = fs.readdirSync(resourcesDir);
    } catch {
        return;
    }
    const staleDownloadCutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of entries) {
        if (entry === keep) continue;
        const full = path.join(resourcesDir, entry);
        // Finished version directories: prune anything that isn't `keep`.
        if (semver.valid(entry)) {
            try {
                fs.rmSync(full, { recursive: true, force: true });
            } catch {}
            continue;
        }
        // Orphaned `.downloading.*` temp dirs from a crashed extract: only
        // prune when older than 24h, well outside any real concurrent window.
        if (entry.includes(".downloading.")) {
            try {
                if (fs.statSync(full).mtimeMs < staleDownloadCutoff) {
                    fs.rmSync(full, { recursive: true, force: true });
                }
            } catch {}
        }
    }
}
