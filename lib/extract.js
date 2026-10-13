'use strict';

// Trích xuất một lần (không qua hàng đợi) cho các endpoint đồng bộ:
// POST /api/licenses/extract và màn hình tải lên của quản trị
// (routes-pages renderPdfReview).
//
// Trước đây hai đường này chỉ đọc lớp text của PDF: gặp bản scan là trả
// về 0 trường kèm ghi chú "cần AI gateway", trong khi nhánh OCR offline
// (Tesseract) chỉ tồn tại trong worker hàng đợi. Module này dùng lại
// ĐÚNG logic nhánh 1.5 của worker.processJob cho trường hợp lớp text
// không dùng được: render 300 DPI -> ocr.js -> parse.js với nguồn 'ocr'
// (+ fieldConfidence và buildCrossCheck của bản 2), tôn trọng công tắc
// OCR_OFFLINE=off, khả dụng của tesseract và giới hạn MAX_OCR_PAGES của
// worker. KHÔNG gọi AI gateway ở đây (đường đồng bộ phải trả kết quả
// ngay; gateway vẫn là việc của hàng đợi).

const pdf = require('./pdf');
const ocr = require('./ocr');
const { parseLicenseText, mergeFields, fieldConfidence, licenseNumberFromLabel, buildCrossCheck } = require('./parse');
const worker = require('./worker');

// Thử OCR offline cho một PDF đã biết là KHÔNG có lớp text dùng được.
//   pdfPath:       đường dẫn file PDF đã lưu trên đĩa
//   textLayerText: text lớp text đã trích (có thể vụn/rỗng) — chỉ dùng để
//                  lấp trường OCR còn trống, giống cách worker gộp.
//   totalPages:    số trang PDF (null nếu chưa biết)
//   licenses:      danh sách bản ghi hiện có trong store (để đối chiếu
//                  storeMatches trong crossCheck; có thể bỏ qua)
// Trả về:
//   { ok: true, fields, confidence, crossCheck, rawText, pagesOcred, totalPages }
//   { ok: false, failure } — OCR tắt/hỏng/text quá ít; nơi gọi giữ hành
//   vi cũ và dùng `failure` để ghi chú cho đúng thực tế.
async function tryOcrOffline(pdfPath, textLayerText, totalPages, licenses) {
  if (!ocr.isEnabled()) {
    return { ok: false, failure: 'OCR offline đang tắt (OCR_OFFLINE=off)' };
  }
  const avail = await ocr.checkAvailable();
  if (!avail.ok) {
    return { ok: false, failure: avail.detail };
  }
  const pages = totalPages || worker.MAX_OCR_PAGES;
  let ocrRes;
  try {
    ocrRes = await ocr.ocrPdfToText(pdfPath, {
      maxPages: Math.min(pages, worker.MAX_OCR_PAGES),
    });
  } catch (e) {
    return { ok: false, failure: 'OCR offline lỗi: ' + String(e && e.message ? e.message : e).slice(0, 300) };
  }
  if (!pdf.hasUsableTextLayer(ocrRes.text)) {
    return {
      ok: false,
      failure: `OCR offline chạy được nhưng text thu được quá ít (${String(ocrRes.text || '').replace(/\s/g, '').length} ký tự)`,
    };
  }
  const fields = mergeFields(parseLicenseText(ocrRes.text), parseLicenseText(textLayerText || ''));
  const confidence = fieldConfidence(fields, {
    fromOcr: true,
    soFromLabel: Boolean(fields.soGiayPhep) && licenseNumberFromLabel(ocrRes.text) === fields.soGiayPhep,
  });
  const crossCheck = buildCrossCheck(ocrRes.text, fields);
  crossCheck.storeMatches = worker.findStoreMatches(licenses || [], fields.soGiayPhep);
  return {
    ok: true,
    fields,
    confidence,
    crossCheck,
    rawText: String(ocrRes.text || '').slice(0, 200000),
    pagesOcred: ocrRes.pagesOcred,
    totalPages: pages,
  };
}

module.exports = { tryOcrOffline };
