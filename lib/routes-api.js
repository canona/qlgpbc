'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');
const pdf = require('./pdf');
const { parseLicenseText, sanitizeFields, mapExternalJson } = require('./parse');
const gateway = require('./gateway');
const worker = require('./worker');
const { tryOcrOffline } = require('./extract');
const drive = require('./drive');
const { normalizeText, sha256Hex, newId, nowIso, readBody, readJsonBody, parseMultipart, sendJson } = require('./util');

// ---------- Helpers dùng chung ----------

function savePdfBuffer(buffer) {
  const sha = sha256Hex(buffer);
  const storedFile = sha + '.pdf';
  const dest = path.join(store.getUploadDir(), storedFile);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buffer);
  return { sha256: sha, storedFile };
}

function recordView(rec) {
  return Object.assign({}, rec.fields, {
    id: rec.id,
    fileName: rec.fileName || '',
    source: rec.source || 'manual',
    storedFile: rec.storedFile || '',
    sha256: rec.sha256 || '',
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  });
}

// Tạo (hoặc trả lại job cũ nếu trùng file theo SHA-256) một job trích xuất từ buffer PDF.
// Bất đồng bộ qua store.save()/worker.kick() do nơi gọi đảm nhiệm khi job mới được tạo.
// Trả về { code, body, isNew } — body đúng định dạng phản hồi của POST /api/extraction-jobs.
function buildPdfJob(db, buffer, fileName) {
  const { sha256, storedFile } = savePdfBuffer(buffer);
  const existing = db.jobs.find(
    (j) => j.sha256 === sha256 && ['done', 'queued', 'processing', 'waiting_integration'].includes(j.status)
  );
  if (existing) {
    const v = jobView(existing);
    v.deduplicated = true;
    if (existing.status === 'done') {
      v.message = 'File đã được trích xuất trước đó — trả lại kết quả cũ, không xử lý lại';
    }
    return { code: 200, body: v, isNew: false };
  }
  const job = {
    id: newId('job'),
    sha256,
    storedFile,
    fileName,
    status: 'queued',
    method: '',
    pages: null,
    result: null,
    rawText: '',
    note: '',
    error: '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.jobs.unshift(job);
  return { code: 202, body: { job_id: job.id, status: job.status, deduplicated: false }, isNew: true };
}

function jobView(job) {
  const v = {
    job_id: job.id,
    status: job.status,
    fileName: job.fileName,
    sha256: job.sha256,
    method: job.method || '',
    pages: job.pages || null,
    note: job.note || '',
    error: job.error || '',
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.status === 'done') v.result = job.result;
  if (job.status === 'done' && job.confidence) v.confidence = job.confidence;
  if (job.status === 'done' && job.crossCheck) v.crossCheck = job.crossCheck;
  return v;
}

function findLicense(id) {
  return store.getDb().licenses.find((l) => l.id === id);
}

function findJob(id) {
  return store.getDb().jobs.find((j) => j.id === id);
}

function filterLicenses(list, query) {
  const q = normalizeText(query.q || '');
  const words = q ? q.split(' ').filter(Boolean) : [];
  return list.filter((rec) => {
    const f = rec.fields;
    if (words.length) {
      const hay = normalizeText(JSON.stringify(f) + ' ' + (rec.fileName || ''));
      if (!words.every((w) => hay.includes(w))) return false;
    }
    if (query.coQuanCap && normalizeText(f.coQuanCap) !== normalizeText(query.coQuanCap)) return false;
    if (query.coQuanChuQuan && normalizeText(f.coQuanChuQuan) !== normalizeText(query.coQuanChuQuan)) return false;
    if (query.coQuanBaoChi && normalizeText(f.coQuanBaoChi) !== normalizeText(query.coQuanBaoChi)) return false;
    if (query.loaiHinh) {
      const want = normalizeText(query.loaiHinh);
      const kinds = [f.loaiVanBan].concat((f.anPham || []).map((a) => a.loaiHinh));
      if (!kinds.some((k) => normalizeText(k).includes(want))) return false;
    }
    if (query.namCap && !String(f.ngayCap || '').startsWith(String(query.namCap))) return false;
    return true;
  });
}

function distinctValues(field) {
  const set = new Set();
  for (const rec of store.getDb().licenses) {
    const v = rec.fields[field];
    if (v) set.add(v);
  }
  return [...set].sort();
}

// ---------- Xử lý route API ----------
// Trả về true nếu đã xử lý request
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  const db = store.getDb();

  // ===== Giấy phép =====
  if (p === '/api/licenses' && method === 'GET') {
    const query = Object.fromEntries(url.searchParams.entries());
    const filtered = filterLicenses(db.licenses, query);
    sendJson(res, 200, {
      total: filtered.length,
      licenses: filtered.map(recordView),
      filterOptions: {
        coQuanCap: distinctValues('coQuanCap'),
        coQuanChuQuan: distinctValues('coQuanChuQuan'),
        coQuanBaoChi: distinctValues('coQuanBaoChi'),
      },
    });
    return true;
  }

  if (p === '/api/licenses' && method === 'POST') {
    const body = await readJsonBody(req);
    const rec = {
      id: newId('lic'),
      fields: sanitizeFields(body.fields || body),
      fileName: String(body.fileName || ''),
      source: ['text', 'image', 'manual', 'ocr'].includes(body.source) ? body.source : 'manual',
      storedFile: String(body.storedFile || ''),
      sha256: String(body.sha256 || ''),
      rawText: String(body.rawText || '').slice(0, 200000),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    db.licenses.unshift(rec);
    await store.save();
    sendJson(res, 201, recordView(rec));
    return true;
  }

  // Nhập JSON hàng loạt (định dạng như file GP_Bao_Bien_Phong_2021.json hoặc mảng các bản ghi)
  if (p === '/api/licenses/import' && method === 'POST') {
    const body = await readJsonBody(req);
    let items = [];
    if (Array.isArray(body)) items = body;
    else if (Array.isArray(body.records)) items = body.records;
    else if (body && typeof body === 'object') items = [body.fields || body];
    const created = [];
    for (const rawItem of items) {
      const item = mapExternalJson(rawItem) || {};
      const rec = {
        id: newId('lic'),
        fields: sanitizeFields(item),
        fileName: String(item.fileName || item._fileName || ''),
        source: 'manual',
        storedFile: '',
        sha256: '',
        rawText: '',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      db.licenses.unshift(rec);
      created.push(rec.id);
    }
    await store.save();
    sendJson(res, 201, { imported: created.length, ids: created });
    return true;
  }

  // Trích xuất thử từ PDF (không tạo job): dùng cho màn hình tải lên của quản trị.
  // Lớp text dùng được -> phân tích luật như cũ. Bản scan -> chạy OCR
  // offline (Tesseract, lib/extract.js) ngay tại đây giống nhánh 1.5 của
  // worker, thay vì trả 0 trường như trước. Chỉ khi OCR offline cũng
  // không dùng được mới trả về fields rỗng như hành vi cũ.
  if (p === '/api/licenses/extract' && method === 'POST') {
    const buf = await readBody(req);
    const { files } = parseMultipart(buf, req.headers['content-type']);
    const file = files.file || files.pdf;
    if (!file) {
      sendJson(res, 400, { error: 'Thiếu file PDF (field "file")' });
      return true;
    }
    const { sha256, storedFile } = savePdfBuffer(file.data);
    const pdfPath = path.join(store.getUploadDir(), storedFile);
    const text = await pdf.extractTextLayer(pdfPath);
    const usable = pdf.hasUsableTextLayer(text);
    const pages = await pdf.pdfPageCount(pdfPath);
    if (usable) {
      sendJson(res, 200, {
        fileName: file.fileName,
        sha256,
        storedFile,
        pages,
        source: 'text',
        fields: parseLicenseText(text),
        rawText: String(text || '').slice(0, 200000),
        note: 'Đã trích xuất từ lớp text của PDF — kiểm tra lại trước khi lưu',
      });
      return true;
    }
    // Bản scan: thử OCR offline giống hệt nhánh 1.5 của worker
    const ocrRes = await tryOcrOffline(pdfPath, text, pages, db.licenses);
    if (ocrRes.ok) {
      sendJson(res, 200, {
        fileName: file.fileName,
        sha256,
        storedFile,
        pages,
        source: 'ocr',
        fields: ocrRes.fields,
        confidence: ocrRes.confidence,
        crossCheck: ocrRes.crossCheck,
        rawText: ocrRes.rawText,
        note:
          pages && pages > ocrRes.pagesOcred
            ? `Đã trích xuất bằng OCR offline (Tesseract) từ bản scan, ${ocrRes.pagesOcred}/${pages} trang đầu (giới hạn MAX_OCR_PAGES=${worker.MAX_OCR_PAGES}) — các trường 'cần kiểm tra' nên đối chiếu bản gốc`
            : "Đã trích xuất bằng OCR offline (Tesseract) từ bản scan — các trường 'cần kiểm tra' nên đối chiếu bản gốc",
      });
      return true;
    }
    sendJson(res, 200, {
      fileName: file.fileName,
      sha256,
      storedFile,
      pages,
      source: 'image',
      fields: parseLicenseText(text || ''),
      rawText: String(text || '').slice(0, 200000),
      note:
        'PDF không có lớp text (bản scan) và OCR offline không dùng được' +
        (ocrRes.failure ? ` (${ocrRes.failure})` : '') +
        '. Có thể cấu hình AI gateway để trích xuất qua hàng đợi API, hoặc nhập tay.',
    });
    return true;
  }

  const licMatch = /^\/api\/licenses\/([^/]+)$/.exec(p);
  if (licMatch) {
    const rec = findLicense(decodeURIComponent(licMatch[1]));
    if (!rec) {
      sendJson(res, 404, { error: 'Không tìm thấy hồ sơ' });
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, Object.assign(recordView(rec), { rawText: rec.rawText || '' }));
      return true;
    }
    if (method === 'PUT' || method === 'PATCH') {
      const body = await readJsonBody(req);
      rec.fields = sanitizeFields(body.fields || body);
      if (typeof body.fileName === 'string') rec.fileName = body.fileName;
      if (['text', 'image', 'manual', 'ocr'].includes(body.source)) rec.source = body.source;
      rec.updatedAt = nowIso();
      await store.save();
      sendJson(res, 200, recordView(rec));
      return true;
    }
    if (method === 'DELETE') {
      db.licenses = db.licenses.filter((l) => l.id !== rec.id);
      await store.save();
      sendJson(res, 200, { deleted: true, id: rec.id });
      return true;
    }
  }

  // ===== Hàng đợi trích xuất cho ứng dụng thứ ba =====
  if (p === '/api/extraction-jobs' && method === 'POST') {
    const buf = await readBody(req);
    const { files } = parseMultipart(buf, req.headers['content-type']);
    const file = files.file || files.pdf;
    if (!file) {
      sendJson(res, 400, { error: 'Thiếu file PDF (field "file")' });
      return true;
    }
    const r = buildPdfJob(db, file.data, file.fileName);
    if (r.isNew) {
      await store.save();
      worker.kick();
    }
    sendJson(res, r.code, r.body);
    return true;
  }

  // Gửi job trích xuất bằng link Google Drive: máy chủ tự tải file PDF về rồi xếp hàng đợi.
  // File phải được chia sẻ "Bất kỳ ai có liên kết đều xem được".
  if (p === '/api/extraction-jobs/from-drive' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}));
    const fileId = drive.parseDriveFileId(body.url || body.link || body.fileId || '');
    if (!fileId) {
      sendJson(res, 400, { error: 'Link Google Drive không hợp lệ — không tách được file ID.' });
      return true;
    }
    let downloaded;
    try {
      downloaded = await drive.downloadDrivePdf(fileId);
    } catch (err) {
      sendJson(res, 502, { error: err.message });
      return true;
    }
    const r = buildPdfJob(db, downloaded.buffer, downloaded.fileName);
    if (r.isNew) {
      await store.save();
      worker.kick();
    }
    sendJson(res, r.code, r.body);
    return true;
  }

  if (p === '/api/extraction-jobs' && method === 'GET') {
    const status = url.searchParams.get('status');
    let list = db.jobs;
    if (status) list = list.filter((j) => j.status === status);
    sendJson(res, 200, { total: list.length, jobs: list.map(jobView) });
    return true;
  }

  if (p === '/api/extraction-jobs/process-now' && method === 'POST') {
    const r = await worker.processBatch();
    sendJson(res, 200, r);
    return true;
  }

  const jobMatch = /^\/api\/extraction-jobs\/([^/]+)$/.exec(p);
  if (jobMatch && method === 'GET') {
    const job = findJob(decodeURIComponent(jobMatch[1]));
    if (!job) {
      sendJson(res, 404, { error: 'Không tìm thấy job' });
      return true;
    }
    sendJson(res, 200, jobView(job));
    return true;
  }
  if (jobMatch && method === 'DELETE') {
    const job = findJob(decodeURIComponent(jobMatch[1]));
    if (!job) {
      sendJson(res, 404, { error: 'Không tìm thấy job' });
      return true;
    }
    // CHỈ xoá bản ghi job — TUYỆT ĐỐI không xoá file PDF (job.storedFile):
    // file đặt tên theo SHA-256 và có thể đang được một hồ sơ giấy phép
    // dùng chung (hồ sơ lưu từ chính job này), xoá file sẽ làm hỏng link
    // "PDF gốc" của hồ sơ đó.
    db.jobs = db.jobs.filter((j) => j.id !== job.id);
    await store.save();
    sendJson(res, 200, { deleted: true, id: job.id });
    return true;
  }

  const retryMatch = /^\/api\/extraction-jobs\/([^/]+)\/retry$/.exec(p);
  if (retryMatch && method === 'POST') {
    const job = findJob(decodeURIComponent(retryMatch[1]));
    if (!job) {
      sendJson(res, 404, { error: 'Không tìm thấy job' });
      return true;
    }
    if (job.status !== 'done') {
      job.status = 'queued';
      job.error = '';
      job.updatedAt = nowIso();
      await store.save();
      worker.kick();
    }
    sendJson(res, 200, jobView(job));
    return true;
  }

  // ===== Cài đặt AI gateway =====
  if (p === '/api/settings/ai' && method === 'GET') {
    sendJson(res, 200, gateway.publicAiConfig());
    return true;
  }
  if (p === '/api/settings/ai' && method === 'POST') {
    const body = await readJsonBody(req);
    const pub = gateway.saveAiConfig(body);
    worker.kick(); // job đang chờ tích hợp có thể chạy tiếp nếu gateway vừa được cấu hình
    sendJson(res, 200, pub);
    return true;
  }
  if (p === '/api/settings/ai/test' && method === 'POST') {
    let overrides = null;
    try {
      const body = await readJsonBody(req);
      if (body && (body.baseUrl || body.model || body.apiKey)) {
        const cur = gateway.getAiConfig();
        overrides = {
          baseUrl: (body.baseUrl || cur.baseUrl || '').replace(/\/+$/, ''),
          model: body.model || cur.model,
          apiKey: body.apiKey || cur.apiKey,
        };
      }
    } catch (e) {
      /* body rỗng -> dùng cấu hình đã lưu */
    }
    const result = await gateway.testConnection(overrides || undefined);
    sendJson(res, 200, result);
    return true;
  }

  // ===== Thống kê =====
  if (p === '/api/stats' && method === 'GET') {
    const byLoaiHinh = {};
    const byNam = {};
    const agencies = new Set();
    for (const rec of db.licenses) {
      agencies.add(rec.fields.coQuanBaoChi || '');
      for (const a of rec.fields.anPham || []) {
        if (a.loaiHinh) byLoaiHinh[a.loaiHinh] = (byLoaiHinh[a.loaiHinh] || 0) + 1;
      }
      const year = String(rec.fields.ngayCap || '').slice(0, 4);
      if (/^\d{4}$/.test(year)) byNam[year] = (byNam[year] || 0) + 1;
    }
    const jobStats = {};
    for (const j of db.jobs) jobStats[j.status] = (jobStats[j.status] || 0) + 1;
    sendJson(res, 200, {
      tongHoSo: db.licenses.length,
      tongCoQuan: agencies.size,
      theoLoaiHinh: byLoaiHinh,
      theoNamCap: byNam,
      hangDoi: jobStats,
    });
    return true;
  }

  return false;
}

// Phục vụ file PDF gốc đã lưu (chỉ chấp nhận tên file dạng <sha256>.pdf)
function handleFileDownload(req, res, url) {
  const m = /^\/files\/(.+)$/.exec(url.pathname);
  if (!m) return false;
  const name = path.basename(decodeURIComponent(m[1]));
  if (!/^[a-f0-9]{64}\.pdf$/.test(name)) {
    sendJson(res, 400, { error: 'Tên file không hợp lệ' });
    return true;
  }
  const full = path.join(store.getUploadDir(), name);
  if (!fs.existsSync(full)) {
    sendJson(res, 404, { error: 'Không tìm thấy file' });
    return true;
  }
  const data = fs.readFileSync(full);
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': data.length });
  res.end(data);
  return true;
}

// Phục vụ ảnh xem trước TỪNG TRANG của PDF gốc (render bằng pdftoppm ở
// 200 DPI, cache trên đĩa tại DATA_DIR/preview/<sha>-p<N>.png) để màn hình
// duyệt hiển thị ảnh trang to, rõ — thay cho trình xem PDF tích hợp của
// trình duyệt (trang bị thu nhỏ kèm thanh thu nhỏ, khó đọc).
async function handleFilePreview(req, res, url) {
  const m = /^\/preview\/(.+)$/.exec(url.pathname);
  if (!m) return false;
  const name = path.basename(decodeURIComponent(m[1]));
  if (!/^[a-f0-9]{64}\.pdf$/.test(name)) {
    sendJson(res, 400, { error: 'Tên file không hợp lệ' });
    return true;
  }
  const full = path.join(store.getUploadDir(), name);
  if (!fs.existsSync(full)) {
    sendJson(res, 404, { error: 'Không tìm thấy file' });
    return true;
  }
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const total = await pdf.pdfPageCount(full);
  if (!Number.isInteger(page) || !total || page < 1 || page > total) {
    sendJson(res, 404, { error: 'Trang không tồn tại' });
    return true;
  }
  const cacheDir = path.join(store.getDataDir(), 'preview');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, name.replace(/\.pdf$/, '') + `-p${page}.png`);
  if (!fs.existsSync(cacheFile)) {
    try {
      await pdf.renderPageToImage(full, page, cacheFile, 200);
    } catch (err) {
      sendJson(res, 500, { error: 'Không render được trang PDF: ' + (err && err.message ? err.message : String(err)) });
      return true;
    }
  }
  const data = fs.readFileSync(cacheFile);
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': data.length,
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(data);
  return true;
}

module.exports = { handleApi, handleFileDownload, handleFilePreview, recordView, jobView, findLicense, filterLicenses, distinctValues };
