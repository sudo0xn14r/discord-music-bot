# Discord music bot

A friends-only music bot for a personal Linux VPS. It is one Node.js process: [discord.js](https://discord.js.org/) v14 and `@discordjs/voice` play audio, and `yt-dlp` reads the stream. There is no Lavalink server, no Docker setup, and no database. The queue lives in memory and is cleared when the process stops.

## What you can play

- A song name. That searches YouTube.
- A direct link from YouTube, YouTube Music, SoundCloud, Bandcamp, and the other sites `yt-dlp` supports.
- A Spotify, Deezer, or Apple Music song, album, or playlist. Those services do not give bots their audio, so the bot plays the matching YouTube recording. Apple Music playlists are the exception: paste the song, the album, or the song name.
- Playlists, albums, and SoundCloud sets are queued up to 50 tracks.

## Limits

- Private and age-restricted videos fail with an error in Discord.
- YouTube sometimes asks a datacenter IP to sign in. `/play` reports that in Discord. Export a Netscape `cookies.txt` and set `YTDLP_COOKIES` to its path if it keeps happening. Do not commit that file.
- One queue per server, up to 50 waiting tracks. Restarting the bot clears it.

## What you need

- Node.js 20 or newer
- `ffmpeg` on `PATH`
- `yt-dlp` on `PATH`. The Linux release is a Python program, so Python 3.11 or newer is required too.

On Debian or Ubuntu:

```bash
sudo apt update
sudo apt install -y ffmpeg python3 curl
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
yt-dlp --version
ffmpeg -version
```

Use that yt-dlp release rather than the `apt` package. The distro package is often too old to extract YouTube audio. `yt-dlp` and `ffmpeg` are started by the bot when someone plays a track. They are not a separate music server.

## 1. Create the Discord application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. Open **Bot** and click **Reset Token**. Put that token in `.env` as `DISCORD_TOKEN`. Do not commit it or paste it into the code.
3. Copy the **Application ID** from **General Information**. You need it for the invite link.

## 2. Intents

The bot requests only these gateway intents:

- **Guilds** — slash commands, and the text channel used for playback errors
- **Guild Voice States** — see who is in voice so commands can require a voice channel

Neither intent is privileged. On the Bot page, leave **Presence Intent**, **Server Members Intent**, and **Message Content Intent** turned off. Message content is unused because every command is a slash command. There is often no separate toggle for Guilds or Guild Voice States; requesting them from the code is enough.

## 3. Invite the bot

Replace `YOUR_CLIENT_ID` with the application id:

```text
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=3145728&scope=bot%20applications.commands
```

That URL asks for the `bot` and `applications.commands` scopes, plus **Connect** (`1048576`) and **Speak** (`2097152`). Open it in a browser, choose your friends' server, and authorize.

Slash command replies use Discord's interaction webhook, so Send Messages is not required for command responses. If a voice channel has its own permission overwrites, allow the bot's role to **View Channel**, **Connect**, and **Speak** there too.

## 4. Configure

```bash
cp .env.example .env
```

`.env.example` lists:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token from the Developer Portal |
| `GUILD_ID` | no | Server id. Set it so commands register on that server immediately. Leave it empty to register globally. |
| `YTDLP_COOKIES` | no | Path to a Netscape `cookies.txt` if YouTube blocks the VPS with a sign-in check. |

Enable Developer Mode in Discord (User Settings → Advanced), then right-click the server icon and choose **Copy Server ID**.

## 5. Install and run

From this directory:

```bash
npm install
npm start
```

`npm start` runs `node src/index.js`. On startup the process:

1. Exits with an error if `DISCORD_TOKEN` is missing.
2. Logs in.
3. Registers the slash commands.

Guild registration (`GUILD_ID` set) shows up in that server right away. Global registration (empty `GUILD_ID`) can take up to an hour. Restart the bot after changing commands. If you previously registered globally and then set `GUILD_ID`, old global commands can linger until you clear them in the Developer Portal.

Check the syntax of the source without logging in:

```bash
npm run check
```

## 6. Commands

Everyone who uses a command must already be in a voice channel. If the bot is already in voice, you have to be in that same channel.

| Command | What it does |
| --- | --- |
| `/play query:` | Song name or a link (YouTube, Spotify, SoundCloud, Deezer, Apple Music, and other sites yt-dlp supports). Joins your channel if needed. |
| `/pause` | Pauses the current track. |
| `/resume` | Resumes a paused track. |
| `/skip` | Skips the current track and plays the next one. |
| `/stop` | Stops playback and clears the queue. The bot stays in voice. |
| `/queue` | Shows the current track and up to 10 upcoming tracks. |
| `/nowplaying` | Shows the current track. |
| `/leave` | Leaves voice and clears the queue. |

Discord replies when a search or link fails, when nothing is playing, and when the bot is not in a voice channel.

## 7. systemd

Example unit for a Linux VPS. Adjust the user and the install path. `EnvironmentFile` loads `.env` (including `DISCORD_TOKEN`) without putting the token in the unit file.

`/etc/systemd/system/discord-music-bot.service`:

```ini
[Unit]
Description=Discord music bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nizar
WorkingDirectory=/opt/discord-music-bot
EnvironmentFile=/opt/discord-music-bot/.env
ExecStart=/usr/bin/env node src/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now discord-music-bot
sudo systemctl status discord-music-bot
```

Logs: `journalctl -u discord-music-bot -f`.

Stopping the service disconnects the bot from voice. The in-memory queue is not saved.
