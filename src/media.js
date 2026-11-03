const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { UserError } = require('./errors');

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const METADATA_TIMEOUT_MS = 25000;
const COLLECTION_TIMEOUT_MS = 45000;
const STREAM_START_TIMEOUT_MS = 25000;
const MAX_RESOLVE = 50;

function classifyQuery(raw) {
  const query = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!query) throw new UserError('Tell me a song name or a link.');
  if (query.length > 500) throw new UserError('That is too long. Keep it under 500 characters.');

  const spotifyUri = query.match(/^spotify:(track|album|playlist|episode):([A-Za-z0-9]+)$/i);
  if (spotifyUri) {
    const type = spotifyUri[1].toLowerCase();
    const id = spotifyUri[2];
    return {
      kind: 'spotify',
      type,
      id,
      url: `https://open.spotify.com/${type}/${id}`,
    };
  }

  if (!/^https?:\/\//i.test(query)) {
    return { kind: 'search', query, label: query };
  }

  let url;
  try {
    url = new URL(query);
  } catch {
    throw new UserError('That link is not a valid URL.');
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  return parseSpotifyUrl(url, host)
    || parseDeezerUrl(url, host)
    || parseAppleUrl(url, host)
    || normalizeDirect(url, host);
}

function parseSpotifyUrl(url, host) {
  if (host !== 'open.spotify.com' && host !== 'spotify.com' && host !== 'play.spotify.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (/^intl-/i.test(parts[0] || '')) parts.shift();
  const type = (parts[0] || '').toLowerCase();
  const id = parts[1] || '';
  if (!/^(track|album|playlist|episode)$/.test(type) || !/^[A-Za-z0-9]+$/.test(id)) {
    throw new UserError('That Spotify link needs to be a song, album, or playlist.');
  }
  return { kind: 'spotify', type, id, url: `https://open.spotify.com/${type}/${id}` };
}

function parseDeezerUrl(url, host) {
  if (host !== 'deezer.com' && host !== 'deezer.page.link') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const index = parts.findIndex((part) => /^(track|album|playlist)$/i.test(part));
  if (index === -1 || !/^\d+$/.test(parts[index + 1] || '')) {
    throw new UserError('That Deezer link needs to be a song, album, or playlist.');
  }
  const type = parts[index].toLowerCase();
  const id = parts[index + 1];
  return { kind: 'deezer', type, id, url: `https://www.deezer.com/${type}/${id}` };
}

function parseAppleUrl(url, host) {
  if (host !== 'music.apple.com' && host !== 'itunes.apple.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const songParam = url.searchParams.get('i');
  if (songParam && /^\d+$/.test(songParam)) {
    return { kind: 'apple', type: 'song', id: songParam, url: url.href };
  }
  const id = parts.at(-1);
  if (!/^\d+$/.test(id || '')) {
    throw new UserError('That Apple Music link needs to be a song or album.');
  }
  if (parts.includes('playlist')) {
    throw new UserError('Apple Music playlists are not supported. Paste a song, an album, or the song name.');
  }
  const type = parts.includes('song') ? 'song' : 'album';
  return { kind: 'apple', type, id, url: url.href };
}

function normalizeDirect(url, host) {
  const youtube = host === 'youtu.be'
    || host === 'youtube.com'
    || host === 'm.youtube.com'
    || host === 'music.youtube.com'
    || host === 'youtube-nocookie.com';
  if (youtube) {
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return { kind: 'direct', url: watchUrl(id), collection: false, label: url.href };
    }
    if (url.pathname === '/watch' && url.searchParams.get('v')) {
      return { kind: 'direct', url: watchUrl(url.searchParams.get('v')), collection: false, label: url.href };
    }
    const nested = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?]+)/);
    if (nested) return { kind: 'direct', url: watchUrl(nested[1]), collection: false, label: url.href };
    if (url.pathname === '/playlist' || url.searchParams.get('list')) {
      return { kind: 'direct', url: url.href, collection: true, label: url.href };
    }
    return { kind: 'direct', url: url.href, collection: false, label: url.href };
  }

  const collection = ((host === 'soundcloud.com' || host === 'm.soundcloud.com') && url.pathname.includes('/sets/'))
    || (host.endsWith('bandcamp.com') && url.pathname.includes('/album/'));
  return { kind: 'direct', url: url.href, collection, label: url.href };
}

function watchUrl(id) {
  if (!VIDEO_ID.test(id || '')) {
    throw new UserError('That YouTube link does not contain a video id.');
  }
  return `https://www.youtube.com/watch?v=${id}`;
}

function isShortLink(value) {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'spotify.link'
      || host === 'spotify.app.link'
      || host === 'link.deezer.com'
      || host === 'deezer.page.link';
  } catch {
    return false;
  }
}

let cachedYtDlp = null;
let cachedFfmpeg = null;

function commandWorks(command, args) {
  const probe = spawnSync(command, args, { stdio: 'ignore' });
  return probe.status === 0;
}

function requireBinary() {
  if (cachedYtDlp) return cachedYtDlp;
  const explicit = (process.env.YTDLP_PATH || '').trim();
  if (explicit) {
    if (!commandWorks(explicit, ['--version'])) {
      throw new UserError(`YTDLP_PATH could not be run (${explicit}). Install yt-dlp and point this at the executable.`);
    }
    cachedYtDlp = explicit;
    return cachedYtDlp;
  }
  if (commandWorks('yt-dlp', ['--version'])) {
    cachedYtDlp = 'yt-dlp';
    return cachedYtDlp;
  }
  throw new UserError('yt-dlp is not installed. Install it on the VPS (see the README) so the yt-dlp command is on PATH.');
}

function ffmpegBinary() {
  if (cachedFfmpeg !== null) return cachedFfmpeg || null;
  const explicit = (process.env.FFMPEG_PATH || '').trim();
  if (explicit && commandWorks(explicit, ['-version'])) {
    cachedFfmpeg = explicit;
    return cachedFfmpeg;
  }
  cachedFfmpeg = commandWorks('ffmpeg', ['-version']) ? 'ffmpeg' : '';
  return cachedFfmpeg || null;
}

function friendlyYtError(stderr, code) {
  const lines = String(stderr || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLine = [...lines].reverse().find((line) => /^ERROR:/i.test(line)) || lines.at(-1) || '';
  const message = errorLine.replace(/^ERROR:\s*/i, '').trim();
  if (/no video results/i.test(message)) return 'No results for that search.';
  if (/unsupported url/i.test(message)) {
    return 'I cannot play that link. Try a song name, or a YouTube, SoundCloud, Spotify, Deezer, or Apple Music link.';
  }
  if (/private video/i.test(message)) return 'That video is private.';
  if (/not a bot|cookies-from-browser|sign in to confirm/i.test(message)) {
    return 'YouTube blocked that request and asked for a sign-in check. Try again later, or set YTDLP_COOKIES to a cookies.txt file (see the README).';
  }
  if (/age-restricted|age restricted|confirm your age/i.test(message)) {
    return 'That video is age-restricted and cannot be played.';
  }
  if (/unavailable|removed|not available|copyright/i.test(message)) return 'That video is unavailable.';
  if (/python/i.test(message) && /not found|no such file/i.test(message)) {
    return 'Python 3.11 or newer is required to run yt-dlp. Install it, then try again.';
  }
  if (message) return message.slice(0, 300);
  return `Couldn't open that (yt-dlp exit ${code ?? 'unknown'}).`;
}

function cookieArgs() {
  const cookies = (process.env.YTDLP_COOKIES || '').trim();
  if (!cookies) return [];
  if (!fs.existsSync(cookies)) {
    throw new UserError(`YTDLP_COOKIES does not exist: ${cookies}`);
  }
  return ['--cookies', cookies];
}

function runYtDlp(args, timeoutMs) {
  const binary = requireBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    let stderr = '';
    let settled = false;

    const finish = (handler) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handler();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new UserError('That took too long to look up. Try again.')));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (error) => {
      finish(() => {
        if (error.code === 'ENOENT') {
          reject(new UserError('yt-dlp could not be started. Install yt-dlp and Python 3.11 or newer, then try again.'));
          return;
        }
        reject(error);
      });
    });
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) {
          resolve(Buffer.concat(stdout).toString('utf8'));
          return;
        }
        const failure = new UserError(friendlyYtError(stderr, code));
        failure.detail = stderr;
        reject(failure);
      });
    });
  });
}

function streamUrlFromEntry(video) {
  const extractor = `${video.extractor || ''} ${video.ie_key || ''} ${video.extractor_key || ''}`.toLowerCase();
  if (typeof video.webpage_url === 'string' && /^https?:\/\//.test(video.webpage_url)) return video.webpage_url;
  if (typeof video.url === 'string' && /^https?:\/\//.test(video.url)) return video.url;
  const id = VIDEO_ID.test(video.id || '') ? video.id : (VIDEO_ID.test(video.url || '') ? video.url : null);
  if (id && extractor.includes('youtube')) return `https://www.youtube.com/watch?v=${id}`;
  return null;
}

function toTrack(video, requestedBy) {
  const url = streamUrlFromEntry(video);
  if (!url) return null;
  const extractor = `${video.extractor || video.ie_key || video.extractor_key || 'link'}`.toLowerCase();
  return {
    title: video.title || video.fulltitle || 'Unknown title',
    url,
    duration: typeof video.duration === 'number' ? video.duration : null,
    requestedBy,
    source: extractor.includes('youtube') ? 'youtube' : extractor.split(' ')[0] || 'link',
    search: null,
  };
}

async function resolveWithYtDlp(target, requestedBy, { collection, limit, label }) {
  const load = async (asCollection) => {
    const json = await runYtDlp([
      '--dump-single-json',
      '--no-warnings',
      '--skip-download',
      '--no-cache-dir',
      '--flat-playlist',
      ...(asCollection ? ['--yes-playlist', '--playlist-end', String(limit)] : ['--no-playlist']),
      ...cookieArgs(),
      '--',
      target,
    ], asCollection ? COLLECTION_TIMEOUT_MS : METADATA_TIMEOUT_MS);
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      throw new UserError('That result could not be read. Try again.');
    }
    const entries = Array.isArray(data.entries) ? data.entries : [data];
    const tracks = [];
    for (const entry of entries) {
      if (!entry) continue;
      const track = toTrack(entry, requestedBy);
      if (!track) continue;
      tracks.push(track);
      if (tracks.length >= limit) break;
    }
    if (!tracks.length) {
      throw new UserError(label ? `No results for "${label}".` : 'I could not open that link.');
    }
    return tracks;
  };

  try {
    return await load(collection);
  } catch (error) {
    const detail = `${error.detail || ''} ${error.message || ''}`;
    if (!collection && /yes-playlist|playlist/i.test(detail) && !/does not exist|unavailable/i.test(detail)) {
      return load(true);
    }
    throw error;
  }
}

function matchedTrack({ title, artist, duration, pageUrl, source, requestedBy }) {
  const name = String(title || '').replace(/\s+/g, ' ').trim();
  const by = String(artist || '').replace(/\s+/g, ' ').trim();
  const search = [by, name].filter(Boolean).join(' ').trim();
  if (!search) return null;
  const seconds = typeof duration === 'number' && Number.isFinite(duration) ? Math.round(duration) : null;
  return {
    title: name || search,
    url: pageUrl,
    duration: seconds,
    requestedBy,
    source,
    search,
  };
}

async function fetchText(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
    });
    if (!response.ok) throw new Error(String(response.status));
    return response.text();
  } catch {
    throw new UserError('I could not open that link. Try the song name instead.');
  }
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError('I could not open that link. Try the song name instead.');
  }
}

async function followRedirect(input) {
  try {
    const response = await fetch(input, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    return response.url || input;
  } catch {
    return input;
  }
}

async function resolveSpotify(target, requestedBy, limit) {
  const html = await fetchText(`https://open.spotify.com/embed/${target.type}/${target.id}`);
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);
  if (!match) throw new UserError('I could not read that Spotify link. Try the song name instead.');
  let entity;
  try {
    entity = JSON.parse(match[1]).props.pageProps.state.data.entity;
  } catch {
    throw new UserError('I could not read that Spotify link. Try the song name instead.');
  }
  if (!entity) throw new UserError('I could not read that Spotify link. Try the song name instead.');

  if (Array.isArray(entity.trackList) && entity.trackList.length) {
    const tracks = entity.trackList.slice(0, limit).map((item) => matchedTrack({
      title: item.title,
      artist: item.subtitle,
      duration: typeof item.duration === 'number' ? item.duration / 1000 : null,
      pageUrl: spotifyPage(item.uri) || target.url,
      source: 'spotify',
      requestedBy,
    })).filter(Boolean);
    if (!tracks.length) throw new UserError('That Spotify list did not contain any playable songs.');
    return tracks;
  }

  const artist = Array.isArray(entity.artists) ? entity.artists.map((person) => person.name).filter(Boolean).join(', ') : '';
  const track = matchedTrack({
    title: entity.title || entity.name,
    artist,
    duration: typeof entity.duration === 'number' ? entity.duration / 1000 : null,
    pageUrl: target.url,
    source: 'spotify',
    requestedBy,
  });
  if (!track) throw new UserError('I could not read that Spotify link. Try the song name instead.');
  return [track];
}

function spotifyPage(uri) {
  const match = String(uri || '').match(/^spotify:(track|episode):([A-Za-z0-9]+)$/);
  if (!match) return null;
  return `https://open.spotify.com/${match[1]}/${match[2]}`;
}

async function resolveDeezer(target, requestedBy, limit) {
  const payload = await fetchJson(`https://api.deezer.com/${target.type}/${target.id}`);
  if (payload.error) throw new UserError('I could not read that Deezer link. Try the song name instead.');
  if (target.type === 'track') {
    const track = matchedTrack({
      title: payload.title_short || payload.title,
      artist: payload.artist?.name,
      duration: payload.duration,
      pageUrl: payload.link || target.url,
      source: 'deezer',
      requestedBy,
    });
    if (!track) throw new UserError('I could not read that Deezer link. Try the song name instead.');
    return [track];
  }

  const fallbackArtist = payload.artist?.name || '';
  const rows = [];
  let page = payload.tracks?.data || [];
  let next = payload.tracks?.next || null;
  rows.push(...page);
  while (next && rows.length < limit) {
    const more = await fetchJson(next);
    page = more.data || [];
    rows.push(...page);
    next = more.next || null;
    if (!page.length) break;
  }
  const tracks = rows.slice(0, limit).map((item) => matchedTrack({
    title: item.title_short || item.title,
    artist: item.artist?.name || fallbackArtist,
    duration: item.duration,
    pageUrl: item.link || target.url,
    source: 'deezer',
    requestedBy,
  })).filter(Boolean);
  if (!tracks.length) throw new UserError('That Deezer list did not contain any playable songs.');
  return tracks;
}

async function resolveApple(target, requestedBy, limit) {
  const lookup = target.type === 'album'
    ? `https://itunes.apple.com/lookup?id=${target.id}&entity=song&limit=${limit + 1}`
    : `https://itunes.apple.com/lookup?id=${target.id}`;
  const payload = await fetchJson(lookup);
  const rows = (payload.results || []).filter((item) => item.wrapperType === 'track' || item.kind === 'song');
  const tracks = rows.slice(0, limit).map((item) => matchedTrack({
    title: item.trackName,
    artist: item.artistName,
    duration: typeof item.trackTimeMillis === 'number' ? item.trackTimeMillis / 1000 : null,
    pageUrl: item.trackViewUrl || target.url,
    source: 'apple',
    requestedBy,
  })).filter(Boolean);
  if (!tracks.length) throw new UserError('I could not read that Apple Music link. Try the song name instead.');
  return tracks;
}

async function resolveTracks(rawQuery, requestedBy, limit = MAX_RESOLVE) {
  const cap = Math.min(MAX_RESOLVE, Math.max(1, limit));
  let input = String(rawQuery || '').replace(/\s+/g, ' ').trim();
  if (isShortLink(input)) input = await followRedirect(input);
  const classified = classifyQuery(input);
  if (classified.kind === 'search') {
    return resolveWithYtDlp(`ytsearch1:${classified.query}`, requestedBy, {
      collection: false,
      limit: 1,
      label: classified.label,
    });
  }
  if (classified.kind === 'spotify') return resolveSpotify(classified, requestedBy, cap);
  if (classified.kind === 'deezer') return resolveDeezer(classified, requestedBy, cap);
  if (classified.kind === 'apple') return resolveApple(classified, requestedBy, cap);
  return resolveWithYtDlp(classified.url, requestedBy, {
    collection: classified.collection,
    limit: cap,
    label: classified.label,
  });
}

async function ensurePlayable(track) {
  if (!track.search) return track;
  const [match] = await resolveWithYtDlp(`ytsearch1:${track.search}`, track.requestedBy, {
    collection: false,
    limit: 1,
    label: track.search,
  });
  if (!match?.url) throw new UserError(`No YouTube match for "${track.title}".`);
  track.url = match.url;
  if (track.duration == null) track.duration = match.duration;
  track.search = null;
  return track;
}

function matchNote(track) {
  if (track?.source === 'spotify') return 'Playing the YouTube match for that Spotify link.';
  if (track?.source === 'deezer') return 'Playing the YouTube match for that Deezer link.';
  if (track?.source === 'apple') return 'Playing the YouTube match for that Apple Music link.';
  return '';
}

function openAudioStream(url) {
  const binary = requireBinary();
  const args = [
    '--no-warnings',
    '--quiet',
    '--no-progress',
    '--no-playlist',
    '--no-cache-dir',
    '-f', 'bestaudio[acodec=opus]/bestaudio/best',
    '-o', '-',
    ...cookieArgs(),
    '--',
    url,
  ];
  const ffmpeg = ffmpegBinary();
  if (ffmpeg) {
    args.splice(args.length - 2, 0, '--ffmpeg-location', ffmpeg);
  }

  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });
  child.on('error', () => {});

  // Don't read stdout here. demuxProbe has to see the first bytes.
  const timer = setTimeout(() => {
    if (child.exitCode == null) child.kill('SIGKILL');
  }, STREAM_START_TIMEOUT_MS);

  return {
    stream: child.stdout,
    process: child,
    stderr: () => stderr,
    clearStartTimeout() {
      clearTimeout(timer);
    },
    kill() {
      clearTimeout(timer);
      if (child.exitCode == null && !child.killed) child.kill('SIGKILL');
    },
  };
}

module.exports = {
  classifyQuery,
  resolveTracks,
  ensurePlayable,
  openAudioStream,
  friendlyYtError,
  matchNote,
};
