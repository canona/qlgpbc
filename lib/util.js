'use strict';

const crypto = require('crypto');

// Bỏ dấu tiếng Việt để tìm kiếm không phân biệt dấu: "Báo Biên Phòng" -> "bao bien phong"
function normalizeText(s) {
  if (s == null) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function newId(prefix) {
  return (prefix || 'id') + '_' + crypto.randomBytes(8).toString('hex');
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Che API key: chỉ để lộ 4 ký tự cuối, ví dụ "••••••••abcd"
function maskKey(key) {
  if (!key) return '';
  const tail = String(key).slice(-4);
  return '••••••••' + tail;
}

function nowIso() {
  return new Date().toISOString();
}

// Đọc body của request (giới hạn kích thước)
function readBody(req, limitBytes) {
  const limit = limitBytes || 60 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('Payload quá lớn'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req, 10 * 1024 * 1024);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

// Phân tích multipart/form-data (đủ cho upload 1 file PDF + vài field text)
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '');
  if (!m) throw new Error('Thiếu boundary trong multipart');
  const boundary = m[1] || m[2];
  const boundaryBuf = Buffer.from('--' + boundary);
  const fields = {};
  const files = {};

  let start = buffer.indexOf(boundaryBuf);
  while (start !== -1) {
    let partStart = start + boundaryBuf.length;
    // Bỏ qua CRLF hoặc dấu "--" kết thúc
    if (buffer[partStart] === 45 && buffer[partStart + 1] === 45) break;
    if (buffer[partStart] === 13 && buffer[partStart + 1] === 10) partStart += 2;
    const headerEnd = buffer.indexOf('\r\n\r\n', partStart);
    if (headerEnd === -1) break;
    const header = buffer.toString('utf8', partStart, headerEnd);
    const dataStart = headerEnd + 4;
    let next = buffer.indexOf(boundaryBuf, dataStart);
    if (next === -1) break;
    // Dữ liệu kết thúc ngay trước CRLF của boundary tiếp theo
    let dataEnd = next;
    if (buffer[dataEnd - 2] === 13 && buffer[dataEnd - 1] === 10) dataEnd -= 2;
    const data = buffer.subarray(dataStart, dataEnd);

    const nameMatch = /name="([^"]+)"/.exec(header);
    const fileMatch = /filename="([^"]*)"/.exec(header);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(header);
    if (nameMatch) {
      const name = nameMatch[1];
      if (fileMatch && fileMatch[1]) {
        files[name] = {
          fileName: fileMatch[1],
          contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
          data: Buffer.from(data),
        };
      } else if (!fileMatch) {
        fields[name] = data.toString('utf8');
      }
    }
    start = next;
  }
  return { fields, files };
}

// Đọc form urlencoded (cho các form HTML quản trị)
function parseUrlEncoded(str) {
  const out = {};
  for (const pair of String(str).split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    const k = decodeURIComponent((idx === -1 ? pair : pair.slice(0, idx)).replace(/\+/g, ' '));
    const v = decodeURIComponent((idx === -1 ? '' : pair.slice(idx + 1)).replace(/\+/g, ' '));
    if (Object.prototype.hasOwnProperty.call(out, k)) {
      if (Array.isArray(out[k])) out[k].push(v);
      else out[k] = [out[k], v];
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = {
  normalizeText,
  sha256Hex,
  newId,
  escapeHtml,
  maskKey,
  nowIso,
  readBody,
  readJsonBody,
  sendJson,
  sendHtml,
  redirect,
  parseMultipart,
  parseUrlEncoded,
};
