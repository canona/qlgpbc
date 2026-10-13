'use strict';

// QLGP Báo Chí — máy chủ HTTP thuần Node (không phụ thuộc thư viện ngoài).
// Gồm: giao diện quản trị (render phía server), API JSON cho ứng dụng thứ ba,
// và worker nền xử lý hàng đợi trích xuất PDF.

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const { handleApi, handleFileDownload, handleFilePreview } = require('./lib/routes-api');
const { handlePages } = require('./lib/routes-pages');
const worker = require('./lib/worker');
const { sendJson } = require('./lib/util');

const PORT = parseInt(process.env.PORT || '3000', 10);
const STYLE_CSS = path.join(__dirname, 'public', 'style.css');

async function dispatch(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/style.css' && req.method === 'GET') {
      const css = fs.readFileSync(STYLE_CSS);
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Content-Length': css.length, 'Cache-Control': 'public, max-age=0, must-revalidate' });
      res.end(css);
      return;
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, app: 'qlgp-bao-chi' });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (handled) return;
    }
    if (url.pathname.startsWith('/files/')) {
      if (handleFileDownload(req, res, url)) return;
    }
    if (url.pathname.startsWith('/preview/')) {
      if (await handleFilePreview(req, res, url)) return;
    }
    if (await handlePages(req, res, url)) return;
    sendJson(res, 404, { error: 'Không tìm thấy đường dẫn' });
  } catch (err) {
    console.error('[server] Lỗi xử lý', req.method, req.url, err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Lỗi máy chủ: ' + (err && err.message ? err.message : String(err)) });
    } else {
      res.end();
    }
  }
}

function main() {
  store.getDb(); // khởi tạo DATA_DIR + store.json
  const server = http.createServer((req, res) => {
    dispatch(req, res);
  });
  server.listen(PORT, () => {
    console.log(`QLGP Báo Chí đang chạy tại http://localhost:${PORT}`);
    console.log(`Dữ liệu: ${store.getDataDir()}`);
  });
  worker.startWorker();
}

if (require.main === module) main();

module.exports = { main };
