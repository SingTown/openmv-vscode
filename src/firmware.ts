import * as path from "node:path";
import { execa } from "execa";
import * as vscode from "vscode";
import { openmv } from "./openmv";
import { getResourcesPath } from "./resource";

let toolsPath: string | null = null;
let outputChannel: vscode.OutputChannel | null = null;

function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) throw new Error("output channel not initialized");
    return outputChannel;
}

const DFU_FACTORY_MSG = vscode.l10n.t(
    "Disconnect your OpenMV Cam from your computer, add a jumper wire between the BOOT and RST pins, and then reconnect your OpenMV Cam to your computer.",
);
const DFU_BOOTLOADER_MSG = vscode.l10n.t(
    "Disconnect your OpenMV Cam from your computer, remove the jumper wire between the BOOT and RST pins, and then reconnect your OpenMV Cam to your computer.",
);
const SBL_FACTORY_MSG = vscode.l10n.t(
    "Disconnect your OpenMV Cam from your computer, add a jumper wire between the SBL and 3.3V pins, and then reconnect your OpenMV Cam to your computer.",
);
const SBL_BOOTLOADER_MSG = vscode.l10n.t(
    "Disconnect your OpenMV Cam from your computer, remove the jumper wire between the SBL and 3.3V pins, and then reconnect your OpenMV Cam to your computer.",
);

interface DetectCommand {
    exe: string;
    args: string[];
    stdoutContains?: string;
}

type Command = [string, ...string[]];

interface BoardProps {
    name: string;
    factoryDetect: DetectCommand | null;
    factoryDetectMessage: string;
    bootloaderDetect: DetectCommand | null;
    bootloaderDetectMessage: string;
    bootloaderCommands: Command[];
    firmwareCommands: Command[];
    firmwareDir: string;
}

export class Board {
    readonly name: string;
    readonly factoryDetect: DetectCommand | null;
    readonly factoryDetectMessage: string;
    readonly bootloaderDetect: DetectCommand | null;
    readonly bootloaderDetectMessage: string;
    readonly bootloaderCommands: Command[];
    readonly firmwareCommands: Command[];
    readonly firmwareDir: string;

    constructor(props: BoardProps) {
        this.name = props.name;
        this.factoryDetect = props.factoryDetect;
        this.factoryDetectMessage = props.factoryDetectMessage;
        this.bootloaderDetect = props.bootloaderDetect;
        this.bootloaderDetectMessage = props.bootloaderDetectMessage;
        this.bootloaderCommands = props.bootloaderCommands;
        this.firmwareCommands = props.firmwareCommands;
        this.firmwareDir = path.join(getResourcesPath(), props.firmwareDir);
    }

    async flashFirmware(customFirmwareDir: string | undefined): Promise<void> {
        this.assertSupported();
        await this.#waitFor(
            this.bootloaderDetect,
            this.bootloaderDetectMessage,
        );
        const dir = customFirmwareDir || this.firmwareDir;
        await this.#execAll(
            this.firmwareCommands,
            dir,
            vscode.l10n.t("Flashing firmware"),
        );
        vscode.window.showInformationMessage(
            vscode.l10n.t("Flash successfully"),
        );
    }

    async repairFirmware(): Promise<void> {
        this.assertSupported();
        await this.#waitFor(this.factoryDetect, this.factoryDetectMessage);
        await this.#execAll(
            this.bootloaderCommands,
            this.firmwareDir,
            vscode.l10n.t("Flashing bootloader"),
        );

        await this.#waitFor(
            this.bootloaderDetect,
            this.bootloaderDetectMessage,
        );
        await this.#execAll(
            this.firmwareCommands,
            this.firmwareDir,
            vscode.l10n.t("Flashing firmware"),
        );
        vscode.window.showInformationMessage(
            vscode.l10n.t("Flash successfully"),
        );
    }

    assertSupported(): void {
        const exes = [
            this.factoryDetect?.exe,
            this.bootloaderDetect?.exe,
            ...this.bootloaderCommands.map((c) => c[0]),
            ...this.firmwareCommands.map((c) => c[0]),
        ];
        if (exes.some((e) => e === "")) {
            throw new Error(
                vscode.l10n.t(
                    "{0} is not supported on {1}/{2}",
                    this.name,
                    process.platform,
                    process.arch,
                ),
            );
        }
    }

    async #waitFor(detect: DetectCommand | null, title: string): Promise<void> {
        if (!detect) return;
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title,
                cancellable: true,
            },
            async (_progress, token) => {
                const needle = detect.stdoutContains?.toLowerCase();
                while (true) {
                    if (token.isCancellationRequested) {
                        throw new vscode.CancellationError();
                    }
                    const result = await execa(detect.exe, detect.args, {
                        reject: false,
                        stdout: needle ? "pipe" : "ignore",
                        stderr: "ignore",
                    });
                    if (result.exitCode === 0) {
                        if (!needle) return;
                        const out =
                            typeof result.stdout === "string"
                                ? result.stdout
                                : "";
                        if (out.toLowerCase().includes(needle)) return;
                    }
                    await new Promise((r) => setTimeout(r, 100));
                }
            },
        );
    }

    async #execAll(
        commands: Command[],
        cwd: string,
        title: string,
    ): Promise<void> {
        const channel = getOutputChannel();
        channel.show(true);
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title,
                cancellable: false,
            },
            async () => {
                for (const [exe, ...args] of commands) {
                    channel.appendLine(`$ ${exe} ${args.join(" ")}`);
                    const sub = execa(exe, args, {
                        cwd,
                        reject: false,
                        stdout: "pipe",
                        stderr: "pipe",
                    });
                    const emit = (chunk: Buffer) =>
                        channel.append(chunk.toString());
                    sub.stdout?.on("data", emit);
                    sub.stderr?.on("data", emit);
                    const result = await sub;
                    if (result.exitCode !== 0) {
                        throw new Error(
                            `Command failed with exit code ${result.exitCode}`,
                        );
                    }
                }
            },
        );
    }
}

function toolPaths() {
    if (!toolsPath) throw new Error("tools not initialized");
    const res = toolsPath;
    const isWin = process.platform === "win32";
    const isMac = process.platform === "darwin";
    const isArm = process.arch === "arm64";

    let dfuUtil: string;
    let sdphost: string;
    let blhost: string;
    let stm32Prog: string;

    if (isWin) {
        dfuUtil = path.join(res, "dfu-util", "windows", "dfu-util.exe");
        sdphost = path.join(res, "sdphost", "win", "sdphost.exe");
        blhost = path.join(res, "blhost", "win", "blhost.exe");
        stm32Prog = path.join(
            res,
            "stcubeprogrammer",
            "windows",
            "STM32_Programmer_CLI.exe",
        );
    } else if (isMac) {
        dfuUtil = path.join(res, "dfu-util", "osx", "dfu-util");
        sdphost = path.join(res, "sdphost", "mac", "sdphost");
        blhost = path.join(res, "blhost", "mac", "blhost");
        stm32Prog = path.join(
            res,
            "stcubeprogrammer",
            "mac",
            "bin",
            "STM32_Programmer_CLI",
        );
    } else if (isArm) {
        dfuUtil = path.join(res, "dfu-util", "aarch64", "dfu-util");
        sdphost = "";
        blhost = "";
        stm32Prog = "";
    } else {
        dfuUtil = path.join(res, "dfu-util", "linux64", "dfu-util");
        sdphost = path.join(res, "sdphost", "linux", "amd64", "sdphost");
        blhost = path.join(res, "blhost", "linux", "amd64", "blhost");
        stm32Prog = path.join(
            res,
            "stcubeprogrammer",
            "linux64",
            "bin",
            "STM32_Programmer_CLI",
        );
    }

    return { dfuUtil, sdphost, blhost, stm32Prog };
}

function dfuListDetect(dfu: string, vidPid: string): DetectCommand {
    return { exe: dfu, args: ["-l"], stdoutContains: `[${vidPid}]` };
}

let cachedBoards: Board[] | null = null;

export function allBoards(): Board[] {
    if (cachedBoards) return cachedBoards;
    const { dfuUtil, sdphost, blhost, stm32Prog } = toolPaths();

    cachedBoards = [
        new Board({
            name: "OpenMV Cam M4",
            factoryDetect: dfuListDetect(dfuUtil, "0483:df11"),
            factoryDetectMessage: DFU_FACTORY_MSG,
            bootloaderDetect: dfuListDetect(dfuUtil, "37C5:9202"),
            bootloaderDetectMessage: DFU_BOOTLOADER_MSG,
            bootloaderCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "37C5:9202",
                    "-a",
                    "0",
                    "-s",
                    "0x08000000",
                    "-D",
                    "bootloader.bin",
                ],
            ],
            firmwareCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "37C5:9202",
                    "-a",
                    "2",
                    "-D",
                    "firmware.bin",
                ],
                [dfuUtil, "-d", "37C5:9202", "-a", "2", "-e"],
            ],
            firmwareDir: "firmware/OPENMV2/",
        }),
        new Board({
            name: "OpenMV Cam M7",
            factoryDetect: dfuListDetect(dfuUtil, "0483:df11"),
            factoryDetectMessage: DFU_FACTORY_MSG,
            bootloaderDetect: dfuListDetect(dfuUtil, "37C5:9203"),
            bootloaderDetectMessage: DFU_BOOTLOADER_MSG,
            bootloaderCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "37C5:9203",
                    "-a",
                    "0",
                    "-s",
                    "0x08000000",
                    "-D",
                    "bootloader.bin",
                ],
            ],
            firmwareCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "37C5:9203",
                    "-a",
                    "2",
                    "-D",
                    "firmware.bin",
                ],
                [dfuUtil, "-d", "37C5:9203", "-a", "2", "-e"],
            ],
            firmwareDir: "firmware/OPENMV3/",
        }),
        new Board({
            name: "OpenMV Cam H7",
            factoryDetect: dfuListDetect(dfuUtil, "0483:df11"),
            factoryDetectMessage: DFU_FACTORY_MSG,
            bootloaderDetect: dfuListDetect(dfuUtil, "37C5:9204"),
            bootloaderDetectMessage: DFU_BOOTLOADER_MSG,
            bootloaderCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "37C5:9204",
                    "-a",
                    "0",
                    "-s",
                    "0x08000000",
                    "-D",
                    "bootloader.bin",
                ],
            ],
            firmwareCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "37C5:9204",
                    "-a",
                    "2",
                    "-D",
                    "firmware.bin",
                ],
                [dfuUtil, "-d", "37C5:9204", "-a", "2", "-e"],
            ],
            firmwareDir: "firmware/OPENMV4/",
        }),
        new Board({
            name: "OpenMV Cam H7 Plus",
            factoryDetect: dfuListDetect(dfuUtil, "0483:df11"),
            factoryDetectMessage: DFU_FACTORY_MSG,
            bootloaderDetect: dfuListDetect(dfuUtil, "37C5:924A"),
            bootloaderDetectMessage: DFU_BOOTLOADER_MSG,
            bootloaderCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "37C5:924A",
                    "-a",
                    "0",
                    "-s",
                    "0x08000000",
                    "-D",
                    "bootloader.bin",
                ],
            ],
            firmwareCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "37C5:924A",
                    "-a",
                    "2",
                    "-D",
                    "firmware.bin",
                ],
                [dfuUtil, "-d", "37C5:924A", "-a", "2", "-e"],
            ],
            firmwareDir: "firmware/OPENMV4P/",
        }),
        new Board({
            name: "OpenMV Pure Thermal",
            factoryDetect: dfuListDetect(dfuUtil, "0483:df11"),
            factoryDetectMessage: DFU_FACTORY_MSG,
            bootloaderDetect: dfuListDetect(dfuUtil, "37C5:9205"),
            bootloaderDetectMessage: DFU_BOOTLOADER_MSG,
            bootloaderCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "37C5:9205",
                    "-a",
                    "0",
                    "-s",
                    "0x08000000",
                    "-D",
                    "bootloader.bin",
                ],
            ],
            firmwareCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "37C5:9205",
                    "-a",
                    "2",
                    "-D",
                    "firmware.bin",
                ],
                [dfuUtil, "-d", "37C5:9205", "-a", "2", "-e"],
            ],
            firmwareDir: "firmware/OPENMVPT/",
        }),
        new Board({
            name: "OpenMV Cam RT1062",
            factoryDetect: {
                exe: sdphost,
                args: ["-u", "0x1FC9,0x0135", "--", "error-status"],
            },
            factoryDetectMessage: SBL_FACTORY_MSG,
            bootloaderDetect: {
                exe: blhost,
                args: ["-u", "0x15A2,0x0073", "--", "get-property", "1"],
            },
            bootloaderDetectMessage: SBL_BOOTLOADER_MSG,
            bootloaderCommands: [
                [
                    sdphost,
                    "-u",
                    "0x1FC9,0x0135",
                    "--",
                    "write-file",
                    "0x20001C00",
                    "sdphost_flash_loader.bin",
                ],
                [
                    sdphost,
                    "-u",
                    "0x1FC9,0x0135",
                    "--",
                    "jump-address",
                    "0x20001C00",
                ],
                [blhost, "-u", "0x15A2,0x0073", "--", "get-property", "1"],
                [
                    blhost,
                    "-u",
                    "0x15A2,0x0073",
                    "--",
                    "fill-memory",
                    "0x2000",
                    "4",
                    "0xC0000008",
                    "word",
                ],
                [
                    blhost,
                    "-u",
                    "0x15A2,0x0073",
                    "--",
                    "configure-memory",
                    "9",
                    "0x2000",
                ],
                [
                    blhost,
                    "-u",
                    "0x15A2,0x0073",
                    "-t",
                    "120000",
                    "--",
                    "flash-erase-region",
                    "0x60000000",
                    "0x1000",
                ],
                [
                    blhost,
                    "-u",
                    "0x15A2,0x0073",
                    "-t",
                    "120000",
                    "--",
                    "flash-erase-region",
                    "0x60001000",
                    "0x3F000",
                ],
                [
                    blhost,
                    "-u",
                    "0x15A2,0x0073",
                    "--",
                    "write-memory",
                    "0x60001000",
                    "blhost_flash_loader.bin",
                ],
            ],
            firmwareCommands: [
                [
                    sdphost,
                    "-u",
                    "0x1FC9,0x0135",
                    "--",
                    "write-file",
                    "0x20001C00",
                    "sdphost_flash_loader.bin",
                ],
                [
                    sdphost,
                    "-u",
                    "0x1FC9,0x0135",
                    "--",
                    "jump-address",
                    "0x20001C00",
                ],
                [blhost, "-u", "0x15A2,0x0073", "--", "get-property", "1"],
                [
                    blhost,
                    "-u",
                    "0x15A2,0x0073",
                    "--",
                    "fill-memory",
                    "0x2000",
                    "4",
                    "0xC0000008",
                    "word",
                ],
                [
                    blhost,
                    "-u",
                    "0x15A2,0x0073",
                    "--",
                    "configure-memory",
                    "9",
                    "0x2000",
                ],
                [
                    blhost,
                    "-u",
                    "0x15A2,0x0073",
                    "-t",
                    "120000",
                    "--",
                    "flash-erase-region",
                    "0x60040000",
                    "0x3C0000",
                ],
                [
                    blhost,
                    "-u",
                    "0x15A2,0x0073",
                    "--",
                    "write-memory",
                    "0x60040000",
                    "firmware.bin",
                ],
                [blhost, "-u", "0x15A2,0x0073", "--", "reset"],
            ],
            firmwareDir: "firmware/OPENMV_RT1060/",
        }),
        new Board({
            name: "OpenMV Cam AE3",
            factoryDetect: null,
            factoryDetectMessage: "",
            bootloaderDetect: dfuListDetect(dfuUtil, "37C5:96E3"),
            bootloaderDetectMessage: DFU_BOOTLOADER_MSG,
            bootloaderCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "37C5:96E3",
                    "-a",
                    "0",
                    "-s",
                    "0x08000000",
                    "-D",
                    "bootloader.bin",
                ],
            ],
            firmwareCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "37C5:96E3",
                    "-a",
                    "1",
                    "-D",
                    "firmware_M55_HP.bin",
                ],
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "37C5:96E3",
                    "-a",
                    "2",
                    "-D",
                    "firmware_M55_HE.bin",
                ],
                [dfuUtil, "-d", "37C5:96E3", "-a", "2", "-e"],
            ],
            firmwareDir: "firmware/OPENMV_AE3/",
        }),
        new Board({
            name: "OpenMV Cam N6",
            factoryDetect: { exe: stm32Prog, args: ["-c", "port=USB1"] },
            factoryDetectMessage: DFU_FACTORY_MSG,
            bootloaderDetect: dfuListDetect(dfuUtil, "37C5:9206"),
            bootloaderDetectMessage: DFU_BOOTLOADER_MSG,
            bootloaderCommands: [
                [stm32Prog, "-c", "port=USB1", "-d", "FlashLayout.tsv"],
            ],
            firmwareCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "37C5:9206",
                    "-a",
                    "1",
                    "-D",
                    "firmware.bin",
                ],
                [dfuUtil, "-d", "37C5:9206", "-a", "1", "-e"],
            ],
            firmwareDir: "firmware/OPENMV_N6/",
        }),
        new Board({
            name: "Arduino Portenta",
            factoryDetect: dfuListDetect(dfuUtil, "0483:df11"),
            factoryDetectMessage: DFU_FACTORY_MSG,
            bootloaderDetect: dfuListDetect(dfuUtil, "2341:035b"),
            bootloaderDetectMessage: DFU_BOOTLOADER_MSG,
            bootloaderCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "2341:035b",
                    "-a",
                    "0",
                    "-s",
                    "0x08000000",
                    "-D",
                    "bootloader.bin",
                ],
            ],
            firmwareCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "2341:035b",
                    "-a",
                    "0",
                    "-s",
                    "0x08040000",
                    "-D",
                    "firmware.bin",
                ],
                [dfuUtil, "-d", "2341:035b", "-a", "0", "-e"],
            ],
            firmwareDir: "firmware/ARDUINO_PORTENTA_H7/",
        }),
        new Board({
            name: "Arduino Giga",
            factoryDetect: dfuListDetect(dfuUtil, "0483:df11"),
            factoryDetectMessage: DFU_FACTORY_MSG,
            bootloaderDetect: dfuListDetect(dfuUtil, "2341:0366"),
            bootloaderDetectMessage: DFU_BOOTLOADER_MSG,
            bootloaderCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "2341:0366",
                    "-a",
                    "0",
                    "-s",
                    "0x08000000",
                    "-D",
                    "bootloader.bin",
                ],
            ],
            firmwareCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "2341:0366",
                    "-a",
                    "0",
                    "-s",
                    "0x08040000",
                    "-D",
                    "firmware.bin",
                ],
                [dfuUtil, "-d", "2341:0366", "-a", "0", "-e"],
            ],
            firmwareDir: "firmware/ARDUINO_GIGA/",
        }),
        new Board({
            name: "Arduino Nicla Vision",
            factoryDetect: dfuListDetect(dfuUtil, "0483:df11"),
            factoryDetectMessage: DFU_FACTORY_MSG,
            bootloaderDetect: dfuListDetect(dfuUtil, "2341:035f"),
            bootloaderDetectMessage: DFU_BOOTLOADER_MSG,
            bootloaderCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "2341:035f",
                    "-a",
                    "0",
                    "-s",
                    "0x08000000",
                    "-D",
                    "bootloader.bin",
                ],
            ],
            firmwareCommands: [
                [
                    dfuUtil,
                    "-w",
                    "-d",
                    "2341:035f",
                    "-a",
                    "0",
                    "-s",
                    "0x08040000",
                    "-D",
                    "firmware.bin",
                ],
                [dfuUtil, "-d", "2341:035f", "-a", "0", "-e"],
            ],
            firmwareDir: "firmware/ARDUINO_NICLA_VISION/",
        }),
    ];
    return cachedBoards;
}

export function findBoardByName(name: string): Board {
    const board = allBoards().find((b) => b.name === name);
    if (!board) throw new Error(`Unknown board: ${name}`);
    return board;
}

async function selectBoard(): Promise<Board | null> {
    const items = allBoards().map((board) => ({ label: board.name, board }));
    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t("Select a board"),
    });
    return selected?.board ?? null;
}

async function selectFirmwareFolder(): Promise<string | null> {
    const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: vscode.l10n.t("Select firmware folder"),
        canSelectFiles: false,
        canSelectFolders: true,
    });
    return fileUri?.[0]?.fsPath ?? null;
}

export function initFirmware(context: vscode.ExtensionContext) {
    toolsPath = path.join(context.extensionPath, "tools");
    outputChannel = vscode.window.createOutputChannel("OpenMV Firmware");
    context.subscriptions.push(outputChannel);

    async function updateCommand(customDir: string | undefined) {
        const info = openmv.getInfo();
        if (!info) {
            vscode.window.showErrorMessage(
                vscode.l10n.t("Please connect a camera first"),
            );
            return;
        }
        const board = findBoardByName(info.name);
        board.assertSupported();
        await openmv.boot();
        await board.flashFirmware(customDir);
    }

    async function customFirmwareCommand() {
        const folder = await selectFirmwareFolder();
        if (!folder) return;
        await updateCommand(folder);
    }

    async function repairCommand() {
        const board = await selectBoard();
        if (!board) return;
        await board.repairFirmware();
    }

    context.subscriptions.push(
        vscode.commands.registerCommand("openmv.update", () =>
            updateCommand(undefined),
        ),
        vscode.commands.registerCommand(
            "openmv.firmware",
            customFirmwareCommand,
        ),
        vscode.commands.registerCommand("openmv.repair", repairCommand),
    );
}
