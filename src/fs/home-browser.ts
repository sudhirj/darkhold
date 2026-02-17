import { homedir } from 'node:os';
import path from 'node:path';
import { readdir } from 'node:fs/promises';

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

const homeRoot = path.resolve(homedir());

function assertWithinHome(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (resolved === homeRoot || resolved.startsWith(`${homeRoot}${path.sep}`)) {
    return resolved;
  }
  throw new Error('Path must be inside the user home directory.');
}

export function getHomeRoot(): string {
  return homeRoot;
}

export async function listFolder(inputPath?: string): Promise<FolderListing> {
  const currentPath = assertWithinHome(inputPath ?? homeRoot);
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

  const parent = currentPath === homeRoot ? null : path.dirname(currentPath);

  return {
    root: homeRoot,
    path: currentPath,
    parent,
    entries,
  };
}
