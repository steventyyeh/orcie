// Where orcie keeps its state and what it names its Docker objects. The defaults are the long-standing ones
// (~/.orcie, containers "orcie-<agent>"); a second, isolated stack (tests, a trial install) sets ORCIE_DIR and ORCIE_PREFIX.
export const ORCIE_DIR = process.env.ORCIE_DIR ?? `${process.env.HOME}/.orcie`;
export const PREFIX = process.env.ORCIE_PREFIX ?? "orcie";
if (!/^[a-z][a-z0-9-]{0,20}$/.test(PREFIX)) throw new Error(`ORCIE_PREFIX "${PREFIX}" must be lowercase letters, digits and dashes`);
