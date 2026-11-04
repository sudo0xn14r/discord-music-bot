const { UserError } = require('../errors');
const {
  durationCompatible,
  linkKind,
  titlesMatch,
} = require('../providers/match');
const { canonicalSoundCloudUrl } = require('../providers/soundcloud-link');

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
  const ready = provider && (typeof provider.canResolve === 'function' ? provider.canResolve() : provider.enabled());
  if (!ready) {
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
  let looseCount = 0;
  for (const item of selected) {
    const match = await providers.findMatch(item);
    const strict = match && titlesMatch(item, match) && durationCompatible(item.durationMs, match.durationMs);
    let chosen = strict ? match : null;
    if (!chosen) {
      if (match) console.error(`[resolver] rejected a weak match for "${item.title}"`);
      chosen = await providers.looseMatch(item);
    }
    if (!chosen) {
      unmatched += 1;
      continue;
    }
    const track = attachRequester(chosen, requester, providerName);
    if (!strict) {
      track.loose = true;
      looseCount += 1;
    }
    if (chosen.pageUrl == null && item.pageUrl) track.pageUrl = item.pageUrl;
    tracks.push(track);
  }
  if (!tracks.length) {
    const names = playbackNames(providers) || 'an authorized source';
    throw new UserError(`I couldn't find a match for that ${provider.label} link in ${names}. Nothing else was substituted.`);
  }
  const notes = [];
  if (looseCount > 1) {
    notes.push(`${looseCount} tracks used the top search result because there was no close match.`);
  }
  if (unmatched) {
    notes.push(`${unmatched} ${provider.label} track${unmatched === 1 ? '' : 's'} had no match and ${unmatched === 1 ? 'was' : 'were'} skipped.`);
  }
  if (metadata.tracks.length > selected.length) {
    notes.push(`Only the first ${selected.length} tracks were checked.`);
  }
  return { tracks, unmatched, notice: notes.join(' ') || null };
}

async function resolveSoundCloud(input, requester, limit, providers) {
  let page;
  try {
    page = await canonicalSoundCloudUrl(input);
  } catch (error) {
    throw new UserError(error.userError ? error.message : 'That SoundCloud link could not be opened.');
  }
  const lavalink = providers.get('lavalink');
  const official = providers.get('soundcloud');
  if (lavalink?.enabled()) {
    try {
      return await resolveDirect(page, requester, limit, providers);
    } catch (error) {
      if (!official?.enabled()) {
        if (error instanceof UserError && /could not be played|did not have playable/.test(error.message)) {
          throw new UserError('That SoundCloud link could not be played.');
        }
        throw error;
      }
    }
  }
  if (!official?.enabled()) {
    throw new UserError('SoundCloud playback is disabled. Leave lavalink in PROVIDER_ORDER.');
  }
  let result;
  try {
    result = await official.resolveUrl(page, requester, limit);
  } catch (error) {
    console.error(`[provider:soundcloud] ${error.message}`);
    throw new UserError(official.friendly(error));
  }
  const notes = [];
  if (result.truncated) notes.push(`Only the first ${limit} tracks were added.`);
  if (result.restricted) {
    notes.push(`${result.restricted} SoundCloud track${result.restricted === 1 ? '' : 's'} could not be streamed and ${result.restricted === 1 ? 'was' : 'were'} skipped.`);
  }
  return {
    tracks: result.tracks.map((track) => attachRequester(track, requester)),
    unmatched: 0,
    notice: notes.join(' ') || null,
  };
}

async function resolveDirect(input, requester, limit, providers, providerName = 'lavalink') {
  const source = providers.get(providerName);
  if (!source || !source.enabled()) {
    const message = providerName === 'youtube'
      ? 'YouTube is disabled. Add youtube to PROVIDER_ORDER.'
      : 'Direct playback is disabled. Add lavalink to PROVIDER_ORDER.';
    throw new UserError(message);
  }
  let result;
  try {
    result = await source.resolveUrl(input, requester, limit);
  } catch (error) {
    console.error(`[provider:${providerName}] ${error.message}`);
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
  if (kind === 'spotify' || kind === 'apple' || kind === 'deezer') {
    return resolveCatalog(input, requester, limit, providers, kind);
  }
  if (kind === 'youtube') {
    return resolveDirect(input, requester, limit, providers, 'youtube');
  }
  if (kind === 'soundcloud') {
    return resolveSoundCloud(input, requester, limit, providers);
  }
  if (kind === 'bandcamp' || kind === 'twitch' || kind === 'vimeo' || kind === 'http') {
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
  let tracks = (await providers.search(input, 1)).map((track) => attachRequester(track, requester));
  if (tracks.length) return { tracks, unmatched: 0, notice: null };
  tracks = (await providers.searchLoose(input, 1)).map((track) => {
    const loose = attachRequester(track, requester);
    loose.loose = true;
    return loose;
  });
  if (!tracks.length) throw new UserError(notFoundMessage(providers));
  return {
    tracks,
    unmatched: 0,
    notice: 'Played the top result. It may not be an exact match.',
  };
}

module.exports = { resolveRequest, notFoundMessage };
