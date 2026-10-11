'use strict';

// Worker hàng đợi trích xuất: chạy nền theo chu kỳ (mặc định 60 giây),
// mỗi lượt xử lý một lô job đang chờ. Chiến lược giảm chi phí token:
//   1) Ưu tiên lớp text có sẵn trong PDF (poppler — miễn phí).
//   2) Chỉ khi PDF là bản scan mới gọi AI gateway (OCR/LLM), và giới hạn
//      số trang đưa qua gateway theo MAX_OCR_PAGES.
//   3) Job trùng file (SHA-256) không bao giờ vào hàng đợi lần hai
//      (khử trùng tại endpoint tiếp nhận).

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const pdf = require('./pdf');
const { parseLicenseText, mergeFields, sanitizeFields } = require('./parse');
const gateway = require('./gateway');
const { nowIso } = require('./util');

const BATCH_SIZE = 3;
const MAX_OCR_PAGES = parseInt(process.env.MAX_OCR_PAGES || '10', 10);
const INTERVAL_MS = Math.max(10, parseInt(process.env.WORKER_INTERVAL_SECONDS || '60', 10)) * 1000;

let running = false;
let timer = null;
let kickTimer = null;

async function processJob(job) {
  const db = store.getDb();
  const pdfPath = path.join(store.getUploadDir(), job.storedFile || '');
  job.status = 'processing';
  job.updatedAt = nowIso();
  job.error = '';
  await store.save();
  try {
    if (!job.storedFile || !fs.existsSync(pdfPath)) {
      throw new Error('Không tìm thấy file PDF đã lưu của job');
    }
    const text = await pdf.extractTextLayer(pdfPath);
    job.rawText = String(text || '').slice(0, 200000);
    job.pages = await pdf.pdfPageCount(pdfPath);

    // Nhánh 1: có lớp text -> phân tích bằng luật, không tốn token
    if (pdf.hasUsableTextLayer(text)) {
      job.result = parseLicenseText(text);
      job.method = 'text';
      job.status = 'done';
      job.note = 'Trích xuất từ lớp text có sẵn trong PDF (không dùng AI gateway)';
      job.updatedAt = nowIso();
      await store.save();
      return;
    }

    // Nhánh 2: PDF scan -> cần AI gateway
    const cfg = gateway.getAiConfig();
    if (!gateway.isConfigured(cfg)) {
      job.status = 'waiting_integration';
      job.method = '';
      job.note = 'PDF không có lớp text (bản scan) và AI gateway chưa được cấu hình — job chờ tích hợp gateway';
      job.updatedAt = nowIso();
      await store.save();
      return;
    }
    const totalPages = job.pages || MAX_OCR_PAGES;
    const pagesToSend = Math.min(totalPages, MAX_OCR_PAGES);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlgp-ocr-'));
    try {
      const images = await pdf.renderPagesToImages(pdfPath, tmpDir, pagesToSend);
      if (!images.length) throw new Error('Không render được trang nào của PDF để OCR');
      const aiFields = await gateway.extractFieldsFromImages(images, cfg);
      // Gộp thêm kết quả phân tích luật từ phần text ít ỏi (nếu có) — chỉ lấp chỗ trống
      const merged = mergeFields(sanitizeFields(aiFields), parseLicenseText(text));
      job.result = merged;
      job.method = 'gateway';
      job.status = 'done';
      job.note =
        totalPages > pagesToSend
          ? `Đã OCR ${pagesToSend}/${totalPages} trang đầu qua AI gateway (giới hạn MAX_OCR_PAGES=${MAX_OCR_PAGES})`
          : `Đã OCR qua AI gateway (${pagesToSend} trang)`;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    job.updatedAt = nowIso();
    await store.save();
  } catch (e) {
    job.status = 'error';
    job.error = String(e && e.message ? e.message : e).slice(0, 1000);
    job.updatedAt = nowIso();
    await store.save();
  }
}

async function processBatch() {
  if (running) return { processed: 0, skipped: true };
  running = true;
  let processed = 0;
  try {
    const db = store.getDb();
    const candidates = db.jobs
      .filter((j) => j.status === 'queued' || j.status === 'waiting_integration')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(0, BATCH_SIZE);
    for (const job of candidates) {
      await processJob(job);
      processed++;
    }
    // Thống kê cho màn hình hàng đợi / kiểm tra nhanh
    const waiting = db.jobs.filter((j) => j.status === 'waiting_integration').length;
    return { processed, waitingIntegration: waiting };
  } finally {
    running = false;
  }
}

function startWorker() {
  if (timer) return;
  // Lượt đầu chạy sớm sau khi khởi động để job tồn đọng được xử lý ngay
  setTimeout(() => {
    processBatch().catch((e) => console.error('[worker]', e.message));
  }, 3000).unref();
  timer = setInterval(() => {
    processBatch().catch((e) => console.error('[worker]', e.message));
  }, INTERVAL_MS);
  timer.unref();
  console.log(`[worker] Hàng đợi trích xuất chạy mỗi ${INTERVAL_MS / 1000}s, lô tối đa ${BATCH_SIZE} job`);
}

// Đánh thức worker sớm (sau khi có job mới hoặc sau khi lưu cấu hình gateway)
function kick() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    processBatch().catch((e) => console.error('[worker]', e.message));
  }, 1000);
  kickTimer.unref();
}

module.exports = { processBatch, processJob, startWorker, kick, MAX_OCR_PAGES };
