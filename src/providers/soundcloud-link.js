const { assertPublicUrl } = require('../util/http');

const SHORT_HOSTS = new Set(['on.soundcloud.com', 'snd.sc']);

function hostOf(url) {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

function isSoundCloudHost(host) {
  return host === 'soundcloud.com' || host === 'm.soundcloud.com' || SHORT_HOSTS.has(host);
}

function userError(message) {
  const error = new Error(message);
  error.userError = true;
  return error;
}

function cleanSoundCloudUrl(value) {
  const url = new URL(value);
  url.protocol = 'https:';
  const host = hostOf(url);
  if (host === 'm.soundcloud.com') url.hostname = 'soundcloud.com';
  url.hash = '';
  const secret = url.searchParams.get('secret_token');
  url.search = '';
  if (secret) url.searchParams.set('secret_token', secret);
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

function permalinkFromHtml(html) {
  const snippet = String(html || '').slice(0, 100000);
  const match = snippet.match(/https?:\/\/(?:www\.|m\.)?soundcloud\.com\/[^"'\\\s<>]+/i);
  return match ? match[0] : null;
}

async function followShortLink(start, fetchImpl) {
  let current = start;
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });
    const status = Number(response.status) || 0;
    if (status >= 300 && status < 400) {
      const location = response.headers?.get?.('location');
      if (!location) break;
      const next = new URL(location, current);
      if (!isSoundCloudHost(hostOf(next))) {
        throw userError('That SoundCloud link did not stay on SoundCloud.');
      }
      assertPublicUrl(next.toString());
      const nextHost = hostOf(next);
      if (nextHost === 'soundcloud.com' || nextHost === 'm.soundcloud.com') return next;
      current = next.toString();
      continue;
    }
    const here = new URL(current);
    if (status === 200 && SHORT_HOSTS.has(hostOf(here)) && typeof response.text === 'function') {
      const found = permalinkFromHtml(await response.text());
      if (!found) break;
      const next = new URL(found);
      if (!isSoundCloudHost(hostOf(next))) {
        throw userError('That SoundCloud link did not stay on SoundCloud.');
      }
      current = next.toString();
    }
    break;
  }
  return new URL(current);
}

async function canonicalSoundCloudUrl(input, fetchImpl = fetch) {
  let clean;
  try {
    clean = assertPublicUrl(String(input || '').trim());
  } catch {
    throw userError('That SoundCloud link could not be opened.');
  }
  let url = new URL(clean);
  if (!isSoundCloudHost(hostOf(url))) {
    throw userError('That link is not a SoundCloud link.');
  }
  if (SHORT_HOSTS.has(hostOf(url))) {
    try {
      url = await followShortLink(url.toString(), fetchImpl);
    } catch (error) {
      if (error.userError) throw error;
      throw userError('That SoundCloud link could not be opened.');
    }
  }
  if (hostOf(url) === 'm.soundcloud.com') url.hostname = 'soundcloud.com';
  const page = cleanSoundCloudUrl(url.toString());
  const parsed = new URL(page);
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (hostOf(parsed) !== 'soundcloud.com' || !parts.length) {
    throw userError('That SoundCloud link could not be opened.');
  }
  return page;
}

module.exports = { canonicalSoundCloudUrl, cleanSoundCloudUrl };
