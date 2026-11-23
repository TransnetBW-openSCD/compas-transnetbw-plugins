// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest';
import {
  createFetchWithTimeout, fetchWithTimeout, BackendTimeoutError, BackendCancellationError, BackendTransportError,
} from './fetch-with-timeout';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('detects a missing API route that serves the frontend HTML instead', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response('<html>OpenSCD</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    ),
  );
  await expect(fetchWithTimeout('/backend')).rejects.toThrow(
    'The backend returned an HTML page instead of an API response.',
  );
});

it('aborts an unreachable backend request after five seconds', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        );
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const request = fetchWithTimeout('/backend');
  const rejected = expect(request).rejects.toBeInstanceOf(BackendTimeoutError);
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
});

it('honours a custom timeout so long-running requests are not cut off at five seconds', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })));
  const request = createFetchWithTimeout(60_000)('/slow');
  const rejected = expect(request).rejects.toMatchObject({ timeoutMs: 60_000 });
  await vi.advanceTimersByTimeAsync(59_999);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
});

it('preserves caller cancellation and clears the timeout after a successful request', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue(new Response('ok'));
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  await fetchWithTimeout('/backend', { signal: controller.signal });
  expect(vi.getTimerCount()).toBe(0);
  controller.abort();
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
  await expect(fetchWithTimeout('/backend', { signal: controller.signal }))
    .rejects.toBeInstanceOf(BackendCancellationError);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(['timeout', 'caller'] as const)(
  'keeps %s cancellation active while a response body stalls after headers',
  async (reason) => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')); },
    }))));
    const controller = new AbortController();
    const request = fetchWithTimeout('/backend', { signal: controller.signal });
    const rejected = expect(request).rejects.toBeInstanceOf(
      reason === 'timeout' ? BackendTimeoutError : BackendCancellationError,
    );
    await vi.advanceTimersByTimeAsync(0);
    if (reason === 'caller') controller.abort();
    else await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('buffers the whole body and preserves status, headers and clone/json behavior', async () => {
  vi.useFakeTimers();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
    start(controller) { stream = controller; },
  }), { status: 201, statusText: 'Created', headers: { 'X-Resource': 'saved' } })));
  let completed = false;
  const pending = fetchWithTimeout('/backend').then((response) => {
    completed = true;
    return response;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(completed).toBe(false);
  stream.enqueue(new TextEncoder().encode('{"saved":true}'));
  stream.close();
  const response = await pending;
  expect(response.status).toBe(201);
  expect(response.statusText).toBe('Created');
  expect(response.headers.get('X-Resource')).toBe('saved');
  expect(response.bodyUsed).toBe(false);
  await expect(response.clone().json()).resolves.toEqual({ saved: true });
  await expect(response.json()).resolves.toEqual({ saved: true });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([204, 205, 304])('preserves bodyless HTTP %s responses', async (status) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));
  const response = await fetchWithTimeout('/backend');
  expect(response.status).toBe(status);
  expect(response.body).toBeNull();
});

it('labels actual fetch failures at the transport boundary', async () => {
  const failure = new TypeError('Failed to fetch');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));
  await expect(fetchWithTimeout('/backend')).rejects.toMatchObject({
    name: 'BackendTransportError', cause: failure,
  } satisfies Partial<BackendTransportError>);
});
