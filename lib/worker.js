'use strict';

// Worker hàng đợi trích xuất: chạy nền theo chu kỳ (mặc định 60 giây),
// mỗi lượt xử lý một lô job đang chờ. Chiến lược giảm chi phí token:
//   1) Ưu tiên lớp text có sẵn trong PDF (poppler — miễn phí).
//   1.5) PDF scan -> OCR offline bằng Tesseract trong container (miễn phí,
//        không cần API key, không gọi AI online) — xem lib/ocr.js.
//        Tắt bằng biến môi trường OCR_OFFLINE=off.
//   2) Chỉ khi OCR offline không dùng được mới gọi AI gateway (OCR/LLM),
//      và giới hạn số trang đưa qua gateway theo MAX_OCR_PAGES.
//   3) Job trùng file (SHA-256) không bao giờ vào hàng đợi lần hai
//      (khử trùng tại endpoint tiếp nhận).

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const pdf = require('./pdf');
const { parseLicenseText, mergeFields, sanitizeFields, fieldConfidence, licenseNumberFromLabel, buildCrossCheck } = require('./parse');
const gateway = require('./gateway');
const ocr = require('./ocr');
const { nowIso } = require('./util');

const BATCH_SIZE = 3;
const MAX_OCR_PAGES = parseInt(process.env.MAX_OCR_PAGES || '10', 10);
const INTERVAL_MS = Math.max(10, parseInt(process.env.WORKER_INTERVAL_SECONDS || '60', 10)) * 1000;

let running = false;
let timer = null;
let kickTimer = null;

// Đối chiếu số GP của job với các bản ghi giấy phép ĐÃ CÓ trong store
// (chỉ để hiển thị gợi ý cho người duyệt — không bao giờ tự sửa giá trị).
// 'exact': trùng nguyên dạng sau khi bỏ khoảng trắng/hoa thường;
// 'partial': phần số trùng nhưng hậu tố khác, hoặc hậu tố trùng mà phần
// số chỉ lệch đúng 1 ký tự (đáng ngờ OCR đọc sai, hoặc hồ sơ trùng lặp).
function findStoreMatches(licenses, soGiayPhep) {
  const so = String(soGiayPhep || '').replace(/\s+/g, '').toUpperCase();
  if (!so) return [];
  const numPart = (s) => (/^(\d+)/.exec(s) || [])[1] || '';
  const suffixPart = (s) => s.slice(numPart(s).length);
  const out = [];
  for (const lic of licenses || []) {
    const otherSo = (lic.fields && lic.fields.soGiayPhep) || '';
    const other = String(otherSo).replace(/\s+/g, '').toUpperCase();
    if (!other) continue;
    if (other === so) {
      out.push({ soGiayPhep: otherSo, coQuanBaoChi: (lic.fields && lic.fields.coQuanBaoChi) || '', match: 'exact' });
      continue;
    }
    let partial = false;
    if (numPart(other) && numPart(other) === numPart(so)) partial = true;
    else if (suffixPart(other) === suffixPart(so) && numPart(other).length === numPart(so).length) {
      let diff = 0;
      for (let i = 0; i < numPart(so).length; i++) if (numPart(so)[i] !== numPart(other)[i]) diff++;
      partial = diff === 1;
    }
    if (partial) {
      out.push({ soGiayPhep: otherSo, coQuanBaoChi: (lic.fields && lic.fields.coQuanBaoChi) || '', match: 'partial' });
    }
    if (out.length >= 5) break;
  }
  return out;
}

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
      job.confidence = fieldConfidence(job.result, {
        fromOcr: false,
        soFromLabel: Boolean(job.result.soGiayPhep) && licenseNumberFromLabel(text) === job.result.soGiayPhep,
      });
      job.method = 'text';
      job.status = 'done';
      job.note = 'Trích xuất từ lớp text có sẵn trong PDF (không dùng AI gateway)';
      job.updatedAt = nowIso();
      await store.save();
      return;
    }

    // Nhánh 1.5: PDF scan -> OCR offline (Tesseract trong container).
    // Chạy TRƯỚC nhánh gateway: không cần API key và không tốn token.
    // Chỉ khi OCR offline bị tắt / chưa cài tesseract / text OCR quá ít
    // mới rơi xuống nhánh gateway như trước.
    let ocrFailure = '';
    if (ocr.isEnabled()) {
      const avail = await ocr.checkAvailable();
      if (!avail.ok) {
        ocrFailure = avail.detail;
      } else {
        try {
          const totalPages = job.pages || MAX_OCR_PAGES;
          const ocrRes = await ocr.ocrPdfToText(pdfPath, {
            maxPages: Math.min(totalPages, MAX_OCR_PAGES),
          });
          if (pdf.hasUsableTextLayer(ocrRes.text)) {
            // OCR là nguồn chính; phần lớp text vụn (nếu có, vd chữ ký số)
            // chỉ lấp trường OCR còn trống — giống cách nhánh gateway gộp.
            job.result = mergeFields(parseLicenseText(ocrRes.text), parseLicenseText(text));
            job.confidence = fieldConfidence(job.result, {
              fromOcr: true,
              soFromLabel:
                Boolean(job.result.soGiayPhep) && licenseNumberFromLabel(ocrRes.text) === job.result.soGiayPhep,
            });
            job.rawText = ocrRes.text.slice(0, 200000);
            // Đối chiếu chéo (bản 2): quét toàn text lấy mọi số GP/ứng
            // viên + cảnh báo, và đối chiếu số GP với hồ sơ đã có trong
            // store — chỉ phục vụ người duyệt, không sửa giá trị trích.
            job.crossCheck = buildCrossCheck(ocrRes.text, job.result);
            job.crossCheck.storeMatches = findStoreMatches(db.licenses, job.result.soGiayPhep);
            job.method = 'ocr-offline';
            job.status = 'done';
            job.note =
              totalPages > ocrRes.pagesOcred
                ? `Đã OCR offline (Tesseract, không dùng AI gateway) ${ocrRes.pagesOcred}/${totalPages} trang đầu (giới hạn MAX_OCR_PAGES=${MAX_OCR_PAGES}). Các trường đánh dấu "cần kiểm tra" nên đối chiếu bản gốc.`
                : `Đã OCR offline (Tesseract, không dùng AI gateway) ${ocrRes.pagesOcred} trang. Các trường đánh dấu "cần kiểm tra" nên đối chiếu bản gốc.`;
            job.updatedAt = nowIso();
            await store.save();
            return;
          }
          ocrFailure = `OCR offline chạy được nhưng text thu được quá ít (${String(ocrRes.text || '').replace(/\s/g, '').length} ký tự)`;
        } catch (e) {
          ocrFailure = 'OCR offline lỗi: ' + String(e && e.message ? e.message : e).slice(0, 300);
        }
      }
    } else {
      ocrFailure = 'OCR offline đang tắt (OCR_OFFLINE=off)';
    }

    // Nhánh 2: PDF scan -> cần AI gateway
    const cfg = gateway.getAiConfig();
    if (!gateway.isConfigured(cfg)) {
      job.status = 'waiting_integration';
      job.method = '';
      job.note =
        'PDF không có lớp text (bản scan), OCR offline không dùng được' +
        (ocrFailure ? ` (${ocrFailure})` : '') +
        ' và AI gateway chưa được cấu hình — job chờ tích hợp gateway';
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
      job.confidence = fieldConfidence(job.result, { fromOcr: false });
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
