const { UserError } = require('../errors');
const { durationCompatible, isHttpUrl, isSoundCloudUrl, isSpotifyUrl, isYouTubeUrl, titlesMatch } = require('../providers/match');

function playbackNames(providers) {
  const names = providers.playbackProviders().map((provider) => provider.label);
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

function notFoundMessage(providers) {
  const names = playbackNames(providers);
  if (!names) {
    return 'No playback source is enabled. Add files to the music folder or configure SoundCloud.';
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

async function resolveSpotify(input, requester, limit, providers) {
  const spotify = providers.get('spotify');
  if (!spotify || !spotify.enabled()) {
    throw new UserError('Spotify is not configured. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.');
  }
  let metadata;
  try {
    metadata = await spotify.resolveMetadata(input);
  } catch (error) {
    console.error(`[provider:spotify] ${error.message}`);
    throw new UserError(spotify.friendly(error));
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
    tracks.push(attachRequester(match, requester, 'spotify'));
    if (match.pageUrl == null && item.pageUrl) tracks[tracks.length - 1].pageUrl = item.pageUrl;
  }
  if (!tracks.length) {
    const names = playbackNames(providers) || 'an authorized source';
    throw new UserError(`I couldn't find an authorized match for that Spotify link in ${names}. Nothing else was substituted.`);
  }
  const notes = [];
  if (unmatched) {
    notes.push(`${unmatched} Spotify track${unmatched === 1 ? '' : 's'} had no authorized match and ${unmatched === 1 ? 'was' : 'were'} skipped.`);
  }
  if (metadata.tracks.length > selected.length) {
    notes.push(`Only the first ${selected.length} tracks were checked.`);
  }
  return { tracks, unmatched, notice: notes.join(' ') || null };
}

async function resolveSoundCloud(input, requester, limit, providers) {
  const soundcloud = providers.get('soundcloud');
  if (!soundcloud || !soundcloud.enabled()) {
    throw new UserError('SoundCloud is not configured. Add SOUNDCLOUD_CLIENT_ID or remove it from the request.');
  }
  let result;
  try {
    result = await soundcloud.resolveUrl(input, requester, limit);
  } catch (error) {
    console.error(`[provider:soundcloud] ${error.message}`);
    throw new UserError(soundcloud.friendly(error));
  }
  if (!result.tracks.length) {
    throw new UserError('SoundCloud does not make that track available to stream.');
  }
  const notes = [];
  if (result.restricted) {
    notes.push(`${result.restricted} track${result.restricted === 1 ? '' : 's'} ${result.restricted === 1 ? 'is' : 'are'} not available to stream and ${result.restricted === 1 ? 'was' : 'were'} skipped.`);
  }
  if (result.truncated) notes.push(`Only the first ${limit} playable tracks were added.`);
  return {
    tracks: result.tracks.map((track) => attachRequester(track, requester)),
    unmatched: result.restricted,
    notice: notes.join(' ') || null,
  };
}

async function resolveRequest(query, requester, limit, providers) {
  const input = String(query || '').trim();
  if (!input) throw new UserError('Tell me a song name or a supported link.');
  if (isYouTubeUrl(input)) {
    throw new UserError('YouTube playback is not supported.');
  }
  if (isSpotifyUrl(input) || /^spotify:(track|album|playlist|episode):/i.test(input)) {
    return resolveSpotify(input, requester, limit, providers);
  }
  if (isSoundCloudUrl(input)) {
    return resolveSoundCloud(input, requester, limit, providers);
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
  if (isHttpUrl(input)) {
    throw new UserError('That link is not a supported source. Use a SoundCloud link, a Spotify link, or a song name.');
  }
  const tracks = (await providers.search(input, 1)).map((track) => attachRequester(track, requester));
  if (!tracks.length) throw new UserError(notFoundMessage(providers));
  return { tracks, unmatched: 0, notice: null };
}

module.exports = { resolveRequest, notFoundMessage };
