# BlockBoard

A real-time online block board

**English** | [中文](./README.zh-CN.md)

[Demo](https://blockboard.motues.top)

![Index](./doc/images/index.png)

## Deployment

```bash
git clone https://github.com/Motues/BlockBoard.git
cd BlockBoard
vim game-config.json # 
pnpm install
pnpm build
pnpm start
```

Then open http://localhost:3000

(`game-config.json` ships with the repo, edit it as needed; delete it and restart to get the
defaults back.)

### Docker

```bash
git clone https://github.com/Motues/BlockBoard.git
cd BlockBoard
docker compose up -d
```

- Image: `ghcr.io/motues/blockboard:latest`. The **internal port is fixed at 3000** and cannot be
  changed from the config file (the `PORT` environment variable wins). To expose a different port,
  edit the left side of the mapping in `docker-compose.yml`, e.g. `8080:3000`, then open
  http://localhost:8080
- The config is mounted from the current directory: edit `./game-config.json` (board size,
  `cellSize`, `devPassword`) and run `docker compose restart`. The container runs as the non-root
  uid 1000, so the file must be readable by it.
- The save lives in `/app/data` inside the container; compose maps it to `./data` on the host.
  Nothing else needs persisting. On Linux the container runs as uid 1000, so if saves fail (check
  the logs) run `sudo chown -R 1000:1000 ./data` once.
- The developer password can also be supplied through the `DEV_PASSWORD` environment variable (it
  wins over the `devPassword` field) — see the comments in the compose file.

> `game-config.json` is tracked in git (compose needs it to exist). Your edited copy will keep
> showing up as modified — don't commit your own `devPassword`. To keep a personal config out of
> git, put it in `game-config.local.json` (already gitignored).

## Configuration

The server reads `game-config.json` (the copy in the repo holds safe defaults, no password):

| Name | Description |
| --- | --- |
| `rows` / `cols` | Number of rows / columns |
| `cellSize` | Size of each block in pixels |
| `port` | Port the server listens on. The `PORT` environment variable wins over this field (the Docker image uses it to pin the internal port to 3000) |
| `devPassword` | Password for the developer tools. Empty keeps them disabled; the `DEV_PASSWORD` environment variable wins over this field |
| `devSessionHours` | How long a developer session stays valid, in hours (default 8) |

## Interface

Available in Simplified Chinese, Traditional Chinese, English, Japanese and Korean. The language
follows the browser on the first visit and can be changed in the settings dialog, which also holds
the developer password and the data backup.

Three buttons sit in the bottom-right corner:

| Button | What it does |
| --- | --- |
| **Developer tools** | Signs in / opens the developer tools (below); hidden on touch devices |
| **Settings** | Language / developer password / data backup |
| **Menu** | Brush color / reset view / save as image / show help — also the settings entry on touch devices |

## Painting

- **Left click** paints a block, clicking it again erases it. On touch screens, **tap**.
- **Short press the right button** (touch: **long press**) opens the brush ring; the rainbow circle in
  the middle picks any RGB color, and the picker also offers an **eyedropper** and **recent colors**.
- **Drag with the right button** to pan, scroll to zoom; on touch screens, drag with one finger and
  pinch with two.

> **On Edge:** the built-in mouse gestures take over right-button dragging and a page cannot turn them
> off. On desktop Edge the first visit shows a hint card whose button opens the settings page — turn
> off *Enable mouse gestures* there.

## Developer tools

Click **Developer tools** in the bottom bar and sign in with the developer password (a password saved
in this browser signs you in automatically). While the mode is on, a banner with an **Exit** button
sits at the top.

- **Drag with the left button** to marquee-select a rectangle; a plain **left click** targets the
  closed region the block belongs to instead (normal painting is disabled in this mode).
- **Right click** opens a menu: fill with the brush color, reset to black, pick a custom color, export
  the selection (PNG + JSON), clear the selection.
- **Closed region fill** is computed in the browser: if the region reaches the board edge it is
  refused instead of flooding the board.

## Data backup

**Data backup** in the settings dialog packs `game-config.json` and the board save into **one `.bbx`
file**; importing it back overwrites the server's config and save. It uses the developer password
above (no second password to type, but save it in the settings first).

- **Export data** — the config inside carries no developer password, so the file is safe to pass on.
- **Import save** — pick a file, then click *Import save*; the first click only asks for confirmation
  because it overwrites server data.
- Import takes effect **immediately** and accepts a different board size than the current one
  (regridded top-left aligned, connected clients resync), so **no restart** is needed. A damaged file
  or a config/save mismatch is rejected and the server is left untouched.

---

Architecture, state format, socket protocol and HTTP endpoints live in [AGENTS.md](./AGENTS.md)
(Chinese).
