/**
 * Whether the user has left the computer.
 *
 * The phone should only receive answers from other sessions while the user is away; when they are
 * sitting at the desk the desktop already shows the answer, and pushing it to WeChat would be noise.
 *
 * Windows exposes exactly this through `GetLastInputInfo` (seconds since the last keyboard/mouse
 * input) and `GetForegroundWindow` (0 while the lock screen owns the session). Both are stable,
 * unprivileged APIs, so a short-lived PowerShell probe is enough — no native addon, no service, no
 * admin rights. The probe runs at most once per `ttlMs`, because each spawn costs a few hundred
 * milliseconds and away-ness changes on a human timescale.
 *
 * @module dsh-wechat-friendly/idle
 */
import { execFile } from 'node:child_process';

/**
 * PowerShell that prints one JSON line: idle seconds, foreground window handle, lock-screen process.
 *
 * The C# is compiled in memory by `Add-Type`; the values are read-only and have no side effects.
 */
const PROBE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshIdle {
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("kernel32.dll")] public static extern uint GetTickCount();
    public static uint IdleSeconds() {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(info);
        if (!GetLastInputInfo(ref info)) return 0;
        return (GetTickCount() - info.dwTime) / 1000;
    }
    public static long Foreground() { return GetForegroundWindow().ToInt64(); }
}
'@
$idle = [DshIdle]::IdleSeconds()
$fg = [DshIdle]::Foreground()
$logon = @(Get-Process -Name LogonUI -ErrorAction SilentlyContinue).Count -gt 0
[pscustomobject]@{ idleSeconds = $idle; foregroundWindow = $fg; logonUi = $logon } | ConvertTo-Json -Compress
`;

/** `-EncodedCommand` avoids every quoting problem a script passed through a shell would have. */
const ENCODED = Buffer.from(PROBE_SCRIPT.replace(/\r\n/g, '\n'), 'utf16le').toString('base64');

/**
 * Runs the probe, caches its raw reading, and turns it into a present/away answer.
 */
export class IdleProbe {
    #ttlMs;
    #cached;
    #pending;

    /**
     * @param options.ttlMs - How long one reading is reused. Away-ness does not change faster than this.
     */
    constructor(options = {}) {
        this.#ttlMs = options.ttlMs ?? 20_000;
    }

    /** Read the raw probe, reusing a recent reading. */
    async #read() {
        const now = Date.now();
        if (this.#cached !== undefined && now - this.#cached.at < this.#ttlMs)
            return this.#cached.value;
        if (this.#pending !== undefined)
            return await this.#pending;
        this.#pending = this.#spawn();
        try {
            const value = await this.#pending;
            this.#cached = { at: Date.now(), value };
            return value;
        }
        finally {
            this.#pending = undefined;
        }
    }

    /** Run PowerShell once and parse its JSON line. */
    async #spawn() {
        if (process.platform !== 'win32')
            return { idleSeconds: 0, foregroundWindow: 1, logonUi: false, failed: true };
        return await new Promise((resolve) => {
            execFile('powershell.exe',
                ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED],
                { timeout: 8_000, windowsHide: true },
                (error, stdout) => {
                    if (error !== null) {
                        resolve({ idleSeconds: 0, foregroundWindow: 1, logonUi: false, failed: true });
                        return;
                    }
                    const line = String(stdout).trim().split(/\r?\n/).filter((item) => item.trim() !== '').pop();
                    try {
                        const parsed = JSON.parse(line ?? '{}');
                        resolve({
                            idleSeconds: Number(parsed.idleSeconds) || 0,
                            foregroundWindow: Number(parsed.foregroundWindow) || 0,
                            logonUi: parsed.logonUi === true,
                            failed: false,
                        });
                    }
                    catch {
                        resolve({ idleSeconds: 0, foregroundWindow: 1, logonUi: false, failed: true });
                    }
                });
        });
    }

    /**
     * @param options.idleMs - How long without input counts as away (0 means only the lock screen).
     * @returns `{ away, idleSeconds, locked, failed }`.
     */
    async isAway(options = {}) {
        const idleMs = Math.max(0, options.idleMs ?? 5 * 60_000);
        const raw = await this.#read();
        const locked = raw.logonUi === true || raw.foregroundWindow === 0;
        const idleAway = idleMs > 0 && raw.idleSeconds * 1000 >= idleMs;
        const away = !raw.failed && (locked || idleAway);
        return { away, idleSeconds: raw.idleSeconds, locked, failed: raw.failed === true };
    }
}
