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

// Render các trang đầu của PDF scan thành ảnh PNG để đưa qua gateway (OCR/LLM).
// Trả về danh sách đường dẫn ảnh đã render.
async function renderPagesToImages(pdfPath, outDir, maxPages) {
  const prefix = path.join(outDir, 'page');
  await run('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', String(maxPages), pdfPath, prefix]);
  const fs = require('fs');
  return fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith('page') && f.endsWith('.png'))
    .sort()
    .map((f) => path.join(outDir, f));
}

// Ngưỡng coi là "không có lớp text" (PDF scan): text trích được quá ngắn.
const MIN_TEXT_CHARS = 200;

function hasUsableTextLayer(text) {
  if (!text) return false;
  return String(text).replace(/\s/g, '').length >= MIN_TEXT_CHARS;
}

module.exports = { extractTextLayer, pdfPageCount, renderPagesToImages, hasUsableTextLayer, MIN_TEXT_CHARS };
