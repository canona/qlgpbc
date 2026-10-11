'use strict';

// Phân tích văn bản trích từ PDF giấy phép báo chí thành các trường có cấu trúc
// bằng luật (regex + cấu trúc mục đánh số thường gặp trong giấy phép).
// Đây là bản "best effort": trường nào không tìm thấy thì để trống để người
// dùng bổ sung tay, hoặc để worker đưa qua AI gateway khi cần độ chính xác cao.

function emptyFields() {
  return {
    soGiayPhep: '',
    loaiVanBan: '',
    ngayCap: '',
    coQuanCap: '',
    nguoiKy: '',
    hieuLuc: '',
    coQuanChuQuan: '',
    coQuanBaoChi: '',
    diaChi: '',
    dienThoai: '',
    fax: '',
    email: '',
    website: '',
    tonChiMucDich: '',
    doiTuongPhucVu: '',
    anPham: [],
    tongBienTap: '',
    phoTongBienTap: [],
    canCuPhapLy: [],
  };
}

function collapseWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// "BÁO BIÊN PHÒNG" -> "Báo Biên Phòng" (chỉ áp dụng khi chuỗi gần như toàn chữ hoa)
function smartTitle(s) {
  const t = collapseWs(s);
  if (!t) return '';
  const letters = t.replace(/[^A-Za-zÀ-ỹ]/g, '');
  if (!letters) return t;
  const upper = letters.replace(/[^A-ZÀ-Ỹ]/g, '').length;
  if (upper / letters.length < 0.8) return t;
  return t
    .toLowerCase()
    .replace(/(^|[-\s])([a-zà-ỹ])/g, (m, p, c) => p + c.toUpperCase());
}

function stripTrailingPunct(s) {
  return collapseWs(s).replace(/[.;]+$/, '').trim();
}

// Lấy đoạn text từ vị trí khớp startRe tới vị trí khớp endRe đầu tiên sau đó
function sliceBetween(text, startRe, endRes, maxLen) {
  const m = startRe.exec(text);
  if (!m) return '';
  const from = m.index + m[0].length;
  let to = text.length;
  for (const re of endRes) {
    re.lastIndex = from;
    const e = re.exec(text);
    if (e && e.index > from && e.index < to) to = e.index;
  }
  if (maxLen && to - from > maxLen) to = from + maxLen;
  return text.slice(from, to);
}

const NEXT_SECTION = /\n\s*\d+\.\s+[A-ZÀ-Ỹ(]/g;

function parseLicenseText(rawText) {
  const f = emptyFields();
  if (!rawText) return f;
  // Chuẩn hoá: bỏ ký tự form-feed, gộp các dòng trang
  const text = String(rawText).replace(/\f/g, '\n');
  const lines = text.split('\n');

  // --- Số giấy phép: "Số: 24 /GP-CBC" hoặc "485/GP-BTTTT"
  const soMatch = /(\d+)\s*\/\s*(GP-[A-Z]+)/.exec(text);
  if (soMatch) f.soGiayPhep = soMatch[1] + '/' + soMatch[2];

  // --- Ngày cấp: "ngày 17 tháng 05 năm 2022" trong phần đầu văn bản
  const head = text.slice(0, 1200);
  const dateMatch = /ngày\s+(\d{1,2})\s+tháng\s+(\d{1,2})\s+năm\s+(\d{4})/i.exec(head);
  if (dateMatch) {
    const dd = dateMatch[1].padStart(2, '0');
    const mm = dateMatch[2].padStart(2, '0');
    f.ngayCap = `${dateMatch[3]}-${mm}-${dd}`;
  }

  // --- Loại văn bản: dòng tiêu đề toàn chữ hoa bắt đầu bằng "GIẤY PHÉP"
  for (const line of lines.slice(0, 40)) {
    const t = line.trim();
    if (/^GIẤY PHÉP/.test(t) && t.length > 10) {
      f.loaiVanBan = smartTitle(t);
      break;
    }
  }

  // --- Cơ quan cấp (suy từ mã số GP / chức danh ký)
  if (/GP-BTTTT/.test(f.soGiayPhep)) f.coQuanCap = 'Bộ Thông tin và Truyền thông';
  else if (/GP-CBC/.test(f.soGiayPhep)) f.coQuanCap = 'Cục Báo chí';
  else if (/GP-BC/.test(f.soGiayPhep)) f.coQuanCap = 'Cục Báo chí';
  else {
    const capMatch = /do\s+(Bộ\s[^;,]{3,60}|Cục\s[^;,]{3,60})\s+cấp/.exec(text);
    if (capMatch) f.coQuanCap = collapseWs(capMatch[1]);
  }

  // --- Tên cơ quan chủ quản / cơ quan báo chí: dòng ngay sau nhãn mục
  function nameAfterLabel(labelRe) {
    for (let i = 0; i < lines.length; i++) {
      if (labelRe.test(lines[i])) {
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const t = lines[j].trim();
          if (!t) continue;
          if (t.startsWith('-')) return '';
          return smartTitle(t.replace(/[:.;]+$/, ''));
        }
        return '';
      }
    }
    return '';
  }
  f.coQuanChuQuan = nameAfterLabel(/Tên cơ quan chủ quản/);
  f.coQuanBaoChi = nameAfterLabel(/Tên cơ quan báo chí/);

  // --- Trụ sở / liên hệ: ưu tiên mục "Trụ sở chính", không có thì lấy lần xuất hiện đầu
  const truSoIdx = text.search(/Trụ sở chính/);
  const contactScope = truSoIdx >= 0 ? text.slice(truSoIdx, truSoIdx + 2000) : text;
  const addrMatch = /Địa chỉ:\s*([^\n]+)/.exec(contactScope);
  if (addrMatch) f.diaChi = stripTrailingPunct(addrMatch[1]);
  const telMatch = /Điện thoại:\s*([\d][\d.]*\d)/.exec(contactScope);
  if (telMatch) f.dienThoai = collapseWs(telMatch[1]);
  const faxMatch = /Fax:\s*([\d][\d.]*\d)/.exec(contactScope);
  if (faxMatch) f.fax = collapseWs(faxMatch[1]);

  // --- Email
  const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  f.email = [...new Set(emails)].join(', ');

  // --- Tôn chỉ, mục đích / Đối tượng phục vụ
  const tonChi = sliceBetween(text, /Tôn chỉ, mục đích:\s*/i, [NEXT_SECTION, /Đối tượng phục vụ:/g], 6000);
  if (tonChi) f.tonChiMucDich = collapseWs(tonChi).replace(/^[-\s]+/, '');
  const doiTuong = sliceBetween(text, /Đối tượng phục vụ:\s*/i, [NEXT_SECTION], 2000);
  if (doiTuong) f.doiTuongPhucVu = stripTrailingPunct(doiTuong);

  // --- Hiệu lực
  const hl = sliceBetween(text, /Hiệu lực(?: của [Gg]iấy phép)?:?\s*/, [NEXT_SECTION], 1500);
  if (hl) f.hieuLuc = collapseWs(hl);

  // --- Ấn phẩm
  const anPham = [];
  // Dạng chuẩn: các khối "Tên gọi: ..." kèm thuộc tính theo sau
  const tenGoiRe = /Tên gọi:\s*([^\n;]+)/g;
  let tg;
  while ((tg = tenGoiRe.exec(text)) !== null) {
    const block = text.slice(tg.index, tg.index + 900);
    const ap = {
      ten: stripTrailingPunct(tg[1]),
      loaiHinh: '',
      soTrang: '',
      kyXuatBan: '',
      tenMien: '',
    };
    const ky = /Kỳ hạn xuất bản:\s*([^\n;]+)/.exec(block);
    if (ky) ap.kyXuatBan = stripTrailingPunct(ky[1]);
    const ph = /Thời gian phát hành:\s*([^\n;]+)/.exec(block);
    if (ph) ap.kyXuatBan = (ap.kyXuatBan ? ap.kyXuatBan + ' — ' : '') + 'Phát hành: ' + stripTrailingPunct(ph[1]);
    const st = /Số trang:\s*([^\n;]+)/.exec(block);
    if (st) ap.soTrang = stripTrailingPunct(st[1]);
    const tm = /Tên miền:\s*([^\s;]+)/.exec(block);
    if (tm) ap.tenMien = tm[1].replace(/[.;]+$/, '');
    const before = text.slice(Math.max(0, tg.index - 400), tg.index);
    if (/Báo điện tử/i.test(before) || ap.tenMien) ap.loaiHinh = 'Báo điện tử';
    else if (/Loại hình in|Ấn phẩm chính/i.test(before)) ap.loaiHinh = 'Báo in';
    anPham.push(ap);
  }
  // Dạng chuyên trang điện tử: "Tên loại hình điện tử: ..." + "Tên miền: ..."
  const ltMatch = /Tên loại hình điện tử:\s*([^\n;]+)/.exec(text);
  if (ltMatch) {
    const tm = /Tên miền:\s*([^\s;]+)/.exec(text);
    anPham.push({
      ten: stripTrailingPunct(ltMatch[1]),
      loaiHinh: 'Báo điện tử',
      soTrang: '',
      kyXuatBan: '',
      tenMien: tm ? tm[1].replace(/[.;]+$/, '') : '',
    });
  }
  // Tên chuyên trang
  const ct = nameAfterLabel(/Tên chuyên trang/);
  if (ct) {
    anPham.push({ ten: ct, loaiHinh: 'Chuyên trang báo điện tử', soTrang: '', kyXuatBan: '', tenMien: '' });
  }
  f.anPham = anPham;

  // --- Website / tên miền chính
  const mainDomain = /Tên miền:\s*([^\s;]+)/.exec(text);
  if (mainDomain) f.website = mainDomain[1].replace(/[.;]+$/, '');
  else {
    const dm = /\b((?:[a-z0-9-]+\.)+(?:com\.vn|vn|com\.vn))\b/i.exec(text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, ' '));
    if (dm) f.website = dm[1];
  }

  // --- Lãnh đạo
  const tbt = /Tổng biên tập:\s*([^\n]+)/.exec(text);
  if (tbt) f.tongBienTap = stripTrailingPunct(tbt[1]);
  const ptbtBlock = sliceBetween(text, /Phó Tổng biên tập:\s*/, [NEXT_SECTION], 600);
  if (ptbtBlock) {
    f.phoTongBienTap = ptbtBlock
      .split(/[;\n]/)
      .map((s) => stripTrailingPunct(s.replace(/^[-–\s]+/, '')))
      .filter((s) => s.length >= 3 && s.length <= 60 && !/^\d+$/.test(s));
  }

  // --- Người ký: tên sau khối chức danh ở cuối văn bản
  const tail = text.slice(-1500);
  const kyMatch = /(THỨ TRƯỞNG|CỤC TRƯỞNG|BỘ TRƯỞNG|PHÓ CỤC TRƯỞNG)\s*\n\s*\n?\s*([A-ZÀ-Ỹ][a-zà-ỹ]+(?: [A-ZÀ-Ỹ][a-zà-ỹ]+){1,3})/.exec(tail);
  if (kyMatch) f.nguoiKy = kyMatch[2].trim();

  // --- Căn cứ pháp lý: các đoạn "Căn cứ ..." trong phần đầu, trước QUYẾT ĐỊNH
  const preambleEnd = text.indexOf('QUYẾT ĐỊNH');
  const preamble = preambleEnd >= 0 ? text.slice(0, preambleEnd) : text.slice(0, 3000);
  const canCuParts = preamble.split(/Căn cứ\s+/).slice(1);
  f.canCuPhapLy = canCuParts
    .map((p) => {
      const cut = p.split(/;|\n\s*Theo đề nghị/)[0];
      return 'Căn cứ ' + collapseWs(cut);
    })
    .filter((s) => s.length > 20 && s.length < 700)
    .slice(0, 10);

  return f;
}

// Gộp các trường đã trích (incoming) lên trên bản ghi gốc: giá trị rỗng không ghi đè
function mergeFields(base, incoming) {
  const out = Object.assign(emptyFields(), base || {});
  if (!incoming) return out;
  for (const key of Object.keys(out)) {
    const v = incoming[key];
    if (Array.isArray(v)) {
      if (v.length) out[key] = v;
    } else if (v != null && String(v).trim() !== '') {
      out[key] = v;
    }
  }
  return out;
}

// Chuẩn hoá dữ liệu gửi lên từ API/UI về đúng cấu trúc trường
function sanitizeFields(input) {
  const f = emptyFields();
  if (!input || typeof input !== 'object') return f;
  for (const key of Object.keys(f)) {
    const v = input[key];
    if (v === undefined) continue;
    if (Array.isArray(f[key])) {
      if (key === 'anPham') {
        f.anPham = (Array.isArray(v) ? v : [])
          .filter((a) => a && typeof a === 'object')
          .map((a) => ({
            ten: String(a.ten || ''),
            loaiHinh: String(a.loaiHinh || ''),
            soTrang: String(a.soTrang || ''),
            kyXuatBan: String(a.kyXuatBan || ''),
            tenMien: String(a.tenMien || ''),
          }));
      } else {
        f[key] = (Array.isArray(v) ? v : [v]).map((x) => String(x)).filter((x) => x.trim() !== '');
      }
    } else {
      f[key] = v == null ? '' : String(v);
    }
  }
  return f;
}

// Ánh xạ JSON "bên ngoài" (định dạng trích xuất 39 trường kiểu PascalCase,
// ví dụ các file trong thư mục data/ của dự án, có thể bọc trong khóa DuLieu)
// về cấu trúc trường nội bộ. Nếu đầu vào đã đúng cấu trúc nội bộ thì trả về nguyên vẹn.
function mapExternalJson(input) {
  if (!input || typeof input !== 'object') return input;
  if (input.soGiayPhep !== undefined || input.fields) return input;
  const o = input.DuLieu && typeof input.DuLieu === 'object' ? input.DuLieu : input;
  const looksExternal =
    o.SoGiayPhep !== undefined ||
    o.GiayPhepHoatDong !== undefined ||
    o.DinhDanhCoQuanBaoChi !== undefined ||
    o.TenCoQuanBaoChi !== undefined;
  if (!looksExternal) return input;

  const gphd = o.GiayPhepHoatDong || {};
  const cqbc = o.CoQuanBaoChi && typeof o.CoQuanBaoChi === 'object' ? o.CoQuanBaoChi : {};
  const truSo = cqbc.TruSoChinh || o.DiaChiLienHe || {};
  const cqcq = o.CoQuanChuQuan && typeof o.CoQuanChuQuan === 'object' ? o.CoQuanChuQuan : {};
  const noiDung = o.NoiDung || {};
  const str = (v) => (v == null ? '' : Array.isArray(v) ? v.join('\n') : String(v));
  const loaiHinhMap = { BAO_IN: 'Báo in', BAO_DIEN_TU: 'Báo điện tử', TAP_CHI_IN: 'Tạp chí in', TAP_CHI_DIEN_TU: 'Tạp chí điện tử' };

  const anPham = (Array.isArray(o.AnPham) ? o.AnPham : []).map((a) => ({
    ten: a.TenAnPham || a.Ten || '',
    loaiHinh: loaiHinhMap[a.LoaiHinh] || a.LoaiHinh || '',
    soTrang: a.SoTrang || '',
    kyXuatBan: [a.KyHanXuatBan, a.ThoiGianPhatHanh ? 'Phát hành: ' + a.ThoiGianPhatHanh : ''].filter(Boolean).join(' — '),
    tenMien: a.TenMien || '',
  }));

  const lanhDao = Array.isArray(o.LanhDao) ? o.LanhDao : [];
  const tbt = lanhDao.find((l) => /TONG_BIEN_TAP/.test(l.ChucDanh || ''));
  const ptbt = lanhDao.filter((l) => /PHO_TONG_BIEN_TAP/.test(l.ChucDanh || '')).map((l) => l.HoTen).filter(Boolean);

  const dienTu = anPham.find((a) => a.tenMien);
  return {
    soGiayPhep: o.SoGiayPhep || gphd.SoGiayPhep || '',
    loaiVanBan: o.LoaiVanBan || '',
    ngayCap: o.NgayCap || gphd.NgayCap || '',
    coQuanCap: typeof o.CoQuanCap === 'string' ? o.CoQuanCap : gphd.CoQuanCap || '',
    nguoiKy: o.NguoiKy && typeof o.NguoiKy === 'object' ? o.NguoiKy.HoTen || '' : str(o.NguoiKy),
    hieuLuc: o.HieuLucGiayPhep || gphd.HieuLucGiayPhep || '',
    coQuanChuQuan: cqcq.TenCoQuan || (typeof o.CoQuanChuQuan === 'string' ? o.CoQuanChuQuan : ''),
    coQuanBaoChi: cqbc.TenCoQuanBaoChi || (o.DinhDanhCoQuanBaoChi || {}).TenCoQuanBaoChi || (typeof o.CoQuanBaoChi === 'string' ? o.CoQuanBaoChi : ''),
    diaChi: truSo.DiaChi || truSo.DiaChiTruSo || '',
    dienThoai: truSo.DienThoai || truSo.SoDienThoai || '',
    fax: truSo.Fax || '',
    email: Array.isArray(truSo.Email) ? truSo.Email.join(', ') : str(truSo.Email),
    website: truSo.Website || (dienTu ? dienTu.tenMien : ''),
    tonChiMucDich: str(o.TonChiMucDich || noiDung.TonChiMucDich),
    doiTuongPhucVu: str(o.DoiTuongPhucVu || noiDung.DoiTuongPhucVu),
    anPham,
    tongBienTap: tbt ? tbt.HoTen : '',
    phoTongBienTap: ptbt,
    canCuPhapLy: Array.isArray(o.CanCuPhapLy) ? o.CanCuPhapLy.map(String) : [],
    _fileName: o.NguonFile || '',
  };
}

module.exports = { emptyFields, parseLicenseText, mergeFields, sanitizeFields, mapExternalJson };
