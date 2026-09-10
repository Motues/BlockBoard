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

## Brush colors

Right click the board to open the brush ring. The ring holds the preset colors; the rainbow circle in
the middle picks **any 24-bit RGB color**: it opens a picker with a saturation/brightness area, a hue
slider and a hex field (`#rgb` / `#rrggbb`). The picked color is applied to the brush immediately, and
the choice is remembered in `localStorage`.

## State format

Each cell takes **24 bits** (see `src/state.ts`):

| Value | Meaning |
| --- | --- |
| `0x000000` | black |
| `0x000001..0x00000F` | preset color index (the palette lives in `public/script.js`, `BRUSH_PRESETS`, currently 8 colors) |
| `>= 0x000010` | custom color, the value itself is the 24-bit RGB |

The 16 preset codes sit at the bottom of the range, so a custom color has to dodge them. Colors in
`#000000..#00000F` (all visually pure black) are stored as `0x000010`, which reads back as `#000010` —
indistinguishable by eye.

The board is stored as a Base64 string in `data/board-state.dat`, 3 bytes per cell: for 20000 cells
that is 60000 bytes of payload, i.e. ~78 KiB as Base64. As long as the board contains no custom color
the server keeps writing the older **4-bit-per-cell** layout (two cells per byte, the earlier cell in
the low nibble): the file stays 6x smaller and older builds can still read it. Save files in the
4-bit, 1-bit and the short-lived 4-byte-per-cell layouts are recognised by their byte length and
migrated automatically on load.

## Socket events

| Event | Direction | Payload |
| --- | --- | --- |
| `init-game` | server → client | `{ config, stateRgb, stateEncoding, black, maxColorIndex, rgbSupport }` — `stateRgb` is the 24-bit board using the RLE layout, or the dense 3-byte one when RLE would be bigger. Clients that do not announce the `rgb24` capability (pages that have not been refreshed) get the legacy `state` field instead |
| `paint-square` | client → server | `{ index, brush }` for a preset color or `{ index, rgb }` for a custom one; a cell already painted with that color is erased to black, otherwise it is painted with that color |
| `toggle-square` | client → server | `index` — legacy black/white toggle, still accepted |
| `update-square` | server → client | `{ index, value, rgb, isBlack }` — `rgb` is the 24-bit color of a custom cell (otherwise `null`), `value`/`isBlack` are kept for clients that have not refreshed yet |
| `online-users` | server → client | number of connected users |

### Handshake capabilities

The client connects with `io({ auth: { caps: ['rgb24', 'rle'] } })`:

| Capability | Meaning |
| --- | --- |
| `rgb24` | understands 24-bit cell values and the dense 3-byte state; the server then sends `stateRgb` instead of the legacy 4-bit `state` |
| `rle` | understands the RLE state layout |

### Compact state (RLE)

Each run of same-colored cells is three varints: `[skipped black cells, run length, value]`, and cells
that are never mentioned stay black. A sparse board costs a few dozen bytes instead of tens of
kilobytes, an empty board costs nothing at all. Only a board where nearly every cell has a different
color is bigger as RLE, and that case falls back to the dense 3-byte layout — so the payload is never
larger than the plain encoding. Large messages are additionally compressed by the WebSocket
`permessage-deflate` extension (engine.io `perMessageDeflate`, threshold 1 KiB).

For the default 200x100 board that means a new connection transfers roughly **250 bytes** instead of
**93 KiB**.
