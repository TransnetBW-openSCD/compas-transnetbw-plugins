import type { Process } from '@oscd-transnet-plugins/shared';
import { createProcessExport, parseStoredProcessesJson } from './processJson';

const STORAGE_KEY = 'engineering-wizard.local-processes';

export function readLocalProcesses(): Process[] {
  try {
    const content = localStorage.getItem(STORAGE_KEY);
    return content === null ? [] : parseStoredProcessesJson(content);
  } catch (error) {
    throw new Error(
      `Could not read local processes: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function writeLocalProcesses(processes: readonly Process[]): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(createProcessExport(processes)),
    );
  } catch (error) {
    throw new Error(
      `Could not save local processes in this browser: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function upsertLocalProcess(process: Process): Process[] {
  const processes = readLocalProcesses().filter(({ id }) => id !== process.id);
  processes.push(process);
  const stored = parseStoredProcessesJson(JSON.stringify(createProcessExport(processes)));
  writeLocalProcesses(stored);
  return stored;
}

export function removeLocalProcess(id: string): Process[] {
  const processes = readLocalProcesses().filter((process) => process.id !== id);
  writeLocalProcesses(processes);
  return processes;
}

export function removeLocalProcessIfUnchanged(snapshot: Process): Process[] {
  const processes = readLocalProcesses();
  const current = processes.find(({ id }) => id === snapshot.id);
  if (current && JSON.stringify(createProcessExport([current])) ===
    JSON.stringify(createProcessExport([snapshot]))) {
    return removeLocalProcess(snapshot.id);
  }
  return processes;
}
