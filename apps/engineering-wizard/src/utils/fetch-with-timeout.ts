const DEFAULT_TIMEOUT_MS = 5000;

export class BackendTransportError extends Error {
  constructor(public readonly cause: unknown) {
    super(`Could not reach the backend: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'BackendTransportError';
  }
}

export class BackendTimeoutError extends Error {
  constructor(public readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    super(`The backend request timed out after ${timeoutMs / 1000} seconds.`);
    this.name = 'BackendTimeoutError';
  }
}

export class BackendCancellationError extends Error {
  constructor(public readonly cause: unknown) {
    super('The backend request was cancelled by the caller.');
    this.name = 'AbortError';
  }
}

export class BackendHtmlResponseError extends Error {
  constructor() {
    super('The backend returned an HTML page instead of an API response.');
    this.name = 'BackendHtmlResponseError';
  }
}

export function createFetchWithTimeout(timeoutMs: number): typeof fetch {
  return (input, init) => fetchWithTimeoutMs(input, init, timeoutMs);
}

export const fetchWithTimeout = createFetchWithTimeout(DEFAULT_TIMEOUT_MS);

async function fetchWithTimeoutMs(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = (error: Error) => {
    rejectAbort(error);
    controller.abort(error);
  };
  const abort = () => cancel(new BackendCancellationError(signal?.reason));
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => cancel(new BackendTimeoutError(timeoutMs)), timeoutMs);
  try {
    if (signal?.aborted) throw new BackendCancellationError(signal.reason);
    const response = await Promise.race([
      Promise.resolve(fetch(input, { ...init, signal: controller.signal })).catch((error: unknown) => {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new BackendTransportError(error);
      }),
      aborted,
    ]);
    // Generated clients decode later. Keep timeout/cancellation active until all
    // bytes arrive, then give them an ordinary, cloneable Response.
    const body = await Promise.race([
      response.arrayBuffer().catch((error: unknown) => {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new BackendTransportError(error);
      }),
      aborted,
    ]);
    if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
      throw new BackendHtmlResponseError();
    }
    if (response.status === 0) return response;
    const buffered = new Response(
      response.body === null || [204, 205, 304].includes(response.status) ? null : body,
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
    for (const key of ['url', 'redirected', 'type'] as const) {
      Object.defineProperty(buffered, key, { value: response[key] });
    }
    return buffered;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
