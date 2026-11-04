// Unsaved edits on the current screen. Leaving it inside the app (menu, breadcrumb, Back button) first asks
// Keep editing / Discard changes (components/ui/LeaveDialog); closing or reloading the page uses the
// browser's own warning (see hooks/useUnsavedGuard).
// Loaded by unit tests through a plain TypeScript transpile: no imports from "@/".

const dirty = new Set<symbol>();

export function setUnsaved(key: symbol, unsaved: boolean): void {
  if (unsaved) dirty.add(key);
  else dirty.delete(key);
}

export function hasUnsavedChanges(): boolean {
  return dirty.size > 0;
}

/** The user chose Discard changes: forget every unsaved mark so the chosen navigation goes ahead. */
export function discardUnsaved(): void {
  dirty.clear();
}
