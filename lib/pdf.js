'use strict';

// Xử lý file PDF bằng bộ công cụ poppler (pdftotext/pdfinfo/pdftoppm),
// được cài trong Docker image (gói poppler-utils).

const { execFile } = require('child_process');
const path = require('path');

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      Object.assign({ maxBuffer: 64 * 1024 * 1024, timeout: 120000 }, opts || {}),
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
        } else resolve(stdout);
      }
    );
  });
}

// Trích lớp text nhúng trong PDF. Trả về chuỗi text thô (có thể rỗng nếu là PDF scan).
async function extractTextLayer(pdfPath) {
  const out = await run('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-']);
  return out.toString('utf8');
}

async function pdfPageCount(pdfPath) {
  try {
    const out = await run('pdfinfo', [pdfPath]);
    const m = /^Pages:\s+(\d+)/m.exec(out.toString('utf8'));
    return m ? parseInt(m[1], 10) : null;
  } catch (e) {
    return null;
  }
}

// Render các trang đầu của PDF scan thành ảnh PNG để đưa qua gateway (OCR/LLM)
// hoặc OCR offline. dpi mặc định 150 (hành vi cũ cho nhánh gateway); nhánh OCR
// offline truyền 300 để Tesseract đọc dấu tiếng Việt tốt hơn.
// Trả về danh sách đường dẫn ảnh đã render.
async function renderPagesToImages(pdfPath, outDir, maxPages, dpi) {
  const prefix = path.join(outDir, 'page');
  const r = dpi && parseInt(dpi, 10) > 0 ? String(parseInt(dpi, 10)) : '150';
  await run('pdftoppm', ['-png', '-r', r, '-f', '1', '-l', String(maxPages), pdfPath, prefix]);
  const fs = require('fs');
  return fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith('page') && f.endsWith('.png'))
    .sort()
    .map((f) => path.join(outDir, f));
}

// Render đúng MỘT trang của PDF ra file PNG (dpi mặc định 200, đủ nét cho
// khổ A4 khi hiển thị toàn chiều rộng cột duyệt). Dùng cho route xem trước
// /preview/<storedFile>?page=N ở màn hình duyệt. outFile là đường dẫn PNG
// đích (pdftoppm -singlefile tự thêm đuôi .png vào tiền tố không đuôi).
async function renderPageToImage(pdfPath, page, outFile, dpi) {
  const r = dpi && parseInt(dpi, 10) > 0 ? String(parseInt(dpi, 10)) : '200';
  const prefix = outFile.replace(/\.png$/i, '');
  await run('pdftoppm', ['-png', '-r', r, '-f', String(page), '-l', String(page), '-singlefile', pdfPath, prefix]);
  return outFile;
}

// Ngưỡng coi là "không có lớp text" (PDF scan): text trích được quá ngắn.
const MIN_TEXT_CHARS = 200;

function hasUsableTextLayer(text) {
  if (!text) return false;
  return String(text).replace(/\s/g, '').length >= MIN_TEXT_CHARS;
}

module.exports = { extractTextLayer, pdfPageCount, renderPagesToImages, renderPageToImage, hasUsableTextLayer, MIN_TEXT_CHARS };
