// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toastService } from '@oscd-transnet-plugins/oscd-services/toast';
import { processService } from '../../bootstrap';
import {
  engineeringProcesses,
  engineeringProcessesStatus,
  engineeringProcessEditing,
  selectedEngineeringProcess,
} from './stores.svelte';
import {
  getPersistedProcesses,
  deleteProcess,
  isProcessLocal,
  loadEngineeringProcesses,
  refreshEngineeringProcesses,
  saveProcess,
  syncProcess,
} from './repository.svelte';
import type { Process } from '@oscd-transnet-plugins/shared';
import { createValidationExport } from '../plugins/validation/validationJson';
import { prepareValidationImport } from '../plugins/validation/validationRules';
import { createProcessExport } from './processJson';
import { classifyProcessImport } from './processImport';
import { readLocalProcesses, writeLocalProcesses } from './local-processes';
import { ProcessService, ProcessVersionConflictError } from './process.service';
import { BackendTransportError, fetchWithTimeout } from '../../utils/fetch-with-timeout';
import { createCustomResourceClient, createCustomResourceService } from '@oscd-transnet-plugins/api-compas-custom-resource';

const source = vi.hoisted(() => ({ xml: '<processes />' }));
vi.mock('./config', () => ({
  get DEFAULT_PROCESSES_XML() { return source.xml; },
  DEFAULT_PLUGIN_SRC_TYPE: 'external',
}));
vi.mock('../../bootstrap', () => ({
  processService: {
    listLatest: vi.fn(),
    getById: vi.fn(),
    readPersisted: vi.fn(),
    save: vi.fn(),
    delete: vi.fn(),
  },
}));

const process: Process = {
  id: 'existing',
  name: 'Existing process',
  description: '',
  version: '1.0.0',
  pluginGroups: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  source.xml = '<processes />';
  localStorage.clear();
  engineeringProcesses.processes = [];
  engineeringProcessesStatus.localProcessIds = [];
  engineeringProcessesStatus.backend = 'unknown';
  engineeringProcessesStatus.backendError = '';
  engineeringProcessesStatus.localReadError = '';
  engineeringProcessEditing.isEditing = false;
  selectedEngineeringProcess.process = null;
  vi.mocked(processService.listLatest).mockResolvedValue([
    {
      resourceId: 'resource-1',
      processId: 'existing',
      version: '2.0.0',
      description: '',
    },
    {
      resourceId: 'resource-2',
      processId: 'unrelated',
      version: '1.0.0',
      description: '',
    },
  ]);
  vi.mocked(processService.getById).mockResolvedValue(process);
  vi.mocked(processService.readPersisted).mockImplementation((entries) =>
    ProcessService.prototype.readPersisted.call(processService, entries),
  );
});

afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('repository concurrency and response regressions', () => {
  afterEach(async () => {
    for (const id of ['parallel-sync', 'parallel-save', 'refresh-save', 'refresh-sync']) {
      await deleteProcess({ ...process, id });
    }
  });
  it.each(['success', 'failure'] as const)('ignores an older refresh finishing with %s', async (outcome) => {
    const older = deferred<Awaited<ReturnType<typeof processService.listLatest>>>();
    vi.mocked(processService.listLatest).mockReturnValueOnce(older.promise);
    const pending = refreshEngineeringProcesses();
    vi.mocked(processService.listLatest).mockResolvedValueOnce([
      { resourceId: 'new', processId: process.id, version: '3.0.0', description: '' },
    ]);
    vi.mocked(processService.getById).mockResolvedValueOnce({ ...process, name: 'Newest' });
    await refreshEngineeringProcesses();
    if (outcome === 'failure') older.reject(new BackendTransportError(new Error('Old failure')));
    else {
      vi.mocked(processService.getById).mockResolvedValueOnce({ ...process, name: 'Older' });
      older.resolve([{ resourceId: 'old', processId: process.id, version: '1.0.0', description: '' }]);
    }
    expect((await pending).warnings).toEqual([]);
    expect(engineeringProcesses.processes).toMatchObject([{ name: 'Newest', version: '3.0.0' }]);
    expect(engineeringProcessesStatus.backend).toBe('available');
    expect(engineeringProcessesStatus.backendError).toBe('');
    expect(engineeringProcessesStatus.loading).toBe(false);
  });

  it.each(['already-present', 'no-match'] as const)(
    'publishes a pending full refresh after a successful subset lookup with %s and no save',
    async (outcome) => {
      const entries = [
        { resourceId: 'resource-1', processId: process.id, version: '2.0.0', description: '' },
        { resourceId: 'resource-2', processId: 'unrelated', version: '1.0.0', description: '' },
      ];
      const full = deferred<Awaited<ReturnType<typeof processService.listLatest>>>();
      vi.mocked(processService.listLatest).mockReturnValueOnce(full.promise).mockResolvedValueOnce(entries);
      vi.mocked(processService.getById).mockImplementation(async (id) =>
        id === 'resource-1' ? process : { ...process, id: 'unrelated', name: 'Unrelated' },
      );
      const loading = refreshEngineeringProcesses();
      const lookup = await getPersistedProcesses(new Set([
        outcome === 'already-present' ? process.id : 'not-imported',
      ]));
      if (lookup.status !== 'available') throw new Error('Expected successful subset lookup');
      if (outcome === 'already-present') {
        expect(classifyProcessImport({ ...process, version: '2.0.0' }, [...lookup.processes.values()]))
          .toEqual({ status: 'already-present' });
      } else expect(lookup.processes.size).toBe(0);
      full.resolve(entries);
      const result = await loading;
      expect(result.processes).toMatchObject([
        { id: process.id, version: '2.0.0' },
        { id: 'unrelated', name: 'Unrelated', version: '1.0.0' },
      ]);
      expect(engineeringProcesses.processes).toEqual(result.processes);
      expect(result.warnings).toEqual([]);
      expect(processService.save).not.toHaveBeenCalled();
    },
  );

  it('does not let an older lookup failure override newer full-refresh backend status', async () => {
    const older = deferred<Awaited<ReturnType<typeof processService.listLatest>>>();
    vi.mocked(processService.listLatest).mockReturnValueOnce(older.promise);
    const pending = getPersistedProcesses(new Set([process.id]));
    vi.mocked(processService.listLatest).mockResolvedValueOnce([
      { resourceId: 'new', processId: process.id, version: '3.0.0', description: '' },
    ]);
    await refreshEngineeringProcesses();
    older.reject(new BackendTransportError(new Error('Older subset lookup failed')));
    expect((await pending).status).toBe('unavailable');
    expect(engineeringProcesses.processes).toMatchObject([{ id: process.id, version: '3.0.0' }]);
    expect(engineeringProcessesStatus.backend).toBe('available');
    expect(engineeringProcessesStatus.backendError).toBe('');
  });

  it('does not let an older lookup failure downgrade newer backend availability', async () => {
    const older = deferred<Awaited<ReturnType<typeof processService.listLatest>>>();
    vi.mocked(processService.listLatest).mockReturnValueOnce(older.promise);
    const pending = getPersistedProcesses(new Set([process.id]));
    vi.mocked(processService.listLatest).mockResolvedValueOnce([]);
    await expect(getPersistedProcesses(new Set([process.id]))).resolves.toEqual({
      status: 'available', processes: new Map(),
    });
    older.reject(new BackendTransportError(new Error('Older lookup failed')));
    expect((await pending).status).toBe('unavailable');
    expect(engineeringProcessesStatus.backend).toBe('available');
    expect(engineeringProcessesStatus.backendError).toBe('');
  });

  it('does not resurrect a deleted process from an in-flight refresh', async () => {
    engineeringProcesses.processes = [process];
    const entries = deferred<Awaited<ReturnType<typeof processService.listLatest>>>();
    vi.mocked(processService.listLatest).mockReturnValueOnce(entries.promise);
    const pending = refreshEngineeringProcesses();
    await deleteProcess(process);
    entries.resolve([{ resourceId: 'old', processId: process.id, version: process.version, description: '' }]);
    await pending;
    expect(engineeringProcesses.processes.some(({ id }) => id === process.id)).toBe(false);
  });

  it.each(['save', 'sync'] as const)('invalidates refresh errors after successful %s', async (operation) => {
    const saved = { ...process, id: `refresh-${operation}`, version: '2.0.0' };
    const older = deferred<Awaited<ReturnType<typeof processService.listLatest>>>();
    vi.mocked(processService.listLatest).mockReturnValueOnce(older.promise);
    const loading = refreshEngineeringProcesses();
    vi.mocked(processService.save).mockResolvedValueOnce({ resourceId: 'saved', version: saved.version });
    if (operation === 'save') await saveProcess(saved);
    else {
      writeLocalProcesses([saved]);
      vi.mocked(processService.listLatest).mockResolvedValueOnce([]);
      await syncProcess(saved);
    }
    older.reject(new BackendTransportError(new Error('Stale refresh failure')));
    expect((await loading).warnings).toEqual([]);
    expect(engineeringProcesses.processes.find(({ id }) => id === saved.id)).toEqual(saved);
    expect(engineeringProcessesStatus.backend).toBe('available');
    expect(engineeringProcessesStatus.backendError).toBe('');
    expect(engineeringProcessesStatus.error).toBe('');
  });

  it('does not turn a malformed HTTP 200 null response into offline lookup or a local save', async () => {
    const api = new ProcessService(createCustomResourceService(
      createCustomResourceClient('https://backend.invalid', fetchWithTimeout),
    ));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('null', {
      headers: { 'Content-Type': 'application/json' },
    })));
    vi.mocked(processService.listLatest).mockImplementationOnce(() => api.listLatest());
    await expect(getPersistedProcesses(new Set([process.id]))).rejects.toBeInstanceOf(TypeError);
    expect(engineeringProcessesStatus.backend).toBe('unknown');
    vi.mocked(processService.save).mockRejectedValueOnce(new TypeError('Malformed upload response'));
    await expect(saveProcess(process)).rejects.toThrow('Malformed upload response');
    expect(readLocalProcesses()).toEqual([]);
    expect(engineeringProcessesStatus.backend).toBe('unknown');
  });

  it.each([
    ['discovery', '404'], ['upload', '404'], ['discovery', 'html'], ['upload', 'html'],
  ] as const)(
    'persists offline through the real API client when the %s endpoint returns %s',
    async (endpoint, response) => {
      const api = new ProcessService(createCustomResourceService(
        createCustomResourceClient('http://localhost:8081/compas-scl-data-service', fetchWithTimeout),
      ));
      vi.stubGlobal('fetch', vi.fn(async () => response === 'html'
        ? new Response('<html>OpenSCD</html>', { headers: { 'Content-Type': 'text/html' } })
        : new Response('Not Found', { status: 404 })));
      const local = { ...process, id: `missing-endpoint-${endpoint}-${response}` };
      if (endpoint === 'discovery') {
        source.xml = '<processes><process><id>baseline</id><name>Baseline</name><version>1.0.0</version></process></processes>';
        vi.mocked(processService.listLatest).mockImplementationOnce(() => api.listLatest());
        const loaded = await loadEngineeringProcesses();
        expect(loaded.processes.some(({ id }) => id === 'baseline')).toBe(true);
        expect(loaded.warnings).toHaveLength(1);
      } else {
        engineeringProcessesStatus.backend = 'available';
        vi.mocked(processService.save).mockImplementationOnce((snapshot, bump) => api.save(snapshot, bump));
      }
      await expect(saveProcess(local, 'patch')).resolves.toEqual({
        version: '1.0.1', target: 'local',
      });
      expect(engineeringProcessesStatus.backend).toBe('unavailable');
      expect(readLocalProcesses()).toEqual([{ ...local, version: '1.0.1' }]);
      expect(isProcessLocal(local.id)).toBe(true);
      vi.mocked(processService.listLatest).mockImplementationOnce(() => api.listLatest());
      await refreshEngineeringProcesses();
      expect(engineeringProcesses.processes.find(({ id }) => id === local.id)).toMatchObject({
        version: '1.0.1',
      });
      vi.mocked(processService.listLatest).mockImplementationOnce(() => api.listLatest());
      await expect(syncProcess(local)).rejects.toThrow('process API endpoint');
      expect(readLocalProcesses()).toEqual([{ ...local, version: '1.0.1' }]);
      await deleteProcess(local);
    },
  );

  it('shares parallel sync across callers, blocks deletion and accurately counts parallel saves', async () => {
    const local = { ...process, id: 'parallel-sync' };
    writeLocalProcesses([local]);
    const upload = deferred<{ resourceId: string; version: string }>();
    const otherUpload = deferred<{ resourceId: string; version: string }>();
    vi.mocked(processService.listLatest).mockResolvedValueOnce([]);
    vi.mocked(processService.save).mockReturnValueOnce(upload.promise).mockReturnValueOnce(otherUpload.promise);
    const first = syncProcess(local);
    const second = syncProcess(local);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(processService.save).toHaveBeenCalledOnce());
    await expect(deleteProcess(local)).rejects.toThrow('syncing');
    const parallel = saveProcess({ ...process, id: 'parallel-save' });
    await vi.waitFor(() => expect(processService.save).toHaveBeenCalledTimes(2));
    upload.resolve({ resourceId: 'synced', version: local.version });
    await Promise.all([first, second]);
    expect(readLocalProcesses()).toEqual([]);
    expect(engineeringProcessesStatus.saving).toBe(true);
    otherUpload.resolve({ resourceId: 'saved', version: process.version });
    await parallel;
    expect(engineeringProcessesStatus.saving).toBe(false);
    expect(processService.delete).not.toHaveBeenCalled();
  });

  it('leaves the published snapshot and local IDs unchanged when a local write fails', async () => {
    const local = { ...process, id: 'failed-local-edit' };
    writeLocalProcesses([local]);
    engineeringProcesses.processes = [local];
    engineeringProcessesStatus.localProcessIds = [local.id];
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Storage full', 'QuotaExceededError');
    });
    await expect(saveProcess({ ...local, name: 'Unsaved' }, 'minor')).rejects.toThrow('Storage full');
    write.mockRestore();
    expect(engineeringProcesses.processes).toEqual([local]);
    expect(readLocalProcesses()).toEqual([local]);
    expect(isProcessLocal(local.id)).toBe(true);
  });
});

describe('process loading failures', () => {
  beforeEach(() => {
    engineeringProcesses.processes = [];
    source.xml = '<processes><process><id>baseline</id><name>Baseline</name><version>1.0.0</version></process></processes>';
  });

  it('restores durable local saves after a fresh repository and store module reload', async () => {
    engineeringProcessesStatus.backend = 'unavailable';
    const local = { ...process, id: 'fresh-reload', name: 'Durable edit' };
    await saveProcess(local, 'patch');
    vi.resetModules();
    const reloaded = await import('./repository.svelte');
    const stores = await import('./stores.svelte');
    vi.mocked(processService.listLatest).mockResolvedValueOnce([]);
    const result = await reloaded.loadEngineeringProcesses();
    expect(result.processes.find(({ id }) => id === local.id)).toMatchObject({
      name: 'Durable edit', version: '1.0.1',
    });
    expect(stores.engineeringProcessesStatus.localProcessIds).toContain(local.id);
    expect(reloaded.isProcessLocal(local.id)).toBe(true);
    await deleteProcess(local);
  });

  it('publishes valid remote processes when local storage is corrupt and leaves storage untouched', async () => {
    localStorage.setItem('engineering-wizard.local-processes', '{broken');
    vi.mocked(processService.listLatest).mockResolvedValueOnce([
      { resourceId: 'resource-1', processId: process.id, version: '2.0.0', description: '' },
    ]);
    const loaded = await loadEngineeringProcesses();
    expect(loaded.processes.find(({ id }) => id === process.id)).toMatchObject({ version: '2.0.0' });
    expect(engineeringProcessesStatus.backend).toBe('available');
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0].title).toBe('Local processes could not be loaded');
    expect(localStorage.getItem('engineering-wizard.local-processes')).toBe('{broken');
  });

  it.each(['before', 'during'] as const)(
    'preserves known local snapshots and publishes other remote processes if storage fails %s loading',
    async (when) => {
      const local = { ...process, id: 'preserved-local', name: 'Pending local edit', version: '3.0.0' };
      writeLocalProcesses([local]);
      engineeringProcesses.processes = [local];
      engineeringProcessesStatus.localProcessIds = [local.id];
      if (when === 'before') localStorage.setItem('engineering-wizard.local-processes', '{broken');
      vi.mocked(processService.readPersisted).mockImplementationOnce(async () => {
        if (when === 'during') localStorage.setItem('engineering-wizard.local-processes', '{broken');
        return [process, { ...local, name: 'Older backend copy', version: '1.0.0' }];
      });
      const loaded = await loadEngineeringProcesses();
      expect(loaded.processes.find(({ id }) => id === process.id)).toEqual(process);
      expect(loaded.processes.find(({ id }) => id === local.id)).toEqual(local);
      expect(isProcessLocal(local.id)).toBe(true);
      expect(loaded.warnings).toHaveLength(1);
      expect(localStorage.getItem('engineering-wizard.local-processes')).toBe('{broken');
    },
  );

  it.each(['listLatest', 'getById'] as const)(
    'warns when %s fails and still loads the XML baseline',
    async (method) => {
      vi.mocked(processService[method]).mockRejectedValueOnce(
        new BackendTransportError(new TypeError('Backend unavailable')),
      );

      const { processes: loaded, warnings } = await loadEngineeringProcesses();

      expect(loaded).toMatchObject([{ id: 'baseline' }]);
      expect(engineeringProcesses.processes).toEqual(loaded);
      expect(engineeringProcessesStatus.loading).toBe(false);
      expect(engineeringProcessesStatus.error).toBe('');
      expect(warnings).toEqual([{
        title: 'Backend processes could not be loaded',
        message: 'You can continue locally. Saved backend processes may be missing or outdated. Could not reach the backend: Backend unavailable',
      }]);
    },
  );

  it('does not warn when the backend has no saved processes', async () => {
    vi.mocked(processService.listLatest).mockResolvedValueOnce([]);

    await expect(loadEngineeringProcesses()).resolves.toMatchObject({
      processes: [{ id: 'baseline' }], warnings: [],
    });
  });

  it.each(['listLatest', 'getById'] as const)(
    'keeps existing processes usable and warns when %s fails during refresh',
    async (method) => {
      engineeringProcesses.processes = [{ ...process, name: 'Previously loaded' }];
      const previous = engineeringProcesses.processes;
      vi.mocked(processService[method]).mockRejectedValueOnce(
        new BackendTransportError(new Error('Refresh failed')),
      );

      const result = await refreshEngineeringProcesses();
      expect(result.processes).toMatchObject([
        { id: 'baseline' }, { id: 'existing', name: 'Previously loaded' },
      ]);

      expect(engineeringProcesses.processes[1]).toEqual(previous[0]);
      expect(engineeringProcessesStatus.error).toBe('');
      expect(engineeringProcessesStatus.backendError).toContain('Refresh failed');
      expect(engineeringProcessesStatus.backend).toBe('unavailable');
      expect(engineeringProcessesStatus.loading).toBe(false);
      expect(result.warnings).toHaveLength(1);
    },
  );

  it('reports operation failures without marking the backend unavailable', async () => {
    vi.mocked(processService.readPersisted).mockRejectedValueOnce(new Error('Stored process ID mismatch'));

    const result = await refreshEngineeringProcesses();

    expect(result.warnings).toHaveLength(1);
    expect(engineeringProcessesStatus.backend).toBe('unknown');
    expect(engineeringProcessesStatus.backendError).toBe('');
  });

  it('shows the embedded baseline and enables actions before the backend responds', async () => {
    let finish!: (entries: []) => void;
    vi.mocked(processService.listLatest).mockReturnValueOnce(
      new Promise((resolve) => { finish = resolve; }),
    );
    const loading = loadEngineeringProcesses();
    expect(engineeringProcesses.processes).toMatchObject([{ id: 'baseline' }]);
    expect(engineeringProcessesStatus.loading).toBe(false);
    finish([]);
    await loading;
  });

  it('keeps edits made to the baseline while backend loading is still pending', async () => {
    let finish!: (entries: Awaited<ReturnType<typeof processService.listLatest>>) => void;
    vi.mocked(processService.listLatest).mockReturnValueOnce(
      new Promise((resolve) => { finish = resolve; }),
    );
    const loading = loadEngineeringProcesses();
    const editing = engineeringProcesses.processes[0];
    selectedEngineeringProcess.process = editing;
    selectedEngineeringProcess.beginEditing(editing, 'existing');
    engineeringProcessEditing.isEditing = true;
    if (!selectedEngineeringProcess.process) throw new Error('Missing editor draft');
    selectedEngineeringProcess.process.name = 'Unsaved local edit';
    const draft = selectedEngineeringProcess.process;
    vi.mocked(processService.getById).mockResolvedValueOnce({
      ...editing, name: 'Remote name', version: '2.0.0',
    });
    finish([{ resourceId: 'baseline-resource', processId: editing.id, version: '2.0.0', description: '' }]);
    await loading;
    expect(selectedEngineeringProcess.process).toBe(draft);
    expect(selectedEngineeringProcess.process?.name).toBe('Unsaved local edit');
    expect(engineeringProcesses.processes[0].name).toBe('Remote name');
  });
});

describe('process import backend lookup', () => {
  it('loads only matching IDs and uses the authoritative metadata version', async () => {
    const result = await getPersistedProcesses(new Set(['existing', 'new']));

    expect(processService.getById).toHaveBeenCalledOnce();
    expect(processService.getById).toHaveBeenCalledWith('resource-1');
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('Expected available backend');
    expect(result.processes.get('existing')).toEqual({ ...process, version: '2.0.0' });
    expect(result.processes.has('new')).toBe(false);
    expect(process.version).toBe('1.0.0');
  });

  it('does not contact the backend when no valid processes were parsed', async () => {
    expect(await getPersistedProcesses(new Set())).toEqual({ status: 'available', processes: new Map() });
    expect(processService.listLatest).not.toHaveBeenCalled();
  });

  it('fails explicitly when existing content cannot be verified', async () => {
    vi.mocked(processService.getById).mockRejectedValueOnce(
      new Error('Read failed'),
    );
    await expect(getPersistedProcesses(new Set(['existing']))).rejects.toThrow(
      'Read failed',
    );
    vi.mocked(processService.getById).mockResolvedValueOnce({
      ...process,
      id: 'wrong-id',
    });
    await expect(getPersistedProcesses(new Set(['existing']))).rejects.toThrow(
      'Stored process ID does not match',
    );
  });

  it('keeps legacy rule identities stable across refreshes and skips unchanged reimports without saving on load', async () => {
    const rule = {
      title: 'Legacy',
      description: '',
      context: '//SCL',
      assert: '@name',
    };
    const legacy: Process = {
      ...process,
      pluginGroups: [
        {
          title: 'Checks',
          plugins: [
            {
              id: 'editor',
              name: 'Editor',
              type: 'internal',
              validations: [
                rule,
                { ...rule },
                { ...rule, id: 'persisted-rule' },
              ],
            },
            {
              id: 'other-editor',
              name: 'Other editor',
              type: 'internal',
              validations: [{ ...rule }],
            },
          ],
        },
      ],
    };
    vi.mocked(processService.listLatest).mockResolvedValue([
      {
        resourceId: 'resource-1',
        processId: legacy.id,
        version: '2.0.0',
        description: '',
      },
    ]);
    vi.mocked(processService.getById).mockImplementation(async () =>
      structuredClone(legacy),
    );
    const { processes: [loaded] } = await loadEngineeringProcesses();
    const exportedProcess = createProcessExport([loaded]).processes[0];
    const exportedRules = createValidationExport(
      loaded.pluginGroups[0].plugins[0].validations ?? [],
    );
    const ids = loaded.pluginGroups[0].plugins.flatMap(
      (plugin) => plugin.validations?.map(({ id }) => id) ?? [],
    );
    expect(new Set(ids).size).toBe(4);
    expect(ids[2]).toBe('persisted-rule');

    const { processes: [refreshed] } = await refreshEngineeringProcesses();
    expect(
      refreshed.pluginGroups[0].plugins.flatMap(
        (plugin) => plugin.validations?.map(({ id }) => id) ?? [],
      ),
    ).toEqual(ids);
    expect(
      prepareValidationImport(
        refreshed.pluginGroups[0].plugins[0].validations ?? [],
        exportedRules.validations,
      ),
    ).toEqual({ added: [], skipped: 3, renamed: [] });
    const persisted = await getPersistedProcesses(new Set([legacy.id]));
    if (persisted.status !== 'available') throw new Error('Expected available backend');
    expect(
      classifyProcessImport(exportedProcess, [
        refreshed,
        ...persisted.processes.values(),
      ]),
    ).toEqual({ status: 'already-present' });
    expect(processService.save).not.toHaveBeenCalled();
    expect(rule).not.toHaveProperty('id');
  });

  describe('local processes and explicit sync', () => {
    it('persists creation and edits offline and keeps them across reloads and backend refreshes', async () => {
      const draft: Process = {
        ...process,
        id: 'offline-edit',
        pluginGroups: [{
          title: 'Host plugins',
          plugins: [{
            id: 'local-editor', name: 'Local editor', type: 'internal',
            src: 'http://localhost:4200/editor.js',
          }],
        }],
      };
      vi.mocked(processService.save).mockRejectedValueOnce(new BackendTransportError(new TypeError('Failed to fetch')));
      expect(await saveProcess(draft)).toEqual({ version: '1.0.0', target: 'local' });
      expect(isProcessLocal(draft.id)).toBe(true);
      expect(readLocalProcesses()).toMatchObject([{ id: draft.id, version: '1.0.0' }]);

      draft.name = 'Edited offline';
      expect(await saveProcess(draft, 'minor')).toEqual({ version: '1.1.0', target: 'local' });
      expect(processService.save).toHaveBeenCalledOnce();
      engineeringProcesses.processes = [];
      engineeringProcessesStatus.localProcessIds = [];
      vi.mocked(processService.listLatest).mockRejectedValueOnce(new BackendTransportError(new TypeError('Offline')));
      const { processes: loaded } = await loadEngineeringProcesses();
      expect(loaded.find(({ id }) => id === draft.id)).toMatchObject({
        name: 'Edited offline', version: '1.1.0',
        pluginGroups: draft.pluginGroups,
      });
      expect(isProcessLocal(draft.id)).toBe(true);

      vi.mocked(processService.listLatest).mockResolvedValueOnce([]);
      await refreshEngineeringProcesses();
      expect(engineeringProcesses.processes.find(({ id }) => id === draft.id)?.version).toBe('1.1.0');
      expect(readLocalProcesses()).toHaveLength(1);
      expect(processService.save).toHaveBeenCalledOnce();
    });

    it('keeps a process saved locally while a backend refresh is pending', async () => {
      engineeringProcessesStatus.backend = 'unavailable';
      let finish!: (entries: []) => void;
      vi.mocked(processService.listLatest).mockReturnValueOnce(
        new Promise((resolve) => { finish = resolve; }),
      );
      const loading = loadEngineeringProcesses();
      const draft = { ...process, id: 'saved-during-refresh' };
      await saveProcess(draft);
      finish([]);
      await loading;
      expect(engineeringProcesses.processes.find(({ id }) => id === draft.id)).toMatchObject(draft);
      expect(isProcessLocal(draft.id)).toBe(true);
    });

    it('uploads the stored version and clears local-only status only after successful sync', async () => {
      const draft = { ...process, id: 'sync-success', version: '1.2.0' };
      writeLocalProcesses([draft]);
      engineeringProcesses.processes = [draft];
      engineeringProcessesStatus.localProcessIds = [draft.id];
      vi.mocked(processService.listLatest).mockResolvedValueOnce([]);
      vi.mocked(processService.save).mockResolvedValueOnce({ resourceId: 'saved', version: '1.2.0' });

      await syncProcess(draft);

      expect(processService.save).toHaveBeenCalledWith(draft);
      expect(isProcessLocal(draft.id)).toBe(false);
      expect(readLocalProcesses()).toEqual([]);
      vi.mocked(processService.listLatest).mockResolvedValueOnce([]);
      await refreshEngineeringProcesses();
      expect(engineeringProcesses.processes.find(({ id }) => id === draft.id)?.version).toBe('1.2.0');
    });

    it('recognizes an already uploaded snapshot after a lost response without uploading again', async () => {
      const draft = { ...process, id: 'sync-existing', version: '2.0.0' };
      writeLocalProcesses([draft]);
      engineeringProcessesStatus.localProcessIds = [draft.id];
      vi.mocked(processService.listLatest).mockResolvedValueOnce([
        { resourceId: 'remote', processId: draft.id, version: draft.version, description: '' },
      ]);
      vi.mocked(processService.getById).mockResolvedValueOnce(draft);

      await syncProcess(draft);

      expect(processService.save).not.toHaveBeenCalled();
      expect(readLocalProcesses()).toEqual([]);
      expect(isProcessLocal(draft.id)).toBe(false);
    });

    it.each(['unavailable', 'conflict'])('keeps local changes when sync fails: %s', async (failure) => {
      const draft = { ...process, id: `sync-${failure}`, version: '2.0.0' };
      writeLocalProcesses([draft]);
      engineeringProcessesStatus.localProcessIds = [draft.id];
      if (failure === 'unavailable') {
        vi.mocked(processService.listLatest).mockRejectedValueOnce(new BackendTransportError(new TypeError('Offline')));
      } else {
        vi.mocked(processService.listLatest).mockResolvedValueOnce([
          { resourceId: 'remote', processId: draft.id, version: '2.0.0', description: '' },
        ]);
        vi.mocked(processService.getById).mockResolvedValueOnce({ ...draft, name: 'Different remote content' });
      }

      await expect(syncProcess(draft)).rejects.toThrow();

      expect(readLocalProcesses()).toEqual([draft]);
      expect(isProcessLocal(draft.id)).toBe(true);
      expect(engineeringProcessesStatus.saveError).not.toBe('');
      expect(processService.save).not.toHaveBeenCalled();
    });

    it('uploads a newer local edit as an explicit version without changing older backend versions', async () => {
      const draft = { ...process, id: 'sync-newer', version: '3.0.0' };
      writeLocalProcesses([draft]);
      engineeringProcessesStatus.localProcessIds = [draft.id];
      vi.mocked(processService.listLatest).mockResolvedValueOnce([
        { resourceId: 'remote', processId: draft.id, version: '2.0.0', description: '' },
      ]);
      vi.mocked(processService.getById).mockResolvedValueOnce({ ...draft, version: '2.0.0' });
      vi.mocked(processService.save).mockResolvedValueOnce({ resourceId: 'newer', version: '3.0.0' });
      await syncProcess(draft);
      expect(processService.save).toHaveBeenCalledWith(draft);
      expect(readLocalProcesses()).toEqual([]);
    });

    it('does not discard a newer edit made while syncing the previous local snapshot', async () => {
      const draft = { ...process, id: 'sync-concurrent-edit' };
      writeLocalProcesses([draft]);
      engineeringProcessesStatus.localProcessIds = [draft.id];
      vi.mocked(processService.listLatest).mockResolvedValueOnce([]);
      let finish!: (result: { resourceId: string; version: string }) => void;
      vi.mocked(processService.save).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
      const syncing = syncProcess(draft);
      await vi.waitFor(() => expect(processService.save).toHaveBeenCalledOnce());
      await saveProcess({ ...draft, name: 'New local edit' }, 'patch');
      finish({ resourceId: 'saved', version: '1.0.0' });
      await syncing;
      expect(readLocalProcesses()).toMatchObject([{ name: 'New local edit', version: '1.0.1' }]);
      expect(isProcessLocal(draft.id)).toBe(true);
    });

    it('deletes a local-only process without contacting the backend or bringing it back on refresh', async () => {
      const draft = { ...process, id: 'local-delete' };
      engineeringProcessesStatus.backend = 'unavailable';
      await saveProcess(draft);
      engineeringProcesses.processes = [draft];
      await deleteProcess(draft);
      expect(processService.delete).not.toHaveBeenCalled();
      expect(readLocalProcesses()).toEqual([]);
      vi.mocked(processService.listLatest).mockResolvedValueOnce([]);
      await refreshEngineeringProcesses();
      expect(engineeringProcesses.processes.some(({ id }) => id === draft.id)).toBe(false);
    });

    it('does not turn a version conflict or a storage failure into a successful local save', async () => {
      vi.mocked(processService.save).mockRejectedValueOnce(new ProcessVersionConflictError(process.id, process.version));
      await expect(saveProcess(process)).rejects.toThrow(ProcessVersionConflictError);
      expect(readLocalProcesses()).toEqual([]);
      engineeringProcessesStatus.backend = 'unavailable';
      const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
        throw new DOMException('Storage full', 'QuotaExceededError');
      });
      await expect(saveProcess(process)).rejects.toThrow('Storage full');
      expect(isProcessLocal(process.id)).toBe(false);
      write.mockRestore();
    });
  });

  describe('corrupt local storage', () => {
    const KEY = 'engineering-wizard.local-processes';

    it('still saves and deletes backend processes and leaves the stored data untouched', async () => {
      localStorage.setItem(KEY, '{broken');
      vi.mocked(processService.save).mockResolvedValueOnce({ version: '1.0.1' } as never);

      await expect(saveProcess(process)).resolves.toEqual({ version: '1.0.1', target: 'backend' });
      await deleteProcess(process);

      expect(processService.delete).toHaveBeenCalledWith(process.id);
      expect(localStorage.getItem(KEY)).toBe('{broken');
    });

    it('warns once about unreadable data while backend operations still succeed', async () => {
      const warn = vi.spyOn(toastService, 'warn').mockImplementation(() => undefined as never);
      localStorage.setItem(KEY, '{broken');
      vi.mocked(processService.save).mockResolvedValue({ version: '1.0.1' } as never);

      await saveProcess(process);
      await saveProcess(process);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe('Local processes could not be read');
      warn.mockRestore();
    });

    it('refuses to overwrite unreadable data when a local save is required', async () => {
      localStorage.setItem(KEY, '{broken');
      engineeringProcessesStatus.backend = 'unavailable';

      await expect(saveProcess(process)).rejects.toThrow('Could not read local processes');
      expect(localStorage.getItem(KEY)).toBe('{broken');
    });

    it('does not push a known local-only process to the backend', async () => {
      engineeringProcessesStatus.localProcessIds = [process.id];
      localStorage.setItem(KEY, '{broken');

      await expect(saveProcess(process)).rejects.toThrow('Could not read local processes');
      expect(processService.save).not.toHaveBeenCalled();
    });
  });

  it('checks the backend again for persisted processes after it was marked unavailable', async () => {
    engineeringProcessesStatus.backend = 'unavailable';

    const result = await getPersistedProcesses(new Set(['existing']));

    expect(result.status).toBe('available');
    expect(engineeringProcessesStatus.backend).toBe('available');
  });

  it('does not record a sync version conflict as backend unavailability', async () => {
    const local = { ...process, id: 'conflicting', version: '1.0.0' };
    engineeringProcessesStatus.backend = 'unavailable';
    await saveProcess(local);
    engineeringProcessesStatus.backend = 'available';
    vi.mocked(processService.listLatest).mockResolvedValueOnce([
      { resourceId: 'r', processId: 'conflicting', version: '2.0.0', description: '' },
    ]);
    vi.mocked(processService.readPersisted).mockResolvedValueOnce([{ ...local, name: 'Other', version: '2.0.0' }]);

    await expect(syncProcess(local)).rejects.toThrow('conflicts');
    expect(engineeringProcessesStatus.backend).toBe('available');
    expect(engineeringProcessesStatus.backendError).toBe('');
  });

  it('assigns persistent IDs to legacy rules before saving the process snapshot', async () => {
    const legacy: Process = {
      ...process,
      pluginGroups: [
        {
          title: 'Checks',
          plugins: [
            {
              id: 'editor',
              name: 'Editor',
              type: 'internal',
              validations: [
                {
                  title: 'Legacy rule',
                  description: '',
                  context: '//SCL',
                  assert: '@name',
                },
              ],
            },
          ],
        },
      ],
    };
    vi.mocked(processService.save).mockResolvedValueOnce({
      resourceId: 'resource-1',
      version: '1.0.0',
    });

    await saveProcess(legacy);

    const id = engineeringProcesses.processes.find(({ id }) => id === legacy.id)
      ?.pluginGroups[0].plugins[0].validations?.[0].id;
    expect(id).toEqual(expect.any(String));
    expect(legacy.pluginGroups[0].plugins[0].validations?.[0].id).toBeUndefined();
    expect(processService.save).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginGroups: [
          expect.objectContaining({
            plugins: [
              expect.objectContaining({
                validations: [expect.objectContaining({ id })],
              }),
            ],
          }),
        ],
      }),
      undefined,
    );
  });
});
