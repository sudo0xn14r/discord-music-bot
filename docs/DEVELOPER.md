# Developer guide

This document is for someone who has to change, debug, or operate the bot. It describes the code as it is. Setup commands, systemd units, and the invite URL are in the root `README.md`.

The project is a single Node.js process (`src/index.js`) plus a separate Lavalink process. Discord is the user interface. Lavalink is the only thing that decodes audio and sends it to a voice channel. Spotify, Apple Music, and Deezer are metadata catalogs. Their audio is never requested.

## Design rules the code enforces

These are product rules, not suggestions. Tests in `test/` lock most of them.

- YouTube plays through Lavalink's youtube-source plugin. There is no yt-dlp step and no browser cookies. The deprecated built-in YouTube source stays off.
- A text search or a catalog link prefers a title and artist match whose duration is in range. If every strict provider misses, and YouTube is enabled, the top `ytsearch` result plays. The reply says it may not be an exact match. Local files are never used as that loose fallback.
- Spotify, Apple Music, and Deezer never appear in the playback provider list, even if someone puts them in `PROVIDER_ORDER`.
- One Discord guild has one queue, one voice connection, and one Lavalink player. Guilds do not share those.
- The queue holds at most 50 upcoming tracks. Saved playlists store a file path or a source address, not an expiring stream URL.
- Playback mutations for one guild run one at a time on a promise chain. A second `/skip` waits for the first.
- Stream URLs must be public HTTP(S). Local files must resolve inside `LOCAL_MUSIC_DIR`.
- User-controlled text is stripped of newlines and Discord markdown before it is sent. `allowedMentions.parse` is empty on every reply.

## Repository map

```
src/index.js                 process entry, command registration, shutdown
src/config/index.js          environment parsing
src/db.js                    SQLite schema and queries (node:sqlite)
src/errors.js                UserError, shown to the user instead of a generic failure
src/format.js                titles, durations, truncated errors
src/panel.js                 now-playing embed, control buttons, queue pages
src/commands/index.js        slash command definitions and handlers
src/events/interactions.js   InteractionCreate router and error replies
src/lavalink/client.js       Shoukaku node client
src/lavalink/events.js       player end, stuck, exception, start, update
src/lavalink/health.js       30s node check, uptime ping, owner DM
src/music/manager.js         one GuildSession per guild, restore, idle leave
src/music/player.js          GuildSession: join, play, skip, persist, panel
src/music/queue.js           in-memory current, upcoming, history, loop
src/music/playlist.js        rebuild saved playlist rows into tracks
src/music/resolver.js        query string to playable tracks
src/music/track.js           createTrack, the only track shape
src/providers/provider-manager.js
src/providers/match.js       URL classification and title matching
src/providers/local-library.js
src/providers/soundcloud.js  official SoundCloud API
src/providers/youtube.js          ytsearch and YouTube URLs, subclass of LavalinkSource
src/providers/lavalink-source.js
src/providers/spotify.js
src/providers/apple.js
src/providers/deezer.js
src/util/http.js             fetch, retries, public-URL checks
src/util/retry.js
src/util/log.js              one JSON object per line
lavalink/application.yml     Lavalink 4 config and plugins
test/                        node:test, no network
```

Dependencies are only `discord.js` 14, `shoukaku` 4, and `dotenv`. SQLite comes from `node:sqlite` (`DatabaseSync`), which needs Node.js 22.13 or newer. Java 17 or newer runs Lavalink. The jar is not in git. `lavalink/application.yml` downloads LavaSrc 4.8.3 and the soundy plugin 1.1.0 on first start.

## Processes

```
Discord gateway
      |
      v
Node bot (src/index.js)
      |  Shoukaku WebSocket + REST, password auth
      v
Lavalink on 127.0.0.1:2333
      |
      +-- local files (absolute path from the bot)
      +-- SoundCloud / Bandcamp / Twitch / Vimeo / public HTTP
            via the soundy plugin and Lavalink's HTTP source
```

Lavalink does not choose policy. The bot decides what identifier to hand it. Lavalink's built-in YouTube and SoundCloud sources are off in `application.yml`. YouTube is played by youtube-source snapshot `2be8e542d3f6f178e048dca565892684c2e40177` (`ytsearch:` and YouTube URLs). Release 1.18.2 is rejected with "The page needs to be reloaded." The plugin sends scrambled stream addresses to `https://cipher.kikkia.dev/` because it cannot extract the signature function from the current player script. SoundCloud search and SoundCloud links are played by the soundy plugin (`scsearch` and SoundCloud URLs, no account). Bandcamp, Twitch, Vimeo, HTTP, and local stay on as Lavalink built-ins.

The plugin config enables search, direct video ids, and direct playlist ids. Clients are tried in order: `MUSIC`, `TV`, `ANDROID_VR`, `WEB`, `WEBEMBEDDED`. `MUSIC` does not play audio. It covers YouTube Music search. `TV` is the client that uses a YouTube sign-in. The others can play without one. `youtubePlaylistLoadLimit` is 50, which the plugin still reads, so a pasted playlist can fill the queue. `youtubeSearchEnabled` stays false because that flag belongs to the built-in source.

OAuth is off. A refresh token or a poToken is only needed when YouTube answers with "sign in to confirm you're not a bot". The commented `oauth.refreshToken` and `pot` blocks in `application.yml` read `YOUTUBE_REFRESH_TOKEN`, `YOUTUBE_POTOKEN`, and `YOUTUBE_VISITOR_DATA` from the environment. Use a burner account. Do not enable OAuth and a poToken together.

LavaSrc is configured with Spotify credentials and `sources.spotify: true`, and with Apple Music, Deezer, YouTube, and yt-dlp off. `sources.youtube: false` is LavaSrc's own YouTube mirror, which is separate from the youtube plugin and stays off. LavaSrc's provider list is `ytsearch:%QUERY%`, then `scsearch:%QUERY%`. The bot does not send Spotify, Apple, or Deezer URLs to Lavalink. It reads metadata itself and then searches YouTube, the local library, or SoundCloud. LavaSrc's album and playlist load limits are 1, so do not assume Lavalink will expand a Spotify playlist if a URL is ever passed through.

The bot joins voice deafened (`deaf: true`). It asks Discord only for the Guilds and Guild Voice States intents.

### Boot order

`src/index.js` does this in order:

1. Load `.env` from the repo root.
2. `loadConfig()`. Missing `DISCORD_TOKEN` or `LAVALINK_PASSWORD` exits the process.
3. Open SQLite and `mkdir` the local music directory.
4. Create the Discord client, the Shoukaku client, `ProviderManager`, and `MusicManager`.
5. Attach the interaction listener and the 30-second health timer.
6. `client.login`.

Two independent events can restore playback:

- `lavalink` `ready`
- Discord `ClientReady`

`MusicManager.restoreAll` runs only when both the Discord client is ready and `getIdealNode()` returns a node. The first successful call stores `restorePromise`, so the second event does not restore twice. A failed restore clears that promise so a later `ready` can try again.

On `ClientReady` the process also logs each provider's `status()` line, starts the idle watcher, and registers slash commands. Registration failure is logged. The bot stays online.

Command scope:

- `GUILD_ID` set: `PUT` guild commands. They show up immediately, and only in that guild.
- `GUILD_ID` empty: `PUT` global commands. Discord can take up to an hour.

There is one Lavalink node, named `main`. Shoukaku options in `src/lavalink/client.js`:

| Option | Value | Effect |
| --- | --- | --- |
| `resume` | true | Ask Lavalink to keep the session |
| `resumeTimeout` | 60 | Seconds Lavalink holds the session |
| `resumeByLibrary` | true | Shoukaku resumes instead of the app doing it by hand |
| `reconnectTries` | infinity | Keep retrying the node |
| `reconnectInterval` | 5 | Seconds between tries |
| `restTimeout` | 15 | REST call timeout |
| `voiceConnectionTimeout` | 15 | Voice connect timeout |
| `moveOnDisconnect` | false | Do not migrate players; there is no second node |

`SIGINT` and `SIGTERM` run `shutdown`: stop the idle timer, stop health checks, `music.shutdown()` (persist, then leave voice), close the database, destroy the Discord client, exit 0. A 5 second timer exits anyway if that hangs. A second signal is ignored.

`unhandledRejection` and `uncaughtException` are logged and do not exit.

## Configuration

`src/config/index.js` reads the environment. Quoted values are unwrapped. Unknown keys are ignored.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | yes | | Process exits if empty |
| `LAVALINK_PASSWORD` | yes | `changeme` in the example | Must equal `lavalink.server.password` |
| `GUILD_ID` | no | empty | 17 to 20 digits, or empty |
| `OWNER_ID` | no | empty | User id for Lavalink-down DMs |
| `LAVALINK_HOST` | no | `127.0.0.1` | |
| `LAVALINK_PORT` | no | `2333` | Integer 1–65535 |
| `LAVALINK_SECURE` | no | false | `true` switches Shoukaku to TLS |
| `PROVIDER_ORDER` | no | `youtube,local,soundcloud,lavalink` | Comma-separated, lowercased |
| `LOCAL_MUSIC_DIR` | no | `music` | Resolved from the repo root |
| `DATABASE_PATH` | no | `data/bot.sqlite` | Resolved from the repo root |
| `IDLE_MINUTES` | no | `10` | `0` disables auto-leave |
| `PLAY_GIF_URL` | no | Among Us Klipy GIF | Direct http(s) GIF posted when `/play`, `/k2`, or `/playnow` starts a song. The page `https://klipy.com/gifs/amongla-among-us-2` is not used; the file URL is. |
| `UPTIME_URL` | no | empty | GET every 30 seconds |
| `SOUNDCLOUD_CLIENT_ID` | no | empty | Official API stays off without it |
| `SOUNDCLOUD_CLIENT_SECRET` | no | empty | Used only to refresh the OAuth token |
| `SPOTIFY_CLIENT_ID` | no | empty | Both Spotify values are required |
| `SPOTIFY_CLIENT_SECRET` | no | empty | Also read by Lavalink if its unit loads `.env` |

`spotify`, `apple`, and `deezer` in `PROVIDER_ORDER` log a warning and are removed from the playback order. Any other unknown name logs a warning and is skipped. Apple Music and Deezer metadata do not use keys. They are always "enabled" as catalogs. Spotify metadata turns on only when both Spotify variables are set. YouTube does not need a key. Remove `youtube` from `PROVIDER_ORDER` to disable it.

Startup prints one `[provider]` line per provider from `ProviderManager.describe()`.

## Discord surface

Every command is guild-only (`InteractionContextType.Guild`). Handlers live in `src/commands/index.js`. `src/events/interactions.js` dispatches chat input commands by name and buttons whose `customId` starts with `player:` or `queue:`.

The user must be in a voice channel. If the bot is already in one, the user must be in that same channel. `/history`, `/stats`, `/playlist list`, `/playlist delete`, and `/djrole` do not require voice. `/volume` requires voice only when the bot is already connected.

### Who can do what

`/djrole` stores an optional role id on the guild. It requires Manage Server. With no role stored, anyone in the voice channel can use every control.

With a role stored:

| Anyone in the voice channel | DJ role or Manage Server |
| --- | --- |
| `/play`, `/k2`, `/pause`, `/resume`, `/skip`, `/queue`, `/nowplaying`, `/history`, `/stats`, playlist save/load/list/delete | `/playnow`, `/stop`, `/clear`, `/leave`, `/volume`, `/seek`, `/loop`, `/shuffle`, `/move`, `/remove`, `/filter` |
| Buttons Pause/Resume, Skip, Previous, queue pages | Buttons Stop, Loop, Shuffle |

`/djrole` itself stays Manage Server only, role or not.

### Commands

| Command | Behavior |
| --- | --- |
| `/play query` | Resolve a song name or a YouTube, SoundCloud, Bandcamp, Spotify, Apple, or Deezer link. Join, append. Starts playback only if nothing is current. |
| `/playnow query` | DJ. Insert at the front, stop the current track, start the new one. The rest of the queue is kept, trimmed to 50. |
| `/pause`, `/resume` | `setPaused` on the Lavalink player. |
| `/skip` | Stop, advance, edit the panel. |
| `/stop` | DJ. Clear queue, memory history, and loop. Leave voice. |
| `/leave` | DJ. Same path as stop, different reply text. |
| `/clear` | DJ. Drop upcoming tracks. Current keeps playing. |
| `/queue` | Text pages of 10. Buttons `queue:N`. |
| `/nowplaying` | Post a new panel and remember it. |
| `/volume level` | Integer 0–150. Stored in `guild_settings` even with no player. Applied with `setGlobalVolume` when connected. |
| `/seek position` | Seconds (`90`) or `m:ss` or `h:mm:ss`. |
| `/loop mode` | `off`, `track`, or `queue`. |
| `/shuffle` | Fisher–Yates on upcoming. Needs at least two. |
| `/move from to` | 1-based positions in the upcoming list. |
| `/remove position` | 1-based. |
| `/filter name` | `off`, `bassboost`, or `nightcore`. |
| `/playlist save\|load\|list\|delete` | Per-guild names, case-insensitive, 1–40 characters. |
| `/history` | Last 10 rows from SQLite for this guild. |
| `/stats` | Play counts and listened time for this guild: overall, top 5 songs, top 5 requesters. |
| `/djrole role` | Set or clear. Empty role clears. Reply is ephemeral. |

`/play`, `/k2`, and `/playlist load` defer, then edit. `/k2` calls the same handler as `/play`. The resulting message becomes the panel (`notePanel`). When the command starts playback, a follow-up message contains the play GIF so Discord can animate it. The default is the direct file for the Klipy Among Us GIF. `PLAY_GIF_URL` replaces that default. Queuing behind a current song does not post the GIF. Other successful commands that change playback either edit that panel (`refreshPanel`) or reply with a fresh one. The panel edit does not include the GIF, so later button updates do not remove it.

Errors:

- `UserError` (or any error with `userError: true`) is sent as its message.
- Anything else becomes `Something went wrong running that command.` and the stack is logged.
- Before a public reply, the error is ephemeral. After `deferReply`, it is an edit of the public reply.
- Button errors are always ephemeral follow-ups or replies.

`query` is at most 500 characters.

## How a query becomes tracks

`resolveRequest` in `src/music/resolver.js` is the only entry. `linkKind` in `src/providers/match.js` classifies the string.

```
query
  |-- empty                         UserError
  |-- youtube host or youtu.be      YoutubeProvider resolve of that URL
  |-- spotify URL or spotify: URI   catalog provider, then findMatch, then YouTube top hit
  |-- music.apple.com               catalog provider, then findMatch, then YouTube top hit
  |-- deezer.com                    catalog provider, then findMatch, then YouTube top hit
  |-- soundcloud.com                Lavalink resolve of that URL
  |-- *.bandcamp.com                Lavalink resolve of that URL
  |-- twitch.tv                     Lavalink resolve of that URL
  |-- vimeo.com                     Lavalink resolve of that URL
  |-- any other http(s) URL         Lavalink resolve, after a public-host check
  |-- path, file://, or audio ext   local library only, must be inside the music dir
  |-- anything else                 strict search, then YouTube top hit
```

YouTube hosts are `youtube.com`, `youtu.be`, `music.youtube.com`, `m.youtube.com`, and `youtube-nocookie.com`. Those URLs go to `YoutubeProvider.resolveUrl`, which asks Lavalink to load the URL. The track `source` is `youtube`, not `lavalink`. If `youtube` is missing from `PROVIDER_ORDER`, the command errors and tells the user to add it.

Direct SoundCloud, Bandcamp, Twitch, Vimeo, and other http(s) links do not use the official SoundCloud provider. `SoundCloudProvider.resolveUrl` exists, but the resolver always sends those URLs to `LavalinkSource`. Official SoundCloud is used for text search and for catalog matching.

The `limit` passed in is the number of free queue slots for `/play`, or 50 for `/playnow`. Catalog and playlist expansion stop at that limit. A notice is attached when tracks were skipped for lack of a match or because the list was longer than the limit.

### Catalog matching

`resolveCatalog` loads metadata, refuses Spotify episodes, then for each item calls `ProviderManager.findMatch`. A candidate is kept only when all of these hold:

- `titlesMatch` (normalized title contains the wanted title, and artist strings overlap)
- `durationCompatible` (see below)
- the match came back non-null

`matchedFrom` is set to `spotify`, `apple`, or `deezer`. Playback `source` stays `youtube`, `local`, `soundcloud`, or `lavalink`. If the playable track has no `pageUrl`, the catalog URL is copied onto it for display and history. A strict miss then calls `ProviderManager.looseMatch`, which plays the top YouTube search result and sets `loose` on the track. The reply says how many tracks used that fallback. If YouTube is disabled, or it returns nothing, and every item missed, the command errors and names the playback sources. Nothing in the local library is substituted just because it was the next file.

Apple Music playlists are rejected by `AppleProvider`. Songs and albums use the public iTunes lookup. An album URL with `?i=<trackId>` resolves as that single song. Deezer accepts track, album, and playlist ids from the public API. Spotify accepts track, album, and playlist (URL or `spotify:` URI) through client-credentials on `api.spotify.com`, and pages until 50 tracks.

### Text search

`ProviderManager.search` walks `playbackProviders()` in `PROVIDER_ORDER`. For each enabled and `available()` provider it calls `search`, then keeps only results that pass `queryMatches`. The first provider that returns at least one match wins. Later providers are not asked. A thrown error is logged and the walk continues. If that walk is empty, `searchLoose` asks the first playback provider with `allowsLooseMatch` (only YouTube) for `topResults` and returns that hit without `queryMatches`. The resolver marks the track `loose` and sets a notice. An empty loose result becomes `UserError` from `notFoundMessage`.

`queryMatches` has two shapes:

- `Artist - Title` (split on ` - `) uses `titlesMatch`.
- Otherwise every token of length 2 or more must appear in the normalized title plus artist, and the title itself must contain a token of length 3 or more, or at least two tokens.

Normalization lowercases, strips parenthetical and bracketed text, drops the words official, audio, video, lyrics, lyric, visualizer, hd, mv, and topic, then keeps letters and digits.

`durationCompatible`: if either duration is missing, zero, or negative, the check passes. Otherwise the found duration must be at least 60 percent of the wanted duration and at most 3 times it. That rejects previews and hour-long uploads of a 4 minute song.

`pickBestMatch` filters with both checks, then prefers an exact normalized title, then the smallest duration delta.

### Local path queries

`LocalLibrary.looksLikePath` is true for `file://`, absolute paths, `./` and `../`, and a basename whose extension is mp3, flac, ogg, opus, wav, m4a, or aac. The file must `realpath` to a regular file inside the music directory's real path. Symlinks that escape the directory fail `owns`. Dotfiles and dot-directories are skipped while cataloging. Files are described as `Artist - Title` when the basename contains ` - `, otherwise the whole basename is the title and the artist is empty.

## Providers

`ProviderManager` constructs seven objects. Playback providers are the subset of `youtube`, `local`, `soundcloud`, and `lavalink` that appear in `PROVIDER_ORDER` and whose `enabled()` is true. Default order tries YouTube first, so a strict YouTube hit wins over a local file of the same song. A local file still wins over an unrelated YouTube hit, because the loose fallback runs only after every strict search misses.

A playback provider is expected to implement:

| Method | Returns |
| --- | --- |
| `enabled()` | Config says it may be used |
| `available()` | It can be called right now |
| `status()` | One short startup line |
| `search(query, limit)` | Tracks that might match |
| `findMatch(metadata)` | Best track or null |
| `playbackIdentifier(track)` | String Lavalink can resolve |
| `friendly(error)` | Sentence for a `UserError` |

`canPlay` is false on Spotify, Apple, and Deezer. `playbackIdentifier` on those throws "That track has no playable source."

### youtube

`YoutubeProvider` extends `LavalinkSource`. Enabled when `youtube` is in `PROVIDER_ORDER`. `searchPrefix` is `ytsearch:`. `allowsLooseMatch` is true, so this is the only provider `searchLoose` will ask. `source` on every track it builds is `youtube`. A search result keeps Lavalink's encoded track and plays that directly. If Lavalink cannot open a watch page, the provider looks the video id up through `ytsearch` and plays that result instead of a different video. The watch URL is resolved again only when that encoded value is missing, which is what a saved playlist has after a restart.

### local

Enabled when `local` is in `PROVIDER_ORDER`. `available` checks that the directory exists. Search walks the tree on every call. There is no index.

`playbackIdentifier` returns `fs.realpathSync` of the file. `GuildSession.playCurrent` then calls Lavalink `rest.resolve` on that absolute path. Lavalink's local source must be able to read the file, so the bot and Lavalink run on the same machine. The path is absolute, so Lavalink's working directory does not have to be the repo for local files. The README still starts Lavalink from the repo root because that is how `application.yml` and plugin paths are resolved.

### soundcloud (official API)

Enabled when `soundcloud` is in `PROVIDER_ORDER` and `SOUNDCLOUD_CLIENT_ID` is set. Without the secret, requests send `client_id` as a query parameter. With the secret, the provider posts client-credentials to `https://secure.soundcloud.com/oauth/token`, caches the token, and refreshes it 60 seconds before expiry. A 401 clears the token and retries once.

Search and match call `GET /tracks` with `access=playable` and `limit=8`. A track is playable when it has an id and title, access is not `blocked` or `preview`, `streamable` is not false, and either there is no transcoding list or there is a non-snipped progressive transcoding. HLS-only tracks that list transcodings but have no progressive entry are rejected.

`playbackIdentifier` re-fetches the track and returns a public HTTPS stream URL from `resolveAudioUrl`. That function follows up to five redirects. A JSON or JavaScript body must contain a `url` string. The final URL has to be HTTPS and public. `client_id`, `client_secret`, and `access_token` query parameters are stripped before the URL is returned. Lavalink's HTTP source then fetches that URL. Seeking a SoundCloud track can fail. Local files still seek.

This provider's `resolveUrl` (`GET /resolve`) is not on the slash-command path. Direct SoundCloud links go to Lavalink.

### lavalink

Enabled when `lavalink` is in `PROVIDER_ORDER`. `available` also requires a connected node. The user-facing label is `SoundCloud`, because text search uses `scsearch:`. The same object also loads Bandcamp, Twitch, Vimeo, and public HTTP URLs.

`resolveUrl` canonicalizes the URL (`m.soundcloud.com` becomes `soundcloud.com`), rejects non-public hosts, and maps Lavalink load types:

| `loadType` | Result |
| --- | --- |
| `track` | One track |
| `playlist` or `search` | Up to `limit` tracks that have an identifier |
| `empty` or `error` | UserError |
| anything else with no tracks | UserError |

`playbackIdentifier` returns that same canonical URL. `playCurrent` resolves it again at play time, so a saved playlist does not depend on an encoded Lavalink track blob.

Search and `findMatch` use `scsearch:<query>`. Results still pass `queryMatches` or `pickBestMatch`.

### Playback identifier by source

`playCurrent` always does `node.rest.resolve(identifier)` and requires `loadType === 'track'`. It plays `response.data.encoded`.

| `track.source` | Identifier handed to Lavalink |
| --- | --- |
| `youtube` | Public YouTube URL resolved again by the youtube plugin |
| `local` | Absolute real path inside the music directory |
| `soundcloud` | Fresh public HTTPS stream URL from the official API |
| `lavalink` | Canonical public page or stream URL |

## Track shape

`createTrack` in `src/music/track.js` is the only constructor. Fields:

| Field | Role |
| --- | --- |
| `title`, `artist` | Display and matching. Truncated to 300 characters. |
| `album` | Optional. Stored on playlists. Not shown on the panel. |
| `durationMs` | Integer milliseconds, or null. Live tracks format as `live`. |
| `source` | `youtube`, `local`, `soundcloud`, or `lavalink` for anything that can play. |
| `requester` | Display name at queue time. |
| `pageUrl` | Human link. May be the catalog URL when the playable source has none. |
| `filePath` | Local files only. |
| `soundcloudId` | Official API tracks only. |
| `identifier` | Lavalink tracks. The URL to resolve again later. |
| `matchedFrom` | `spotify`, `apple`, `deezer`, or null. Drives the "matched metadata" sentence. |
| `loose` | True when this track is a top search result rather than a close match. Not a database column. It rides along in the playback JSON. |

Do not put a short-lived CDN URL in `identifier` or `pageUrl` if the track will be saved. Playlist load and resume call `playbackIdentifier` again.

## Session and queue

`MusicManager.session(guildId)` creates a `GuildSession` on first use and keeps it for the life of the process. `peek` does not create one.

`GuildQueue` (`src/music/queue.js`):

- `current` is the track Lavalink was asked to play.
- `upcoming` is what `/queue` shows. Cap `MAX_QUEUE` is 50.
- `history` is an in-memory stack of at most 25 tracks, used only by Previous. It is not the SQLite history table.
- `loopMode` is `off`, `track`, or `queue`.
- `volume` starts at 100, or at the stored guild volume.
- `rememberCurrent` is set false when a shift should not push `current` onto the previous stack (failed tracks, queue-loop rotation, previous).

`enqueue` appends until the cap and reports how many were skipped. `placeNow` puts the new tracks in front and keeps as much of the old upcoming list as fits in 50.

`shiftNext` pops upcoming into `current`. If `rememberCurrent` and there was a current track, that track is pushed onto `history`.

`previous` pops history, pushes the old current onto upcoming, pushes the prior track in front of that, caps at 50, and sets `rememberCurrent` false. The caller then `shiftNext`s, so the prior track becomes current and is not immediately written back into history.

`reset` clears current, upcoming, history, and loop. It does not change volume. Stop and leave call it.

### The command lock

Every mutating method on `GuildSession` except `clearUpcoming` goes through `enqueue`. That is a promise tail: the next task starts when the previous one settles, and `persist()` runs in a `finally` unless `skipPersist` is set. Do not call `playCurrent`, `shiftNext`, or `stopTrack` from a new command path without going through this tail. Lavalink events use the same tail (`session.enqueue` in `src/lavalink/events.js`).

`generation` is a counter. `playCurrent` returns `{ dropped: true }` as soon as `generation` changes or `leaving` is set. Skip, previous, play-now, stop, leave, and a track-loop restart increment it. That drops a `playCurrent` loop that is still walking failed tracks.

`playGeneration` is the generation that the in-flight `playTrack` belongs to, or `-1` when nothing should react to `end`. The `end` handler captures it before queueing work. If skip already bumped the generation, the late `end` is ignored. `starting` is true only around `playTrack`, and `end` returns immediately while it is true so the start itself cannot advance the queue.

### playCurrent

The loop keeps going while `queue.current` is set and fewer than 3 consecutive failures have happened (`MAX_CONSECUTIVE_FAILURES`).

1. Ask the provider for an identifier. A throw drops this track and tries the next. The skip reason is the provider's `friendly` message when it has one.
2. `rest.resolve`. A thrown REST error puts the track back at the front of upcoming and returns failure. The track is not dropped, because the node may only be briefly down.
3. `loadType !== 'track'` counts as a failure, drops the track, and tries the next. The user sees "that audio is unavailable".
4. `playTrack` with the encoded track and the guild volume. On success, `restorePlaybackOptions` seeks, reapplies the filter, and pauses if this call was a resume of a paused session.
5. A throw from `playTrack` drops the track and tries the next.

After 3 failures, if a current track remains, it is put back at the front and the reason is "Several tracks failed in a row, so playback stopped."

`add`:

- If the queue was idle, or this is play-now, it increments `generation`, optionally `stopTrack`s, `shiftNext`s, and `playCurrent`s.
- If something is already playing and this is a normal add, it only appends. Nothing is sent to Lavalink until the current track ends.

### When a track ends

`player.on('end')` ignores every reason except `finished` and `loadFailed`.

- `finished` and loop mode `track`: increment `generation` and play the same current track again.
- `finished` and loop mode `queue`: append current to upcoming, set `rememberCurrent` false, then `shiftNext` and play.
- `loadFailed`: log it, `shiftNext`, play the next one.
- Otherwise: `shiftNext` and play.

`stuck` stops the player, increments `generation`, drops the current track without recording it as previous, and plays the next. The panel text says the track got stuck.

`exception` only logs. The following `end` with `loadFailed` is what advances.

`start` records SQLite history for `queue.current`, copies Lavalink's track length onto `durationMs` when it is a positive number, and sets `positionMs` from a pending seek.

`update` stores the position. `notePosition` writes SQLite at most once every 15 seconds.

`closed` logs the voice close code. It does not leave or clear the queue by itself.

### Filters

`bassboost` clears filters and sets equalizer bands 0–4 to gains 0.2, 0.15, 0.1, 0.05, 0. Volume is reapplied because clearing filters can reset it. `nightcore` sets timescale speed 1.2, pitch 1.2, rate 1. `off` only clears. The name is stored on the session and in the playback row, and it is applied again after every successful `playTrack` and after restore.

Lavalink must have the `equalizer`, `timescale`, and `volume` filters enabled. They are on in `application.yml`. Karaoke, tremolo, vibrato, distortion, rotation, channel mix, and low pass are off. Adding a filter name in the slash command without enabling the Lavalink filter does nothing useful.

### Idle

Every 30 seconds, for each session that has a `channelId` and is not `leaving`:

- Not idle: clear `idleSince`.
- Idle and no timestamp yet: set `idleSince`.
- Idle for at least `IDLE_MINUTES`: `leave()`, then a message in the session text channel: `I left the voice channel after N minutes with nothing playing.`

Idle means the voice channel has no human members, or the queue is empty (no current and no upcoming). A paused song still has a current track, so the bot stays. If the channel is not in the Discord cache, `voiceChannelEmpty` returns null and only an empty queue counts. Bots in the channel do not count as listeners. `IDLE_MINUTES=0` never starts the timer. The check runs every 30 seconds, so the leave can be up to 30 seconds later than the limit.

## Panel

`playerMessage` builds one embed and, when something is queued or playing, two button rows.

The embed title is `Playing` or `Paused` plus the title. The description is artist, a 16-cell progress bar, loop mode, filter name if not `off`, and the next three upcoming titles. Footer is the requester. Color is `0x1f6feb`.

Buttons: Pause or Resume, Skip, Loop, Shuffle, Stop, and Previous. Previous is disabled when the in-memory history stack is empty. Shuffle is disabled below two upcoming tracks. An empty player removes the components.

`session.panel` remembers one channel id and message id. `refreshPanel` fetches and edits it. The first edit failure is logged. Later failures are not, so a deleted panel does not spam. The next `/play`, `/skip`, or `/nowplaying` points the panel at a new message.

`/queue` is a separate message. It is not the panel. Page buttons update that message only.

## Persistence

Database file default is `data/bot.sqlite`. `openDatabase(':memory:')` is what tests use. Foreign keys are on. `ensureColumn` adds `dj_role_id` and `playlist_tracks.identifier` on old files.

### guild_settings

| Column | Meaning |
| --- | --- |
| `guild_id` | Primary key |
| `volume` | 0–150, default 100 |
| `text_channel_id` | Last channel that issued a command |
| `dj_role_id` | Nullable |

Volume, DJ role, and text channel are written immediately, not only in the playback snapshot.

### playback

One row per guild. Written at the end of each queued task, on the 15 second position tick, and once at the start of shutdown before voice disconnect.

| Column | Meaning |
| --- | --- |
| `channel_id` | Voice channel to rejoin |
| `text_channel_id` | Where the panel lived |
| `position_ms` | Last player update |
| `paused` | 0 or 1 |
| `loop_mode` | `off`, `track`, `queue` |
| `volume` | Copy of the session volume |
| `filter_name` | `off`, `bassboost`, `nightcore` |
| `current_json` | `createTrack` object, or null |
| `upcoming_json` | Array of track objects |
| `updated_at` | `Date.now()` |

The row is deleted when there is no voice channel or both current and upcoming are empty. Restore skips and deletes a row with no voice channel or no tracks. It also deletes the row if the guild can no longer be fetched.

Restore joins the saved voice channel, then `playCurrent` with `seekMs` and `pauseAfter`. `skipPersist` is set around the whole restore so the empty session is not written before the queue is filled. Unknown loop modes become `off`. Unknown filters become `off`. Volume is clamped to 0–150.

Shutdown sets `skipPersist`, calls `persist()` while the queue is still intact, then leaves voice. The tail's automatic persist is suppressed, so the row survives the disconnect and the next boot resumes. Stop and leave from a user do the opposite: they clear the queue and the row.

In-memory Previous history is not stored. After a restart, Previous is empty until new tracks finish. Loop mode, filter, pause, and position are stored.

### playlists

`playlists` is unique on `(guild_id, name)`. Lookup is `COLLATE NOCASE`. Save replaces tracks in a transaction. Delete cascades to `playlist_tracks`.

Stored per track: title, artist, album, duration, source, page URL, file path, SoundCloud id, identifier, position. Load rebuilds tracks in `tracksFromPlaylist`. It accepts `local`, `soundcloud`, `lavalink`, and `youtube`. Anything else is skipped. Local rows whose file is no longer inside the library are skipped. YouTube and Lavalink rows need `identifier` or `pageUrl`, and the matching provider has to be enabled. A disabled provider skips its rows. The reply says how many could not be loaded.

### history

Append-only play log, not the Previous stack. Inserted on Lavalink `start`. Each guild keeps the newest 100 rows. `/history` shows 10. Columns: title, artist, source, page URL, requester, `played_at`.

### listens

One row per time playback starts. `/stats` reads this table, not `history`, so the totals are not cut off at 100. `song_key` is the lowercased title and artist, so the same song groups together. `requester_id` is the Discord user id stamped when someone uses `/play`, `/playnow`, or `/playlist load`. Older rows without an id use `name:` plus the display name.

`played_ms` is how far playback reached, not wall-clock time. A pause does not add time. A track that plays from the start through `finished` stores its duration. A skip stores the position reached. The row is updated at most every 15 seconds with the position, and closed on skip, stop, leave, shutdown, or the Lavalink `end` event. `/stats` shows the server total, the top 5 songs, and the top 5 listeners, each with a play count and listened time.

## Health

`startHealth` every 30 seconds:

1. GET `UPTIME_URL` if set, 10 second timeout. Non-200 is logged. The URL is not logged.
2. If `getIdealNode()` is null, log once per transition to `down` and DM the owner.
3. Otherwise `node.rest.getLavalinkInfo()`. Success logs once per transition to `up`. Failure logs and DMs once per transition to `unhealthy`.

Owner DMs are at most one per hour, and only when `OWNER_ID` is set and the Discord client is ready. A failed DM is logged.

## Errors and logs

`UserError` is the type for mistakes the user can act on: wrong channel, empty queue, bad seek syntax, missing playlist. Throw it from command code and from providers (`error.userError = true` is also honored, because some provider errors are plain `Error` objects).

`friendlyProviderError` maps HTTP status to a sentence: 401/403 credentials, 404 unavailable, 429 rate limit, anything else "could not be reached". Timeouts from `fetchJson` use status 0 and fall through to the generic sentence.

`fetchJson` retries up to 3 times with delays 400ms and 800ms. It does not retry 401, 403, or 404. The body must be JSON.

Structured logs go through `src/util/log.js`: one JSON object with `time`, `level`, `message`, and whatever fields the caller passed. Playback failures include `guildId`, `source`, `error`, and `node`. They do not include the stream URL or the query. Some older paths still use `console.error` with a prefix (`[lavalink]`, `[db]`, `[panel]`, `[provider:name]`, `[resolver]`).

## Security boundaries

- Lavalink listens on `127.0.0.1`. The password is the only app-level auth on that port. Do not publish it.
- `assertPublicUrl` rejects non-HTTP(S) URLs, `localhost`, `.local`, `::1`, and the dotted forms of loopback, RFC1918, link-local, and `0.0.0.0/8`. The check is on the hostname string. It does not resolve DNS, so a public name that later points at a private address is not blocked.
- Local playback refuses paths outside the music directory after `realpath`, including symlink escapes.
- Catalog and search tokens stay in process memory. `stripSecrets` removes them from URLs before those URLs are returned to Lavalink.
- No token is read from source. `.env`, `data/`, `logs/`, `cookies.txt`, and `lavalink/*.jar` are gitignored.
- Discord mention parsing is off. Titles lose `*` and `` ` `` before they are interpolated into markdown.

The README's licensing note still applies: this is built for a private server. The code does not enforce a guild allowlist. `GUILD_ID` only scopes slash-command registration. Any server the bot is invited to can play.

## Tests

`npm test` runs `node --test`. The suite does not call Discord, Spotify, SoundCloud, Lavalink, or the public Apple and Deezer APIs. `npm run check` syntax-checks `src/index.js` only.

| File | What it locks |
| --- | --- |
| `test/match.test.js` | YouTube host detection, Spotify and Apple and Deezer parsing, title and query matching, preview rejection |
| `test/queue.test.js` | Per-guild isolation, cap of 50, clear, previous, play-now, move and remove indexes, shuffle, loop reset |
| `test/player.test.js` | Skip a missing track, do not stick on a broken track, two guilds do not share a player |
| `test/providers.test.js` | Local match and path escape, search falls through a throwing provider, unrelated search rejected when YouTube is absent, YouTube URLs and `ytsearch` fallback, Spotify top-result fallback, strict local match beats an unrelated YouTube hit, saved YouTube rows, SoundCloud playable rules, per-guild SQLite |

When you change matching, queue limits, or the play-failure loop, extend these tests. A new provider needs a unit test that does not hit the network: fake `fetch` is not set up, so test the pure functions or inject a fake provider through `ProviderManager.fromList`.

## Changing the bot

### Add a slash command

Add a `SlashCommandBuilder` and an `execute` function in `src/commands/index.js`, and put `{ data, execute }` on the exported `commands` array. Registration on ready picks it up. If the command changes playback, take the session from `music.session` or `activeSession`, and do the work inside a `GuildSession` method that uses `enqueue`. Read the DJ rule before adding a destructive control. `requireControl` is the check.

### Add a playback source

1. Implement the provider methods listed above and return `createTrack` objects with a new `source` name.
2. Register it in `ProviderManager` and add the name to `PLAYBACK_PROVIDERS`.
3. Teach `playbackIdentifier` to return something Lavalink's `resolve` already understands, or extend Lavalink's config so it does.
4. Teach `tracksFromPlaylist` about the new source. It currently allows `youtube`, `local`, `soundcloud`, and `lavalink`. Set `allowsLooseMatch` only if a miss should play this provider's top hit. YouTube is the only one that does.
5. Add the name to the `PROVIDER_ORDER` comment in `.env.example`.

### Add a metadata catalog

1. Detect the URL in `linkKind`.
2. Implement `resolveMetadata` returning `{ kind: 'tracks', tracks: [{ title, artist, album, durationMs, pageUrl }] }`. Set `canPlay` false.
3. Call it from `resolveRequest` through `resolveCatalog`. Do not add a path that plays the catalog's own audio.
4. `findMatch` and the `titlesMatch` plus `durationCompatible` checks stay in the resolver. `looseMatch` runs only after those checks fail, and only YouTube accepts that fallback.

### Add a filter

Add the choice on `/filter`, add the name to the allowlists in `setFilter`, `applyFilter`, and `restoreGuild`, and enable that filter in `lavalink/application.yml`. Persist only the name. The gain values stay in `applyFilter`.

### Add a button

Use a `customId` prefix of `player:` or `queue:`. Handle it in `executeButton`. Buttons have no slash-command permission of their own. Call `requireControl` for anything that is DJ-only.

## Behaviors that surprise people

- YouTube links use `YoutubeProvider`. Song names try `ytsearch:` first, then the local library, then the official SoundCloud API when it is configured, then `scsearch`. The loose top-hit fallback is YouTube only, and it runs after that whole strict walk misses.
- A strict miss plays the top YouTube result. It does not play an unrelated file from `music/`.
- Turning off `youtube` in `PROVIDER_ORDER` refuses YouTube URLs and turns the loose fallback off. Catalog links go back to refusing when nothing is close.
- Turning off `lavalink` in `PROVIDER_ORDER` disables SoundCloud, Bandcamp, Twitch, Vimeo, and raw HTTP links. YouTube links keep working, because they use the youtube provider.
- Official SoundCloud tracks still need a connected Lavalink node. The API only supplies the stream URL. Lavalink plays it.
- `LavalinkSource.label` is the string `SoundCloud`. With only that provider enabled, "could not find that song" names SoundCloud even though the same object is what plays Bandcamp.
- Play-now that cannot fit the old queue drops the tail. The reply's skipped count is about tracks that did not fit, not about a failed resolve.
- Three bad tracks in a row stop playback and put the third current track back at the front. A REST error stops immediately and also puts the current track back, without consuming the failure budget.
- `/stop` and a process restart are different. Stop deletes the playback row. A signal persists it and resumes.
- Resume seeks with `player.seekTo` after `playTrack`. SoundCloud often rejects that seek. The error is logged as `playback option failed` and playback continues from the start. Local files seek.
- The panel position is whatever the last Lavalink `update` said, not a local clock.
- `GUILD_ID` does not restrict which servers can invite or use the bot.
- Apple and Deezer stay available with an empty `.env`. Spotify does not.
- Playlist names are case-insensitive. Saving `Friday` overwrites `friday`.
- History on `/history` is per guild in SQLite. Previous is per process, in memory, and cleared by stop, leave, and restart.
- The bot will sit in a channel with only bots until the idle timer fires, if no humans are present. It will also leave a channel that still has humans when the queue is empty.
- First Lavalink start needs outbound network to `maven.lavalink.dev` and `jitpack.io`. Later starts use `lavalink/plugins/`, which is gitignored.

## Failure cheatsheet

| Symptom | Look at |
| --- | --- |
| Process exits immediately | `DISCORD_TOKEN` or `LAVALINK_PASSWORD` missing, or `GUILD_ID` / `OWNER_ID` / port not valid |
| Commands missing | Guild id wrong, or global registration still propagating. Log line says which mode ran |
| "audio server is not connected" | Lavalink down, password mismatch, or port. `GET /version` with the `Authorization` header |
| Link works, song name does not | `PROVIDER_ORDER`, SoundCloud client id, files named `Artist - Title.ext` |
| Spotify link says no match | Expected when the library and SoundCloud have no title that passes the matcher |
| YouTube asks for a sign-in | Plugin block, not the bot. Set the poToken or a burner OAuth refresh token, then restart Lavalink. Update `youtube-plugin` when this comes back after it was working |
| YouTube link says it is disabled | `youtube` is not in `PROVIDER_ORDER` |
| Queue did not resume | `data/bot.sqlite` missing, guild no longer visible to the bot, or the row had no channel. `journalctl` for `could not resume playback` |
| Buttons do nothing useful | Panel message was deleted. Use `/nowplaying`. DJ role blocks Stop, Loop, and Shuffle |
| Seek fails on SoundCloud | Known plugin limit. The track was not replaced |
| Wrong song almost played | Matching rejected it. Log line `[resolver] rejected a weak match`. The user got a refusal or a skipped-track note |
