// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { OscdToastHost } from '@oscd-transnet-plugins/oscd-component';
import { toastService } from '@oscd-transnet-plugins/oscd-services/toast';

const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');

beforeEach(() => {
  vi.useFakeTimers();
  // Simulate suspended animations: their completion callbacks never fire.
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: vi.fn(() => ({
      cancel: vi.fn(),
      finish: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      currentTime: 0,
      onfinish: null,
    })),
  });
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  });
});

afterEach(() => {
  for (const { id } of toastService.toasts.items) toastService.remove(id);
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate);
  else Reflect.deleteProperty(Element.prototype, 'animate');
  if (originalGetAnimations) Object.defineProperty(Element.prototype, 'getAnimations', originalGetAnimations);
  else Reflect.deleteProperty(Element.prototype, 'getAnimations');
});

it('removes expired toasts independently while animation completion is suspended', async () => {
  const first = toastService.success('Saved', undefined, 4000);
  const second = toastService.warn('Backend unavailable', undefined, 15000);
  const { queryByText, getByText } = render(OscdToastHost);
  expect(getByText('Saved')).toBeTruthy();
  await vi.advanceTimersByTimeAsync(4000);
  await tick();
  expect(toastService.toasts.items.map(({ id }) => id)).toEqual([second]);
  expect(queryByText('Saved')).toBeNull();
  expect(getByText('Backend unavailable')).toBeTruthy();
  expect(toastService.toasts.items.some(({ id }) => id === first)).toBe(false);
  await vi.advanceTimersByTimeAsync(11000);
  await tick();
  expect(queryByText('Backend unavailable')).toBeNull();
});

it('removes a manually closed toast without waiting for animation completion', async () => {
  const id = toastService.info('Close me');
  const { getByRole, queryByText } = render(OscdToastHost);
  await fireEvent.click(getByRole('button', { name: 'Close notification' }));
  await tick();
  expect(toastService.toasts.items.some((toast) => toast.id === id)).toBe(false);
  expect(queryByText('Close me')).toBeNull();
});
