# Mini Atys — MMORPG thu nhỏ dựa trên kiến trúc Ryzom Core

Mini Atys là một MMORPG 2D chơi ngay trên trình duyệt: nhiều người chơi cùng một thế giới, có quái AI, combat, XP/level, loot, shop, chat và lưu nhân vật.
Phần server **mô phỏng lại kiến trúc service của shard Ryzom** (`ryzom/server/src`). Thay vì hơn chục process C++ nói chuyện qua NeL, ở đây mỗi service là một module JavaScript chạy trong một process Node.js duy nhất.

- **Không có dependency nào**: chỉ cần Node.js ≥ 22. WebSocket (RFC 6455) được tự viết trong `server/net/websocket.js`.
- **Server authoritative**: client tự di chuyển nhân vật của mình (giống client Ryzom), còn server kiểm tra tốc độ và va chạm cho mọi bước đi. Combat, loot và XP đều do server quyết định.

## Chạy

```bash
cd mini_atys
npm start            # http://localhost:8080
npm run dev          # bật thêm lệnh GM /spawn <creature> [level]
npm test             # 12 unit test gameplay + 1 test end-to-end qua WebSocket thật
npm run bots -- 100 30   # load test: 100 bot chơi trong 30 giây (server phải đang chạy)
```

Tuỳ chọn: `--port 8080`, `--data ./data`, `--seed 1337`, `--dev`. Bạn cũng có thể dùng biến môi trường `PORT`, `DATA_DIR`, `SEED`, `DEV`.
Muốn chạy bằng Docker: `docker build -t mini-atys . && docker run -p 8080:8080 -v atys:/data mini-atys`.

Mở nhiều tab hoặc nhiều máy cùng trỏ vào server để chơi chung. **Lần đăng nhập đầu tiên với một tên mới sẽ tạo nhân vật**; các lần sau cần đúng mật khẩu (lưu bằng scrypt).

## Cách chơi

| Thao tác | Phím |
|---|---|
| Di chuyển | `WASD`/phím mũi tên, hoặc click xuống đất |
| Chọn mục tiêu + tấn công | Click vào quái (nhân vật tự đuổi theo rồi auto-attack); `Tab` chọn con gần nhất |
| Kỹ năng | `1` Attack · `2` Fire Bolt (tốn Sap) · `3` Heal (bản thân hoặc người chơi đang chọn) · `4` Potion · `5` Sap Crystal |
| NPC | Click NPC hoặc bấm `E` khi đứng gần |
| Khác | `I` túi đồ · `H` hướng dẫn · `Enter` chat · `Esc` bỏ mục tiêu |
| Lệnh chat | `/w` chat toàn server · `/me` · `/who` · `/top` · `/stuck` (về làng) · `/help` |

**Vòng gameplay**: xuất phát ở làng **Silan** (vùng an toàn, hồi máu nhanh) → ra 4 vùng Matis Forest / Fyros Desert / Tryker Lakes / Zorai Jungle → quái càng xa trung tâm càng mạnh (Yubo lv1 → Gingo, Torbak, Ragus → Kitin lv 20+) → bán loot cho **Merchant Lyna**, mua potion và trang bị (vũ khí, amplifier, giáp) → cuối cùng là boss **Kirosta Matriarch** lv 30 (6000 HP) ở góc đông nam, cần đánh theo nhóm.

Màu tên quái cho biết độ khó so với level của bạn: xám < xanh lá < vàng < cam < đỏ. Quái **aggressive** sẽ tự lao vào khi bạn đến gần; quái passive chỉ đánh trả khi bị đánh. Nếu bị kéo quá xa ổ, quái sẽ **leash** về nhà (lúc đó miễn sát thương và hồi đầy máu). Chết sẽ mất 10% XP của level hiện tại rồi hồi sinh ở Silan.

## Kiến trúc: ánh xạ sang Ryzom Core

```
Browser (client/game.js)
   │  WebSocket JSON — mỗi game cycle 100 ms server gửi delta tick
   ▼
FrontendService ──► EGS ◄── AIService
   │                 │
   ├─ ChatService    ├─ EntityMatrix (lưới không gian)
   └─ Persistence    └─ sheets.js (dữ liệu tĩnh)
        ▲
   TickService điều phối: egs.update → ai.update → fes.flush
```

| Ryzom Core (`ryzom/server/src/…`) | Mini Atys | Vai trò |
|---|---|---|
| `tick_service` (TickTimeStep 100 ms) | `server/tick_service.js` | Game cycle cố định 10 Hz, có bù trễ, đo thời gian tick |
| `frontend_service` (`client_host`, `fe_receive_sub`, `distance_prioritizer`) | `server/frontend_service.js`, `server/net/websocket.js` | Session, login, giải mã message, vision delta (add/upd/del) theo bán kính nhìn; entity ở xa được gửi thưa hơn |
| `entities_game_service` (+ `phrase_manager`) | `server/egs.js` | Nhân vật, chỉ số HP/Sap/Stamina, combat, XP/level, túi đồ, mua bán, chết/hồi sinh |
| `entities_game_service/entity_matrix.h` | `server/entity_matrix.js` | Spatial hash phục vụ truy vấn vision, aggro, chat local |
| `ai_service` (`ai_bot_fauna`, `ai_grp_fauna`, `ai_aggro`) | `server/ai_service.js` | Spawn group, lang thang, aggro list theo threat, đuổi, leash/evade, respawn, LOD (group xa người chơi thì ngủ) |
| `gpm_service/move_checker.cpp` | `shared/rules.js` + `egs.clientMove()` | Kiểm tra tốc độ (speed budget) và va chạm đoạn thẳng → gửi `correct` nếu gian lận |
| `input_output_service` (chat) | `server/chat.js` | Kênh say/universe/emote, lệnh slash, rate limit |
| `backup_service` / PDS | `server/persistence.js` | Lưu JSON atomic (ghi file tạm rồi rename) mỗi 30 giây và khi logout |
| georges sheets (`.creature`, `.sitem`) | `server/sheets.js` | Bảng dữ liệu quái, vật phẩm, trang bị |
| `ryzom_admin_service` | `GET /status` | Thống kê shard: tick time, người chơi, traffic, leaderboard |
| `game_share/characteristics.h` | `Rules.playerStats()` | HP/Sap/Stamina tăng theo level |

`shared/rules.js` được dùng chung bởi cả server lẫn client, nên phép kiểm tra va chạm ở hai phía luôn khớp nhau. Nhờ vậy client có thể tự dự đoán chuyển động mà không bị server "kéo giật lại".

### Giao thức (JSON qua `/ws`)

- Client → server: `login`, `pos {x,y}`, `act {a, target}`, `stop`, `chat`, `respawn`, `talk {id}`, `buy {item}`, `sell`, `ping`
- Server → client: `welcome` (map, catalog), `tick {c, add, upd:[id,x,y,hp%,flags], del, ev}`, `me` (chỉ số riêng), `correct`/`teleport`, `chat`, `err`, `loot`, `xp`, `shop`, `dialog`, `kicked`, `pong`

Bảo vệ cơ bản: giới hạn 64 KB/frame, tối đa 60 message/giây/client (vượt sẽ bị ngắt kết nối), validate tên và mật khẩu, mỗi nhân vật chỉ có một session (đăng nhập lại sẽ kick session cũ), không gửi tick cho client chậm có buffer > 1 MB, và static file chỉ phục vụ theo whitelist.

## Kết quả kiểm thử

- `npm test`: 13/13 pass. Các test phủ world gen (liên thông, deterministic), AI (aggro, leash, passive), movement anti-cheat, combat, chết/hồi sinh, lên level, mua bán, persistence, và một kịch bản end-to-end qua WebSocket (2 người chơi, chat, teleport bị chặn, giết quái, shop, đăng nhập lại khôi phục vị trí và XP, kick session trùng).
- Load test trên một máy: **200 bot** cùng lúc → tick trung bình ~22 ms trên ngân sách 100 ms, 0 lần correction sai, khoảng 20 KB/s cho mỗi client.

## Giới hạn và hướng mở rộng

- Đồ hoạ 2D vẽ bằng canvas, không dùng asset 3D của Ryzom. Bước tiếp theo tự nhiên là load `.shape` hoặc `.zone` qua NeL.
- Toàn bộ shard chạy trong một process. Muốn scale ngang thì tách FES ra nhiều process, giống cách Ryzom tách FES/EGS/AIS qua NeL `CUnifiedNetwork` và mirror service.
- Chưa có party/guild, quest, crafting/forage, PvP hay outpost — đó là các hệ thống lớn của Ryzom có thể thêm dần vào `egs.js`.
