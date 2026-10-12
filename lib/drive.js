'use strict';

// Tải file PDF từ Google Drive theo link chia sẻ công khai.
// Chỉ chấp nhận link/host của Google Drive; URL tải xuống do module này tự dựng
// từ file ID đã tách, nên không có nguy cơ bị điều hướng tới máy chủ lạ (SSRF).
// File trên Drive phải được chia sẻ ở chế độ "Bất kỳ ai có liên kết đều xem được".

const MAX_BYTES = 30 * 1024 * 1024; // 30 MB
const TIMEOUT_MS = 60000;

// Tách file ID từ các dạng link Drive phổ biến, hoặc nhận thẳng ID.
// Trả về null nếu không nhận diện được.
function parseDriveFileId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s; // người dùng dán thẳng ID
  let u;
  try {
    u = new URL(s);
  } catch (err) {
    return null;
  }
  if (!/(^|\.)drive\.google\.com$/.test(u.hostname) && u.hostname !== 'drive.usercontent.google.com') {
    return null;
  }
  const m = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(u.pathname);
  if (m) return m[1];
  const id = u.searchParams.get('id');
  if (id && /^[A-Za-z0-9_-]{10,}$/.test(id)) return id;
  return null;
}

function fileNameFromDisposition(header, fallback) {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch (err) {
      /* bỏ qua */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  if (plain) return plain[1].trim();
  return fallback;
}

// Tải PDF về bộ nhớ. Trả về { buffer, fileName }.
// Ném Error với thông điệp tiếng Việt rõ ràng cho các tình huống thường gặp.
async function downloadDrivePdf(fileId) {
  const url =
    'https://drive.usercontent.google.com/download?id=' +
    encodeURIComponent(fileId) +
    '&export=download&confirm=t';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
  } catch (err) {
    throw new Error('Không kết nối được tới Google Drive (mạng hoặc quá thời gian chờ).');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error('Google Drive trả lỗi HTTP ' + res.status + ' khi tải file.');
  }
  const declared = parseInt(res.headers.get('content-length') || '0', 10);
  if (declared && declared > MAX_BYTES) {
    throw new Error('File trên Drive lớn hơn giới hạn 30 MB.');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    throw new Error('File trên Drive lớn hơn giới hạn 30 MB.');
  }
  // Drive trả trang HTML khi file chưa chia sẻ công khai hoặc cần xác nhận —
  // kiểm tra chữ ký PDF để phân biệt.
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error(
      'Không tải được file PDF từ Drive. Hãy kiểm tra file đã được chia sẻ ở chế độ "Bất kỳ ai có liên kết đều xem được" và link trỏ đúng tới một file PDF.'
    );
  }
  const name = fileNameFromDisposition(res.headers.get('content-disposition'), 'drive-' + fileId + '.pdf');
  return { buffer: buf, fileName: name };
}

module.exports = { parseDriveFileId, downloadDrivePdf, MAX_BYTES };
