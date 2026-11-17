// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/svelte';
import type { Process } from '@oscd-transnet-plugins/shared';
import { openDialog } from '@oscd-transnet-plugins/oscd-services/dialog';
import { toastService } from '@oscd-transnet-plugins/oscd-services/toast';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { deleteProcess, getPersistedProcesses, saveProcess, syncProcess } from '../features/processes/repository.svelte';
import { ProcessVersionConflictError } from '../features/processes/process.service';
import {
  engineeringProcesses,
  engineeringProcessesStatus,
  runningEngineeringProcess,
  selectedEngineeringProcess,
} from '../features/processes/stores.svelte';
import ProcessesList from './ProcessesList.view.svelte';
import { createProcessExport } from '../features/processes/processJson';
import { readLocalProcesses } from '../features/processes/local-processes';
import { readFileSync } from 'node:fs';

// Prevent Vite from rewriting this filesystem URL as a public asset.
const moduleUrl = import.meta.url;
const globalStyles = readFileSync(new URL('../../public/global.css', moduleUrl), 'utf8');

vi.mock('../features/processes/repository.svelte', () => ({
  deleteProcess: vi.fn(),
  saveProcess: vi.fn(),
  getPersistedProcesses: vi.fn(),
  syncProcess: vi.fn(),
  isProcessLocal: (id: string) => engineeringProcessesStatus.localProcessIds.includes(id),
}));
vi.mock('@oscd-transnet-plugins/oscd-services/dialog', () => ({
  openDialog: vi.fn(),
}));
vi.mock('@oscd-transnet-plugins/oscd-services/toast', () => ({
  toastService: { success: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

function publishSave(process: Process, version: string) {
  const saved = { ...JSON.parse(JSON.stringify(process)) as Process, version };
  engineeringProcesses.processes = [...engineeringProcesses.processes, saved];
  return { version, target: 'backend' as const };
}

beforeEach(() => {
  vi.resetAllMocks();
  runningEngineeringProcess.process = null;
  engineeringProcessesStatus.loading = false;
  engineeringProcessesStatus.error = '';
  engineeringProcessesStatus.backend = 'unknown';
  engineeringProcessesStatus.localProcessIds = [];
  localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  engineeringProcesses.processes = ['Alpha', 'Beta', 'Gamma'].map((name) => ({
    id: name.toLowerCase(),
    name,
    description: '',
    version: '1.0.0',
    pluginGroups: [],
  }));
  vi.mocked(openDialog).mockResolvedValue({ type: 'confirm' });
  vi.mocked(getPersistedProcesses).mockResolvedValue({ status: 'available', processes: new Map() });
  vi.mocked(saveProcess).mockImplementation(async (process) => publishSave(process, process.version));
});

afterEach(() => {
  cleanup();
  document.getElementById('process-list-global-css')?.remove();
  selectedEngineeringProcess.process = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderList() {
  const callbacks = {
    handleStart: vi.fn(),
    handleView: vi.fn(),
    handleEdit: vi.fn(),
    handleAddNew: vi.fn(),
    handleDeleted: vi.fn(),
  };
  return { ...render(ProcessesList, callbacks), ...callbacks };
}

it('recalculates the scrollable table height when host padding changes around a running process', async () => {
  const callbacks = new Map<Element, Set<() => void>>();
  vi.stubGlobal('ResizeObserver', class {
    private targets = new Set<Element>();
    constructor(private callback: () => void) {}
    observe(target: Element, options?: ResizeObserverOptions) {
      if (options?.box !== 'border-box') return;
      this.targets.add(target);
      if (!callbacks.has(target)) callbacks.set(target, new Set());
      callbacks.get(target)?.add(this.callback);
    }
    disconnect() {
      for (const target of this.targets) callbacks.get(target)?.delete(this.callback);
    }
  });
  let tableTop = 144;
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(() => new DOMRect(0, tableTop, 1000, 0));
  try {
    const { container, getByRole } = renderList();
    const table = container.querySelector<HTMLElement>('.oscd-basic-table');
    expect(table?.style.getPropertyValue('--oscd-basic-table-max-height'))
      .toBe(`${window.innerHeight - 144 - 24}px`);

    runningEngineeringProcess.process = engineeringProcesses.processes[0];
    await waitFor(() => expect(getByRole('button', { name: 'Continue', exact: true })).toBeTruthy());
    tableTop = 236;
    for (const callback of callbacks.get(document.body) ?? []) callback();
    expect(table?.style.getPropertyValue('--oscd-basic-table-max-height'))
      .toBe(`${window.innerHeight - 236 - 24}px`);

    tableTop = 300;
    for (const callback of callbacks.get(document.body) ?? []) callback();
    expect(table?.style.getPropertyValue('--oscd-basic-table-max-height'))
      .toBe(`${window.innerHeight - 300 - 24}px`);
  } finally {
    bounds.mockRestore();
  }
});

it('opens a saved duplicate when the user stays in the process list', async () => {
  const { getAllByRole, handleEdit, handleView } = renderList();

  await fireEvent.click(getAllByRole('button', { name: 'Duplicate process' })[0]);

  await waitFor(() => expect(handleEdit).toHaveBeenCalledOnce());
  expect(handleEdit).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'alpha-copy', name: 'Alpha (copy)', version: '1.0.0' }),
  );
  expect(handleView).not.toHaveBeenCalled();
  expect(engineeringProcesses.processes).toHaveLength(4);
});

it('shows Sync only for local processes and retains local state when syncing fails', async () => {
  const stylesheet = document.createElement('style');
  stylesheet.id = 'process-list-global-css';
  stylesheet.textContent = globalStyles;
  document.head.appendChild(stylesheet);
  engineeringProcessesStatus.localProcessIds = ['alpha'];
  vi.mocked(syncProcess).mockRejectedValueOnce(new TypeError('Backend unavailable'));
  const { getByRole, queryByRole, getByText, handleView } = renderList();
  expect(getByText('Local only')).toBeTruthy();
  expect(queryByRole('button', { name: 'Sync process Beta' })).toBeNull();
  const syncButton = getByRole('button', { name: 'Sync process Alpha' });
  expect(getComputedStyle(syncButton).marginBottom).toBe('0px');
  expect(syncButton.querySelector('svg')).not.toBeNull();
  expect(syncButton.querySelector('svg path')?.getAttribute('d')).not.toBe(
    getByRole('button', { name: 'Export' }).querySelector('svg path')?.getAttribute('d'),
  );
  expect(syncButton.title).toBe('Sync to backend');
  expect(syncButton.closest('td')?.textContent).toContain('Local only');
  expect(syncButton.closest('.ew-table-actions')).toBeNull();
  const localActions = syncButton.closest('tr')?.querySelector('.ew-table-actions');
  const syncedActions = getByRole('checkbox', { name: 'Select process Beta' })
    .closest('tr')?.querySelector('.ew-table-actions');
  for (const actions of [localActions, syncedActions]) {
    expect(Array.from(actions?.children ?? []).map((button) => button.getAttribute('aria-label')))
      .toEqual(['Start process', 'Duplicate process', 'Delete process']);
  }

  await fireEvent.click(syncButton);

  await waitFor(() => expect(toastService.error).toHaveBeenCalledWith(
    'Sync failed', 'Backend unavailable Your local process was kept.',
  ));
  expect(handleView).not.toHaveBeenCalled();
  expect(getByRole<HTMLButtonElement>('button', { name: 'Sync process Alpha' }).disabled).toBe(false);

  vi.mocked(syncProcess).mockImplementationOnce(async () => {
    engineeringProcessesStatus.localProcessIds = [];
  });
  await fireEvent.click(getByRole('button', { name: 'Sync process Alpha' }));
  await waitFor(() => expect(queryByRole('button', { name: 'Sync process Alpha' })).toBeNull());
  expect(toastService.success).toHaveBeenCalledWith(
    'Process synced', '"Alpha" was saved to the backend.',
  );
});

it('loads the built-in process and imports files locally when the backend is unreachable', async () => {
  const repository = await vi.importActual<typeof import('../features/processes/repository.svelte')>(
    '../features/processes/repository.svelte',
  );
  vi.mocked(getPersistedProcesses).mockImplementation(repository.getPersistedProcesses);
  vi.mocked(saveProcess).mockImplementation(repository.saveProcess);
  engineeringProcesses.processes = [];
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await repository.loadEngineeringProcesses();
  const { getByRole, getByLabelText } = renderList();
  expect(getByRole('checkbox', { name: 'Select process Standard Process 1' })).toBeTruthy();
  expect(getByRole<HTMLButtonElement>('button', { name: 'Import' }).disabled).toBe(false);
  const process: Process = {
    id: 'offline-import', name: 'Offline import', description: '', version: '1.0.0', pluginGroups: [],
  };
  await fireEvent.change(getByLabelText('Import processes JSON files'), {
    target: { files: [{
      name: 'local.json', size: 100,
      text: async () => JSON.stringify(createProcessExport([process])),
    }] },
  });
  await waitFor(() => expect(toastService.success).toHaveBeenCalledWith(
    'Process import complete', expect.stringContaining('1 saved locally in this browser. Use Sync'),
  ));
  expect(getByRole('button', { name: 'Sync process Offline import' })).toBeTruthy();
  engineeringProcesses.processes = [];
  await repository.loadEngineeringProcesses();
  expect(engineeringProcesses.processes.some(({ id }) => id === 'offline-import')).toBe(true);
});

it('keeps an import local after its lookup fails even when a newer refresh reconnects', async () => {
  const repository = await vi.importActual<typeof import('../features/processes/repository.svelte')>(
    '../features/processes/repository.svelte',
  );
  vi.mocked(getPersistedProcesses).mockImplementationOnce(repository.getPersistedProcesses);
  vi.mocked(saveProcess).mockImplementationOnce(repository.saveProcess);
  let rejectLookup!: (reason: Error) => void;
  const fetchBackend = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { rejectLookup = reject; }))
    .mockImplementation(async () => new Response('[]', {
      headers: { 'Content-Type': 'application/json' },
    }));
  vi.stubGlobal('fetch', fetchBackend);
  const { getByLabelText, getByRole } = renderList();
  const process: Process = {
    id: 'unverified-import', name: 'Unverified import', version: '1.0.0', description: '', pluginGroups: [],
  };
  await fireEvent.change(getByLabelText('Import processes JSON files'), {
    target: { files: [{
      name: 'processes.json', size: 100,
      text: async () => JSON.stringify(createProcessExport([process])),
    }] },
  });
  await waitFor(() => expect(fetchBackend).toHaveBeenCalledOnce());
  await repository.refreshEngineeringProcesses();
  expect(engineeringProcessesStatus.backend).toBe('available');
  rejectLookup(new TypeError('Failed to fetch'));
  await waitFor(() => expect(toastService.success).toHaveBeenCalledWith(
    'Process import complete', expect.stringContaining('1 saved locally'),
  ));
  expect(saveProcess).toHaveBeenCalledWith(process, undefined, { localOnly: true });
  expect(fetchBackend).toHaveBeenCalledTimes(2);
  expect(readLocalProcesses()).toEqual([process]);
  expect(getByRole('button', { name: 'Sync process Unverified import' })).toBeTruthy();
  await repository.deleteProcess(process);
});

it('duplicates a process locally without a backend', async () => {
  const repository = await vi.importActual<typeof import('../features/processes/repository.svelte')>(
    '../features/processes/repository.svelte',
  );
  vi.mocked(saveProcess).mockImplementationOnce(repository.saveProcess);
  engineeringProcessesStatus.backend = 'unavailable';
  const { getAllByRole, getByRole, handleEdit } = renderList();
  await fireEvent.click(getAllByRole('button', { name: 'Duplicate process' })[0]);
  await waitFor(() => expect(handleEdit).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'alpha-copy' }),
  ));
  expect(getByRole('button', { name: 'Sync process Alpha (copy)' })).toBeTruthy();
  expect(toastService.success).toHaveBeenCalledWith('Process duplicated', expect.stringContaining('locally'));
});

it('saves a pending duplicate without discarding a draft opened after leaving the list', async () => {
  let finishSave!: (version: string) => void;
  vi.mocked(saveProcess).mockImplementationOnce(async (process) => {
    const version = await new Promise<string>((resolve) => { finishSave = resolve; });
    return publishSave(process, version);
  });
  const { getAllByRole, handleEdit, unmount } = renderList();
  handleEdit.mockImplementation((process: Process) => {
    selectedEngineeringProcess.process = process;
  });
  await fireEvent.click(getAllByRole('button', { name: 'Duplicate process' })[0]);
  expect(saveProcess).toHaveBeenCalledOnce();
  await unmount();
  selectedEngineeringProcess.draft = {
    id: 'unsaved',
    name: 'Unsaved work',
    description: '',
    version: '1.0.0',
    pluginGroups: [],
  };

  finishSave('1.0.0');

  await waitFor(() => expect(engineeringProcesses.processes).toHaveLength(4));
  expect(handleEdit).not.toHaveBeenCalled();
  expect(selectedEngineeringProcess.draft?.name).toBe('Unsaved work');
  expect(toastService.success).toHaveBeenCalledWith('Process duplicated', expect.any(String));
});

it.each(['Start', 'Continue'])(
  'keeps the %s label and starts the process without opening its editor',
  async (label) => {
    if (label === 'Continue') {
      runningEngineeringProcess.process = engineeringProcesses.processes[0];
    }
    const { getByRole, handleStart, handleView } = renderList();
    const table = within(getByRole('table'));
    const action = table.getAllByRole('button', {
      name: `${label} process`,
    })[0];

    expect(action.textContent?.trim()).toBe(label);
    await fireEvent.click(action);
    expect(handleStart).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'alpha' }),
    );
    expect(handleView).not.toHaveBeenCalled();
  },
);

it.each(['short', 'long'])(
  'preserves full %s process text in tooltips and row callbacks',
  async (length) => {
    const repeat = length === 'long' ? 50 : 1;
    const process = {
      id: 'process-a',
      name: 'Process name '.repeat(repeat).trim(),
      description: 'Description with <equipment> & details '
        .repeat(repeat)
        .trim(),
      version: `1.0.0-${'revision'.repeat(repeat)}`,
      pluginGroups: [],
    };
    engineeringProcesses.processes = [process];
    const { getByTitle, getByRole, handleView } = renderList();

    for (const value of [process.name, process.description, process.version]) {
      expect(getByTitle(value).textContent).toBe(value);
    }
    const table = within(getByRole('table'));
    expect(table.getByRole('button', { name: 'Start process' })).toBeTruthy();
    expect(table.getByRole('button', { name: 'Delete process' })).toBeTruthy();
    await fireEvent.click(getByTitle(process.name));
    expect(handleView).toHaveBeenCalledWith(expect.objectContaining(process));
  },
);

it('selects rows without opening them and shows partial/select-all state', async () => {
  const { getByRole, handleView } = renderList();
  const toolbar = within(
    getByRole('toolbar', { name: 'Processes table controls' }),
  );
  expect(
    toolbar.getByRole('searchbox', { name: 'Search Processes' }),
  ).toBeTruthy();
  expect(toolbar.getByRole('status').textContent?.trim()).toBe('3 processes');
  expect(
    toolbar.getByRole<HTMLButtonElement>('button', {
      name: 'Delete',
      exact: true,
    }).disabled,
  ).toBe(true);
  const alpha = getByRole('checkbox', { name: 'Select process Alpha' });
  const all = getByRole<HTMLInputElement>('checkbox', {
    name: 'Select all rows',
  });

  const selectionCell = alpha.closest('td');
  if (!selectionCell) throw new Error('Missing checkbox cell');
  await fireEvent.click(selectionCell);
  expect(handleView).not.toHaveBeenCalled();
  expect(getByRole<HTMLInputElement>('checkbox', { name: 'Select process Alpha' }).checked).toBe(false);

  await fireEvent.keyDown(alpha, { key: ' ' });
  expect(handleView).not.toHaveBeenCalled();
  await fireEvent.click(alpha);
  expect(handleView).not.toHaveBeenCalled();
  expect(all.indeterminate).toBe(true);
  expect(toolbar.getByRole('status').textContent?.trim()).toBe('1 selected');

  await fireEvent.click(all);
  expect(
    toolbar.getByRole<HTMLButtonElement>('button', {
      name: 'Delete',
      exact: true,
    }).disabled,
  ).toBe(false);
  expect(toolbar.getByRole('status').textContent?.trim()).toBe('3 selected');
  expect(all.checked).toBe(true);
  await fireEvent.click(all);
  expect(
    toolbar.getByRole<HTMLButtonElement>('button', {
      name: 'Delete',
      exact: true,
    }).disabled,
  ).toBe(true);
  expect(toolbar.getByRole('status').textContent?.trim()).toBe('3 processes');
});

it.each([0, 1])(
  'shows the process count and disabled deletion for %i processes',
  (count) => {
    engineeringProcesses.processes = engineeringProcesses.processes.slice(
      0,
      count,
    );
    const { getByRole } = renderList();

    expect(getByRole('status').textContent?.trim()).toBe(
      `${count} ${count === 1 ? 'process' : 'processes'}`,
    );
    expect(
      getByRole<HTMLButtonElement>('button', { name: 'Delete', exact: true })
        .disabled,
    ).toBe(true);
  },
);

it('excludes hidden selections from bulk deletion and preserves failed deletions for retry', async () => {
  const { getByRole, handleDeleted } = renderList();
  await fireEvent.click(
    getByRole('checkbox', { name: 'Select process Alpha' }),
  );
  await fireEvent.input(getByRole('searchbox'), { target: { value: 'Beta' } });
  expect(
    getByRole<HTMLButtonElement>('button', { name: 'Delete', exact: true })
      .disabled,
  ).toBe(true);
  expect(getByRole('status').textContent?.trim()).toBe('1 process');
  await fireEvent.click(getByRole('checkbox', { name: 'Select all rows' }));

  vi.mocked(deleteProcess).mockImplementation(async (process: Process) => {
    if (process.id === 'beta') throw new Error('Backend unavailable');
    engineeringProcesses.processes = engineeringProcesses.processes.filter(
      (item) => item.id !== process.id,
    );
  });
  await fireEvent.click(getByRole('button', { name: 'Delete', exact: true }));

  await waitFor(() =>
    expect(toastService.error).toHaveBeenCalledWith(
      'Delete failed',
      '"Beta" could not be deleted.',
    ),
  );
  expect(openDialog).toHaveBeenCalledTimes(1);
  expect(
    vi.mocked(deleteProcess).mock.calls.map(([process]) => process.id),
  ).toEqual(['beta']);
  expect(handleDeleted).not.toHaveBeenCalled();
  expect(
    getByRole<HTMLInputElement>('checkbox', { name: 'Select process Beta' })
      .checked,
  ).toBe(true);
  expect(
    getByRole<HTMLButtonElement>('button', { name: 'Delete', exact: true })
      .disabled,
  ).toBe(false);
  await fireEvent.input(getByRole('searchbox'), { target: { value: '' } });
  expect(
    getByRole<HTMLInputElement>('checkbox', { name: 'Select process Alpha' })
      .checked,
  ).toBe(true);
});

it('removes successful bulk deletions from the selection but retains failures', async () => {
  const { getByRole, handleDeleted } = renderList();
  await fireEvent.click(getByRole('checkbox', { name: 'Select all rows' }));
  vi.mocked(deleteProcess).mockImplementation(async (process: Process) => {
    if (process.id === 'beta') throw new Error('Backend unavailable');
    engineeringProcesses.processes = engineeringProcesses.processes.filter(
      (item) => item.id !== process.id,
    );
  });
  await fireEvent.click(getByRole('button', { name: 'Delete', exact: true }));

  await waitFor(() => expect(toastService.error).toHaveBeenCalled());
  expect(handleDeleted.mock.calls.map(([process]) => process.id)).toEqual([
    'alpha',
    'gamma',
  ]);
  expect(
    getByRole<HTMLInputElement>('checkbox', { name: 'Select process Beta' })
      .checked,
  ).toBe(true);
  expect(
    getByRole<HTMLButtonElement>('button', { name: 'Delete', exact: true })
      .disabled,
  ).toBe(false);
});

it('does not delete or clear selection when confirmation is cancelled', async () => {
  vi.mocked(openDialog).mockResolvedValue({ type: 'cancel' });
  const { getByRole } = renderList();
  await fireEvent.click(getByRole('checkbox', { name: 'Select all rows' }));
  await fireEvent.click(getByRole('button', { name: 'Delete', exact: true }));

  await waitFor(() =>
    expect(
      getByRole<HTMLButtonElement>('button', { name: 'Delete', exact: true })
        .disabled,
    ).toBe(false),
  );
  expect(deleteProcess).not.toHaveBeenCalled();
  expect(
    getByRole<HTMLInputElement>('checkbox', { name: 'Select all rows' })
      .checked,
  ).toBe(true);
});

it('selects and deselects ranges with Shift without opening a process', async () => {
  const { getByRole, handleView } = renderList();
  const alpha = getByRole<HTMLInputElement>('checkbox', {
    name: 'Select process Alpha',
  });
  const beta = getByRole<HTMLInputElement>('checkbox', {
    name: 'Select process Beta',
  });
  const gamma = getByRole<HTMLInputElement>('checkbox', {
    name: 'Select process Gamma',
  });

  await fireEvent.click(gamma);
  await fireEvent.click(alpha, { shiftKey: true });

  expect([alpha.checked, beta.checked, gamma.checked]).toEqual([
    true,
    true,
    true,
  ]);
  expect(
    getByRole('button', {
      name: 'Delete',
      exact: true,
    }).closest('[role="toolbar"]'),
  ).not.toBeNull();
  expect(handleView).not.toHaveBeenCalled();

  await fireEvent.click(alpha, { shiftKey: true });
  expect([alpha.checked, beta.checked, gamma.checked]).toEqual([
    false,
    false,
    false,
  ]);
  expect(
    getByRole<HTMLButtonElement>('button', { name: 'Delete', exact: true })
      .disabled,
  ).toBe(true);
});

it('does not extend a Shift selection from an anchor hidden by filtering', async () => {
  const { getByRole } = renderList();
  await fireEvent.click(
    getByRole('checkbox', { name: 'Select process Alpha' }),
  );
  await fireEvent.input(getByRole('searchbox'), { target: { value: 'Gamma' } });
  await fireEvent.click(
    getByRole('checkbox', { name: 'Select process Gamma' }),
    { shiftKey: true },
  );
  await fireEvent.input(getByRole('searchbox'), { target: { value: '' } });

  expect(
    getByRole<HTMLInputElement>('checkbox', { name: 'Select process Alpha' })
      .checked,
  ).toBe(true);
  expect(
    getByRole<HTMLInputElement>('checkbox', { name: 'Select process Beta' })
      .checked,
  ).toBe(false);
  expect(
    getByRole<HTMLInputElement>('checkbox', { name: 'Select process Gamma' })
      .checked,
  ).toBe(true);
});

it('places import before new process and export before delete using table action styling', () => {
  const { getByRole, getByText } = renderList();
  const importButton = getByRole('button', { name: 'Import' });
  const exportButton = getByRole('button', { name: 'Export' });
  const toolbar = getByRole('toolbar', { name: 'Processes table controls' });
  const newButton = getByText('Add new process');
  const deleteButton = within(toolbar).getByRole('button', { name: 'Delete', exact: true });

  expect(importButton.closest('.process-toolbar__actions')).toBe(newButton.parentElement);
  expect(importButton.compareDocumentPosition(newButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(toolbar.contains(importButton)).toBe(false);
  expect(exportButton.parentElement?.nextElementSibling).toBe(deleteButton);
  for (const button of [importButton, exportButton]) {
    expect(button.classList.contains('ew-table-action--labeled')).toBe(true);
    expect(button.style.getPropertyValue('--mdc-theme-primary')).toBe('var(--oscd-plugin-surface)');
    expect(button.style.borderWidth).toBe('0px');
    expect(button.querySelector('svg')).not.toBeNull();
  }
});

it('exports only selected visible processes', async () => {
  const createObjectURL = vi.fn<(blob: Blob) => string>().mockReturnValue('blob:processes');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  const { getByRole } = renderList();
  expect(getByRole<HTMLButtonElement>('button', { name: 'Export' }).disabled).toBe(true);
  await fireEvent.click(getByRole('checkbox', { name: 'Select process Alpha' }));
  expect(getByRole<HTMLButtonElement>('button', { name: 'Export' }).disabled).toBe(false);
  await fireEvent.click(getByRole('button', { name: 'Export' }));
  expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  expect(click).toHaveBeenCalledOnce();
  const blob = vi.mocked(createObjectURL).mock.calls[0][0];
  const content = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
  expect(JSON.parse(content)).toEqual(createProcessExport([engineeringProcesses.processes[0]]));
  await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:processes'));
  await fireEvent.click(getByRole('checkbox', { name: 'Select process Alpha' }));
  expect(getByRole<HTMLButtonElement>('button', { name: 'Export' }).disabled).toBe(true);
  await fireEvent.click(getByRole('checkbox', { name: 'Select process Alpha' }));
  await fireEvent.input(getByRole('searchbox'), { target: { value: 'Beta' } });
  expect(getByRole<HTMLButtonElement>('button', { name: 'Export' }).disabled).toBe(true);
  click.mockRestore();
});

it('persists new processes, reports ID conflicts separately from save failures, and highlights only additions', async () => {
  vi.mocked(saveProcess)
    .mockImplementationOnce(async (process) => publishSave(process, '2.0.0'))
    .mockRejectedValueOnce(new Error('Backend unavailable'));
  const { getByLabelText, container } = renderList();
  const input = getByLabelText('Import processes JSON files');
  const processes = ['alpha', 'new', 'failed'].map((id) => ({
    id, name: id, description: '', version: '1.0.0', pluginGroups: [],
  }));
  await fireEvent.change(input, {
    target: { files: [{ name: 'processes.json', size: 100, text: async () => JSON.stringify(createProcessExport(processes)) }] },
  });
  await waitFor(() => expect(toastService.warn).toHaveBeenCalled());
  expect(vi.mocked(saveProcess).mock.calls.map(([process]) => process.id)).toEqual(['new', 'failed']);
  expect(engineeringProcesses.processes.map(({ id }) => id)).toEqual(['alpha', 'beta', 'gamma', 'new']);
  expect(engineeringProcesses.processes.at(-1)?.version).toBe('2.0.0');
  expect(toastService.warn).toHaveBeenCalledWith(
    'Process import completed with issues',
    expect.stringContaining('Backend unavailable'),
    15_000,
  );
  expect(toastService.warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.stringContaining('1 imported; 0 already present; 1 conflicting; 1 failed.'),
    15_000,
  );
  expect(container.querySelectorAll('tr.oscd-basic-table__row--added')).toHaveLength(1);
  expect((input as HTMLInputElement).value).toBe('');
});

it('recognizes an identical backend-only process without uploading it', async () => {
  const process = { id: 'backend-only', name: 'Existing remote process', description: '', version: '9.0.0', pluginGroups: [] };
  vi.mocked(getPersistedProcesses).mockResolvedValueOnce({ status: 'available', processes: new Map([[process.id, process]]) });
  const { getByLabelText } = renderList();
  await fireEvent.change(getByLabelText('Import processes JSON files'), {
    target: { files: [{
      name: 'processes.json',
      size: 100,
      text: async () => JSON.stringify(createProcessExport([process])),
    }] },
  });

  await waitFor(() => expect(toastService.success).toHaveBeenCalledWith(
    'Process import complete',
    '0 imported; 1 already present; 0 conflicting; 0 failed.',
  ));
  expect(getPersistedProcesses).toHaveBeenCalledOnce();
  expect(saveProcess).not.toHaveBeenCalled();
  expect(engineeringProcesses.processes.map(({ id }) => id)).toEqual(['alpha', 'beta', 'gamma']);
});

it('imports the first stored process when the backend returns SDS-0006 and only the default process exists', async () => {
  engineeringProcesses.processes = [{
    id: 'default', name: 'Default', description: '', version: '1.0.0', pluginGroups: [],
  }];
  const repository = await vi.importActual<typeof import('../features/processes/repository.svelte')>(
    '../features/processes/repository.svelte',
  );
  vi.mocked(getPersistedProcesses).mockImplementationOnce(repository.getPersistedProcesses);
  vi.mocked(saveProcess).mockImplementationOnce(repository.saveProcess);
  const fetchBackend = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      errorMessages: [{
        code: 'SDS-0006',
        message: "No data entries found for type 'engineering-wizard_process'",
        property: null,
      }],
    }), { status: 404 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'resource-1', version: '1.0.0' })));
  vi.stubGlobal('fetch', fetchBackend);
  const { getByLabelText, getByRole } = renderList();
  const process: Process = {
    id: 'first-import', name: 'First import', description: '', version: '1.0.0', pluginGroups: [],
  };
  await fireEvent.change(getByLabelText('Import processes JSON files'), {
    target: { files: [{
      name: 'processes.json', size: 100,
      text: async () => JSON.stringify(createProcessExport([process])),
    }] },
  });

  await waitFor(() => expect(toastService.success).toHaveBeenCalledWith(
    'Process import complete',
    '1 imported; 0 already present; 0 conflicting; 0 failed.',
  ));
  expect(fetchBackend).toHaveBeenCalledTimes(2);
  expect(fetchBackend).toHaveBeenNthCalledWith(
    1, expect.stringContaining('/plugins/resources/engineering-wizard_process/latest'),
    expect.objectContaining({ method: 'GET' }),
  );
  expect(fetchBackend).toHaveBeenNthCalledWith(
    2, expect.stringMatching(/\/plugins\/resources$/),
    expect.objectContaining({ method: 'POST' }),
  );
  expect(engineeringProcesses.processes.map(({ id }) => id)).toEqual(['default', 'first-import']);
  expect(getByRole('checkbox', { name: 'Select process First import' })).toBeTruthy();
  expect(toastService.error).not.toHaveBeenCalled();
});

it('does not save while backend verification is pending or failed and allows retry', async () => {
  let rejectCheck!: (reason: Error) => void;
  vi.mocked(getPersistedProcesses).mockReturnValueOnce(new Promise((_resolve, reject) => {
    rejectCheck = reject;
  }));
  const { getByLabelText, getByRole } = renderList();
  const process = { id: 'new', name: 'New process', description: '', version: '1.0.0', pluginGroups: [] };
  const event = { target: { files: [{
    name: 'processes.json',
    size: 100,
    text: async () => JSON.stringify(createProcessExport([process])),
  }] } };
  const input = getByLabelText('Import processes JSON files');
  await fireEvent.change(input, event);
  await waitFor(() => expect(getPersistedProcesses).toHaveBeenCalledOnce());
  expect(saveProcess).not.toHaveBeenCalled();
  expect(getByRole<HTMLButtonElement>('button', { name: 'Import' }).disabled).toBe(true);

  rejectCheck(new Error('Backend unavailable'));
  await waitFor(() => expect(toastService.error).toHaveBeenCalledWith('Import failed', 'Backend unavailable'));
  expect(saveProcess).not.toHaveBeenCalled();
  expect(engineeringProcesses.processes).toHaveLength(3);
  expect(toastService.success).not.toHaveBeenCalled();
  expect(getByRole<HTMLButtonElement>('button', { name: 'Import' }).disabled).toBe(false);

  await fireEvent.change(input, event);
  await waitFor(() => expect(toastService.success).toHaveBeenCalled());
  expect(getPersistedProcesses).toHaveBeenCalledTimes(2);
  expect(saveProcess).toHaveBeenCalledOnce();
  expect(engineeringProcesses.processes.map(({ id }) => id)).toEqual(['alpha', 'beta', 'gamma', 'new']);
});

it('skips identical processes across files, preserves duplicate display names, and never saves conflicting versions', async () => {
  const original = engineeringProcesses.processes[0];
  const incoming: Process = {
    id: 'new-alpha', name: 'Alpha', description: '', version: '1.0.0', pluginGroups: [],
  };
  const { getByLabelText } = renderList();
  const file = (name: string, processes: Process[]) => ({
    name,
    size: 100,
    text: async () => JSON.stringify(createProcessExport(processes)),
  });

  await fireEvent.change(getByLabelText('Import processes JSON files'), {
    target: { files: [
      file('first.json', [original, incoming]),
      file('second.json', [incoming, { ...incoming, version: '2.0.0' }]),
    ] },
  });

  await waitFor(() => expect(toastService.warn).toHaveBeenCalledWith(
    'Process import completed with issues',
    expect.stringContaining('1 imported; 2 already present; 1 conflicting; 0 failed.'),
    15_000,
  ));
  expect(saveProcess).toHaveBeenCalledOnce();
  expect(saveProcess).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-alpha', name: 'Alpha' }));
  expect(engineeringProcesses.processes.find(({ id }) => id === 'alpha')).toBe(original);
  expect(engineeringProcesses.processes.filter(({ name }) => name === 'Alpha')).toHaveLength(2);
});

it('reports a backend-only version conflict without saving or changing local state', async () => {
  const process: Process = {
    id: 'backend-only', name: 'Remote', description: '', version: '2.0.0', pluginGroups: [],
  };
  vi.mocked(getPersistedProcesses).mockResolvedValueOnce({ status: 'available', processes: new Map([[process.id, process]]) });
  const { getByLabelText } = renderList();
  await fireEvent.change(getByLabelText('Import processes JSON files'), {
    target: { files: [{
      name: 'older.json', size: 100,
      text: async () => JSON.stringify(createProcessExport([{ ...process, version: '1.0.0' }])),
    }] },
  });

  await waitFor(() => expect(toastService.warn).toHaveBeenCalledWith(
    'Process import completed with issues',
    expect.stringContaining('Existing version "2.0.0" differs from imported version "1.0.0".'),
    15_000,
  ));
  expect(saveProcess).not.toHaveBeenCalled();
  expect(engineeringProcesses.processes).toHaveLength(3);
});

it('reports concurrent backend version conflicts separately from failed saves', async () => {
  vi.mocked(saveProcess).mockRejectedValueOnce(new ProcessVersionConflictError('new', '1.0.0'));
  const process: Process = {
    id: 'new', name: 'New', description: '', version: '1.0.0', pluginGroups: [],
  };
  const { getByLabelText, container } = renderList();
  await fireEvent.change(getByLabelText('Import processes JSON files'), {
    target: { files: [{
      name: 'new.json', size: 100, text: async () => JSON.stringify(createProcessExport([process])),
    }] },
  });

  await waitFor(() => expect(toastService.warn).toHaveBeenCalledWith(
    'Process import completed with issues',
    expect.stringContaining('0 imported; 0 already present; 1 conflicting; 0 failed.'),
    15_000,
  ));
  expect(engineeringProcesses.processes).toHaveLength(3);
  expect(container.querySelector('.oscd-basic-table__row--added')).toBeNull();
});

it('sorts rows without reordering stored processes and briefly highlights successful imports', async () => {
  engineeringProcesses.processes.reverse();
  const { getAllByRole, getByLabelText, getByRole } = renderList();
  expect(getAllByRole('checkbox').slice(1).map((checkbox) => checkbox.getAttribute('aria-label')))
    .toEqual(['Select process Alpha', 'Select process Beta', 'Select process Gamma']);
  expect(engineeringProcesses.processes.map(({ id }) => id)).toEqual(['gamma', 'beta', 'alpha']);
  vi.useFakeTimers();
  const process: Process = {
    id: 'aardvark', name: 'Aardvark', description: '', version: '1.0.0', pluginGroups: [],
  };
  await fireEvent.change(getByLabelText('Import processes JSON files'), {
    target: { files: [{
      name: 'new.json', size: 100, text: async () => JSON.stringify(createProcessExport([process])),
    }] },
  });
  await vi.advanceTimersByTimeAsync(0);

  const row = getByRole('checkbox', { name: 'Select process Aardvark' }).closest('tr');
  expect(getAllByRole('checkbox')[1].getAttribute('aria-label')).toBe('Select process Aardvark');
  expect(row?.classList.contains('oscd-basic-table__row--added')).toBe(true);
  await vi.advanceTimersByTimeAsync(1600);
  expect(row?.classList.contains('oscd-basic-table__row--added')).toBe(false);
});

it('gives every process imported from multiple files its own uninterrupted highlight lifetime', async () => {
  const { getByLabelText, getByRole } = renderList();
  vi.useFakeTimers();
  vi.mocked(saveProcess).mockImplementation((process) =>
    new Promise((resolve) => setTimeout(() => resolve(publishSave(process, '1.0.0')), 400)),
  );
  const incoming: Process[] = ['A', 'B', 'C'].map((suffix) => ({
    id: `imported-${suffix}`,
    name: `Imported ${suffix}`,
    description: '',
    version: '1.0.0',
    pluginGroups: [],
  }));
  const file = (name: string, processes: Process[]) => ({
    name,
    size: 100,
    text: async () => JSON.stringify(createProcessExport(processes)),
  });
  const highlighted = (name: string) =>
    getByRole('checkbox', { name: `Select process ${name}` }).closest('tr')
      ?.classList.contains('oscd-basic-table__row--added');

  await fireEvent.change(getByLabelText('Import processes JSON files'), {
    target: { files: [
      file('first.json', [engineeringProcesses.processes[0], incoming[0]]),
      file('second.json', incoming.slice(1)),
    ] },
  });
  await vi.advanceTimersByTimeAsync(400);
  expect(highlighted('Imported A')).toBe(true);
  expect(highlighted('Alpha')).toBe(false);
  await vi.advanceTimersByTimeAsync(400);
  expect(highlighted('Imported A')).toBe(true);
  expect(highlighted('Imported B')).toBe(true);
  await vi.advanceTimersByTimeAsync(400);
  expect(incoming.map(({ name }) => highlighted(name))).toEqual([true, true, true]);
  expect(toastService.success).toHaveBeenCalledWith(
    'Process import complete',
    '3 imported; 1 already present; 0 conflicting; 0 failed.',
  );

  await vi.advanceTimersByTimeAsync(799);
  expect(incoming.map(({ name }) => highlighted(name))).toEqual([true, true, true]);
  await vi.advanceTimersByTimeAsync(1);
  expect(incoming.map(({ name }) => highlighted(name))).toEqual([false, true, true]);
  await vi.advanceTimersByTimeAsync(400);
  expect(incoming.map(({ name }) => highlighted(name))).toEqual([false, false, true]);
  await vi.advanceTimersByTimeAsync(400);
  expect(incoming.map(({ name }) => highlighted(name))).toEqual([false, false, false]);
});

it('does not highlight processes loaded from the backend as newly imported', async () => {
  const loaded = engineeringProcesses.processes;
  engineeringProcesses.processes = [];
  engineeringProcessesStatus.loading = true;
  const { container } = renderList();

  engineeringProcesses.processes = loaded;
  engineeringProcessesStatus.loading = false;
  await tick();

  expect(container.querySelector('.oscd-basic-table__row--added')).toBeNull();
});
