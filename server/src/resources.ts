// Per-agent resource limits: CPU, memory, disk. Pure validation and planning (no Docker calls) so it can be tested.
export type Res = { cpus: number; memoryMb: number; diskGb: number | null }; // diskGb null = legacy volume with no size limit
export type Bounds = { cpusMin: number; cpusMax: number; memMinMb: number; memMaxMb: number; diskMinGb: number; diskMaxGb: number };
export const PRESETS: Record<string, { cpus: number; memoryMb: number; diskGb: number }> = {
  small: { cpus: 1, memoryMb: 2048, diskGb: 10 }, standard: { cpus: 2, memoryMb: 4096, diskGb: 20 }, large: { cpus: 4, memoryMb: 8192, diskGb: 40 },
};
export const BROWSER_MIN_MB = 2048; // Chromium shares the container's memory limit; below this pages crash
export const SHRINK_MAX_FILL = 0.85; // a disk may only shrink to a size where the data fills at most this much of it

export function limits(hostCpus: number, vmMemMb: number, vmDiskGb: number): Bounds {
  return { cpusMin: 0.5, cpusMax: Math.max(1, hostCpus), memMinMb: 1024, memMaxMb: Math.max(1024, Math.min(32768, vmMemMb)), diskMinGb: 2, diskMaxGb: Math.max(2, Math.min(500, vmDiskGb)) };
}

/** "4g", "512m", "20GB", "2.5" (plain numbers use defaultUnit). Returns the amount in the target unit, or throws. */
export function parseSize(v: unknown, unit: "mb" | "gb", defaultUnit: "m" | "g" = "g"): number {
  const m = String(v ?? "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(k|m|g|t)?b?$/);
  if (!m) throw new Error(`cannot read size "${v}" (examples: 512m, 4g)`);
  const mb = Number(m[1]) * { k: 1 / 1024, m: 1, g: 1024, t: 1048576 }[(m[2] ?? defaultUnit) as "k" | "m" | "g" | "t"];
  return unit === "mb" ? Math.round(mb) : Math.round((mb / 1024) * 100) / 100;
}

const num = (v: unknown, what: string) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${what} must be a number`); return n; };
export type Warning = string;
/** Validates a requested change against the bounds. Missing fields keep the current value. */
export function validateRes(input: any, cur: Res, b: Bounds, browser = true): { res: Res; warnings: Warning[] } {
  const cpus = input?.cpus === undefined ? cur.cpus : Math.round(num(input.cpus, "CPU") * 100) / 100;
  const memoryMb = input?.memoryMb === undefined ? cur.memoryMb : Math.round(num(input.memoryMb, "memory"));
  const diskGb = input?.diskGb === undefined || input.diskGb === null ? cur.diskGb : Math.round(num(input.diskGb, "disk") * 100) / 100;
  if (cpus < b.cpusMin || cpus > b.cpusMax) throw new Error(`CPU must be between ${b.cpusMin} and ${b.cpusMax} cores (this host has ${b.cpusMax})`);
  if (memoryMb < b.memMinMb || memoryMb > b.memMaxMb) throw new Error(`memory must be between ${b.memMinMb / 1024} and ${Math.floor(b.memMaxMb / 102.4) / 10} GB (what the Docker VM has)`);
  if (diskGb !== null && (diskGb < b.diskMinGb || diskGb > b.diskMaxGb)) throw new Error(`disk must be between ${b.diskMinGb} and ${b.diskMaxGb} GB`);
  const warnings: Warning[] = [];
  if (browser && memoryMb < BROWSER_MIN_MB) warnings.push(`Under ${BROWSER_MIN_MB / 1024} GB the agent's browser may crash: Chromium shares this memory limit.`);
  return { res: { cpus, memoryMb, diskGb }, warnings };
}

/** What applying `next` over `cur` takes. Live: `docker update` and online resize. Restart: the container is recreated on the same volume. */
export function plan(cur: Res, next: Res, usedBytes: number | null): { live: string[]; restart: string[]; error?: string } {
  const live: string[] = [], restart: string[] = [];
  if (next.cpus !== cur.cpus) live.push("cpu");
  if (next.memoryMb !== cur.memoryMb) live.push("memory");
  if (next.diskGb !== cur.diskGb && next.diskGb !== null) {
    if (cur.diskGb === null) restart.push("disk: move the workspace into a size-limited volume (the old volume is kept as a backup)");
    else if (next.diskGb > cur.diskGb) live.push("disk");
    else {
      if (usedBytes !== null && usedBytes > next.diskGb * 2 ** 30 * SHRINK_MAX_FILL) return { live, restart, error: `the agent already uses ${(usedBytes / 2 ** 30).toFixed(1)} GB; a ${next.diskGb} GB disk would be over ${SHRINK_MAX_FILL * 100}% full. Free space first or pick at least ${Math.ceil(usedBytes / 2 ** 30 / SHRINK_MAX_FILL)} GB.` };
      restart.push("disk: shrinking needs the volume offline");
    }
  }
  return { live, restart };
}

/** Usage level against the limit: 0 below 80%, 80 from 80%, 95 from 95%, 100 when full. Hysteresis is the caller's job. */
export const usageLevel = (used: number, size: number) => (size <= 0 ? 0 : used / size >= 0.995 ? 100 : used / size >= 0.95 ? 95 : used / size >= 0.8 ? 80 : 0);
