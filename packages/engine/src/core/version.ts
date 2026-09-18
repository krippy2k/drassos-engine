export const HISTORY_FORMAT_VERSION = 1;

const SEMVER = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function isValidWorkflowVersion(version: string): boolean {
  return typeof version === "string" && version.length > 0 && SEMVER.test(version);
}

export function parseWorkflowVersion(version: string): { major: number; minor: number; patch: number; prerelease: string | null } {
  const match = SEMVER.exec(version);
  if (!match) {
    throw new Error(`Invalid workflow version "${version}"`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4] ?? null,
  };
}

export function workflowKey(name: string, version: string): string {
  return `${name}@${version}`;
}

export function parseWorkflowKey(value: string): { name: string; version: string } {
  const index = value.lastIndexOf("@");
  if (index <= 0) {
    return { name: value, version: "1" };
  }
  return { name: value.slice(0, index), version: value.slice(index + 1) };
}
