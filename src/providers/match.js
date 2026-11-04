const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'youtu.be',
  'music.youtube.com',
  'm.youtube.com',
  'youtube-nocookie.com',
]);

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function isYouTubeUrl(value) {
  if (!isHttpUrl(value)) return false;
  const host = hostOf(value);
  return YOUTUBE_HOSTS.has(host);
}

function isSpotifyUrl(value) {
  if (!isHttpUrl(value)) return false;
  const host = hostOf(value);
  return host === 'open.spotify.com' || host === 'spotify.com' || host === 'play.spotify.com';
}

function isSoundCloudUrl(value) {
  if (!isHttpUrl(value)) return false;
  const host = hostOf(value);
  return host === 'soundcloud.com' || host === 'm.soundcloud.com' || host === 'on.soundcloud.com';
}

function isBandcampUrl(value) {
  if (!isHttpUrl(value)) return false;
  const host = hostOf(value);
  return host === 'bandcamp.com' || host.endsWith('.bandcamp.com');
}

function isTwitchUrl(value) {
  if (!isHttpUrl(value)) return false;
  const host = hostOf(value);
  return host === 'twitch.tv' || host.endsWith('.twitch.tv');
}

function isVimeoUrl(value) {
  if (!isHttpUrl(value)) return false;
  const host = hostOf(value);
  return host === 'vimeo.com' || host === 'player.vimeo.com';
}

function isAppleMusicUrl(value) {
  if (!isHttpUrl(value)) return false;
  const host = hostOf(value);
  return host === 'music.apple.com' || host === 'geo.music.apple.com' || host.endsWith('.music.apple.com');
}

function isDeezerUrl(value) {
  if (!isHttpUrl(value)) return false;
  const host = hostOf(value);
  return host === 'deezer.com' || host.endsWith('.deezer.com');
}

function linkKind(input) {
  const value = String(input || '').trim();
  if (isYouTubeUrl(value)) return 'youtube';
  if (isSpotifyUrl(value) || /^spotify:(track|album|playlist|episode):/i.test(value)) return 'spotify';
  if (isAppleMusicUrl(value)) return 'apple';
  if (isDeezerUrl(value)) return 'deezer';
  if (isSoundCloudUrl(value)) return 'soundcloud';
  if (isBandcampUrl(value)) return 'bandcamp';
  if (isTwitchUrl(value)) return 'twitch';
  if (isVimeoUrl(value)) return 'vimeo';
  if (isHttpUrl(value)) return 'http';
  return 'text';
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\((?:[^)]*)\)|\[(?:[^\]]*)\]/g, ' ')
    .replace(/\b(official|audio|video|lyrics|lyric|visualizer|hd|mv|topic)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titlesMatch(wanted, found) {
  const wantTitle = normalize(wanted.title);
  const foundTitle = normalize(found.title);
  if (wantTitle.length < 2 || foundTitle.length < 2) return false;
  const titleOk = wantTitle === foundTitle || foundTitle.includes(wantTitle);
  if (!titleOk) return false;
  const wantArtist = normalize(wanted.artist);
  if (!wantArtist) return true;
  const foundArtist = normalize(found.artist);
  if (!foundArtist) return false;
  return foundArtist.includes(wantArtist) || wantArtist.includes(foundArtist);
}

function queryMatches(query, found) {
  const raw = String(query || '').trim();
  if (!raw) return false;
  const split = raw.split(/\s+-\s+/);
  if (split.length >= 2 && split[0].trim() && split.slice(1).join('').trim()) {
    return titlesMatch({ artist: split[0], title: split.slice(1).join(' - ') }, found);
  }
  const tokens = normalize(raw).split(' ').filter((token) => token.length >= 2);
  if (!tokens.length) return false;
  const title = normalize(found.title);
  const artist = normalize(found.artist);
  if (title.length < 2) return false;
  const haystack = `${title} ${artist}`.trim();
  if (!tokens.every((token) => haystack.includes(token))) return false;
  const inTitle = tokens.filter((token) => title.includes(token));
  return inTitle.some((token) => token.length >= 3) || inTitle.length >= 2;
}

function durationCompatible(wantedMs, foundMs) {
  if (!Number.isFinite(wantedMs) || !Number.isFinite(foundMs)) return true;
  if (wantedMs <= 0 || foundMs <= 0) return true;
  if (foundMs < wantedMs * 0.6) return false;
  if (foundMs > wantedMs * 3) return false;
  return true;
}

function pickBestMatch(wanted, candidates) {
  const matches = candidates.filter((candidate) => (
    titlesMatch(wanted, candidate) && durationCompatible(wanted.durationMs, candidate.durationMs)
  ));
  matches.sort((left, right) => {
    const leftExact = normalize(left.title) === normalize(wanted.title) ? 0 : 1;
    const rightExact = normalize(right.title) === normalize(wanted.title) ? 0 : 1;
    if (leftExact !== rightExact) return leftExact - rightExact;
    const leftDelta = Number.isFinite(left.durationMs) && Number.isFinite(wanted.durationMs)
      ? Math.abs(left.durationMs - wanted.durationMs)
      : Number.MAX_SAFE_INTEGER;
    const rightDelta = Number.isFinite(right.durationMs) && Number.isFinite(wanted.durationMs)
      ? Math.abs(right.durationMs - wanted.durationMs)
      : Number.MAX_SAFE_INTEGER;
    return leftDelta - rightDelta;
  });
  return matches[0] || null;
}

function spotifyTarget(input) {
  const value = String(input || '').trim();
  const uri = value.match(/^spotify:(track|album|playlist|episode):([A-Za-z0-9]+)$/i);
  if (uri) return { type: uri[1].toLowerCase(), id: uri[2] };
  if (!isSpotifyUrl(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const typeIndex = parts.findIndex((part) => ['track', 'album', 'playlist', 'episode'].includes(part));
  if (typeIndex === -1 || !parts[typeIndex + 1]) return null;
  return { type: parts[typeIndex], id: parts[typeIndex + 1] };
}

module.exports = {
  isHttpUrl,
  isYouTubeUrl,
  isSpotifyUrl,
  isSoundCloudUrl,
  isBandcampUrl,
  isTwitchUrl,
  isVimeoUrl,
  isAppleMusicUrl,
  isDeezerUrl,
  linkKind,
  normalize,
  titlesMatch,
  queryMatches,
  durationCompatible,
  pickBestMatch,
  spotifyTarget,
};
