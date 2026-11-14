// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import {
  engineeringProcesses,
  runningEngineeringProcess,
  selectedEngineeringProcess,
} from '../features/processes/stores.svelte';
import type { ViewPlugin } from '../features/workflow/viewPlugin';
import PluginHost from '../features/workflow/components/plugins/PluginHost.svelte';
import { validateRulesWithContent } from '../services/validationService';
import { validationCoordinator } from '../services/validationCoordinator.svelte';
import EngineeringWorkflow from './EngineeringWorkflow.view.svelte';

vi.mock('../features/workflow/components/plugins/PluginHost.svelte', () => ({
  default: vi.fn(),
}));
vi.mock('../services/validationService', () => ({
  validateRulesWithContent: vi.fn(),
  describeValidationError: (error: Error) => error.message,
}));

afterEach(() => {
  cleanup();
  validationCoordinator.cancel();
  runningEngineeringProcess.process = null;
  runningEngineeringProcess.lastSelectedPluginId = null;
  selectedEngineeringProcess.process = null;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it('passes the loaded file to plugins and allows navigation when validation is unavailable', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  const plugins: ViewPlugin[] = ['first', 'second'].map((id) => ({
    id,
    name: id,
    src: `${id}.js`,
    type: 'internal',
    validations: [
      { title: 'Check', description: '', context: '//SCL', assert: 'true()' },
    ],
  }));
  const process = {
    id: 'offline-workflow',
    name: 'Offline workflow',
    version: '1.0.0',
    description: '',
    pluginGroups: [{ title: 'Plugins', plugins }],
  };
  engineeringProcesses.processes = [process];
  runningEngineeringProcess.process = process;
  selectedEngineeringProcess.process = process;
  const doc = new DOMParser().parseFromString('<SCL/>', 'application/xml');
  vi.mocked(validateRulesWithContent).mockRejectedValueOnce(
    new TypeError('Backend unavailable'),
  );
  validationCoordinator.runNow(process, doc);
  await waitFor(() =>
    expect(validationCoordinator.getPluginView(plugins[0]).state).toBe('error'),
  );
  const { getByRole, queryByRole, queryByText, container } = render(
    EngineeringWorkflow,
    {
      doc,
      host: document.createElement('div'),
      plugins,
    },
  );
  expect(
    queryByText(
      'Validation is unavailable. You can continue without validation.',
    ),
  ).toBeNull();
  expect(queryByRole('button', { name: 'Retry validation' })).toBeNull();
  expect(container.querySelectorAll('.badge--error')).toHaveLength(2);
  expect(PluginHost).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      doc,
      plugin: expect.objectContaining({ id: 'first' }),
    }),
  );
  const next = getByRole<HTMLButtonElement>('button', { name: 'Next step' });
  expect(next.disabled).toBe(false);
  await fireEvent.click(next);
  expect(runningEngineeringProcess.lastSelectedPluginId).toBe('second');
  expect(PluginHost).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      doc,
      plugin: expect.objectContaining({ id: 'second' }),
    }),
  );
});
