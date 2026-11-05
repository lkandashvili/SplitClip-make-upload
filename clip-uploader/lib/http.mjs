// Thin fetch wrapper: retries transient failures and turns every platform's
// error shape into one readable message instead of "[object Object]".

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class ApiError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

/** Platforms hide the useful sentence in different places. Find it. */
function extractMessage(body, status) {
  if (!body) return `HTTP ${status} with an empty body`;
  if (typeof body === 'string') return body.slice(0, 600);

  const candidates = [
    body?.error?.error_user_msg,
    body?.error?.message,
    body?.error_description,
    body?.message,
    body?.error?.msg,
    body?.detail,
  ];
  const base = candidates.find((c) => typeof c === 'string' && c.trim());
  const parts = [];
  if (base) parts.push(base);
  if (body?.error?.code) parts.push(`code ${body.error.code}`);
  if (body?.error?.subcode) parts.push(`subcode ${body.error.subcode}`);
  if (body?.error?.type) parts.push(`type ${body.error.type}`);
  return parts.length ? parts.join(' | ') : JSON.stringify(body).slice(0, 600);
}

async function parseBody(res) {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * JSON/multipart request with exponential backoff.
 * `label` prefixes any error so you know which platform failed.
 */
export async function request(url, opts = {}) {
  const { label = 'request', retries = 3, timeoutMs = 120_000 } = opts;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      ...opts,
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((err) => {
      throw new ApiError(`${label}: network error - ${err.message}`, { url });
    });

    const body = await parseBody(res);

    if (res.ok) return { status: res.status, body, headers: res.headers };

    if (RETRY_STATUS.has(res.status) && attempt < retries) {
      await sleep(Math.min(2000 * 2 ** attempt, 15_000));
      continue;
    }

    throw new ApiError(`${label}: ${extractMessage(body, res.status)}`, {
      status: res.status,
      body,
      url,
    });
  }

  throw new ApiError(`${label}: gave up after ${retries} retries`, { url });
}

export function jsonRequest(url, { token, ...opts } = {}) {
  return request(url, {
    ...opts,
    method: opts.method ?? 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
    body: opts.payload === undefined ? opts.body : JSON.stringify(opts.payload),
  });
}

export { extractMessage };
