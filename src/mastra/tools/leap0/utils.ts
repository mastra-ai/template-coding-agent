import path from 'node:path';

import { Leap0Client, Sandbox } from 'leap0';

let clientInstance: Leap0Client | null = null;

export const getLeap0Client = (): Leap0Client => {
  if (!clientInstance) {
    clientInstance = new Leap0Client();
  }
  return clientInstance;
};

export const getSandboxById = async (sandboxId: string): Promise<Sandbox> => {
  const client = getLeap0Client();
  return client.sandboxes.get(sandboxId);
};

/** Fetches the sandbox and its configured workdir (from the Leap0 API). */
export const getSandboxWithWorkdir = async (
  sandboxId: string,
): Promise<{ sandbox: Sandbox; workspaceRoot: string }> => {
  const sandbox = await getSandboxById(sandboxId);
  const workspaceRoot = path.posix.resolve(await sandbox.getWorkdir());
  return { sandbox, workspaceRoot };
};

export const normalizeSandboxPath = (inputPath: string, workspaceRoot: string): string => {
  const workspaceRootResolved = path.posix.resolve(workspaceRoot);

  const isUnderWorkspace = (resolved: string): boolean =>
    resolved === workspaceRootResolved || resolved.startsWith(`${workspaceRootResolved}/`);

  const trimmed = inputPath.trim();
  if (trimmed === '' || trimmed === '/') {
    return workspaceRootResolved;
  }

  const resolved = trimmed.startsWith('/')
    ? path.posix.resolve(trimmed)
    : path.posix.resolve(workspaceRootResolved, trimmed);

  if (!isUnderWorkspace(resolved)) {
    throw new Error(`Path is outside workspace (${workspaceRootResolved}): ${inputPath}`);
  }

  return resolved;
};

/**
 * List path resolution: omitted or empty path lists the configured workdir (`getWorkdir`).
 * `"/"` lists the sandbox filesystem root. Other absolute paths are POSIX-resolved without
 * an extra `getWorkdir` when not needed. Relative paths resolve under the workdir.
 */
export const getSandboxAndNormalizedListPath = async (
  sandboxId: string,
  rawPath: string | undefined,
): Promise<{ sandbox: Sandbox; normalizedPath: string }> => {
  const sandbox = await getSandboxById(sandboxId);
  if (rawPath === undefined || rawPath.trim() === '') {
    const workspaceRoot = path.posix.resolve(await sandbox.getWorkdir());
    return { sandbox, normalizedPath: workspaceRoot };
  }
  const trimmed = rawPath.trim();
  if (trimmed === '/') {
    return { sandbox, normalizedPath: '/' };
  }
  if (trimmed.startsWith('/')) {
    return { sandbox, normalizedPath: path.posix.resolve(trimmed) };
  }
  const workspaceRoot = path.posix.resolve(await sandbox.getWorkdir());
  return { sandbox, normalizedPath: normalizeSandboxPath(trimmed, workspaceRoot) };
};
