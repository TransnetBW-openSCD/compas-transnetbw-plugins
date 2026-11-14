import { compareVersions, type Process } from '@oscd-transnet-plugins/shared';
import type { ProcessService } from './process.service';
import { classifyProcessImport } from './processImport';
import { readLocalProcesses, removeLocalProcessIfUnchanged } from './local-processes';

const writes = new Map<string, Promise<unknown>>();
const syncs = new Map<string, Promise<void>>();

export function isProcessSyncing(id: string): boolean {
  return syncs.has(id);
}

export function coordinateProcessWrite<T>(
  id: string,
  operation: () => Promise<T>,
  deleting = false,
): Promise<T> {
  if (deleting && isProcessSyncing(id)) {
    return Promise.reject(new Error('This process is syncing. Wait before deleting it.'));
  }
  const run = () => {
    if (deleting && isProcessSyncing(id)) {
      throw new Error('This process is syncing. Wait before deleting it.');
    }
    return operation();
  };
  // Wait for settlement; preceding failures still reject their own callers.
  const result = (writes.get(id) ?? Promise.resolve()).then(run, run);
  writes.set(id, result);
  const cleanup = () => { if (writes.get(id) === result) writes.delete(id); };
  void result.then(cleanup, cleanup);
  return result;
}

export function coordinateProcessSync(id: string, operation: () => Promise<void>): Promise<void> {
  const existing = syncs.get(id);
  if (existing) return existing;
  const result = (writes.get(id) ?? Promise.resolve()).then(operation, operation);
  syncs.set(id, result);
  const cleanup = () => { if (syncs.get(id) === result) syncs.delete(id); };
  void result.then(cleanup, cleanup);
  return result;
}

export async function syncLocalProcess(
  id: string,
  service: ProcessService,
): Promise<{ process: Process; localProcesses: Process[] }> {
  const snapshot = readLocalProcesses().find((process) => process.id === id);
  if (!snapshot) throw new Error('This process has no local changes to sync.');
  const entries = await service.listLatest();
  const [remote] = await service.readPersisted(entries.filter((entry) => entry.processId === id));
  const identical = remote && classifyProcessImport(snapshot, [remote]).status === 'already-present';
  if (!identical && remote && compareVersions(snapshot.version, remote.version) <= 0) {
    throw new Error(
      `Backend version "${remote.version}" conflicts with local version "${snapshot.version}". No backend data was changed. Edit the local process and save it with a higher version before syncing.`,
    );
  }
  const version = identical ? remote.version : (await service.save(snapshot)).version;
  return {
    process: { ...snapshot, version },
    localProcesses: removeLocalProcessIfUnchanged(snapshot),
  };
}
