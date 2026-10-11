'use strict';

// Tích hợp AI Gateway tương thích OpenAI (ví dụ gateway tự host của người dùng,
// truy cập qua https://qlgpbc.vtcdigital.top/ai).
// API key chỉ nằm ở phía server (lưu trong store hoặc biến môi trường),
// không bao giờ trả nguyên văn về client — chỉ trả bản đã che.

const fs = require('fs');
const store = require('./store');
const { maskKey } = require('./util');
const { emptyFields } = require('./parse');

function getAiConfig() {
  const db = store.getDb();
  const ai = (db.settings && db.settings.ai) || {};
  return {
    baseUrl: (ai.baseUrl || process.env.AI_GATEWAY_URL || 'https://qlgpbc.vtcdigital.top/ai').replace(/\/+$/, ''),
    model: ai.model || process.env.AI_GATEWAY_MODEL || '',
    apiKey: ai.apiKey || process.env.AI_GATEWAY_API_KEY || '',
  };
}

function isConfigured(cfg) {
  const c = cfg || getAiConfig();
  return Boolean(c.baseUrl && c.apiKey);
}

// Bản cấu hình an toàn để trả về client: key đã che
function publicAiConfig() {
  const cfg = getAiConfig();
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKeyMasked: maskKey(cfg.apiKey),
    hasApiKey: Boolean(cfg.apiKey),
    configured: isConfigured(cfg),
  };
}

function saveAiConfig(input) {
  const db = store.getDb();
  if (!db.settings) db.settings = {};
  if (!db.settings.ai) db.settings.ai = {};
  const ai = db.settings.ai;
  if (typeof input.baseUrl === 'string') ai.baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  if (typeof input.model === 'string') ai.model = input.model.trim();
  // Chỉ ghi đè key khi người dùng nhập key mới (chuỗi rỗng = giữ nguyên)
  if (typeof input.apiKey === 'string' && input.apiKey.trim() !== '') {
    ai.apiKey = input.apiKey.trim();
  }
  if (input.clearApiKey === true) ai.apiKey = '';
  store.save();
  return publicAiConfig();
}

function apiRoot(baseUrl) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  return /\/v1$/.test(b) ? b : b + '/v1';
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
  try {
    return await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h.Authorization = 'Bearer ' + cfg.apiKey;
  return h;
}

// Kiểm tra kết nối: thử GET /v1/models; nếu gateway không hỗ trợ thì thử
// một lời gọi chat completions tối thiểu. Không bao giờ đưa key vào kết quả.
async function testConnection(cfgInput) {
  const cfg = cfgInput || getAiConfig();
  if (!cfg.baseUrl) return { ok: false, detail: 'Chưa cấu hình địa chỉ gateway' };
  const root = apiRoot(cfg.baseUrl);
  try {
    const res = await fetchWithTimeout(root + '/models', { headers: authHeaders(cfg) }, 15000);
    if (res.ok) return { ok: true, detail: 'Kết nối thành công (GET /v1/models trả về 200)' };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: 'Gateway từ chối xác thực (HTTP ' + res.status + ') — kiểm tra lại API key' };
    }
    // Một số gateway không có /models: thử chat completions tối thiểu
    const res2 = await fetchWithTimeout(
      root + '/chat/completions',
      {
        method: 'POST',
        headers: authHeaders(cfg),
        body: JSON.stringify({
          model: cfg.model || 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      },
      30000
    );
    if (res2.ok) return { ok: true, detail: 'Kết nối thành công (chat completions phản hồi 200)' };
    return { ok: false, detail: 'Gateway phản hồi HTTP ' + res2.status + ' khi gọi chat completions' };
  } catch (e) {
    return { ok: false, detail: 'Không kết nối được tới gateway: ' + (e.name === 'AbortError' ? 'quá thời gian chờ' : e.message) };
  }
}

const FIELD_PROMPT = `Bạn là hệ thống trích xuất dữ liệu giấy phép báo chí Việt Nam.
Đọc ảnh các trang của giấy phép và trả về DUY NHẤT một JSON (không giải thích, không markdown) có đúng các khóa sau:
{"soGiayPhep":"","loaiVanBan":"","ngayCap":"YYYY-MM-DD","coQuanCap":"","nguoiKy":"","hieuLuc":"","coQuanChuQuan":"","coQuanBaoChi":"","diaChi":"","dienThoai":"","fax":"","email":"","website":"","tonChiMucDich":"","doiTuongPhucVu":"","anPham":[{"ten":"","loaiHinh":"","soTrang":"","kyXuatBan":"","tenMien":""}],"tongBienTap":"","phoTongBienTap":[],"canCuPhapLy":[]}
Trường nào không có trong văn bản thì để chuỗi rỗng hoặc mảng rỗng.`;

// Đưa ảnh các trang PDF scan qua gateway để trích xuất trường dữ liệu.
async function extractFieldsFromImages(imagePaths, cfgInput) {
  const cfg = cfgInput || getAiConfig();
  if (!isConfigured(cfg)) throw new Error('AI gateway chưa được cấu hình');
  const content = [{ type: 'text', text: FIELD_PROMPT }];
  for (const p of imagePaths) {
    const b64 = fs.readFileSync(p).toString('base64');
    content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } });
  }
  const root = apiRoot(cfg.baseUrl);
  const res = await fetchWithTimeout(
    root + '/chat/completions',
    {
      method: 'POST',
      headers: authHeaders(cfg),
      body: JSON.stringify({
        model: cfg.model || 'gpt-4o-mini',
        messages: [{ role: 'user', content }],
        temperature: 0,
      }),
    },
    240000
  );
  if (!res.ok) {
    throw new Error('Gateway trả về HTTP ' + res.status + ' khi trích xuất');
  }
  const data = await res.json();
  const textOut =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '')
      : '';
  const jsonMatch = /\{[\s\S]*\}/.exec(textOut.replace(/```json|```/g, ''));
  if (!jsonMatch) throw new Error('Gateway không trả về JSON hợp lệ');
  const parsed = JSON.parse(jsonMatch[0]);
  const fields = emptyFields();
  for (const k of Object.keys(fields)) {
    if (parsed[k] !== undefined) fields[k] = parsed[k];
  }
  return fields;
}

module.exports = { getAiConfig, isConfigured, publicAiConfig, saveAiConfig, testConnection, extractFieldsFromImages, apiRoot };
