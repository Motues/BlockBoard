# 状态格式

## 每格取值

每格一个 24bit 值（存在 `Uint32Array`，只用低 24 位）：

| 取值 | 含义 |
| --- | --- |
| `0x000000` | 黑色（默认底色） |
| `0x000001..0x00000F` | 预设颜色编号（调色板在 `public/js/config.mjs` 的 `BRUSH_PRESETS`，目前 8 色） |
| `>= 0x000010` | 自定义颜色，值本身就是 24bit RGB |

预设编号占 `0x00..0x0F` 这 16 个码位，自定义颜色必须避开：落到 `0x000000..0x00000F`（肉眼看都是纯黑）的颜色存储时抬到 `0x000010`，读出来是 `#000010`，肉眼分辨不出。旧客户端只认 4bit 编号，自定义颜色在它们眼里统一是 `0x0F`（`toLegacyIndex`）。

## 存档

- `data/board-state.dat` —— v3 格式：`'BBS3'` + 1 字节 flags（位 0 = 载荷是 24bit/格）+ `uint32LE cols` + `uint32LE rows` + `uint32LE epoch` + `uint32LE rev` + `deflate(裸状态字节)`，共 21 字节头。带自定义颜色写 24bit（3 字节/格），否则写 4bit/格（每字节两格，前一个格子放低 4 位），文件小 6 倍且旧版本程序也能读。写盘走 `writeFileAtomic()`：先写 `.tmp` 再 `rename`（原子替换），只有棋盘真的变了才写（`stateRev !== savedRev`）；写之前先把排队中的单格广播 flush 掉，保证文件里的 `rev` 与状态配套。
- `epoch` / `rev` 给增量同步用：服务端重启后沿用存档里的 epoch / rev，客户端拿同样版本号回来可直接“什么都不用传”；棋盘尺寸变了换新 epoch（客户端缓存作废）。v2 存档（13 字节头、没有 epoch / rev）也能读，读出 epoch = 0 / rev = 0，服务端会换一个新 epoch。
- `data/board-size.json` —— 这份存档对应的 `{ cols, rows }`。启动时先写一次，每次自动存档（每 60 秒）一起更新；主要给旧格式存档消歧（新格式尺寸在文件头）。
- 三个写盘口（`data/config/game-config.json`、`board-state.dat`、`board-size.json`）都走 `board-persist.ts` 的 `writeFileAtomic()`：先 `.tmp` 再 `rename`。配置放在 `data/config/` 里、和存档同属一个目录树，正常部署（挂 `data/` 目录）rename 都不受阻；**只有把单个文件挂进来**（`./game-config.json:/app/game-config.json` 或把 `board-state.dat` 单独挂载）时 rename 才换不过去（Linux 对 mount point 的 rename 一律 `EBUSY`，Node 报 “resource busy or locked”；跨文件系统的绑定挂载是 `EXDEV`，Docker Desktop 常见 `EPERM`），这时退回原地覆写。原地覆写没有原子性，所以只在上述错误码上退回（`ENOSPC` / `EROFS` 之类照旧抛错，免得把文件截成半份），并且每个文件只警告一次，之后直接原地覆写（不再白写一遍 `.tmp`）。
- 自动存档：`setInterval(saveState, 60s)`，`saveState()` 第一件事比较 `stateRev` 与 `savedRev`，没改动直接返回 —— 不再每分钟重写几 MB 文件。

旧存档仍能读（`loadState`）：先试 `parseSaveFile`（v3 / v2）；都不是就把整个文件当 base64 文本，交给 `decodeState` 按字节长度依次判定 **24bit（3 字节/格）→ 32bit（4 字节/格，高 8 位是自定义颜色标记）→ 4bit（每字节两格）→ 1bit（每字节八格）**。判定顺序关键：先看字节数是否正好等于某种格式在当前配置下的长度，都不匹配再尝试反推格子数，否则“比当前棋盘小的 4bit 存档”会被当成 24bit 读出乱码。字节数不足以反推尺寸时用 `board-size.json` 里的上一个配置消歧，仍没有就按更常见的 4bit 读。旧存档会在下一次真正发生改动时自动写成 v3，不需要手动迁移。

## 尺寸变更重排

改棋盘尺寸（`game-config.json` 的 `rows` / `cols` 变了）时按左上角对齐重排（`regridState`）：逐行整段搬运，棋盘变大右下角补黑，变小时丢弃超出部分，重叠区域颜色原样保留。不能只按一维数组截断/补零 —— 列数一变一维下标与二维行列对不上，整幅画会斜着错位。

v2 存档尺寸精确；旧格式存档尺寸靠字节长度推断：24bit / 4byte 布局精确，只改行数也精确；唯一无法还原的是“4bit 或 1bit 存档且列数也变了”，退化成逐格裁剪/补黑（改动前旧行为）。

> 这套“尺寸变了就重排”的逻辑有两个入口：启动时读盘发现尺寸不符，以及数据导入（`board-transfer.ts` 显式调用 `regridState`，尺寸没变也走一遍把长度裁准）。两条路行为刻意一致，改的时候别只改一条。另外 `gridState` 是 `Uint32Array` 的 `let` 绑定（`getGridState()`）：导入会整块换掉它，任何模块顶层缓存数组引用的写法都会在导入后失效。

## 编码

编码一律先出 `Buffer`：

- `encodeStateBuffer` / `encodeLegacyStateBuffer` / `encodeRleBuffer`；
- 字符串版只是 base64 包装；
- 存档是带 magic、尺寸、epoch、rev 与 deflate 的 v3 格式（`buildSaveFile` / `parseSaveFile`，v2 也能读）。

RLE 紧凑状态：每个色块三个 varint `[跳过多少个黑格, 连续多少格, 颜色值]`，没被提到的格子保持黑色。空棋盘零字节，稀疏棋盘几十字节；噪点棋盘 `encodeCompactState` 退回 3 字节/格稠密格式。

批量差量 runs 与状态 RLE 同一套 varint 三元组，但语义不同：`update-region` 的 `runs` 不跳过黑色 —— 黑色在批量操作里是“擦除”有效结果，只有值真的没变的格子才跳过。编码端维护 `cursor`：第一个 varint 是相对上一段结束再跳过多少格，不是相对 `start` 的绝对偏移。广播必须带 `start`。

## 浏览器状态缓存

IndexedDB 缓存（`state-cache.mjs`，增量同步用）：

| 库 / 表 | 键 | 内容 |
| --- | --- | --- |
| `blockboard` / `board-state` | `current` | `{ epoch, rev, cols, rows, bytes }` —— 状态是 3 字节/格稠密裸字节，`epoch` / `rev` 与它一起在同一事务写，保证对得上。超过 12 MB 的棋盘不缓存 |

`state-cache.mjs` 是叶子，不 import 任何模块，避免和 `shared.mjs` 成环。`shared.mjs` 顶层 `await` 读它（握手要带缓存 epoch / rev），`connection.mjs` 往里报“状态变了”，`main.mjs` 把“当前状态 + epoch/rev”喂给它写盘。