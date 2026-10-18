# Phi Đội Giấy Online · Đà Nẵng

**Một bầu trời chung. Cùng nhau giữ lấy phố biển.**

Đây là bản MMO của **Phi Đội Giấy · Đà Nẵng**, game không chiến máy bay giấy 3D trong repo PaperWorld (branch `claude/zen-gauss-3pxtg6`, thư mục `phidoi/`). Bản gốc là game một người chơi với 6 nhiệm vụ. Ở bản này, mọi phi công bay chung một bầu trời Đà Nẵng:

- Băng Mực Đen tuần tra khắp bờ biển.
- Chúng định kỳ đánh vào các địa danh thật: Mỹ Khê, Cầu Rồng, Sơn Trà, Non Nước, Hội An.
- Mực Khổng Lồ trồi lên giữa vịnh, cần nhiều phi công cùng đánh.
- Quanh Cù Lao Chàm là vùng trời tự do, nơi phi công được bắn nhau.

Phần server chia service giống `mini_atys` và Ryzom Core (tick, frontend, EGS, AI, chat, lưu trữ). Server giữ quyền quyết định: AI địch, sát thương, máu, đạn, phần thưởng và sự kiện thế giới đều chạy trên server.

- **Không có dependency npm**, chỉ cần Node.js ≥ 22. WebSocket tự viết.
- **Client** là file HTML three.js của Phi Đội Giấy, giữ nguyên bản đồ Đà Nẵng – Hội An dựng tay, flight model, HUD, nhạc "Phi Đội FM" và điều khiển cảm ứng/tay cầm. Lớp nhiệm vụ một người chơi được thay bằng lớp mạng.

## Chạy

```bash
cd phidoi_online
npm start              # http://localhost:8090 — mở nhiều tab/máy để bay chung
npm run dev            # thêm lệnh GM: /tp x y z · /raid · /boss · /xu N · /lvl N
npm test               # 16 test gameplay + 1 test end-to-end qua WebSocket
npm run bots -- 100 30 # load test 100 bot trong 30 giây (server phải đang chạy)
```

Tuỳ chọn: `--port 8090`, `--data ./data`, `--dev`, hoặc các biến môi trường `PORT`, `DATA_DIR`, `DEV`.
Chạy bằng Docker: `docker build -t phidoi-online . && docker run -p 8090:8090 -v phidoi:/data phidoi-online`.

Trình duyệt tải three.js 0.170 từ jsDelivr, giống bản gốc. Lần đăng nhập đầu với một tên mới (được dùng tiếng Việt có dấu) sẽ tạo phi công; mật khẩu được lưu bằng scrypt.

## Thế giới

| | Cái gì | Ở đâu / khi nào |
|---|---|---|
| 🏢 | **Ahamove Sky Hub**: nơi xuất phát và hồi sinh, Hangar. Băng Mực Đen không vào được | bên sông Hàn, bán kính 380 m |
| 🔧 | **Bãi chữ H**: đáp xuống để sửa máy bay và nạp tên lửa, pháo sáng. Thủy phi cơ đáp xuống biển cũng tự vá cánh | Sky Hub, bờ Mỹ Khê, Hội An, cảng Tiên Sa |
| 🪁✈ | **Tuần tra**: khoảng 34 diều mực và 8 cặp phi cơ giấy than; một Quạ Đen lượn qua lại giữa các vùng | khắp bản đồ, hồi sinh sau 25–60 giây |
| ⚠ | **Raid**: Băng Mực Đen tấn công một địa danh theo 3 đợt (lấy từ 6 nhiệm vụ gốc). Số địch tăng theo số phi công có mặt (tối đa ×3). Oanh tạc cơ thả bom mực làm giảm độ nguyên vẹn của địa danh | khoảng 2,5 phút sau mỗi raid; địa danh về 0% thì thất thủ |
| 🦑 | **World boss Mực Khổng Lồ**: phá 6 túi mực tím để lộ trái tim mực. Boss phóng tên lửa mực, bắn chùm mực và gọi thêm quân | vịnh Đà Nẵng, mỗi 15 phút; lặn mất sau 12 phút nếu chưa bị hạ |
| ⚔ | **Vùng trời tự do**: đạn và tên lửa trúng được phi công khác (khi cả hai đều ở trong vùng) | vòng 1,3 km quanh Cù Lao Chàm |
| 📦 | **Thùng Ahamove**: 🔧 sửa máy bay · 🚀 tên lửa · ✦ pháo sáng. Bay xuyên qua để nhận | địch rơi có 15% cơ hội để lại thùng; boss rơi 6 thùng |

Giờ trong game theo giờ Đà Nẵng thật (UTC+7), nên mọi người cùng thấy một bầu trời. Có thể đổi giờ bằng `?hour=17`.

## Tiến trình

- **XP và xu Ahamove**: mỗi lần hạ địch, ai có góp sát thương đều được thưởng theo phần đóng góp (tối thiểu 35%). Giữ được địa danh trong raid thưởng thêm theo % địa danh còn nguyên. Hạ phi công khác trong vùng PvP được "tiền thưởng" theo cấp của người bị hạ.
- **30 cấp**: mỗi cấp tăng +3% độ bền và +2% sát thương.
- **Phi cơ**: ✈ phản lực giấy (cấp 1) · 🛩 thủy phi cơ (cấp 4) · 🚁 trực thăng Ahamove (cấp 7). Đổi phi cơ ở Sky Hub hoặc khi đang đậu trên bãi chữ H.
- **Hangar** (phím `U`): mỗi món có 5 cấp, giá 150 → 2200 xu.
  - Súng: +12% sát thương mỗi cấp.
  - Giáp giấy: +12% độ bền mỗi cấp.
  - Tên lửa: +1 quả và +10% sát thương mỗi cấp.
  - Pháo sáng: +2 quả mỗi cấp.
- Bảng xếp hạng có trong Hangar, hoặc gõ `/top` và `/pvp` trong chat.

## Điều khiển

Giữ nguyên điều khiển của Phi Đội Giấy: `W/S` ngóc/chúc, `A/D` nghiêng, `Q/E` bánh lái, `SHIFT` đốt sau, `SPACE` hoặc chuột trái bắn, `F` hoặc chuột phải phóng tên lửa, `G` thả pháo sáng, `TAB` đổi mục tiêu, `V` lộn né đạn, `C` đổi góc máy, `M` bản đồ, `R` gấp máy bay mới sau khi rơi.

Bản online thêm:
- `ENTER`: chat với cả phi đội. Các lệnh `/who`, `/top`, `/pvp`, `/home`.
- `U`: mở Hangar.
- `ESC`: mở menu (Về Sky Hub / Đăng xuất). Thế giới chung nên **không có tạm dừng**.

Trên điện thoại có thêm nút 💬 (chat) và 🛠 (Hangar).

## Kiến trúc

```
Trình duyệt (client/index.html — three.js, bản đồ Đà Nẵng, flight model)
  │  WebSocket JSON · client gửi vị trí 20 Hz, báo trúng đạn mỗi 100 ms · server gửi snapshot 20 Hz
  ▼
frontend.js ── players.js ── combat.js ── enemies.js ── events.js
  │                 ▲                           ▲
  ├ chat.js         └──── shared/rules.js       └── shared/geo.js (địa hình Đà Nẵng, giống hệt client)
  └ persistence.js        tick.js: players → enemies → đạn/tên lửa → thùng → sự kiện → frontend
```

| Ryzom Core / mini_atys | Phi Đội Giấy Online | Vai trò |
|---|---|---|
| `tick_service` | `server/tick.js` | Game cycle 20 Hz (50 ms) |
| `frontend_service` (`distance_prioritizer`) | `server/frontend.js`, `server/net/websocket.js` | Đăng nhập, snapshot theo tầm nhìn. ~10 thực thể gần nhất cập nhật 20 Hz, xa hơn thì 10/5/4 Hz, cả theo khoảng cách lẫn thứ hạng, nên một đám đông không thể làm nghẽn một client |
| EGS (nhân vật, combat) | `server/players.js`, `server/combat.js` | Độ bền, đạn dược, sửa chữa, XP/xu, nâng cấp, chết và hồi sinh, xác thực đòn trúng |
| `ai_service` | `server/enemies.js`, `server/events.js` | AI của Phi Đội Giấy (bám đuôi dẫn bắn, bẻ lái né khi bị bám đuôi hoặc bị khoá tên lửa, chia lượt tấn công, oanh tạc cơ, Mực Khổng Lồ), nay chọn mục tiêu trong số nhiều phi công; tuần tra, raid, world boss |
| GPMS `move_checker` | `shared/geo.js` + `players.clientState()` | Kiểm tra tốc độ theo phi cơ, giới hạn vùng bay; số thứ tự `seq` loại bỏ các báo cáo vị trí đã cũ sau khi bị dịch chuyển hoặc sửa vị trí |
| IOS (chat) | `server/chat.js` | Kênh chung, lệnh, giới hạn tốc độ chat |
| PDS / backup | `server/persistence.js` | JSON ghi atomic, tự lưu mỗi 30 giây và khi đăng xuất |
| admin service | `GET /status` | Tick time, số phi công và địch, băng thông, raid và boss, bảng xếp hạng |

**Ai quyết định cái gì.** Client tự lái máy bay của mình (giống client Ryzom) và tự mô phỏng đạn vạch, tên lửa của mình để bắn có cảm giác tức thì. Các đòn trúng được báo lên server, và server kiểm tra trước khi tính:
- **Ngân sách đạn**: số viên được tính trúng không vượt quá số viên súng thực sự bắn ra, theo tốc độ bắn của phi cơ.
- **Tầm bắn hợp lệ** giữa phi công và mục tiêu.
- **Tên lửa** phải được phóng (và trừ khỏi giá) trước khi được tính trúng.
- **PvP** chỉ tính khi cả hai phi công đều ở trong vùng tự do.

Đạn, bom, tên lửa của địch đều do server mô phỏng và trúng vào vị trí phi công đã báo. Server gửi sự kiện để client vẽ lại, và gửi `hurt`/`down` để client hiện hiệu ứng.

**Địa hình chung.** `shared/geo.js` được trích nguyên văn từ mã nguồn Phi Đội Giấy (noise và hàm `sample()` của bản đồ Đà Nẵng – Hội An). Test kiểm tra giá trị của nó khớp tuyệt đối với giá trị đo trong trình duyệt. Nhờ vậy AI của server né được núi Sơn Trà, Ngũ Hành Sơn, Bà Nà, và đạn, bom chạm đúng mặt đất mà người chơi nhìn thấy.

## Kết quả kiểm thử

- `npm test`: **17/17 pass**. Các test phủ:
  - Địa hình khớp trình duyệt.
  - AI tấn công, nhưng không vào được Sky Hub.
  - Ngân sách đạn, tầm bắn, chia thưởng.
  - Tên lửa phải phóng mới được tính; pháo sáng làm lạc tên lửa.
  - Giáp tim Mực Khổng Lồ; PvP chỉ trong vùng.
  - Chống speed-hack, `seq` loại báo cáo cũ sau khi dịch chuyển.
  - Sửa máy bay ở bãi đáp; lên cấp, mở khoá phi cơ, nâng cấp.
  - Thùng tiếp tế; raid thắng và thua.
  - Lưu trữ với tên tiếng Việt.
  - Kịch bản WebSocket đầy đủ: 2 phi công, chat, bị sửa vị trí, hạ diều mực, tự rơi rồi hồi sinh, đăng nhập lại, đăng nhập trùng bị kick.
- **Trình duyệt (Chromium)**: hai phi công thấy nhau. Bắn trúng diều mực được server tính. PvP ở Cù Lao Chàm làm máu đối thủ giảm từ 100 xuống 86. World boss, Hangar, bản đồ và giao diện cảm ứng hiển thị đúng; không có lỗi JavaScript.
- **Load test 100 bot** trên một máy:
  - Tick trung bình ~6 ms trên ngân sách 50 ms.
  - Không có lần sửa vị trí nhầm nào.
  - Băng thông ~34 KB/s mỗi client trong trường hợp xấu nhất, khi cả 100 máy bay chen nhau một chỗ.

## Quay video quảng bá

`tools/film.js` dựng video 30 giây với 4 phi công thật (Linh, Quân, Mai, Tuấn) đăng nhập vào cùng một shard. Video gồm 7 cảnh:

1. Biển Mỹ Khê lúc bình minh
2. Tượng Quan Âm chùa Linh Ứng, Sơn Trà
3. Cầu Vàng, Bà Nà
4. Ngũ Hành Sơn
5. Cầu Rồng lúc hoàng hôn
6. Phố cổ Hội An lên đèn
7. Trận đánh world boss Mực Khổng Lồ có hiện HUD, kết bằng màn hình giới thiệu game

```bash
PLAYWRIGHT=/đường/dẫn/playwright node tools/film.js --out promo.mp4   # 1920×1080, 30 fps (cần ffmpeg)
node tools/film.js --stills --only sontra,bana                         # vài khung mẫu mỗi cảnh, để chỉnh bố cục
```

Cách công cụ hoạt động:
- **Đồng hồ ảo.** Server chạy ngay trong tiến trình của công cụ. Mỗi khung hình, nó bước server thêm đúng 1/30 giây, rồi bước 4 trình duyệt cùng nhịp (`requestAnimationFrame` và `performance.now` đều chạy theo đồng hồ ảo). Vì vậy video vẫn mượt dù máy render chậm, kể cả chỉ có CPU.
- **Chế độ đạo diễn.** Kịch bản chỉ điều khiển đường bay (`game.director.pose`) và camera (`game.director.cam`). Còn lại đều là game thật: mạng, nội suy máy bay của người khác, đạn, sự kiện world boss, chat.
- **Chạy khi không có internet.** Đặt `THREE_JS` và `FONTS_DIR` để phục vụ three.js và Google Fonts từ ổ đĩa.

## Giới hạn và hướng tiếp theo

- Toàn bộ shard chạy trong một process. Muốn mở rộng thì tách frontend ra nhiều process, như Ryzom.
- Va chạm với nhà cao tầng chỉ có ở client. Server chỉ biết địa hình, vì collider của toà nhà được dựng cùng mô hình 3D phía client.
- Chưa có party hoặc phi đội cố định, kênh chat riêng, nhiệm vụ cá nhân hằng ngày, hay mua bán giữa người chơi.
