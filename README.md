# Discord music bot

Friends-only music bot. Lavalink plays the audio. The bot decides what is allowed to play. YouTube, yt-dlp, and browser cookies are not used.

Lavalink is only the player. It does not supply a music catalogue, and this project does not turn on Lavalink's YouTube or SoundCloud scrapers.

## What can play

- **Local files** in the `music` folder. This is the dependable source. Name files `Artist - Title.mp3` (also flac, ogg, opus, wav, m4a, aac).
- **SoundCloud** tracks the official API marks as streamable for your developer app. A 30-second preview is not played as if it were the full song.
- **Spotify links** for metadata only (title, artist, album, duration). The bot searches the local library, then SoundCloud, and plays a match. It never streams Spotify's audio. If nothing matches, it says so and does not substitute a different song.

A YouTube link gets: `YouTube playback is not supported.`

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
| `SPOTIFY_CLIENT_ID` | Spotify app client id |
| `SPOTIFY_CLIENT_SECRET` | Spotify app secret |
| `PROVIDER_ORDER` | Playback order. Default `local,soundcloud`. |
| `LOCAL_MUSIC_DIR` | Folder of audio files. Default `music`. |
| `DATABASE_PATH` | SQLite file. Default `data/bot.sqlite`. |

Leave a provider's variables empty to disable it. `PROVIDER_ORDER=local` disables SoundCloud searches without affecting files already in the library. Spotify turns on only when both Spotify variables are set. It is not a playback source.

No tokens belong in source files.

## Lavalink

Download the jar once:

```bash
curl -L -o lavalink/Lavalink.jar https://github.com/lavalink-devs/Lavalink/releases/download/4.2.2/Lavalink.jar
```

Start it from the project root so local files resolve:

```bash
java -jar lavalink/Lavalink.jar --spring.config.additional-location=file:./lavalink/application.yml
```

Then, in another terminal:

```bash
npm install
npm start
```

The bot reconnects if Lavalink drops. It still cannot play until Lavalink is back and a provider has a real file or an allowed SoundCloud stream.

## Discord setup

1. Create an application and a bot at the Discord Developer Portal.
2. Leave privileged intents off. The bot uses Guilds and Guild Voice States only.
3. Invite it with Connect, Speak, and applications.commands. Send Messages and Read Message History let the on-screen player update in place:

   `https://discord.com/api/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=3213312&scope=bot%20applications.commands`

   Connect and Speak alone (`permissions=3145728`) still run the slash commands.
4. Join a voice channel and use `/play`.

Commands: `/play`, `/playnow`, `/pause`, `/resume`, `/skip`, `/stop`, `/clear`, `/queue`, `/nowplaying`, `/leave`, `/volume`, `/playlist`, `/history`. The player buttons are Previous, Pause/Resume, Next, and Stop. `/clear` removes upcoming songs and leaves the current one playing. `/playnow` interrupts the current song and keeps the rest of the queue.

You need to be in a voice channel. If the bot is already in one, you need to be in that same channel.

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
ExecStart=/usr/bin/java -jar /opt/discord-music-bot/lavalink/Lavalink.jar --spring.config.additional-location=file:./lavalink/application.yml
Restart=on-failure
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
Restart=on-failure
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

Use the password from `.env` if you changed it. `journalctl -u lavalink -u discord-music-bot -f` shows both logs.

After a later `git pull`, run `npm install` and restart both units if `package-lock.json` or `lavalink/application.yml` changed. The jar is not in git.

## Checks

```bash
npm test
node src/index.js
```

Without `DISCORD_TOKEN`, the process exits and tells you to set it. `npm test` does not call Discord, Spotify, SoundCloud, or Lavalink.

## Limits

- One Lavalink node on localhost. Each Discord server has its own queue and player.
- Playlists are capped at 50 tracks. Saved playlists store the file path or SoundCloud id, not an expiring stream URL.
- SoundCloud can refuse streams when the app lacks permission. That failure is logged and shown as a normal error. The rest of the bot keeps running.
- Local files are the source that does not depend on an external account.
