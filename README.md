# Discord music bot

Friends-only music bot. Lavalink plays the audio. The bot decides which links are allowed. There is no yt-dlp step and no browser cookies.

Lavalink is the player. YouTube, SoundCloud, Bandcamp, Twitch, Vimeo, public HTTP streams, and the local `music` folder can play. Spotify, Apple Music, and Deezer links are read as metadata, then matched to YouTube, the local library, or SoundCloud. A close title match wins. If nothing is close, the bot plays the top YouTube result instead of refusing.

## What can play

- **YouTube** links and `ytsearch` through Lavalink's youtube-source plugin. The old built-in YouTube source stays off.
- **Local files** in the `music` folder. This is the source that does not depend on an outside account. Name files `Artist - Title.mp3` (also flac, ogg, opus, wav, m4a, aac).
- **SoundCloud, Bandcamp, Twitch, and Vimeo** links through Lavalink. None of these ask for a cookie or a user login.
- **Public HTTP and HTTPS streams.** Private hosts, localhost, and link-local addresses are refused.
- **SoundCloud search** when `soundcloud` or `lavalink` is in `PROVIDER_ORDER`. The official API still needs a SoundCloud developer app. Lavalink's own SoundCloud search does not.
- **Spotify, Apple Music, and Deezer links** for title, artist, album, and duration. Spotify uses a developer app when `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` are set. Apple Music uses the public iTunes lookup. Deezer uses the public Deezer API. None of those three are streamed. The LavaSrc plugin turns a Spotify link Lavalink loads itself into a YouTube search, then SoundCloud. Its Apple Music, Deezer, and YouTube audio sources stay off.

YouTube playback goes against YouTube's terms of service. For a private server that is usually tolerated, and it is your risk. YouTube also breaks often. If Lavalink logs "sign in to confirm you're not a bot", set a poToken or a YouTube OAuth refresh token on a burner account in `lavalink/application.yml`. The plugin needs regular updates. This config downloads the current youtube-source snapshot `2be8e542d3f6f178e048dca565892684c2e40177`, because release 1.18.2 is rejected with "The page needs to be reloaded." Stream addresses are deciphered by the public cipher at `https://cipher.kikkia.dev/`, because the plugin cannot read the current player script itself.

How the process, providers, queue, and database fit together is in [docs/DEVELOPER.md](docs/DEVELOPER.md).

## Requirements

- Node.js 22.13 or newer (`node:sqlite` is built in; you may see an experimental warning)
- Java 17 or newer (Java 21 is a good choice) for Lavalink
- A Discord bot token
- Lavalink 4.2.2, downloaded separately and not committed

On the VPS, ffmpeg and yt-dlp are no longer required. `cookies.txt` can be deleted.

## Configuration

```bash
cp .env.example .env
```

Set `DISCORD_TOKEN`. Set `GUILD_ID` to your server id if you want slash commands to update immediately.

`LAVALINK_PASSWORD` must be the same as `password` under `lavalink.server` in `lavalink/application.yml`. Both ship as `changeme`. Change both if the machine is shared. Lavalink listens on `127.0.0.1:2333` only. Do not open that port.

Optional:

| Variable | Purpose |
| --- | --- |
| `OWNER_ID` | Discord user id. One direct message per hour if Lavalink is down. |
| `SOUNDCLOUD_CLIENT_ID` | SoundCloud app client id |
| `SOUNDCLOUD_CLIENT_SECRET` | SoundCloud app secret, used to refresh the API token |
| `SPOTIFY_CLIENT_ID` | Spotify app client id. Also read by Lavalink when the unit loads `.env`. |
| `SPOTIFY_CLIENT_SECRET` | Spotify app secret |
| `PROVIDER_ORDER` | Playback order. Default `youtube,local,soundcloud,lavalink`. |
| `LOCAL_MUSIC_DIR` | Folder of audio files. Default `music`. |
| `DATABASE_PATH` | SQLite file. Default `data/bot.sqlite`. |
| `IDLE_MINUTES` | Leave after this many minutes in an empty channel or with an empty queue. Default 10. `0` disables it. |
| `UPTIME_URL` | Optional address that receives a GET every 30 seconds. |

Leave a provider's variables empty to disable that provider. `PROVIDER_ORDER=local` keeps file playback and skips YouTube and SoundCloud search. If `.env` already sets `PROVIDER_ORDER`, add `youtube` at the front. An existing value is not rewritten. Spotify metadata turns on only when both Spotify variables are set. Apple Music and Deezer metadata need no keys. YouTube search does not need a key. OAuth and a poToken are only for when YouTube starts refusing anonymous playback.

No tokens belong in source files. Keep `.env` readable only by the account that runs the bot.

## Lavalink

Download the jar once:

```bash
curl -L -o lavalink/Lavalink.jar https://github.com/lavalink-devs/Lavalink/releases/download/4.2.2/Lavalink.jar
```

Start it from the project root so local files resolve:

```bash
java -jar lavalink/Lavalink.jar --spring.config.additional-location=file:./lavalink/application.yml
```

The first start downloads LavaSrc from `maven.lavalink.dev` and the SoundCloud plugin from `jitpack.io`. That start is slower and needs outbound network. Later starts reuse the downloaded plugins. Lavalink's built-in SoundCloud source is off, because SoundCloud no longer serves a stream that source can read. The soundy plugin plays SoundCloud links and `scsearch` with no account and no cookie. Seeking inside a SoundCloud track can fail. Local files still seek.

Then, in another terminal:

```bash
npm install
npm start
```

The bot reconnects if Lavalink drops, and Lavalink session resume is enabled. The current track, position, pause state, loop mode, volume, filter, and the rest of the queue are stored in SQLite and restored after a restart. A failed resume is logged with the guild, source, and node. The log line does not include the stream address.

## Discord setup

1. Create an application and a bot at the Discord Developer Portal.
2. Leave privileged intents off. The bot uses Guilds and Guild Voice States only.
3. Invite it with Connect, Speak, and applications.commands. Send Messages and Read Message History let the on-screen player update in place:

   `https://discord.com/api/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=3213312&scope=bot%20applications.commands`

   Connect and Speak alone (`permissions=3145728`) still run the slash commands.
4. Join a voice channel and use `/play`.

Commands: `/play`, `/k2`, `/playnow`, `/pause`, `/resume`, `/skip`, `/stop`, `/clear`, `/queue`, `/nowplaying`, `/leave`, `/volume`, `/seek`, `/loop`, `/shuffle`, `/move`, `/remove`, `/filter`, `/djrole`, `/playlist`, `/history`, `/stats`.

`/k2` is the same command as `/play`. When a song starts, the bot posts the Among Us GIF from Klipy. Set `PLAY_GIF_URL` to a different direct `.gif` link to change it. Queuing behind a song that is already playing does not post it again.

The player is an embed with a progress bar. Buttons are Pause, Skip, Loop, Shuffle, Stop, and Previous. `/queue` pages through the upcoming songs. `/loop` is `off`, `track`, or `queue`. `/seek` takes seconds or `1:30`. `/filter` is `bassboost`, `nightcore`, or `off`. `/clear` removes upcoming songs and leaves the current one playing. `/playnow` interrupts the current song and keeps the rest of the queue.

`/stats` shows how many times songs have started, who requested them, and how long was actually heard. The totals are for this server. `/history` is only the latest plays.

With nothing left to play, the bot leaves the voice channel after `IDLE_MINUTES` (10 by default) and says so in the last text channel. `0` turns that off. A paused song is still the current song, so the bot stays.

`/djrole` is optional. With no role set, anyone in the same voice channel can use the controls. With a role set, anyone can still `/play`, pause, and skip. Stop, clear, leave, shuffle, remove, move, volume, filter, seek, loop, and `/playnow` need that role or Manage Server.

You need to be in a voice channel. If the bot is already in one, you need to be in that same channel. Errors that happen before a public reply are ephemeral.

## Windows development

1. Install Node.js 22 and Temurin or another Java 21 JDK.
2. Clone the repo and `npm install`.
3. Copy `.env.example` to `.env` and fill it in.
4. Put songs in `music\`.
5. Download `Lavalink.jar` into `lavalink\`.
6. From the project folder, start Lavalink:

   `java -jar lavalink\Lavalink.jar --spring.config.additional-location=file:./lavalink/application.yml`

7. In a second terminal: `npm start`.

## Linux VPS

```bash
apt update
apt install -y openjdk-21-jre-headless curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
cd /opt/discord-music-bot
git pull
npm install
cp -n .env.example .env
curl -L -o lavalink/Lavalink.jar https://github.com/lavalink-devs/Lavalink/releases/download/4.2.2/Lavalink.jar
mkdir -p music
```

Edit `.env`. Remove any old `YTDLP_COOKIES` line. Put files in `/opt/discord-music-bot/music`.

`/etc/systemd/system/lavalink.service`:

```ini
[Unit]
Description=Lavalink audio server
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/discord-music-bot
EnvironmentFile=/opt/discord-music-bot/.env
ExecStart=/usr/bin/java -jar /opt/discord-music-bot/lavalink/Lavalink.jar --spring.config.additional-location=file:./lavalink/application.yml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/discord-music-bot.service`:

```ini
[Unit]
Description=Discord music bot
After=network-online.target lavalink.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/discord-music-bot
EnvironmentFile=/opt/discord-music-bot/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now lavalink
systemctl restart discord-music-bot
```

Confirm Lavalink before blaming the bot:

```bash
curl -s -H "Authorization: changeme" http://127.0.0.1:2333/version
```

Use the password from `.env` if you changed it. `journalctl -u lavalink -u discord-music-bot -f` shows both logs. Playback failures are one JSON line each, with the source, the error, and the node name.

After a later `git pull`, restart both units. Run `npm install` when `package-lock.json` changed. The first Lavalink start after this source change also downloads the plugin, so give that start a minute. The jar is not in git.

Back up `music/` and `data/bot.sqlite` with the rest of the machine. Those two hold the library and the queue that a restart resumes.

## Checks

```bash
npm test
node src/index.js
```

Without `DISCORD_TOKEN`, the process exits and tells you to set it. `npm test` does not call Discord, Spotify, SoundCloud, or Lavalink.

## Limits

- One Lavalink node on localhost. Each Discord server has its own queue and player.
- Playlists are capped at 50 tracks. Saved playlists store the file path or the source address, not an expiring stream URL.
- Spotify, Apple Music, and Deezer audio are never requested. A close match in YouTube, the local library, or SoundCloud plays. If there is no close match and YouTube is enabled, the top YouTube result plays.
- This bot is for a private server. Playing a library into other people's servers can raise licensing questions.
- Local files are the source that does not depend on an external account.
