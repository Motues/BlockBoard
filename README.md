# BlockBoard

A real-time online block board

![Index](./doc/images/index.png)

## Deployment

1. Clone the repo
    ```bash
    git clone https://github.com/Motues/BlockBoard.git
    ```
2. Install dependencies
    ```
    cd BlockBoard
    pnpm install
    ```
3. Start the server
    ```
    pnpm build
    pnpm start
    ```
    then open http://localhost:33333

## Configuration

Configure the server in `game-config.json`

| Name | Description |
| --- | --- |
| `rows` | The number of rows in the board |
| `cols` | The number of columns in the board |
| `cellSize` | The size of each block in pixels |
| `port` | The port the server will listen to |

## State format

Each cell takes **4 bits**: `0` means black, `1..15` are color indices. The palette itself lives in
the client (`public/script.js`, `BRUSH_PRESETS`, currently 8 colors) and indices are mapped to real
colors by `VALUE_COLORS`.

The whole board is packed two cells per byte (the earlier cell in the low nibble) and stored as a
Base64 string in `data/board-state.dat`. Save files written by the older 1-bit-per-cell version are
recognised by their byte length and migrated automatically on load.

## Socket events

| Event | Direction | Payload |
| --- | --- | --- |
| `init-game` | server → client | `{ config, state, black, maxColorIndex }` — `state` is the packed Base64 board |
| `paint-square` | client → server | `{ index, brush }` — a cell already painted with the brush color is erased to black, otherwise it is painted with that color |
| `toggle-square` | client → server | `index` — legacy black/white toggle, still accepted |
| `update-square` | server → client | `{ index, value, isBlack }` — `isBlack` is kept for clients that have not refreshed yet |
| `online-users` | server → client | number of connected users |
