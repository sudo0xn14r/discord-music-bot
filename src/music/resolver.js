const { UserError } = require('../errors');
const {
  YOUTUBE_MESSAGE,
  durationCompatible,
  linkKind,
  titlesMatch,
} = require('../providers/match');

function playbackNames(providers) {
  const names = providers.playbackProviders().map((provider) => provider.label);
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

function notFoundMessage(providers) {
  const names = playbackNames(providers);
  if (!names) {
    return 'No playback source is enabled. Add files to the music folder or leave SoundCloud enabled.';
  }
  return `I couldn't find that song in ${names}. Nothing else was substituted.`;
}

function attachRequester(track, requester, matchedFrom) {
  return {
    ...track,
    requester: requester || track.requester,
    matchedFrom: matchedFrom || track.matchedFrom || null,
  };
}

async function resolveCatalog(input, requester, limit, providers, providerName) {
  const provider = providers.get(providerName);
  if (!provider || !provider.enabled()) {
    throw new UserError(`${provider?.label || 'That source'} is not configured.`);
  }
  let metadata;
  try {
    metadata = await provider.resolveMetadata(input);
  } catch (error) {
    console.error(`[provider:${providerName}] ${error.message}`);
    throw new UserError(provider.friendly(error));
  }
  if (metadata.kind === 'episode') {
    throw new UserError('Spotify episodes are not supported. This bot only matches songs to an authorized source.');
  }
  const selected = metadata.tracks.slice(0, limit);
  const tracks = [];
  let unmatched = 0;
  for (const item of selected) {
    const match = await providers.findMatch(item);
    if (!match || !titlesMatch(item, match) || !durationCompatible(item.durationMs, match.durationMs)) {
      if (match) console.error(`[resolver] rejected a weak match for "${item.title}"`);
      unmatched += 1;
      continue;
    }
    const track = attachRequester(match, requester, providerName);
    if (match.pageUrl == null && item.pageUrl) track.pageUrl = item.pageUrl;
    tracks.push(track);
  }
  if (!tracks.length) {
    const names = playbackNames(providers) || 'an authorized source';
    throw new UserError(`I couldn't find a match for that ${provider.label} link in ${names}. Nothing else was substituted.`);
  }
  const notes = [];
  if (unmatched) {
    notes.push(`${unmatched} ${provider.label} track${unmatched === 1 ? '' : 's'} had no match and ${unmatched === 1 ? 'was' : 'were'} skipped.`);
  }
  if (metadata.tracks.length > selected.length) {
    notes.push(`Only the first ${selected.length} tracks were checked.`);
  }
  return { tracks, unmatched, notice: notes.join(' ') || null };
}

async function resolveDirect(input, requester, limit, providers) {
  const source = providers.get('lavalink');
  if (!source || !source.enabled()) {
    throw new UserError('Direct playback is disabled. Add lavalink to PROVIDER_ORDER.');
  }
  let result;
  try {
    result = await source.resolveUrl(input, requester, limit);
  } catch (error) {
    console.error(`[provider:lavalink] ${error.message}`);
    throw new UserError(source.friendly(error));
  }
  const notes = [];
  if (result.truncated) notes.push(`Only the first ${limit} tracks were added.`);
  return {
    tracks: result.tracks.map((track) => attachRequester(track, requester)),
    unmatched: 0,
    notice: notes.join(' ') || null,
  };
}

async function resolveRequest(query, requester, limit, providers) {
  const input = String(query || '').trim();
  if (!input) throw new UserError('Tell me a song name or a supported link.');
  const kind = linkKind(input);
  if (kind === 'youtube') throw new UserError(YOUTUBE_MESSAGE);
  if (kind === 'spotify' || kind === 'apple' || kind === 'deezer') {
    return resolveCatalog(input, requester, limit, providers, kind);
  }
  if (kind === 'soundcloud' || kind === 'bandcamp' || kind === 'twitch' || kind === 'vimeo' || kind === 'http') {
    return resolveDirect(input, requester, limit, providers);
  }
  const local = providers.get('local');
  if (local?.looksLikePath?.(input)) {
    if (!local.enabled()) throw new UserError('The local library is disabled.');
    let result;
    try {
      result = await local.resolveUrl(input, requester);
    } catch (error) {
      console.error(`[provider:local] ${error.message}`);
      throw new UserError(local.friendly(error));
    }
    if (!result.tracks.length) throw new UserError('That file is not in the local music library.');
    return { tracks: result.tracks, unmatched: 0, notice: null };
  }
  const tracks = (await providers.search(input, 1)).map((track) => attachRequester(track, requester));
  if (!tracks.length) throw new UserError(notFoundMessage(providers));
  return { tracks, unmatched: 0, notice: null };
}

module.exports = { resolveRequest, notFoundMessage };
