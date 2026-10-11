'use strict';

// Tầng truy cập dữ liệu: lưu toàn bộ vào 1 file JSON trong DATA_DIR.
// Chọn JSON store (thay cho SQLite) để gói chạy được trên mọi bản Node >= 20
// mà không cần biên dịch native như better-sqlite3; dữ liệu của ứng dụng này
// nhỏ (vài nghìn bản ghi) nên JSON là đủ và dễ sao lưu.
// Mọi thao tác ghi đều ghi nguyên tử (ghi file tạm rồi rename) qua hàng đợi ghi
// đơn luồng để tránh hỏng file khi có nhiều request đồng thời.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'store.json');

let db = null;
let writeChain = Promise.resolve();

function emptyDb() {
  return {
    licenses: [],
    jobs: [],
    settings: {
      ai: {
        baseUrl: process.env.AI_GATEWAY_URL || 'https://qlgpbc.vtcdigital.top/ai',
        model: process.env.AI_GATEWAY_MODEL || '',
        apiKey: process.env.AI_GATEWAY_API_KEY || '',
      },
    },
  };
}

function load() {
  if (db) return db;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      // File hỏng: giữ bản sao để điều tra, bắt đầu lại với DB trống
      fs.copyFileSync(DB_FILE, DB_FILE + '.broken-' + Date.now());
      db = emptyDb();
    }
  } else {
    db = emptyDb();
    persistSync();
  }
  if (!db.licenses) db.licenses = [];
  if (!db.jobs) db.jobs = [];
  if (!db.settings || !db.settings.ai) {
    const d = emptyDb();
    db.settings = d.settings;
  }
  return db;
}

function persistSync() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// Ghi bất đồng bộ, nối tiếp nhau để không giẫm lên nhau
function save() {
  writeChain = writeChain.then(() => {
    try {
      persistSync();
    } catch (e) {
      console.error('[store] Lỗi ghi dữ liệu:', e.message);
    }
  });
  return writeChain;
}

function getDb() {
  return load();
}

function getUploadDir() {
  load();
  return UPLOAD_DIR;
}

function getDataDir() {
  return DATA_DIR;
}

module.exports = { getDb, save, getUploadDir, getDataDir, DATA_DIR };
