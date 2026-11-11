// @effect-diagnostics nodeBuiltinImport:off - Exercises the Windows installer against isolated files.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const quotePowerShell = (value: string) => `'${value.replaceAll("'", "''")}'`;
const backupName = "win-unpacked.backup-20990101-000000-aaaaaaaa";

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-portable-rotation-"));
  const release = NodePath.join(root, "release");
  const destination = NodePath.join(root, "installed");
  const installer = NodePath.join(release, "install-desktop-portable.ps1");
  await NodeFSP.mkdir(NodePath.join(release, "win-unpacked"), { recursive: true });
  await NodeFSP.mkdir(destination);
  await NodeFSP.copyFile(
    NodePath.join(import.meta.dirname, "install-desktop-portable.ps1"),
    installer,
  );
  return {
    root,
    destination,
    async release(version: string) {
      const content = Buffer.from(version);
      await NodeFSP.writeFile(NodePath.join(release, "win-unpacked/T3 Code Plus.exe"), content);
      await NodeFSP.writeFile(
        NodePath.join(release, "release.json"),
        JSON.stringify({
          appName: "T3 Code Plus",
          version,
          files: [{ path: "T3 Code Plus.exe", length: content.length }],
        }),
      );
    },
    install(setup = "", args: string[] = []) {
      const result = NodeChildProcess.spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `${setup}\n& ${quotePowerShell(installer)} -DestinationRoot ${quotePowerShell(destination)} ${args.join(" ")}\nexit $LASTEXITCODE`,
        ],
        { encoding: "utf8" },
      );
      if (result.error) throw result.error;
      return { status: result.status, output: result.stdout + result.stderr };
    },
    async directories() {
      return (await NodeFSP.readdir(destination)).sort();
    },
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(root, { recursive: true });
    },
  };
}

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
  "portable installation backups",
  () => {
    it("validates without changes and retains only the immediate previous installation", async () => {
      await using f = await fixture();
      await f.release("first");
      expect(f.install("", ["-ValidateOnly"]).status).toBe(0);
      expect(await f.directories()).toEqual([]);
      expect(f.install().status).toBe(0);
      const manualBackup = NodePath.join(f.destination, "win-unpacked.backup-manual");
      await NodeFSP.mkdir(manualBackup);
      await NodeFSP.writeFile(NodePath.join(manualBackup, "notes.txt"), "keep");
      await NodeFSP.mkdir(NodePath.join(f.destination, backupName));
      await f.release("second");
      const second = f.install();
      expect(second.status, second.output).toBe(0);
      await f.release("third");
      const third = f.install();
      expect(third.status, third.output).toBe(0);
      const names = await f.directories();
      const backups = names.filter((name) => /^win-unpacked\.backup-\d/.test(name));
      expect(backups).toHaveLength(1);
      expect(names).toHaveLength(3);
      expect(names).toContain("win-unpacked.backup-manual");
      expect(
        await NodeFSP.readFile(
          NodePath.join(f.destination, "win-unpacked/T3 Code Plus.exe"),
          "utf8",
        ),
      ).toBe("third");
      expect(
        await NodeFSP.readFile(
          NodePath.join(f.destination, backups[0]!, "T3 Code Plus.exe"),
          "utf8",
        ),
      ).toBe("second");
      expect(await NodeFSP.readFile(NodePath.join(manualBackup, "notes.txt"), "utf8")).toBe("keep");
    });

    it("keeps the installation and backups when release validation fails", async () => {
      await using f = await fixture();
      await f.release("first");
      expect(f.install().status).toBe(0);
      await f.release("second");
      expect(f.install().status).toBe(0);
      const before = await f.directories();
      const failed = f.install("", ["-ExpectedVersion 'different'"]);
      expect(failed.status, failed.output).toBe(1);
      expect(await f.directories()).toEqual(before);
      expect(
        await NodeFSP.readFile(
          NodePath.join(f.destination, "win-unpacked/T3 Code Plus.exe"),
          "utf8",
        ),
      ).toBe("second");
    });

    it("removes its staging directory after a failed copy", async () => {
      await using f = await fixture();
      await f.release("first");
      expect(f.install().status).toBe(0);
      await f.release("second");
      const failed = f.install(`
      function Copy-Item {
        param($LiteralPath, $Destination, [switch]$Recurse)
        New-Item -ItemType Directory -Path $Destination | Out-Null
        Set-Content -LiteralPath (Join-Path $Destination 'partial.txt') -Value 'partial'
        throw 'Copy interrupted'
      }
    `);
      expect(failed.status, failed.output).toBe(1);
      expect(failed.output).toContain("Copy interrupted");
      expect(await f.directories()).toEqual(["win-unpacked"]);
      expect(
        await NodeFSP.readFile(
          NodePath.join(f.destination, "win-unpacked/T3 Code Plus.exe"),
          "utf8",
        ),
      ).toBe("first");
    });

    it("restores the previous installation when activation fails", async () => {
      await using f = await fixture();
      await f.release("first");
      expect(f.install().status).toBe(0);
      await f.release("second");
      const failed = f.install(`
      function Move-Item {
        param($LiteralPath, $Destination)
        if ((Split-Path (Split-Path $LiteralPath) -Leaf).StartsWith('.install-')) {
          throw 'Activation interrupted'
        }
        Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination
      }
    `);
      expect(failed.status, failed.output).toBe(1);
      expect(failed.output).toContain("Activation");
      expect(await f.directories()).toEqual(["win-unpacked"]);
      expect(
        await NodeFSP.readFile(
          NodePath.join(f.destination, "win-unpacked/T3 Code Plus.exe"),
          "utf8",
        ),
      ).toBe("first");
    });

    it("retains linked and running backups with an explicit cleanup warning", async () => {
      await using f = await fixture();
      await f.release("first");
      expect(f.install().status).toBe(0);
      const outside = NodePath.join(f.root, "outside");
      await NodeFSP.mkdir(outside);
      await NodeFSP.writeFile(NodePath.join(outside, "keep.txt"), "keep");
      const linked = NodePath.join(f.destination, backupName);
      await NodeFSP.symlink(outside, linked, "junction");
      const running = NodePath.join(f.destination, "win-unpacked.backup-20000101-000000-bbbbbbbb");
      await NodeFSP.mkdir(running);
      const nested = NodePath.join(f.destination, "win-unpacked.backup-20000102-000000-cccccccc");
      await NodeFSP.mkdir(nested);
      await NodeFSP.symlink(outside, NodePath.join(nested, "linked-data"), "junction");
      await f.release("second");
      const installed = f.install(`
      function Get-CimInstance {
        [pscustomobject]@{ ExecutablePath = ${quotePowerShell(NodePath.join(running, "T3 Code Plus.exe"))}; ProcessId = 1234 }
      }
    `);
      expect(installed.status, installed.output).toBe(0);
      expect(installed.output).toContain("Backup rotation incomplete");
      expect(await NodeFSP.readFile(NodePath.join(outside, "keep.txt"), "utf8")).toBe("keep");
      expect(await NodeFSP.lstat(linked).then((s) => s.isSymbolicLink())).toBe(true);
      expect(
        await NodeFSP.lstat(NodePath.join(nested, "linked-data")).then((s) => s.isSymbolicLink()),
      ).toBe(true);
      expect(await NodeFSP.stat(running).then((s) => s.isDirectory())).toBe(true);
      expect((await f.directories()).some((name) => name.startsWith(".install-"))).toBe(false);
      await NodeFSP.unlink(linked);
      await NodeFSP.unlink(NodePath.join(nested, "linked-data"));
    });
  },
);
