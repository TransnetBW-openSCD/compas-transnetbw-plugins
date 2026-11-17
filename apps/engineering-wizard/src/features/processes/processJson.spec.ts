import { describe, expect, it, vi } from 'vitest';
import type { Process } from '@oscd-transnet-plugins/shared';
import {
  createProcessExport,
  importProcessFiles,
  MAX_PROCESS_IMPORT_BYTES,
  parseProcessImportJson,
  parseStoredProcessesJson,
} from './processJson';

const process: Process = {
  id: 'engineering',
  name: 'Engineering',
  description: 'A process',
  version: '2.1.0',
  pluginGroups: [{
    title: 'Configuration',
    plugins: [{
      id: 'editor',
      name: 'Editor',
      catalogId: 'catalog-editor',
      type: 'external',
      src: '/editor.js',
      sourceUrl: 'https://example.com/editor.js',
      icon: 'edit',
      validations: [{
        id: 'rule-1',
        title: 'Required equipment',
        description: '',
        context: '//Substation',
        assert: 'count(Bay) > 0',
        message: 'Add a bay',
      }],
    }],
  }],
};

describe('process JSON transfer', () => {
  it('round-trips processes with ordered groups, plugins and validation rules', () => {
    const exported = createProcessExport([process]);
    expect(parseProcessImportJson(JSON.stringify(exported))).toEqual([process]);
    expect(parseProcessImportJson(JSON.stringify([process]))).toEqual([process]);
    expect(exported.processes[0]).not.toBe(process);
    expect(exported.processes[0].pluginGroups).not.toBe(process.pluginGroups);
  });

  it('exports processes that the strict import parser would reject', () => {
    const lenient = { ...process, name: '' };
    expect(createProcessExport([lenient]).processes).toEqual([lenient]);
  });

  it.each(['http://example.com/a.js', 'javascript:alert(1)', 'data:text/javascript,1'])(
    'rejects non-https plugin url %s',
    (src) => {
      const plugin = { id: 'p', name: 'P', type: 'external', src };
      const content = JSON.stringify([{ ...process, pluginGroups: [{ title: 'G', plugins: [plugin] }] }]);
      expect(() => parseProcessImportJson(content)).toThrow('must use https');
    },
  );

  it('accepts http plugin urls in stored snapshots but still rejects other schemes', () => {
    const stored = (src: string) => JSON.stringify([{
      ...process, pluginGroups: [{ title: 'G', plugins: [{ id: 'p', name: 'P', type: 'external', src }] }],
    }]);
    expect(parseStoredProcessesJson(stored('http://host/a.js'))[0].pluginGroups[0].plugins[0].src).toBe('http://host/a.js');
    expect(() => parseStoredProcessesJson(stored('javascript:alert(1)'))).toThrow('must use https or http');
    expect(() => parseStoredProcessesJson(stored('data:text/javascript,1'))).toThrow('must use https or http');
  });

  it.each([
    ['invalid JSON', '{'],
    ['unsupported version', '{"formatVersion":2,"processes":[]}'],
    ['missing groups', JSON.stringify([{ ...process, pluginGroups: undefined }])],
    ['empty id', JSON.stringify([{ ...process, id: '' }])],
    ['invalid plugin type', JSON.stringify([{
      ...process,
      pluginGroups: [{ title: 'Group', plugins: [{ id: 'a', name: 'A', type: 'unknown' }] }],
    }])],
    ['invalid rule', JSON.stringify([{
      ...process,
      pluginGroups: [{ title: 'Group', plugins: [{ id: 'a', name: 'A', type: 'internal', validations: [{}] }] }],
    }])],
    ['duplicate plugin IDs', JSON.stringify([{
      ...process,
      pluginGroups: [process.pluginGroups[0], process.pluginGroups[0]],
    }])],
  ])('rejects %s', (_name, content) => {
    expect(() => parseProcessImportJson(content)).toThrow();
  });

  it('imports valid files and reports invalid files without importing partial file contents', async () => {
    const result = await importProcessFiles([
      { name: 'good.json', size: 20, text: async () => JSON.stringify([process]) },
      { name: 'bad.json', size: 20, text: async () => JSON.stringify([process, {}]) },
    ]);
    expect(result.processes).toEqual([process]);
    expect(result.importedFiles).toBe(1);
    expect(result.failures).toEqual([{ name: 'bad.json', reason: expect.any(String) }]);
  });

  it('counts failed files toward the combined import size limit', async () => {
    const text = vi.fn(async () => JSON.stringify([process]));
    const result = await importProcessFiles([
      { name: 'invalid.json', size: MAX_PROCESS_IMPORT_BYTES, text: async () => '{' },
      { name: 'over-limit.json', size: 1, text },
    ]);
    expect(text).not.toHaveBeenCalled();
    expect(result.processes).toEqual([]);
    expect(result.failures).toHaveLength(2);
  });
});
