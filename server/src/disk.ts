// Size-limited agent volumes. Docker's overlay2 on colima cannot enforce `--storage-opt size`, so each limited agent gets a
// sparse ext4 image file inside the Docker VM, loop-mounted, and exposed to Docker as a bind-backed local volume. Writes beyond
// the image size fail with ENOSPC, so the limit is enforced by the filesystem itself, not by polling.
import { execFileSync } from "node:child_process";
import { validName } from "./profile.ts";

const DIR = process.env.ORCIE_DISK_DIR ?? "/var/lib/docker/orcie-disks"; // inside the VM (the 40 GB data disk on colima)
// How to run a root shell where the Docker daemon runs. colima VM by default; set ORCIE_VM_EXEC="sudo -n" on a native Linux host.
const VM = (process.env.ORCIE_VM_EXEC ?? "colima ssh -- sudo -n").split(/\s+/);
const vm = (script: string, timeout = 600_000) => execFileSync(VM[0], [...VM.slice(1), "sh", "-ec", script], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
const safe = (n: string) => { if (!validName(n)) throw new Error("bad agent name"); return n; };
const img = (n: string) => `${DIR}/${safe(n)}.img`, mnt = (n: string) => `${DIR}/mnt/${safe(n)}`;
export const volumeName = (n: string) => `orcie-${n}-disk`;

const docker = (...a: string[]) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const ensureFstab = (n: string) => `grep -q "^${img(n)} " /etc/fstab || echo '${img(n)} ${mnt(n)} ext4 loop,nofail 0 0 # orcie' >> /etc/fstab`;
const mountCmd = (n: string) => `mkdir -p ${mnt(n)}; mountpoint -q ${mnt(n)} || mount -o loop ${img(n)} ${mnt(n)}`;

export function hostFacts() { // what the Docker VM has: CPUs, memory (MB), data disk (GB)
  const [cpus, mem] = docker("info", "--format", "{{.NCPU}} {{.MemTotal}}").split(" ").map(Number);
  let diskGb = 200; try { diskGb = Math.floor(Number(vm(`df -B1 --output=size ${DIR.split("/").slice(0, 4).join("/")} | tail -1`)) / 2 ** 30); } catch { /* keep default */ }
  return { cpus, memMb: Math.floor(mem / 2 ** 20), diskGb };
}
export const vmFreeGb = () => Number(vm(`mkdir -p ${DIR}; df -B1 --output=avail ${DIR} | tail -1`)) / 2 ** 30;

/** Creates the image, formats and mounts it, and registers it with Docker as a volume. Does not touch any other volume. */
export function create(name: string, gb: number) {
  if (volumeExists(name)) throw new Error(`volume ${volumeName(name)} already exists`);
  vm(`mkdir -p ${DIR}/mnt; test ! -e ${img(name)}; truncate -s ${Math.ceil(gb * 1024)}M ${img(name)}; mkfs.ext4 -q -m 0 -F -L orcie-${name} ${img(name)}; ${ensureFstab(name)}; ${mountCmd(name)}; chown 1000:1000 ${mnt(name)}`);
  docker("volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind", "--opt", `device=${mnt(name)}`, volumeName(name));
}
export const volumeExists = (n: string) => { try { docker("volume", "inspect", volumeName(n)); return true; } catch { return false; } };

/** Mounts the image again after a VM reboot or a failed unmount (the fstab entry normally does this at boot). */
export function ensureMounted(name: string) { vm(`test -e ${img(name)} && { ${mountCmd(name)}; }`); }

/** Online growth: the container keeps running. */
export function grow(name: string, gb: number) {
  vm(`L=$(losetup -j ${img(name)} | head -1 | cut -d: -f1); test -n "$L"; truncate -s ${Math.ceil(gb * 1024)}M ${img(name)}; losetup -c "$L"; resize2fs "$L" >/dev/null`);
}
/** Offline shrink: the volume must not be in use (container stopped/removed). Checks the filesystem first. */
export function shrink(name: string, gb: number) {
  const m = Math.ceil(gb * 1024), i = img(name);
  // always remount, even when the shrink is refused or fails, so the volume is never left unmounted
  vm(`{ mountpoint -q ${mnt(name)} && umount ${mnt(name)}; true; }; trap '${mountCmd(name)}' EXIT; e2fsck -fy ${i} >/dev/null 2>&1 || [ $? -le 1 ]; MIN=$(resize2fs -P ${i} 2>/dev/null | awk '{print $NF}'); BS=$(dumpe2fs -h ${i} 2>/dev/null | awk '/^Block size/{print $3}'); NEED=$(( MIN * BS / 1048576 + 64 )); if [ ${m} -lt $NEED ]; then echo "too small: needs at least $NEED MB" >&2; exit 3; fi; resize2fs ${i} ${m}M >/dev/null; truncate -s ${m}M ${i}`);
}
/** Free the image and its mount. Called when an agent is laid off. */
export function destroy(name: string) {
  try { docker("volume", "rm", "-f", volumeName(name)); } catch { /* none */ }
  vm(`umount ${mnt(name)} 2>/dev/null || true; rmdir ${mnt(name)} 2>/dev/null || true; rm -f ${img(name)}; sed -i '\\#^${img(name)} #d' /etc/fstab`);
}
export const imageGb = (n: string) => { try { return Number(vm(`stat -c %s ${img(n)}`)) / 2 ** 30; } catch { return null; } };

/** Copies a legacy volume into a new limited one. The old volume stays untouched as a backup. Returns file counts for verification. */
export function migrate(name: string, oldVolume: string, gb: number, image: string) {
  create(name, gb);
  try {
    const run = (cmd: string) => docker("run", "--rm", "--user", "root", "--entrypoint", "sh", "-v", `${oldVolume}:/from:ro`, "-v", `${volumeName(name)}:/to`, image, "-c", cmd);
    run("cp -a /from/. /to/");
    // verify by manifest: every path with its type and size (lost+found is the new filesystem's own)
    const manifest = (d: string) => run(`cd ${d} && find . -path ./lost+found -prune -o -printf '%y %s %p\\n' | LC_ALL=C sort | tee /tmp/m | sha256sum | cut -d' ' -f1; wc -l < /tmp/m; awk '{n+=$2} END {print n+0}' /tmp/m`).split("\n");
    const [h1, f1, b1] = manifest("/from"), [h2, f2, b2] = manifest("/to");
    if (h1 !== h2) throw new Error(`copy check failed (${f1} entries / ${b1} bytes before, ${f2} / ${b2} after)`);
    const files = Number(f1), bytes = Number(b1);
    return { files, bytes };
  } catch (e) { try { destroy(name); } catch { /* best effort */ } throw e; }
}
