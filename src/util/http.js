const { withRetry } = require('./retry');

class HttpError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function fetchJson(url, options = {}) {
  const {
    method = 'GET',
    headers,
    body,
    timeoutMs = 10000,
    attempts = 3,
  } = options;
  return withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method, headers, body, signal: controller.signal });
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }
      if (!response.ok) {
        throw new HttpError(`Request failed (${response.status}).`, response.status);
      }
      if (payload == null) {
        throw new HttpError('The provider returned an unreadable response.', 502);
      }
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') throw new HttpError('The request timed out.', 0);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }, { attempts });
}

function stripSecrets(value) {
  const url = new URL(value);
  url.searchParams.delete('client_id');
  url.searchParams.delete('client_secret');
  url.searchParams.delete('access_token');
  return url.toString();
}

function assertPublicUrl(value, { httpsOnly = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError('The stream URL was not usable.', 502);
  }
  const https = url.protocol === 'https:';
  const http = url.protocol === 'http:';
  if (!https && (httpsOnly || !http)) {
    throw new HttpError('The stream URL was not a public http link.', 502);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost'
    || host.endsWith('.local')
    || host === '::1'
    || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)
  ) {
    throw new HttpError('The stream URL did not point at a public host.', 502);
  }
  return stripSecrets(url.toString());
}

function assertPublicHttps(value) {
  return assertPublicUrl(value, { httpsOnly: true });
}

async function resolveAudioUrl(url, headers) {
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(current, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === 'AbortError') throw new HttpError('The request timed out.', 0);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel?.();
      if (!location) throw new HttpError('The stream location was missing.', 502);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel?.();
      throw new HttpError(`Stream request failed (${response.status}).`, response.status);
    }
    const type = response.headers.get('content-type') || '';
    if (type.includes('json') || type.includes('text/javascript')) {
      const body = await response.json().catch(() => null);
      if (!body?.url || typeof body.url !== 'string') {
        throw new HttpError('The provider did not return a stream.', 502);
      }
      return assertPublicHttps(body.url);
    }
    await response.body?.cancel?.();
    return assertPublicHttps(current);
  }
  throw new HttpError('The stream redirected too many times.', 502);
}

function friendlyProviderError(error, label) {
  if (error?.userError) return error.message;
  if (error?.status === 401 || error?.status === 403) {
    return `${label} refused the request. Check the app credentials and permissions.`;
  }
  if (error?.status === 404) return `That ${label} item is unavailable.`;
  if (error?.status === 429) return `${label} is rate limiting requests. Try again in a moment.`;
  return `${label} could not be reached. Try again in a moment.`;
}

module.exports = {
  HttpError,
  fetchJson,
  resolveAudioUrl,
  assertPublicHttps,
  assertPublicUrl,
  friendlyProviderError,
};
