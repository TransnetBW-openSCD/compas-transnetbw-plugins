import { bumpVersion, type Process } from '@oscd-transnet-plugins/shared';
import { toastService } from '@oscd-transnet-plugins/oscd-services/toast';
import { DEFAULT_PROCESSES_XML } from './config';
import { engineeringProcesses, engineeringProcessesStatus } from './stores.svelte';
import { parseProcessesXml, parseXmlString } from './xml-parser';
import { processService } from '../../bootstrap';
import { isBackendUnavailable, type VersionBump } from './process.service';
import { readLocalProcesses, upsertLocalProcess, removeLocalProcess } from './local-processes';
import { mergeProcesses, normalizeProcess, reconcileProcesses } from './process-reconciliation';
import {
  coordinateProcessWrite, coordinateProcessSync, isProcessSyncing, syncLocalProcess,
} from './process-sync';

let recentlySavedProcesses = new Map<string, Process>();
let loadGeneration = 0;
// Subset lookups coordinate backend status, not full-list publication.
let backendEpoch = 0;
let pendingWrites = 0;

export interface LoadWarning {
  title: string;
  message: string;
}

export interface LoadResult {
  processes: Process[];
  warnings: LoadWarning[];
}

export type PersistedProcessesResult =
  | { status: 'available'; processes: Map<string, Process> }
  | { status: 'unavailable'; message: string };

export interface SaveProcessResult {
  version: string;
  target: 'local' | 'backend';
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

function setLocalIds(processes: readonly Process[]): void {
  engineeringProcessesStatus.localProcessIds = processes.map(({ id }) => id);
}

export function isProcessLocal(id: string): boolean {
  return engineeringProcessesStatus.localProcessIds.includes(id);
}

// Only availability failures describe the backend. Operation failures (conflicts,
// validation, malformed data) are reported to their caller and leave status alone.
function recordBackendFailure(error: unknown): void {
  if (!isBackendUnavailable(error)) return;
  engineeringProcessesStatus.backend = 'unavailable';
  engineeringProcessesStatus.backendError = messageOf(error);
}

// Corrupt local storage must not block backend operations. Callers that need to
// write locally still fail loudly, so unreadable data is never overwritten.
function tryReadLocalProcesses(): Process[] | undefined {
  try {
    const local = readLocalProcesses();
    setLocalIds(local);
    engineeringProcessesStatus.localReadError = '';
    return local;
  } catch (error) {
    const message = messageOf(error);
    if (message !== engineeringProcessesStatus.localReadError) {
      engineeringProcessesStatus.localReadError = message;
      toastService.warn(
        'Local processes could not be read',
        `Backend operations continue, but local-only processes are unavailable and were not modified. ${message}`,
        15_000,
      );
    }
    return undefined;
  }
}

function recordBackendSuccess(): void {
  engineeringProcessesStatus.backend = 'available';
  engineeringProcessesStatus.backendError = '';
}

function publishSaved(process: Process): void {
  ++loadGeneration;
  ++backendEpoch;
  engineeringProcessesStatus.loading = false;
  recentlySavedProcesses.set(process.id, process);
  engineeringProcesses.processes = mergeProcesses(engineeringProcesses.processes, [process]);
}

async function trackWrite<T>(operation: () => Promise<T>): Promise<T> {
  ++pendingWrites;
  engineeringProcessesStatus.saving = true;
  engineeringProcessesStatus.saveError = '';
  try {
    return await operation();
  } catch (error) {
    engineeringProcessesStatus.saveError = messageOf(error);
    throw error;
  } finally {
    engineeringProcessesStatus.saving = --pendingWrites > 0;
  }
}

async function loadEngineeringProcessesFromSources(): Promise<LoadResult> {
  const current = ++loadGeneration;
  const backendCurrent = ++backendEpoch;
  const warnings: LoadWarning[] = [];
  const result = (): LoadResult => ({
    processes: engineeringProcesses.processes,
    warnings: current === loadGeneration ? warnings : [],
  });
  engineeringProcessesStatus.loading = true;
  engineeringProcessesStatus.error = '';
  const readLocal = (): Process[] | undefined => {
    try {
      const local = readLocalProcesses();
      setLocalIds(local);
      return local;
    } catch (error) {
      const warning = { title: 'Local processes could not be loaded', message: messageOf(error) };
      if (!warnings.some(({ title, message }) => title === warning.title && message === warning.message)) {
        warnings.push(warning);
      }
      return undefined;
    }
  };
  try {
    const baseline = parseProcessesXml(parseXmlString(DEFAULT_PROCESSES_XML));
    let local = readLocal();
    engineeringProcesses.processes = mergeProcesses(
      baseline, engineeringProcesses.processes, Array.from(recentlySavedProcesses.values()), local ?? [],
    ).map(normalizeProcess);
    engineeringProcessesStatus.loading = false;

    let remote: Process[];
    try {
      remote = await processService.readPersisted(await processService.listLatest());
    } catch (error) {
      if (current !== loadGeneration) return result();
      if (backendCurrent === backendEpoch) recordBackendFailure(error);
      warnings.push({
        title: 'Backend processes could not be loaded',
        message: `You can continue locally. Saved backend processes may be missing or outdated. ${messageOf(error)}`,
      });
      return result();
    }
    if (current !== loadGeneration) return result();
    if (backendCurrent === backendEpoch) recordBackendSuccess();
    // Preserve known local snapshots if storage fails, without hiding valid remote data.
    local = readLocal() ?? local ?? engineeringProcesses.processes.filter(({ id }) => isProcessLocal(id));
    const reconciled = reconcileProcesses(baseline, remote, recentlySavedProcesses, local);
    recentlySavedProcesses = reconciled.pending;
    engineeringProcesses.processes = reconciled.processes;
    return result();
  } catch (error) {
    if (current === loadGeneration) engineeringProcessesStatus.error = messageOf(error);
    throw error;
  } finally {
    if (current === loadGeneration) engineeringProcessesStatus.loading = false;
  }
}

export function loadEngineeringProcesses(): Promise<LoadResult> {
  return loadEngineeringProcessesFromSources();
}

export function refreshEngineeringProcesses(): Promise<LoadResult> {
  return loadEngineeringProcessesFromSources();
}

export async function getPersistedProcesses(ids: ReadonlySet<string>): Promise<PersistedProcessesResult> {
  if (ids.size === 0) return { status: 'available', processes: new Map() };
  const current = ++backendEpoch;
  try {
    const entries = await processService.listLatest();
    const processes = await processService.readPersisted(entries.filter(({ processId }) => ids.has(processId)));
    if (current === backendEpoch) recordBackendSuccess();
    return { status: 'available', processes: new Map(processes.map((process) => [process.id, process])) };
  } catch (error) {
    if (!isBackendUnavailable(error)) throw error;
    if (current === backendEpoch) recordBackendFailure(error);
    return { status: 'unavailable', message: messageOf(error) };
  }
}

export function saveProcess(
  process: Process,
  versionBump?: VersionBump,
  options: { localOnly?: boolean } = {},
): Promise<SaveProcessResult> {
  const snapshot = normalizeProcess($state.snapshot(process) as Process);
  return trackWrite(() => coordinateProcessWrite(snapshot.id, async () => {
    // Durable state, rather than a view flag, decides whether edits stay local.
    const local = tryReadLocalProcesses();
    const isLocal = local ? local.some(({ id }) => id === snapshot.id) : isProcessLocal(snapshot.id);
    const saveLocally = (): SaveProcessResult => {
      const version = versionBump
        ? bumpVersion(snapshot.version || '1.0.0', versionBump)
        : snapshot.version || '1.0.0';
      const saved = { ...snapshot, version };
      setLocalIds(upsertLocalProcess(saved));
      publishSaved(saved);
      return { version, target: 'local' };
    };
    if (options.localOnly || engineeringProcessesStatus.backend === 'unavailable' ||
      isLocal || isProcessSyncing(snapshot.id)) {
      return saveLocally();
    }
    let version: string;
    try {
      ({ version } = await processService.save(snapshot, versionBump));
    } catch (error) {
      if (!isBackendUnavailable(error)) throw error;
      recordBackendFailure(error);
      return saveLocally();
    }
    recordBackendSuccess();
    publishSaved({ ...snapshot, version });
    return { version, target: 'backend' };
  }));
}

export function syncProcess(process: Process): Promise<void> {
  const id = process.id;
  const alreadySyncing = isProcessSyncing(id);
  // Mark synchronously so the UI disables sync/delete even while queued behind a write.
  if (!alreadySyncing) {
    engineeringProcessesStatus.syncingProcessIds = [...engineeringProcessesStatus.syncingProcessIds, id];
  }
  const result = coordinateProcessSync(id, () => trackWrite(async () => {
    try {
      const synced = await syncLocalProcess(id, processService);
      setLocalIds(synced.localProcesses);
      recordBackendSuccess();
      // A save during upload wins over the uploaded snapshot.
      const newer = synced.localProcesses.find((local) => local.id === id);
      publishSaved(newer ?? normalizeProcess(synced.process));
    } catch (error) {
      recordBackendFailure(error);
      throw error;
    }
  }));
  if (!alreadySyncing) {
    const unmark = () => {
      engineeringProcessesStatus.syncingProcessIds =
        engineeringProcessesStatus.syncingProcessIds.filter((other) => other !== id);
    };
    void result.then(unmark, unmark);
  }
  return result;
}

export function deleteProcess(process: Process): Promise<void> {
  return trackWrite(() => coordinateProcessWrite(process.id, async () => {
    const local = tryReadLocalProcesses();
    const isLocal = local ? local.some(({ id }) => id === process.id) : isProcessLocal(process.id);
    if (isLocal) {
      setLocalIds(removeLocalProcess(process.id));
    } else {
      await processService.delete(process.id);
    }
    ++loadGeneration;
    ++backendEpoch;
    engineeringProcessesStatus.loading = false;
    recentlySavedProcesses.delete(process.id);
    engineeringProcesses.processes = engineeringProcesses.processes.filter(({ id }) => id !== process.id);
  }, true));
}
