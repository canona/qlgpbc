'use strict';

// Giao diện quản trị render phía server (không cần framework frontend).
// Ba khu vực: Hồ sơ giấy phép / Hàng đợi API / Cài đặt AI Gateway.

const store = require('./store');
const pdf = require('./pdf');
const path = require('path');
const fs = require('fs');
const { parseLicenseText, sanitizeFields, emptyFields, mapExternalJson } = require('./parse');
const gateway = require('./gateway');
const worker = require('./worker');
const drive = require('./drive');
const api = require('./routes-api');
const {
  escapeHtml: e,
  normalizeText,
  readBody,
  parseMultipart,
  parseUrlEncoded,
  sendHtml,
  redirect,
  newId,
  nowIso,
  sha256Hex,
} = require('./util');

const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://qlgpbc.vtcdigital.top').replace(/\/+$/, '');

const JOB_STATUS_LABEL = {
  queued: 'Chờ xử lý',
  processing: 'Đang xử lý',
  waiting_integration: 'Chờ tích hợp gateway',
  done: 'Hoàn thành',
  error: 'Lỗi',
};

function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} — QLGP Báo Chí</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="topbar">
  <div class="brand">🗂️ QLGP Báo Chí</div>
  <nav>
    <a href="/licenses">Hồ sơ giấy phép</a>
    <a href="/queue">Hàng đợi API</a>
    <a href="/settings">Cài đặt AI Gateway</a>
  </nav>
</header>
<main class="container">
${body}
</main>
<footer class="footer">QLGP Báo Chí — quản lý hồ sơ giấy phép báo chí · ${e(APP_BASE_URL)}</footer>
</body>
</html>`;
}

function fieldRow(label, value) {
  if (!value) return '';
  return `<div class="frow"><div class="flabel">${e(label)}</div><div class="fvalue">${e(value)}</div></div>`;
}

// ---------- Danh sách hồ sơ ----------
function licensesPage(url) {
  const db = store.getDb();
  const query = Object.fromEntries(url.searchParams.entries());
  const filtered = api.filterLicenses(db.licenses, query);
  const stats = {
    tong: db.licenses.length,
    coQuan: new Set(db.licenses.map((l) => l.fields.coQuanBaoChi).filter(Boolean)).size,
  };
  const capOpts = api.distinctValues('coQuanCap');
  const cqOpts = api.distinctValues('coQuanChuQuan');
  const sel = (cur, v) => (cur === v ? ' selected' : '');

  const rows = filtered
    .map((rec) => {
      const f = rec.fields;
      const kinds = [...new Set((f.anPham || []).map((a) => a.loaiHinh).filter(Boolean))].join(', ');
      const domains = [...new Set((f.anPham || []).map((a) => a.tenMien).filter(Boolean))].concat(f.website ? [f.website] : []).join(', ');
      return `<tr>
        <td><a href="/licenses/${rec.id}"><strong>${e(f.soGiayPhep || '(chưa rõ)')}</strong></a><br><small>${e(f.loaiVanBan || '')}</small></td>
        <td>${e(f.ngayCap || '')}</td>
        <td>${e(f.coQuanBaoChi || '')}</td>
        <td>${e(f.coQuanChuQuan || '')}</td>
        <td>${e(kinds)}</td>
        <td>${e(domains)}</td>
        <td class="actions">
          <a href="/licenses/${rec.id}">Xem</a> ·
          <a href="/licenses/${rec.id}/edit">Sửa</a>
        </td>
      </tr>`;
    })
    .join('\n');

  const body = `
<h1>Hồ sơ giấy phép</h1>
<div class="stats">
  <div class="stat"><div class="stat-num">${stats.tong}</div><div class="stat-label">Tổng số giấy phép</div></div>
  <div class="stat"><div class="stat-num">${stats.coQuan}</div><div class="stat-label">Cơ quan báo chí</div></div>
  <div class="stat"><div class="stat-num">${db.jobs.filter((j) => j.status === 'queued' || j.status === 'processing').length}</div><div class="stat-label">Job đang chờ/đang xử lý</div></div>
</div>

<div class="toolbar">
  <a class="btn" href="/upload">⬆ Tải PDF lên trích xuất</a>
  <a class="btn btn-light" href="/licenses/new">＋ Thêm hồ sơ thủ công</a>
  <form method="post" action="/licenses/import-file" enctype="multipart/form-data" class="inline-form">
    <label class="btn btn-light">Nhập JSON <input type="file" name="jsonfile" accept=".json,application/json" onchange="this.form.submit()" hidden></label>
  </form>
</div>

<form method="get" action="/licenses" class="searchbar">
  <input type="text" name="q" placeholder="Tìm kiếm (không cần gõ dấu)…" value="${e(query.q || '')}">
  <select name="coQuanCap">
    <option value="">— Cơ quan cấp —</option>
    ${capOpts.map((v) => `<option value="${e(v)}"${sel(query.coQuanCap, v)}>${e(v)}</option>`).join('')}
  </select>
  <select name="coQuanChuQuan">
    <option value="">— Cơ quan chủ quản —</option>
    ${cqOpts.map((v) => `<option value="${e(v)}"${sel(query.coQuanChuQuan, v)}>${e(v)}</option>`).join('')}
  </select>
  <input type="text" name="loaiHinh" placeholder="Loại hình (vd: Báo điện tử)" value="${e(query.loaiHinh || '')}">
  <input type="text" name="namCap" placeholder="Năm cấp" size="8" value="${e(query.namCap || '')}">
  <button class="btn" type="submit">Tìm</button>
</form>

<p class="muted">${filtered.length} kết quả</p>
<table class="table">
  <thead><tr><th>Số GP</th><th>Ngày cấp</th><th>Cơ quan báo chí</th><th>Cơ quan chủ quản</th><th>Loại hình</th><th>Tên miền</th><th></th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7" class="muted">Chưa có hồ sơ nào. Hãy tải lên một file PDF giấy phép để bắt đầu.</td></tr>'}</tbody>
</table>`;
  return layout('Hồ sơ giấy phép', body);
}

// ---------- Form hồ sơ (thêm/sửa/ duyệt sau trích xuất) ----------
function licenseFormPage({ title, action, fields, meta, note }) {
  const f = Object.assign(emptyFields(), fields || {});
  const text = (name, label, val, placeholder) =>
    `<label class="fld"><span>${e(label)}</span><input type="text" name="f_${name}" value="${e(val || '')}" placeholder="${e(placeholder || '')}"></label>`;
  const area = (name, label, val, rows) =>
    `<label class="fld"><span>${e(label)}</span><textarea name="f_${name}" rows="${rows || 3}">${e(val || '')}</textarea></label>`;

  const body = `
<h1>${e(title)}</h1>
${note ? `<div class="notice">${e(note)}</div>` : ''}
<form method="post" action="${e(action)}" class="form">
  <input type="hidden" name="fileName" value="${e((meta && meta.fileName) || '')}">
  <input type="hidden" name="storedFile" value="${e((meta && meta.storedFile) || '')}">
  <input type="hidden" name="sha256" value="${e((meta && meta.sha256) || '')}">
  <input type="hidden" name="source" value="${e((meta && meta.source) || 'manual')}">
  <input type="hidden" name="rawText" value="${e((meta && meta.rawText) || '')}">
  <div class="grid2">
    ${text('soGiayPhep', 'Số giấy phép', f.soGiayPhep, 'vd: 485/GP-BTTTT')}
    ${text('loaiVanBan', 'Loại văn bản', f.loaiVanBan, 'vd: Giấy phép hoạt động báo in và báo điện tử')}
    ${text('ngayCap', 'Ngày cấp (YYYY-MM-DD)', f.ngayCap)}
    ${text('coQuanCap', 'Cơ quan cấp', f.coQuanCap)}
    ${text('nguoiKy', 'Người ký', f.nguoiKy)}
    ${text('coQuanBaoChi', 'Tên cơ quan báo chí', f.coQuanBaoChi)}
    ${text('coQuanChuQuan', 'Cơ quan chủ quản', f.coQuanChuQuan)}
    ${text('diaChi', 'Địa chỉ trụ sở', f.diaChi)}
    ${text('dienThoai', 'Điện thoại', f.dienThoai)}
    ${text('fax', 'Fax', f.fax)}
    ${text('email', 'Email', f.email)}
    ${text('website', 'Website / tên miền', f.website)}
    ${text('tongBienTap', 'Tổng biên tập', f.tongBienTap)}
  </div>
  ${area('hieuLuc', 'Hiệu lực giấy phép', f.hieuLuc, 3)}
  ${area('tonChiMucDich', 'Tôn chỉ, mục đích', f.tonChiMucDich, 5)}
  ${area('doiTuongPhucVu', 'Đối tượng phục vụ', f.doiTuongPhucVu, 2)}
  <label class="fld"><span>Phó tổng biên tập (mỗi người một dòng)</span>
    <textarea name="f_phoTongBienTap" rows="3">${e((f.phoTongBienTap || []).join('\n'))}</textarea></label>
  <label class="fld"><span>Căn cứ pháp lý (mỗi căn cứ một dòng)</span>
    <textarea name="f_canCuPhapLy" rows="4">${e((f.canCuPhapLy || []).join('\n'))}</textarea></label>
  <label class="fld"><span>Ấn phẩm (JSON — mảng các đối tượng: ten, loaiHinh, soTrang, kyXuatBan, tenMien)</span>
    <textarea name="anPhamJson" rows="6" class="mono">${e(JSON.stringify(f.anPham || [], null, 2))}</textarea></label>
  <div class="form-actions">
    <button class="btn" type="submit">Lưu hồ sơ</button>
    <a class="btn btn-light" href="/licenses">Hủy</a>
  </div>
</form>`;
  return layout(title, body);
}

// Lắp fields từ dữ liệu form quản trị
function fieldsFromForm(form) {
  const raw = {};
  for (const k of Object.keys(emptyFields())) {
    raw[k] = form['f_' + k] !== undefined ? form['f_' + k] : undefined;
  }
  raw.phoTongBienTap = String(form.f_phoTongBienTap || '').split('\n').map((s) => s.trim()).filter(Boolean);
  raw.canCuPhapLy = String(form.f_canCuPhapLy || '').split('\n').map((s) => s.trim()).filter(Boolean);
  try {
    raw.anPham = JSON.parse(form.anPhamJson || '[]');
  } catch (e2) {
    raw.anPham = [];
  }
  return sanitizeFields(raw);
}

// ---------- Chi tiết hồ sơ ----------
function licenseDetailPage(rec) {
  const f = rec.fields;
  const anPhamRows = (f.anPham || [])
    .map(
      (a) =>
        `<tr><td>${e(a.ten)}</td><td>${e(a.loaiHinh)}</td><td>${e(a.soTrang)}</td><td>${e(a.kyXuatBan)}</td><td>${e(a.tenMien)}</td></tr>`
    )
    .join('');
  const body = `
<h1>${e(f.soGiayPhep || 'Hồ sơ giấy phép')}</h1>
<p class="muted">${e(f.loaiVanBan || '')} · Nguồn: ${e(rec.fileName || rec.source || '')}
${rec.storedFile ? ` · <a href="/files/${e(rec.storedFile)}" target="_blank">Mở PDF gốc</a>` : ''}</p>
<div class="toolbar">
  <a class="btn" href="/licenses/${rec.id}/edit">Sửa hồ sơ</a>
  <form method="post" action="/licenses/${rec.id}/delete" class="inline-form" onsubmit="return confirm('Xóa hồ sơ này?')">
    <button class="btn btn-danger" type="submit">Xóa hồ sơ</button>
  </form>
</div>
<section class="card">
  ${fieldRow('Số giấy phép', f.soGiayPhep)}
  ${fieldRow('Ngày cấp', f.ngayCap)}
  ${fieldRow('Cơ quan cấp', f.coQuanCap)}
  ${fieldRow('Người ký', f.nguoiKy)}
  ${fieldRow('Hiệu lực', f.hieuLuc)}
  ${fieldRow('Cơ quan chủ quản', f.coQuanChuQuan)}
  ${fieldRow('Cơ quan báo chí', f.coQuanBaoChi)}
  ${fieldRow('Địa chỉ trụ sở', f.diaChi)}
  ${fieldRow('Điện thoại', f.dienThoai)}
  ${fieldRow('Fax', f.fax)}
  ${fieldRow('Email', f.email)}
  ${fieldRow('Website', f.website)}
  ${fieldRow('Đối tượng phục vụ', f.doiTuongPhucVu)}
  ${fieldRow('Tổng biên tập', f.tongBienTap)}
  ${fieldRow('Phó tổng biên tập', (f.phoTongBienTap || []).join('; '))}
</section>
${
  f.tonChiMucDich
    ? `<section class="card"><h2>Tôn chỉ, mục đích</h2><p class="preserve">${e(f.tonChiMucDich)}</p></section>`
    : ''
}
${
  anPhamRows
    ? `<section class="card"><h2>Ấn phẩm</h2><table class="table"><thead><tr><th>Tên ấn phẩm</th><th>Loại hình</th><th>Số trang</th><th>Kỳ xuất bản</th><th>Tên miền</th></tr></thead><tbody>${anPhamRows}</tbody></table></section>`
    : ''
}
${
  (f.canCuPhapLy || []).length
    ? `<section class="card"><h2>Căn cứ pháp lý</h2><ul>${f.canCuPhapLy.map((c) => `<li>${e(c)}</li>`).join('')}</ul></section>`
    : ''
}
${
  rec.rawText
    ? `<details class="card"><summary>Văn bản trích từ PDF</summary><pre class="rawtext">${e(rec.rawText.slice(0, 20000))}</pre></details>`
    : ''
}
<p><a href="/licenses">← Quay lại danh sách</a></p>`;
  return layout(f.soGiayPhep || 'Chi tiết hồ sơ', body);
}

// ---------- Trang tải PDF ----------
function uploadPage(msg) {
  const body = `
<h1>Tải PDF giấy phép lên</h1>
${msg ? `<div class="notice">${e(msg)}</div>` : ''}
<p>Hệ thống sẽ đọc lớp text có sẵn trong PDF và tự động điền các trường. Nếu PDF là bản scan (không có lớp text), hồ sơ sẽ được tạo ở chế độ nhập tay hoặc đưa vào hàng đợi chờ AI gateway xử lý.</p>
<form method="post" action="/licenses/upload-submit" enctype="multipart/form-data" class="form">
  <label class="fld"><span>Chọn file PDF</span><input type="file" name="file" accept="application/pdf,.pdf" required></label>
  <div class="form-actions"><button class="btn" type="submit">Tải lên &amp; trích xuất</button></div>
</form>
<section class="card">
<h2>Hoặc nhập từ Google Drive</h2>
<p>Dán link chia sẻ của file PDF trên Google Drive — hệ thống sẽ tự tải file về và trích xuất, không cần tải file về máy trước. File phải được chia sẻ ở chế độ <strong>"Bất kỳ ai có liên kết đều xem được"</strong> (trong Drive: chuột phải vào file → Chia sẻ → chọn chế độ này).</p>
<form method="post" action="/licenses/upload-drive" class="form">
  <label class="fld"><span>Link Google Drive</span><input type="url" name="driveUrl" placeholder="https://drive.google.com/file/d/…/view" required></label>
  <div class="form-actions"><button class="btn" type="submit">Tải từ Drive &amp; trích xuất</button></div>
</form>
</section>`;
  return layout('Tải PDF lên', body);
}

// ---------- Hàng đợi API ----------
function queuePage() {
  const db = store.getDb();
  const cfg = gateway.publicAiConfig();
  const rows = db.jobs
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((j) => {
      const resultSummary =
        j.status === 'done' && j.result
          ? `${e(j.result.soGiayPhep || '')} — ${e(j.result.coQuanBaoChi || '')}`
          : e(j.error || j.note || '');
      const actions =
        j.status !== 'done' && j.status !== 'processing'
          ? `<form method="post" action="/queue/retry/${j.id}" class="inline-form"><button class="btn btn-light" type="submit">Chạy lại</button></form>`
          : '';
      return `<tr>
        <td class="mono">${e(j.id)}</td>
        <td>${e(j.fileName)}</td>
        <td><span class="badge badge-${e(j.status)}">${e(JOB_STATUS_LABEL[j.status] || j.status)}</span></td>
        <td>${e(j.method || '')}</td>
        <td>${e(String(j.createdAt || '').replace('T', ' ').slice(0, 19))}</td>
        <td>${resultSummary}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join('');

  const body = `
<h1>Hàng đợi API trích xuất</h1>
<p class="muted">Worker xử lý nền mỗi ${e(process.env.WORKER_INTERVAL_SECONDS || '60')} giây, mỗi lô tối đa 3 job. Ưu tiên lớp text của PDF (miễn phí); chỉ PDF scan mới gọi AI gateway (tối đa ${worker.MAX_OCR_PAGES} trang/job). File trùng (cùng SHA-256) trả lại kết quả cũ, không xử lý lại.</p>
<p>Trạng thái AI gateway: ${cfg.configured ? '<strong>Đã cấu hình</strong>' : '<strong class="warn">Chưa cấu hình API key</strong> — job PDF scan sẽ ở trạng thái "Chờ tích hợp gateway"'} · <a href="/settings">Đi tới cài đặt</a></p>
<form method="post" action="/queue/process-now" class="inline-form">
  <button class="btn" type="submit">Xử lý ngay một lô</button>
</form>
<table class="table">
  <thead><tr><th>Job ID</th><th>File</th><th>Trạng thái</th><th>Cách trích xuất</th><th>Tạo lúc</th><th>Kết quả / ghi chú</th><th></th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7" class="muted">Chưa có job nào.</td></tr>'}</tbody>
</table>

<section class="card">
<h2>Tài liệu API cho ứng dụng thứ ba</h2>
<p><strong>1. Gửi file PDF để trích xuất</strong> (nhận <span class="mono">job_id</span> ngay, không chờ xử lý):</p>
<pre class="code">curl -X POST ${e(APP_BASE_URL)}/api/extraction-jobs \\
  -F "file=@giay-phep.pdf"

# Phản hồi 202:
# {"job_id":"job_xxx","status":"queued","deduplicated":false}</pre>
<p><strong>2. Tra cứu kết quả theo job_id:</strong></p>
<pre class="code">curl ${e(APP_BASE_URL)}/api/extraction-jobs/job_xxx

# Khi hoàn thành:
# {"job_id":"job_xxx","status":"done","method":"text",
#  "result":{"soGiayPhep":"485/GP-BTTTT","ngayCap":"2021-07-28", ... }}</pre>
<p>Các trạng thái: <span class="mono">queued</span> (chờ xử lý), <span class="mono">processing</span> (đang xử lý),
<span class="mono">waiting_integration</span> (PDF scan, chờ cấu hình AI gateway), <span class="mono">done</span> (hoàn thành),
<span class="mono">error</span> (lỗi). Nếu gửi trùng một file đã trích xuất xong, API trả lại job cũ kèm <span class="mono">"deduplicated": true</span> và kết quả sẵn có.</p>
<p>Các endpoint khác: <span class="mono">GET /api/licenses</span> (danh sách + tìm kiếm),
<span class="mono">GET /api/licenses/:id</span>, <span class="mono">POST /api/licenses</span>,
<span class="mono">PUT /api/licenses/:id</span>, <span class="mono">DELETE /api/licenses/:id</span>,
<span class="mono">POST /api/licenses/import</span> (nhập JSON), <span class="mono">GET /api/stats</span>.</p>
<p><strong>3. Gửi job bằng link Google Drive</strong> (máy chủ tự tải file về; file phải chia sẻ "Bất kỳ ai có liên kết đều xem được"):</p>
<pre class="code">curl -X POST ${e(APP_BASE_URL)}/api/extraction-jobs/from-drive \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://drive.google.com/file/d/&lt;FILE_ID&gt;/view"}'

# Phản hồi 202: {"job_id":"job_xxx","status":"queued","deduplicated":false}</pre>
</section>`;
  return layout('Hàng đợi API', body);
}

// ---------- Cài đặt AI gateway ----------
function settingsPage(saved) {
  const cfg = gateway.publicAiConfig();
  const body = `
<h1>Cài đặt AI Gateway</h1>
${saved ? '<div class="notice">Đã lưu cấu hình.</div>' : ''}
<p>Gateway dùng để trích xuất các PDF dạng scan (không có lớp text). API key được lưu ở phía máy chủ và <strong>không bao giờ hiển thị nguyên văn</strong> — dưới đây chỉ hiện bản đã che.</p>
<form method="post" action="/settings/save" class="form">
  <label class="fld"><span>Địa chỉ gateway (base URL)</span>
    <input type="text" id="gw-base" name="baseUrl" value="${e(cfg.baseUrl)}" placeholder="https://qlgpbc.vtcdigital.top/ai"></label>
  <label class="fld"><span>Model trích xuất</span>
    <input type="text" id="gw-model" name="model" value="${e(cfg.model)}" placeholder="vd: gpt-4o-mini"></label>
  <label class="fld"><span>API key ${cfg.hasApiKey ? `(hiện tại: <span class="mono">${e(cfg.apiKeyMasked)}</span>)` : '(chưa có)'}</span>
    <input type="password" id="gw-key" name="apiKey" value="" placeholder="Để trống nếu giữ nguyên key hiện tại" autocomplete="off"></label>
  <label class="check"><input type="checkbox" name="clearApiKey" value="1"> Xóa API key đã lưu</label>
  <div class="form-actions">
    <button class="btn" type="submit">Lưu cấu hình</button>
    <button class="btn btn-light" type="button" id="btn-test">Kiểm tra kết nối</button>
    <span id="test-result" class="muted"></span>
  </div>
</form>
<script>
document.getElementById('btn-test').addEventListener('click', async () => {
  const out = document.getElementById('test-result');
  out.textContent = 'Đang kiểm tra…';
  try {
    const res = await fetch('/api/settings/ai/test', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        baseUrl: document.getElementById('gw-base').value,
        model: document.getElementById('gw-model').value,
        apiKey: document.getElementById('gw-key').value
      })
    });
    const data = await res.json();
    out.textContent = (data.ok ? '✅ ' : '❌ ') + data.detail;
  } catch (err) {
    out.textContent = '❌ Lỗi: ' + err.message;
  }
});
</script>`;
  return layout('Cài đặt AI Gateway', body);
}

// ---------- Điều phối route trang ----------
// Lưu buffer PDF (theo SHA-256), trích lớp text và render trang kiểm tra kết quả
// cho người dùng duyệt trước khi lưu hồ sơ. Dùng chung cho tải file trực tiếp
// và nhập từ Google Drive.
async function renderPdfReview(res, buffer, fileName) {
  const sha256 = sha256Hex(buffer);
  const storedFile = sha256 + '.pdf';
  const dest = path.join(store.getUploadDir(), storedFile);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buffer);
  const text = await pdf.extractTextLayer(dest);
  const usable = pdf.hasUsableTextLayer(text);
  const fields = parseLicenseText(text || '');
  sendHtml(
    res,
    200,
    licenseFormPage({
      title: 'Kiểm tra kết quả trích xuất',
      action: '/licenses',
      fields,
      meta: {
        fileName,
        storedFile,
        sha256,
        source: usable ? 'text' : 'image',
        rawText: String(text || '').slice(0, 200000),
      },
      note: usable
        ? 'Đã trích xuất từ lớp text của PDF. Hãy kiểm tra và sửa các trường trước khi lưu.'
        : 'PDF không có lớp text (bản scan) nên chưa trích xuất được trường nào. Bạn có thể nhập tay, hoặc cấu hình AI Gateway rồi gửi file qua hàng đợi API để trích xuất tự động.',
    })
  );
}

async function handlePages(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  const db = store.getDb();

  if (p === '/' && method === 'GET') {
    redirect(res, '/licenses');
    return true;
  }
  if (p === '/licenses' && method === 'GET') {
    sendHtml(res, 200, licensesPage(url));
    return true;
  }
  if (p === '/licenses/new' && method === 'GET') {
    sendHtml(res, 200, licenseFormPage({ title: 'Thêm hồ sơ thủ công', action: '/licenses', fields: {}, meta: {} }));
    return true;
  }
  if (p === '/licenses' && method === 'POST') {
    const form = parseUrlEncoded((await readBody(req)).toString('utf8'));
    const rec = {
      id: newId('lic'),
      fields: fieldsFromForm(form),
      fileName: form.fileName || '',
      source: ['text', 'image', 'manual'].includes(form.source) ? form.source : 'manual',
      storedFile: form.storedFile || '',
      sha256: form.sha256 || '',
      rawText: String(form.rawText || '').slice(0, 200000),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    db.licenses.unshift(rec);
    await store.save();
    redirect(res, '/licenses/' + rec.id);
    return true;
  }
  if (p === '/licenses/import-file' && method === 'POST') {
    const buf = await readBody(req);
    const { files } = parseMultipart(buf, req.headers['content-type']);
    const jf = files.jsonfile || files.file;
    if (jf) {
      try {
        const parsed = JSON.parse(jf.data.toString('utf8'));
        let items = [];
        if (Array.isArray(parsed)) items = parsed;
        else if (parsed && Array.isArray(parsed.records)) items = parsed.records;
        else if (parsed && typeof parsed === 'object') items = [parsed.DuLieu || parsed.fields || parsed];
        for (const rawItem of items) {
          const item = mapExternalJson(rawItem) || {};
          db.licenses.unshift({
            id: newId('lic'),
            fields: sanitizeFields(item),
            fileName: item._fileName || jf.fileName || '',
            source: 'manual',
            storedFile: '',
            sha256: '',
            rawText: '',
            createdAt: nowIso(),
            updatedAt: nowIso(),
          });
        }
        await store.save();
      } catch (err) {
        sendHtml(res, 400, layout('Lỗi nhập JSON', `<h1>Không đọc được file JSON</h1><p>${e(err.message)}</p><p><a href="/licenses">Quay lại</a></p>`));
        return true;
      }
    }
    redirect(res, '/licenses');
    return true;
  }
  if (p === '/upload' && method === 'GET') {
    sendHtml(res, 200, uploadPage());
    return true;
  }
  if (p === '/licenses/upload-submit' && method === 'POST') {
    const buf = await readBody(req);
    const { files } = parseMultipart(buf, req.headers['content-type']);
    const file = files.file || files.pdf;
    if (!file) {
      sendHtml(res, 400, layout('Lỗi', '<h1>Thiếu file PDF</h1><p><a href="/upload">Quay lại</a></p>'));
      return true;
    }
    await renderPdfReview(res, file.data, file.fileName);
    return true;
  }
  if (p === '/licenses/upload-drive' && method === 'POST') {
    const form = parseUrlEncoded((await readBody(req)).toString('utf8'));
    const fileId = drive.parseDriveFileId(form.driveUrl || '');
    if (!fileId) {
      sendHtml(res, 400, layout('Lỗi', '<h1>Link Google Drive không hợp lệ</h1><p>Không tách được mã file từ link bạn dán. Hãy kiểm tra lại link chia sẻ của file PDF.</p><p><a href="/upload">Quay lại</a></p>'));
      return true;
    }
    let downloaded;
    try {
      downloaded = await drive.downloadDrivePdf(fileId);
    } catch (err) {
      sendHtml(res, 502, layout('Lỗi tải từ Drive', `<h1>Không tải được file từ Google Drive</h1><p>${e(err.message)}</p><p><a href="/upload">Quay lại</a></p>`));
      return true;
    }
    await renderPdfReview(res, downloaded.buffer, downloaded.fileName);
    return true;
  }

  const detailMatch = /^\/licenses\/([^/]+)$/.exec(p);
  if (detailMatch && method === 'GET') {
    const rec = api.findLicense(decodeURIComponent(detailMatch[1]));
    if (!rec) {
      sendHtml(res, 404, layout('Không tìm thấy', '<h1>Không tìm thấy hồ sơ</h1><p><a href="/licenses">Quay lại danh sách</a></p>'));
      return true;
    }
    sendHtml(res, 200, licenseDetailPage(rec));
    return true;
  }
  const editMatch = /^\/licenses\/([^/]+)\/edit$/.exec(p);
  if (editMatch && method === 'GET') {
    const rec = api.findLicense(decodeURIComponent(editMatch[1]));
    if (!rec) {
      sendHtml(res, 404, layout('Không tìm thấy', '<h1>Không tìm thấy hồ sơ</h1>'));
      return true;
    }
    sendHtml(
      res,
      200,
      licenseFormPage({
        title: 'Sửa hồ sơ',
        action: '/licenses/' + rec.id + '/update',
        fields: rec.fields,
        meta: { fileName: rec.fileName, storedFile: rec.storedFile, sha256: rec.sha256, source: rec.source, rawText: rec.rawText },
      })
    );
    return true;
  }
  const updateMatch = /^\/licenses\/([^/]+)\/update$/.exec(p);
  if (updateMatch && method === 'POST') {
    const rec = api.findLicense(decodeURIComponent(updateMatch[1]));
    if (!rec) {
      sendHtml(res, 404, layout('Không tìm thấy', '<h1>Không tìm thấy hồ sơ</h1>'));
      return true;
    }
    const form = parseUrlEncoded((await readBody(req)).toString('utf8'));
    rec.fields = fieldsFromForm(form);
    rec.updatedAt = nowIso();
    await store.save();
    redirect(res, '/licenses/' + rec.id);
    return true;
  }
  const deleteMatch = /^\/licenses\/([^/]+)\/delete$/.exec(p);
  if (deleteMatch && method === 'POST') {
    const id = decodeURIComponent(deleteMatch[1]);
    db.licenses = db.licenses.filter((l) => l.id !== id);
    await store.save();
    redirect(res, '/licenses');
    return true;
  }

  if (p === '/queue' && method === 'GET') {
    sendHtml(res, 200, queuePage());
    return true;
  }
  if (p === '/queue/process-now' && method === 'POST') {
    await readBody(req);
    await worker.processBatch();
    redirect(res, '/queue');
    return true;
  }
  const retryMatch = /^\/queue\/retry\/([^/]+)$/.exec(p);
  if (retryMatch && method === 'POST') {
    await readBody(req);
    const job = db.jobs.find((j) => j.id === decodeURIComponent(retryMatch[1]));
    if (job && job.status !== 'done') {
      job.status = 'queued';
      job.error = '';
      job.updatedAt = nowIso();
      await store.save();
      worker.kick();
    }
    redirect(res, '/queue');
    return true;
  }

  if (p === '/settings' && method === 'GET') {
    sendHtml(res, 200, settingsPage(url.searchParams.get('saved') === '1'));
    return true;
  }
  if (p === '/settings/save' && method === 'POST') {
    const form = parseUrlEncoded((await readBody(req)).toString('utf8'));
    gateway.saveAiConfig({
      baseUrl: form.baseUrl || '',
      model: form.model || '',
      apiKey: form.apiKey || '',
      clearApiKey: form.clearApiKey === '1',
    });
    worker.kick();
    redirect(res, '/settings?saved=1');
    return true;
  }

  return false;
}

module.exports = { handlePages };
