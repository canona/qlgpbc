'use strict';

// OCR offline bằng Tesseract (gói tesseract-ocr + tesseract-ocr-vie cài trong
// Docker image) — không gọi bất kỳ dịch vụ AI online nào, không cần API key.
// Dùng cho nhánh "1.5" của worker: PDF scan (không có lớp text) được render
// ảnh ở 300 DPI, OCR từng trang thành text thô, rồi đưa qua bộ phân tích
// luật parse.js giống hệt nhánh lớp text.
//
// Biến môi trường:
//   OCR_OFFLINE=off  -> tắt hẳn nhánh OCR offline (rơi về hành vi cũ:
//                       chỉ còn nhánh gateway / chờ tích hợp).
//   OCR_DPI=300      -> độ phân giải render khi OCR (mặc định 300).
//   OCR_LANGS=vie+eng-> ngôn ngữ Tesseract (mặc định vie+eng).

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pdf = require('./pdf');

const OCR_LANGS = process.env.OCR_LANGS || 'vie+eng';
const OCR_DPI = parseInt(process.env.OCR_DPI || '300', 10) || 300;
// Ngân sách thời gian OCR cho mỗi trang: scan A4 ở 300 DPI trên CPU thường
// mất vài giây tới ~20 giây; cho tối đa 120 giây/trang để không kẹt hàng đợi.
const PAGE_TIMEOUT_MS = 120000;

function isEnabled() {
  return String(process.env.OCR_OFFLINE || '').toLowerCase() !== 'off';
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      Object.assign({ maxBuffer: 64 * 1024 * 1024 }, opts || {}),
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
        } else resolve(stdout);
      }
    );
  });
}

let availabilityCache = null;

// Kiểm tra tesseract có mặt và có dữ liệu ngôn ngữ tiếng Việt hay không.
// Kết quả được cache trong vòng đời tiến trình (môi trường container cố định).
async function checkAvailable() {
  if (availabilityCache) return availabilityCache;
  try {
    const out = await run('tesseract', ['--list-langs'], { timeout: 15000 });
    const langs = String(out || '');
    const hasVie = /(^|\s)vie(\s|$)/.test(langs) || langs.includes('\nvie');
    availabilityCache = hasVie
      ? { ok: true, detail: 'tesseract sẵn sàng (có dữ liệu vie)' }
      : { ok: false, detail: 'tesseract có mặt nhưng thiếu dữ liệu ngôn ngữ vie' };
  } catch (e) {
    availabilityCache = {
      ok: false,
      detail: 'không chạy được lệnh tesseract (chưa cài tesseract-ocr?): ' + (e.code || e.message),
    };
  }
  return availabilityCache;
}

// Hậu xử lý tối thiểu cho text OCR trước khi đưa vào parse.js:
// - Gộp khoảng trắng thừa cuối dòng, bỏ ký tự điều khiển lạ.
// - Sửa các nhầm lẫn có hệ thống quanh mẫu số giấy phép và ngày tháng:
//   OCR hay đọc "/GP-" thành "/OP-" hoặc chèn khoảng trắng trong mã cơ quan;
//   chỉ sửa trong đúng ngữ cảnh mẫu số GP để không đụng nội dung khác.
function normalizeOcrText(raw) {
  let text = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n');
  // "485 /GP-BTT TT" -> "485/GP-BTTTT"; "24/GP-C8C" không sửa bừa: chỉ xử lý
  // khoảng trắng và ký tự O<->0 trong phần số đứng trước "/GP-".
  text = text.replace(/(\d)\s+\/\s*(GP-)/g, '$1/$2');
  text = text.replace(/(\d+)\s*\/\s*GP-\s+/g, '$1/GP-');
  // Mã cơ quan bị tách khoảng trắng: "GP-BTT TT" -> "GP-BTTTT"
  text = text.replace(/(GP-[A-ZĐ]{2,})\s+([A-ZĐ]{1,3})(?![A-ZĐa-zà-ỹ])/g, '$1$2');
  // Tên miền bị chèn khoảng trắng sau dấu chấm: "dttg. bienphong.com.vn"
  text = text.replace(/(\w)\.\s+(?=(?:[a-z0-9-]+\.)*(?:com\.vn|vn|com|net|org)\b)/gi, '$1.');
  return text;
}

// OCR một file PDF: render trang ở OCR_DPI rồi chạy tesseract từng trang.
// Trả về { text, pagesOcred, pageTimingsMs } — text đã qua normalizeOcrText,
// các trang nối nhau bằng ký tự form-feed giống đầu ra pdftotext.
async function ocrPdfToText(pdfPath, opts) {
  const options = opts || {};
  const maxPages = options.maxPages || 10;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlgp-ocr-offline-'));
  const pageTimingsMs = [];
  try {
    const images = await pdf.renderPagesToImages(pdfPath, tmpDir, maxPages, OCR_DPI);
    if (!images.length) throw new Error('Không render được trang nào của PDF để OCR offline');
    const pageTexts = [];
    for (const img of images) {
      const started = Date.now();
      const out = await run('tesseract', [img, 'stdout', '-l', OCR_LANGS, '--psm', '1'], {
        timeout: PAGE_TIMEOUT_MS,
      });
      pageTimingsMs.push(Date.now() - started);
      pageTexts.push(String(out || ''));
    }
    return {
      text: normalizeOcrText(pageTexts.join('\f')),
      pagesOcred: images.length,
      pageTimingsMs,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { isEnabled, checkAvailable, ocrPdfToText, normalizeOcrText, OCR_DPI, OCR_LANGS };
