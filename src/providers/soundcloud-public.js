const API = 'https://api-v2.soundcloud.com';
const HOME = 'https://soundcloud.com/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let cachedClientId = '';
let cachedAt = 0;

function resetSoundCloudClientId() {
  cachedClientId = '';
  cachedAt = 0;
}

function userError(message) {
  const error = new Error(message);
  error.userError = true;
  return error;
}

async function readResponse(fetchImpl, url, accept) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: accept,
      'User-Agent': USER_AGENT,
      Referer: 'https://soundcloud.com/',
      Origin: 'https://soundcloud.com',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const error = new Error(`SoundCloud returned ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return response.text();
}

async function soundCloudClientId(fetchImpl) {
  if (cachedClientId && Date.now() - cachedAt < 6 * 60 * 60 * 1000) return cachedClientId;
  const home = await readResponse(fetchImpl, HOME, 'text/html');
  const scripts = [...home.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)]
    .map((match) => match[1]);
  for (const script of scripts.slice(-4).reverse()) {
    const source = await readResponse(fetchImpl, script, '*/*');
    const match = source.match(/[,{]client_id:"([a-zA-Z0-9]{32})"/);
    if (!match) continue;
    cachedClientId = match[1];
    cachedAt = Date.now();
    return cachedClientId;
  }
  throw new Error('SoundCloud did not share a client id.');
}

function toMeta(resource) {
  const title = String(resource?.title || '').trim();
  const pageUrl = String(resource?.permalink_url || '').trim();
  if (!title || !pageUrl) return null;
  const duration = Number(resource.duration);
  return {
    title,
    artist: resource.user?.username || resource.publisher_metadata?.artist || '',
    durationMs: Number.isFinite(duration) ? duration : null,
    pageUrl,
  };
}

async function resolvePublicSoundCloud(page, limit, fetchImpl = fetch) {
  const clientId = await soundCloudClientId(fetchImpl);
  let resource;
  try {
    const body = await readResponse(
      fetchImpl,
      `${API}/resolve?url=${encodeURIComponent(page)}&client_id=${clientId}`,
      'application/json',
    );
    resource = JSON.parse(body);
  } catch (error) {
    if (error.status === 404) throw userError('That SoundCloud link could not be played.');
    throw error;
  }
  if (resource?.kind === 'track') {
    const track = toMeta(resource);
    if (!track) throw userError('SoundCloud does not make that track available.');
    return { tracks: [track], notice: null };
  }
  if (resource?.kind === 'playlist') {
    const tracks = (resource.tracks || []).map(toMeta).filter(Boolean).slice(0, limit);
    if (!tracks.length) throw userError('That SoundCloud playlist has no playable tracks.');
    const notes = [];
    const total = Number(resource.track_count) || (resource.tracks || []).length;
    if (total > tracks.length) notes.push(`Only the first ${tracks.length} tracks were added.`);
    return { tracks, notice: notes.join(' ') || null };
  }
  if (resource?.kind === 'user') {
    const body = await readResponse(
      fetchImpl,
      `${API}/users/${encodeURIComponent(resource.id)}/tracks?representation=full&limit=${limit}&client_id=${clientId}`,
      'application/json',
    );
    const payload = JSON.parse(body);
    const tracks = (payload.collection || []).map(toMeta).filter(Boolean).slice(0, limit);
    if (!tracks.length) throw userError('That SoundCloud profile has no tracks to play.');
    const name = resource.username || 'that profile';
    return { tracks, notice: `Playing the latest tracks from ${name}.` };
  }
  throw userError('Paste a SoundCloud track, playlist, or artist link.');
}

function compactTitle(value) {
  return String(value || '')
    .replace(/\u0640/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}

function plainTranscoding(resource) {
  const usable = (resource?.media?.transcodings || []).filter((item) => (
    item?.url
    && item.snipped !== true
    && item.format?.protocol === 'hls'
    && String(item.format?.mime_type || '').startsWith('audio/mp4')
  ));
  return usable.find((item) => item.preset === 'aac_160k') || usable[0] || null;
}

function sameRecording(wanted, candidate) {
  const wantedTitle = compactTitle(wanted.title);
  const candidateTitle = compactTitle(candidate.title);
  if (wantedTitle.length < 2 || candidateTitle.length < 2) return false;
  if (!candidateTitle.includes(wantedTitle) && !wantedTitle.includes(candidateTitle)) return false;
  const wantedMs = Number(wanted.duration);
  const candidateMs = Number(candidate.duration);
  if (!Number.isFinite(wantedMs) || !Number.isFinite(candidateMs) || wantedMs <= 0 || candidateMs <= 0) {
    return true;
  }
  return Math.abs(candidateMs - wantedMs) <= Math.max(20000, wantedMs * 0.15);
}

async function mediaUrlFor(transcoding, clientId, fetchImpl) {
  const separator = transcoding.url.includes('?') ? '&' : '?';
  let media;
  try {
    media = JSON.parse(await readResponse(
      fetchImpl,
      `${transcoding.url}${separator}client_id=${clientId}`,
      'application/json',
    ));
  } catch (error) {
    if (error.status === 404) throw userError('SoundCloud does not make that track available.');
    throw error;
  }
  if (!media?.url) throw userError('SoundCloud does not make that track available.');
  return media.url;
}

async function playableCopy(resource, clientId, fetchImpl) {
  const query = String(resource.title || '').trim();
  if (!query) return null;
  const body = await readResponse(
    fetchImpl,
    `${API}/search/tracks?q=${encodeURIComponent(query)}&limit=10&client_id=${clientId}`,
    'application/json',
  );
  const matches = (JSON.parse(body).collection || [])
    .filter((item) => item?.id !== resource.id && plainTranscoding(item) && sameRecording(resource, item));
  matches.sort((left, right) => (
    Math.abs(Number(left.duration) - Number(resource.duration))
    - Math.abs(Number(right.duration) - Number(resource.duration))
  ));
  return matches[0] || null;
}

async function soundCloudMediaUrl(page, fetchImpl = fetch) {
  const clientId = await soundCloudClientId(fetchImpl);
  let resource;
  try {
    resource = JSON.parse(await readResponse(
      fetchImpl,
      `${API}/resolve?url=${encodeURIComponent(page)}&client_id=${clientId}`,
      'application/json',
    ));
  } catch (error) {
    if (error.status === 404) throw userError('That SoundCloud track could not be played.');
    throw error;
  }
  if (resource?.kind !== 'track') throw userError('That SoundCloud track could not be played.');
  let chosen = plainTranscoding(resource);
  if (!chosen) {
    const copy = await playableCopy(resource, clientId, fetchImpl);
    chosen = copy ? plainTranscoding(copy) : null;
  }
  if (!chosen) throw userError('That SoundCloud upload is locked, and there is no other copy to play.');
  return mediaUrlFor(chosen, clientId, fetchImpl);
}

module.exports = {
  resolvePublicSoundCloud,
  resetSoundCloudClientId,
  soundCloudMediaUrl,
};
