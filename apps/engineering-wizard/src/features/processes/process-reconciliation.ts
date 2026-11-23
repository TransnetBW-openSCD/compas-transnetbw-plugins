import { compareVersions, type Process } from '@oscd-transnet-plugins/shared';
import { v5 as uuidv5 } from 'uuid';

const LEGACY_VALIDATION_NAMESPACE = uuidv5('engineering-wizard/legacy-validation', uuidv5.URL);

export function normalizeProcess(process: Process): Process {
  return {
    ...process,
    pluginGroups: process.pluginGroups.map((group) => ({
      ...group,
      plugins: group.plugins.map((plugin) => ({
        ...plugin,
        ...(plugin.validations ? {
          validations: plugin.validations.map((validation, index) => ({
            ...validation,
            id: validation.id ?? uuidv5(JSON.stringify([
              process.id, plugin.id, index, validation.title,
              validation.description ?? '', validation.context, validation.assert,
              validation.message ?? '',
            ]), LEGACY_VALIDATION_NAMESPACE),
          })),
        } : {}),
      })),
    })),
  };
}

export function mergeProcesses(...sources: readonly (readonly Process[])[]): Process[] {
  const byId = new Map<string, Process>();
  for (const source of sources) for (const process of source) byId.set(process.id, process);
  return Array.from(byId.values());
}

export function reconcileProcesses(
  baseline: readonly Process[],
  remote: readonly Process[],
  recent: ReadonlyMap<string, Process>,
  local: readonly Process[],
): { processes: Process[]; pending: Map<string, Process> } {
  const processes = mergeProcesses(baseline, remote);
  const pending = new Map<string, Process>();
  for (const [id, saved] of recent) {
    const persisted = remote.find((process) => process.id === id);
    if (!persisted || compareVersions(saved.version, persisted.version) > 0) pending.set(id, saved);
  }
  return {
    processes: mergeProcesses(processes, Array.from(pending.values()), local).map(normalizeProcess),
    pending,
  };
}
