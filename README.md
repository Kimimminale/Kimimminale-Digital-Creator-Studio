# VideoFlow — Secure publishing backend

Ứng dụng này thêm một backend Node.js cho giao diện Creator Studio. API key, OAuth client secret và access token **không có trong `app.js`** và không được trả về API cho trình duyệt.

## Chạy cục bộ

```bash
cp .env.example .env
# Điền khóa ngẫu nhiên và OAuth credentials từ từng nền tảng
npm start
```

Mở `http://localhost:3000`. Để kiểm tra cú pháp, chạy `npm run check`.

## Luồng bảo mật và lưu trữ

- `POST /api/videos` nhận video rồi lưu trong object-storage adapter. Bản mẫu dùng đĩa cục bộ (`storage/videos`); thay adapter này bằng S3/R2/GCS trước production.
- `POST /api/campaigns` lưu video, tiêu đề, mô tả, nền tảng, thời điểm và trạng thái; đồng thời tạo một job cho từng nền tảng.
- Access/refresh token OAuth được AES-256-GCM mã hóa trước khi ghi database. Khóa lấy từ `TOKEN_ENCRYPTION_KEY`; session cookie là `HttpOnly` và có chữ ký.
- OAuth dùng `state`, thời hạn phiên 10 phút và PKCE `S256`. Chỉ credentials phía server được dùng để đổi authorization code.
- Scheduler quét job mỗi 15 giây, đổi token gần hết hạn và retry tối đa 3 lần với exponential backoff. Trạng thái/lỗi được ghi vào API dashboard.

## Triển khai production

`JsonDatabase` và `LocalObjectStorage` có chủ ý là adapter không phụ thuộc package để dự án chạy ngay. Với production, thay chúng bằng PostgreSQL + migration và S3/R2/GCS; chạy `processQueue` trong worker riêng dùng hàng đợi bền vững (BullMQ/SQS/Cloud Tasks). Cấu hình OAuth redirect URI của từng nền tảng thành:

```text
https://your-domain/api/oauth/{youtube|tiktok|instagram|facebook}/callback
```

Trước khi bật đăng thật, hoàn tất phần multipart/resumable upload riêng cho API của từng nền tảng trong `publishJob`. Điều này là cần thiết vì YouTube, TikTok, Instagram và Facebook có định dạng upload, quyền, review app và hạn mức API khác nhau. Backend cố tình báo lỗi/retry thay vì giả vờ đã đăng khi adapter chưa hoàn tất.
