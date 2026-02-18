import { homedir } from 'node:os';
import path from 'node:path';
import { realpath, readdir } from 'node:fs/promises';

export type FolderEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
};

export type FolderListing = {
  root: string;
  path: string;
  parent: string | null;
  entries: FolderEntry[];
};

let configuredRoot = path.resolve(homedir());
let configuredRootReal = path.resolve(homedir());

async function resolveAndAssertWithinRoot(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const resolvedReal = await realpath(resolved);
  if (resolvedReal === configuredRootReal || resolvedReal.startsWith(`${configuredRootReal}${path.sep}`)) {
    return resolvedReal;
  }
  throw new Error('Path must be inside the configured base path.');
}

export async function setBrowserRoot(basePath?: string): Promise<string> {
  const resolved = path.resolve(basePath ?? homedir());
  const resolvedReal = await realpath(resolved);
  configuredRoot = resolved;
  configuredRootReal = resolvedReal;
  return configuredRootReal;
}

export function getHomeRoot(): string {
  return configuredRootReal;
}

export async function listFolder(inputPath?: string): Promise<FolderListing> {
  const currentPath = await resolveAndAssertWithinRoot(inputPath ?? configuredRoot);
  const dirents = await readdir(currentPath, { withFileTypes: true });

  const entries = dirents
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => {
      const entryPath = path.join(currentPath, entry.name);
      return {
        name: entry.name,
        path: entryPath,
        kind: entry.isDirectory() ? 'directory' : 'file',
      } as FolderEntry;
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

  const parent = currentPath === configuredRootReal ? null : path.dirname(currentPath);

  return {
    root: configuredRootReal,
    path: currentPath,
    parent,
    entries,
  };
}
