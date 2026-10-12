# QLGP Báo Chí — Mã nguồn self-host

Ứng dụng web quản lý hồ sơ giấy phép báo chí: tải PDF giấy phép lên, trích xuất thông tin thành bản ghi có cấu trúc, hiển thị dạng bảng, tìm kiếm theo cơ quan và các trường liên quan. Kèm API hàng đợi cho ứng dụng thứ ba (gửi PDF → nhận `job_id` → tra kết quả trích xuất) và tích hợp AI gateway tự host cho các PDF dạng scan.

Ngoài tải file trực tiếp, trang "Tải PDF lên" và API còn hỗ trợ **nhập từ Google Drive**: dán link chia sẻ của file PDF, máy chủ tự tải về và trích xuất (file phải được chia sẻ ở chế độ "Bất kỳ ai có liên kết đều xem được"). Endpoint API: `POST /api/extraction-jobs/from-drive` với body JSON `{"url": "<link Drive>"}`.

Ứng dụng viết bằng Node.js thuần (không phụ thuộc thư viện ngoài), dữ liệu lưu trong một file JSON (`store.json`) + thư mục `uploads/` chứa PDF gốc, tất cả nằm trong thư mục dữ liệu (Docker volume) nên sao lưu rất đơn giản.

## Chạy bằng Docker Compose (khuyến nghị — đúng cách triển khai lên Coolify)

```bash
cp .env.example .env
# Sửa .env nếu cần (cổng, AI gateway...)
docker compose up -d --build
```

Mở trình duyệt tại `http://localhost:18080` (cổng host mặc định, đổi được qua biến `HOST_PORT` trong `.env`).

## Chạy trực tiếp bằng Node (không Docker)

Yêu cầu: Node.js ≥ 20 và gói `poppler-utils` (cung cấp `pdftotext`, `pdfinfo`, `pdftoppm`).

```bash
# Debian/Ubuntu: sudo apt-get install -y poppler-utils
DATA_DIR=./data PORT=3000 node server.js
```

## Biến môi trường (file `.env`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `HOST_PORT` | `18080` | Cổng HTTP phía host (tránh xung đột); cổng trong container luôn là 3000 |
| `APP_BASE_URL` | `https://qlgpbc.vtcdigital.top` | Địa chỉ công khai, dùng hiển thị ví dụ API trong trang Hàng đợi |
| `AI_GATEWAY_URL` | `https://qlgpbc.vtcdigital.top/ai` | Địa chỉ AI gateway tương thích OpenAI (có thể cấu hình lại trong trang Cài đặt) |
| `AI_GATEWAY_API_KEY` | _(trống)_ | API key của gateway (hoặc nhập trong trang Cài đặt — key lưu phía server, chỉ hiển thị dạng che) |
| `AI_GATEWAY_MODEL` | _(trống)_ | Model dùng cho trích xuất OCR/LLM |
| `DATA_DIR` | `/app/data` (trong Docker) | Thư mục chứa `store.json` và `uploads/` |
| `MAX_OCR_PAGES` | `10` | Giới hạn số trang đưa qua gateway cho mỗi job (giảm chi phí token) |
| `WORKER_INTERVAL_SECONDS` | `60` | Chu kỳ worker quét hàng đợi trích xuất |

## Kiến trúc ngắn gọn

- `server.js` — máy chủ HTTP, điều phối route.
- `lib/routes-pages.js` — giao diện quản trị (Hồ sơ giấy phép / Hàng đợi API / Cài đặt AI Gateway).
- `lib/routes-api.js` — API JSON: `/api/licenses`, `/api/licenses/import`, `/api/licenses/extract`, `/api/extraction-jobs`, `/api/settings/ai`, `/api/stats`.
- `lib/worker.js` — worker nền xử lý hàng đợi mỗi 60 giây: ưu tiên lớp text của PDF (miễn phí, qua `pdftotext`), chỉ PDF scan mới gọi AI gateway; khử trùng lặp theo SHA-256 tại endpoint tiếp nhận.
- `lib/drive.js` — tải PDF từ Google Drive theo link chia sẻ công khai (tự dựng URL tải từ file ID, kiểm tra chữ ký PDF, giới hạn 30 MB).
- `lib/parse.js` — phân tích văn bản giấy phép thành các trường bằng luật + ánh xạ JSON trích xuất bên ngoài (định dạng PascalCase 39 trường).
- `lib/store.js` — tầng dữ liệu JSON (ghi nguyên tử).
- `deploy/` — ví dụ chia đường dẫn trên cùng tên miền `qlgpbc.vtcdigital.top`: ứng dụng ở `/`, AI gateway ở `/ai/` — cho Cloudflare Tunnel (`cloudflared-config.yml`) và cho Traefik/Coolify (`traefik-coolify.yml`, có cắt tiền tố `/ai` trước khi chuyển tiếp).

## Triển khai lên Coolify

1. Đẩy thư mục này lên một Git repo (GitHub).
2. Trong Coolify: tạo ứng dụng mới từ repo, chọn build bằng Dockerfile (hoặc Docker Compose với `docker-compose.yaml` sẵn có).
3. Khai báo các biến môi trường như bảng trên trong phần Environment của Coolify; đặt tên miền `qlgpbc.vtcdigital.top` cho ứng dụng.
4. Nếu AI gateway chạy ở service khác, áp dụng một trong hai ví dụ trong `deploy/` để chia đường dẫn `/ai`.

## Lưu ý bảo mật

- Ứng dụng không có sẵn cơ chế đăng nhập — hãy đặt sau Cloudflare Access hoặc reverse proxy có xác thực nếu mở ra Internet.
- API key của gateway chỉ lưu phía server và mọi phản hồi API/giao diện đều hiển thị dạng che (chỉ lộ 4 ký tự cuối).
