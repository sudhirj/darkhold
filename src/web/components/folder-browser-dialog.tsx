import React from 'react';
import {
  Button,
  Combobox,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
} from '@headlessui/react';
import { FolderEntry, FolderListing } from '../types';

type FolderBrowserDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  basePath: string | null;
  columnPaths: string[];
  columnSearch: Record<string, string>;
  columnSelections: Record<string, string | null>;
  folderCache: Record<string, FolderListing>;
  folderInputRefs: React.MutableRefObject<Record<string, HTMLInputElement | null>>;
  suppressNextAutoFocusRef: React.MutableRefObject<boolean>;
  onChangeSearch: (listingPath: string, value: string) => void;
  onSelectDirectory: (columnIndex: number, listingPath: string, targetPath: string) => Promise<void>;
  onOpenAgentForPath: (path: string) => Promise<void>;
};

function directoriesFor(folderCache: Record<string, FolderListing>, listingPath: string): FolderEntry[] {
  const listing = folderCache[listingPath];
  if (!listing) {
    return [];
  }
  return listing.entries.filter((entry) => entry.kind === 'directory');
}

function filterDirectories(
  folderCache: Record<string, FolderListing>,
  columnSearch: Record<string, string>,
  listingPath: string,
): FolderEntry[] {
  const searchValue = columnSearch[listingPath]?.trim().toLowerCase() ?? '';
  const dirs = directoriesFor(folderCache, listingPath);
  if (!searchValue) {
    return dirs;
  }
  return dirs.filter((entry) => entry.name.toLowerCase().includes(searchValue));
}

export function FolderBrowserDialog({
  isOpen,
  onClose,
  basePath,
  columnPaths,
  columnSearch,
  columnSelections,
  folderCache,
  folderInputRefs,
  suppressNextAutoFocusRef,
  onChangeSearch,
  onSelectDirectory,
  onOpenAgentForPath,
}: FolderBrowserDialogProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <Dialog open={isOpen} onClose={onClose} className="position-relative">
      <DialogBackdrop className="modal-backdrop fade show" />
      <div className="modal fade show d-block position-fixed top-0 start-0 w-100 h-100" id="folderBrowserPanel" tabIndex={-1}>
        <div
          className="modal-dialog modal-dialog-scrollable h-100"
          style={{ width: '90vw', maxWidth: '200ch', margin: '10vh auto', height: '80dvh' }}
        >
          <DialogPanel className="modal-content h-100">
            <div className="modal-header">
              <DialogTitle as="h2" className="modal-title h5 mb-0" id="folderBrowserPanelLabel">
                Folder Browser
              </DialogTitle>
              <button className="btn-close" type="button" aria-label="Close" onClick={onClose} />
            </div>
            <div className="modal-body overflow-auto">
              <input
                className="form-control form-control-sm font-mono mb-3"
                type="text"
                value={basePath ?? 'Loading...'}
                disabled
                aria-label="Base path"
              />

              <div className="d-flex flex-column gap-2">
                {columnPaths.length === 0 ? <div className="text-secondary small">Loading folders...</div> : null}
                {columnPaths.map((listingPath, columnIndex) => {
                  const listing = folderCache[listingPath];
                  const directories = filterDirectories(folderCache, columnSearch, listingPath);
                  const allDirectories = directoriesFor(folderCache, listingPath);
                  const selectedPath = columnSelections[listingPath] ?? null;
                  const searchId = `folder-search-${columnIndex}`;

                  return (
                    <section key={listingPath} className="w-100">
                      <div className="d-flex gap-2 align-items-start">
                        <div className="flex-grow-1">
                          <Combobox
                            immediate
                            value={selectedPath}
                            onChange={(nextPath) => {
                              if (nextPath) {
                                void onSelectDirectory(columnIndex, listingPath, nextPath);
                              }
                            }}
                            disabled={!listing || allDirectories.length === 0}
                          >
                            <div className="position-relative">
                              <ComboboxInput
                                id={searchId}
                                ref={(node) => {
                                  folderInputRefs.current[listingPath] = node;
                                }}
                                className="form-control form-control-sm"
                                aria-label={`Search folders in combobox ${columnIndex + 1}`}
                                placeholder={listing ? 'Type to search folders' : 'Loading folders...'}
                                displayValue={(value: string | null) =>
                                  directoriesFor(folderCache, listingPath).find((entry) => entry.path === value)?.name ?? ''
                                }
                                onKeyDown={(event) => {
                                  if (event.key === 'Tab') {
                                    suppressNextAutoFocusRef.current = true;
                                  } else if (event.key === 'Enter') {
                                    suppressNextAutoFocusRef.current = false;
                                  }
                                }}
                                onChange={(event) => onChangeSearch(listingPath, event.target.value)}
                              />
                              <ComboboxOptions className="position-absolute mt-1 w-100 border rounded bg-white shadow-sm p-1 z-3 folder-list">
                                {listing && directories.map((dir) => (
                                  <ComboboxOption
                                    key={dir.path}
                                    value={dir.path}
                                    className={({ focus, selected }) =>
                                      `list-group-item border-0 rounded px-2 py-1 d-flex justify-content-between align-items-center ${
                                        selected
                                          ? 'active'
                                          : focus
                                            ? 'list-group-item-primary'
                                            : 'list-group-item-action'
                                      }`
                                    }
                                  >
                                    <span>{dir.name}</span>
                                    {selectedPath === dir.path ? <i className="bi bi-check2" aria-hidden="true" /> : null}
                                  </ComboboxOption>
                                ))}
                                {listing && directories.length === 0 ? (
                                  <div className="list-group-item text-secondary border-0 rounded px-2 py-1">No matching folders.</div>
                                ) : null}
                              </ComboboxOptions>
                            </div>
                          </Combobox>
                        </div>
                        <Button
                          as="button"
                          type="button"
                          tabIndex={0}
                          className="btn btn-sm btn-outline-primary"
                          onClick={() => void onOpenAgentForPath(listingPath)}
                          disabled={!listing}
                          aria-label={`Open agent for combobox ${columnIndex + 1}`}
                          title="Open agent"
                        >
                          <i className="bi bi-robot" aria-hidden="true" />
                        </Button>
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}
