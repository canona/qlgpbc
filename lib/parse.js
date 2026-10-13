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
  return collapseWs(s).replace(/[.;:]+$/, '').trim();
}

// Bỏ dấu tiếng Việt (bản module-level cho các hàm ngoài parseLicenseText)
function stripAccents(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

// Chuẩn hoá (năm, tháng, ngày) thành chuỗi ISO yyyy-mm-dd, CHỈ khi đó là
// ngày có thật trên lịch: chặn ngày > 31, tháng > 12 và các ngày không tồn
// tại như 31/2 (lỗi OCR từng cho ra "2021-07-98" từ "ngày 98 tháng 7").
// Không hợp lệ -> '' để nơi gọi tự bỏ qua.
function isoDateOrEmpty(y, m, d) {
  const yy = parseInt(y, 10);
  const mm = parseInt(m, 10);
  const dd = parseInt(d, 10);
  if (!yy || mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  if (dt.getUTCFullYear() !== yy || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return '';
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
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
  // Bỏ dấu tiếng Việt để so khớp khoan dung với lỗi rớt dấu của OCR
  const noAccent = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase();

  // --- Số giấy phép: CHỈ tin số đọc được tại nhãn "Số:" ở đầu văn bản (vd
  // "Số: 24/GP-CBC"); OCR có thể chèn dấu "-" hoặc khoảng trắng thừa giữa
  // phần số và "/GP-" nên cho phép ký tự phân cách đó, và chấp nhận cả
  // biến thể mất dấu hai chấm khi "Số" đứng đầu dòng ở vùng đầu văn bản.
  // Số GP xuất hiện trong thân văn bản ở ngữ cảnh VIỆN DẪN/THAY THẾ (vd
  // "Giấy phép hoạt động báo chí số 164/GP-BVHTT ngày..." trong phần căn
  // cứ hoặc mục hiệu lực) TUYỆT ĐỐI không được lấy làm số của văn bản này
  // — đó là bẫy đã khiến hồ sơ 183/GP-BC bị gán nhầm 164/GP-BVHTT ở bản 1;
  // các số đó chỉ được thu vào danh sách ứng viên đối chiếu (buildCrossCheck).
  const soLabel =
    /Số:\s*(\d+)\s*[-.]?\s*\/\s*(GP-[A-Z]+)/.exec(text) ||
    /^\s*S[ốôo]\s+(\d{1,6})\s*[-.]?\s*\/\s*(GP-[A-Z]+)/m.exec(text.slice(0, 1500));
  if (soLabel) {
    f.soGiayPhep = soLabel[1] + '/' + soLabel[2];
  } else {
    // Dự phòng thận trọng: số GP đầu tiên KHÔNG nằm trong ngữ cảnh viện
    // dẫn (dòng chứa "Căn cứ/Thay thế/Quyết định..." hoặc dạng "...số <số>"
    // đều bị loại). Không còn ứng viên nào thì để trống — thà trống còn
    // hơn gán nhầm số của giấy phép khác.
    const gpRe = /(\d+)\s*\/\s*(GP-[A-Z]+)/g;
    let gm;
    while ((gm = gpRe.exec(text)) !== null) {
      const lineStart = text.lastIndexOf('\n', gm.index) + 1;
      const nl = text.indexOf('\n', gm.index);
      const line = text.slice(lineStart, nl === -1 ? text.length : nl);
      const before = noAccent(line.slice(0, gm.index - lineStart)).trim();
      const citationContext =
        /(^|\s)so\s*:?\s*$/.test(before) ||
        /(can cu|thay the|quyet dinh|thong tu|nghi dinh|cong van|de nghi)/.test(noAccent(line));
      if (citationContext) continue;
      f.soGiayPhep = gm[1] + '/' + gm[2];
      break;
    }
  }

  // --- Ngày cấp: dòng địa danh + "ngày ... tháng ... năm ..." ở phần đầu.
  // Chỉ quét vùng thư đầu — các dòng TRƯỚC dòng tiêu đề/căn cứ đầu tiên —
  // vì ngày ký luôn nằm ở khối đầu văn bản; quét sâu hơn sẽ trúng ngày của
  // văn bản được viện dẫn trong phần căn cứ hoặc nội dung (vd giấy phép
  // gốc được nhắc lại trong tôn chỉ). Trong vùng quét vẫn bỏ qua dòng
  // viện dẫn và dòng nối tiếp của chúng.
  // Dự phòng cuối: mốc "Thời gian ký: dd/mm/yyyy" của chữ ký số (nếu có).
  const CITATION_LINE = /(căn cứ|luật|nghị định|thông tư|quyết định số|văn bản số|công văn|đề nghị|hồ sơ)/i;
  const headLines = text.slice(0, 3000).split('\n');
  let headCut = headLines.length;
  for (let i = 0; i < headLines.length; i++) {
    if (CITATION_LINE.test(headLines[i]) || /QUY[ÊẾE]T\s*Đ[ỊI]NH/.test(headLines[i])) {
      headCut = i;
      break;
    }
  }
  for (let i = 0; i < headCut; i++) {
    const line = headLines[i];
    if (CITATION_LINE.test(line)) continue;
    // Dòng nối tiếp của một dòng viện dẫn (câu căn cứ bị ngắt dòng) cũng bỏ
    // qua: nhìn lại dòng có chữ gần nhất phía trước, nếu đó là dòng viện
    // dẫn thì ngày trong dòng nối tiếp vẫn là ngày của văn bản viện dẫn.
    let prev = '';
    for (let j = i - 1; j >= 0; j--) {
      if (headLines[j].trim()) {
        prev = headLines[j];
        break;
      }
    }
    if (prev && CITATION_LINE.test(prev)) continue;
    const dm = /ngày\s+(\d{1,2})\s+tháng\s+(\d{1,2})\s+năm\s+(\d{4})/i.exec(line);
    if (dm) {
      const iso = isoDateOrEmpty(dm[3], dm[2], dm[1]);
      // Ngày không tồn tại (vd OCR đọc chữ viết tay thành "ngày 98 tháng
      // 7") thì bỏ qua dòng này và tiếp tục quét — không bao giờ để lọt
      // ngày vô lý như 2021-07-98.
      if (iso) {
        f.ngayCap = iso;
        break;
      }
    }
  }
  if (!f.ngayCap) {
    const stamp = /Thời gian ký:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
    if (stamp) f.ngayCap = isoDateOrEmpty(stamp[3], stamp[2], stamp[1]);
  }

  // --- Loại văn bản: dòng tiêu đề toàn chữ hoa bắt đầu bằng "GIẤY PHÉP".
  // So khớp không dấu vì OCR hay đọc sai dấu ở dòng tiêu đề in hoa
  // ("GIẦY PHÉP", "GIAY PHÉP"...).
  for (const line of lines.slice(0, 40)) {
    const t = line.trim();
    if (noAccent(t).startsWith('giay phep') && t.length > 10) {
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
  const addrMatch = /[ĐD][ịi]a chỉ:\s*([^\n]+)/.exec(contactScope);
  if (addrMatch) f.diaChi = stripTrailingPunct(addrMatch[1]);
  const telMatch = /Điện thoại:\s*([\d][\d.]*\d)/.exec(contactScope);
  if (telMatch) f.dienThoai = collapseWs(telMatch[1]);
  const faxMatch = /Fax:\s*([\d][\d.]*\d)/.exec(contactScope);
  if (faxMatch) f.fax = collapseWs(faxMatch[1]);

  // --- Email
  const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  f.email = [...new Set(emails)].join(', ');

  // --- Tôn chỉ, mục đích / Đối tượng phục vụ
  // Nhãn "Đối tượng phục vụ" nới lỏng dấu ([ĐD].i ... v[ụu]) vì OCR hay
  // rớt dấu ở đúng nhãn này ("Doi tượng phục vu:").
  const tonChi = sliceBetween(text, /Tôn chỉ, mục đích:\s*/i, [NEXT_SECTION, /[ĐD].i tượng phục v[ụu]:/g], 6000);
  if (tonChi) f.tonChiMucDich = collapseWs(tonChi).replace(/^[-\s]+/, '');
  const doiTuong = sliceBetween(text, /[ĐD].i tượng phục v[ụu]:\s*/i, [NEXT_SECTION], 2000);
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
  // Dạng tiêu đề mục đánh số: "5.1.2.1. Ấn phẩm An ninh biên giới" rồi các
  // thuộc tính gạch đầu dòng theo sau (không có nhãn "Tên gọi:").
  const headingRe = /\d+(?:\.\d+)*\.\s*(?:[ẤÂ]n phẩm|An phẩm)\s+([^\n;]+)/g;
  let hm;
  while ((hm = headingRe.exec(text)) !== null) {
    const ten = stripTrailingPunct(hm[1]);
    if (!ten || ten.length < 3) continue;
    // Bỏ các tiêu đề mục chung chung kiểu "Ấn phẩm chính:" / "Ấn phẩm khác:"
    if (['chinh', 'khac'].includes(noAccent(ten))) continue;
    if (anPham.some((a) => collapseWs(a.ten).toLowerCase() === collapseWs(ten).toLowerCase())) continue;
    const block = text.slice(hm.index, hm.index + 700);
    const ap = { ten, loaiHinh: 'Báo in', soTrang: '', kyXuatBan: '', tenMien: '' };
    const ky2 = /Kỳ hạn xuất bản:\s*([^\n;]+)/.exec(block);
    if (ky2) ap.kyXuatBan = stripTrailingPunct(ky2[1]);
    const ph2 = /Thời gian phát hành:\s*([^\n;]+)/.exec(block);
    if (ph2) ap.kyXuatBan = (ap.kyXuatBan ? ap.kyXuatBan + ' — ' : '') + 'Phát hành: ' + stripTrailingPunct(ph2[1]);
    const st2 = /Số trang:\s*([^\n;]+)/.exec(block);
    if (st2) ap.soTrang = stripTrailingPunct(st2[1]);
    const tm2 = /Tên miền:\s*([^\s;]+)/.exec(block);
    if (tm2) {
      ap.tenMien = tm2[1].replace(/[.;]+$/, '');
      ap.loaiHinh = 'Báo điện tử';
    }
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

  // --- Người ký: khối ký ở cuối văn bản. Trên giấy phép mẫu hiện hành,
  // tên người ký thường KHÔNG đứng ngay sau dòng chức danh (ở giữa là nét
  // chữ ký tay bị OCR thành rác, hoặc cả khối "Nơi nhận"), nên bản 1 gần
  // như luôn bỏ trống dù tên có mặt trong text thô (14/15 tổ hợp ở đợt
  // benchmark). Bản 2 nới cách bắt theo 2 bước nhưng mọi ứng viên đều
  // phải qua bộ lọc "giống tên người Việt" rất chặt — không qua được thì
  // vẫn để trống:
  //   A) Tên đứng trong vài dòng ngay sau dòng chức danh ký — bố cục chuẩn.
  //   B) Vùng SAU khối "Nơi nhận", quét từ cuối lên: dòng tên đứng riêng
  //      (vị trí nét ký), hoặc dòng "- Chức danh <Tên>" trong danh sách
  //      nơi nhận khi chức danh đó trùng chức danh ký (người ký tự nhận
  //      một bản "để b/c": KT. BỘ TRƯỞNG do Thứ trưởng ký thì dòng
  //      "- Thứ trưởng <Tên>" chính là người ký).
  // Tên bắt theo cách này khi nguồn là OCR luôn bị fieldConfidence gắn
  // 'low' (xem fieldConfidence) vì vùng quanh khối ký rất nhiễu.
  const SIGNER_TITLES = ['pho cuc truong', 'cuc truong', 'bo truong', 'thu truong'];
  const RANK_PREFIXES = ['thieu tuong', 'thien tuong', 'trung tuong', 'thuong tuong', 'dai ta'];
  const NAME_BLOCKLIST = /(kinh gui|noi nhan|co quan|tu lenh|bien phong|chinh tri|phe duyet|to khai)/;
  function cleanSignerName(raw) {
    const s = collapseWs(String(raw || '').replace(/^[-–—•\s]+/, '').replace(/[;.,:()"]+$/, '').trim());
    if (!s || /[0-9/\\<>=+@#*_|]/.test(s)) return '';
    const titled = smartTitle(s);
    const toks = titled.split(' ');
    if (toks.length < 2 || toks.length > 4) return '';
    for (const t of toks) {
      if (!/^[A-Za-zÀ-ỹ]+$/.test(t)) return '';
      const stripped = noAccent(t);
      if (stripped.length < 2 || stripped.length > 7) return '';
      // Chữ/cụm chữ không tồn tại trong tiếng Việt: tên ký tay bị OCR rác
      // hay sinh dạng này ("Ffoang" có f, "Notiyen" có cụm iy).
      if (/[fjwz]/i.test(t) || /iy/.test(stripped)) return '';
      if (!/^[A-ZÀ-Ỹ]/.test(t)) return '';
      // Từ viết tắt toàn hoa ("BP", "VT") lẫn trong dòng chữ thường -> không
      // phải tên người. Phải so token với chính dạng hoa/thường của nó:
      // KHÔNG dùng lớp ký tự [A-ZÀ-Ỹ] vì khoảng À-Ỹ chứa cả chữ thường có
      // dấu (ỗ, ữ, ộ...) — sẽ giết nhầm họ 2 chữ như "Đỗ", "Võ", "Hồ".
      if (t.length <= 3 && t === t.toUpperCase() && t !== t.toLowerCase() && titled !== titled.toUpperCase()) return '';
    }
    if (NAME_BLOCKLIST.test(noAccent(titled))) return '';
    return titled;
  }
  function stripSignerPrefix(line) {
    const cleaned = collapseWs(String(line || '').replace(/^[-–—•\s]+/, ''));
    const toks = cleaned.split(' ');
    for (let n = Math.min(3, toks.length - 2); n >= 1; n--) {
      const head = noAccent(toks.slice(0, n).join(' ')).replace(/[.:]+$/, '');
      if (SIGNER_TITLES.includes(head) || RANK_PREFIXES.includes(head)) {
        return { title: head, rest: toks.slice(n).join(' ') };
      }
    }
    return null;
  }
  f.nguoiKy = extractSigner();
  function extractSigner() {
    const tailLines = text.slice(-3000).split('\n');
    // Chức danh ký xuất hiện trong các dòng NGẮN ở cuối văn bản (khối ký /
    // dòng đầu khối Nơi nhận). "KT." = ký thay: khi đó cấp phó (Thứ
    // trưởng / Phó Cục trưởng) là người ký thật.
    const anchorTitles = new Set();
    let ktPresent = false;
    for (const line of tailLines) {
      const na = noAccent(line).trim();
      if (na.length > 70) continue;
      for (const t of SIGNER_TITLES) if (na.includes(t)) anchorTitles.add(t);
      if (na.includes('kt.')) ktPresent = true;
    }
    if (ktPresent) {
      anchorTitles.add('thu truong');
      anchorTitles.add('pho cuc truong');
    }
    const prefixAllowed = (p) => anchorTitles.has(p.title) || RANK_PREFIXES.includes(p.title);
    // Bước A: tên trong vài dòng ngay sau dòng chức danh ký
    for (let i = 0; i < tailLines.length; i++) {
      const na = noAccent(tailLines[i]).trim().replace(/[.:]+$/, '');
      if (!SIGNER_TITLES.some((t) => na === t || na === 'kt ' + t || na.endsWith(' ' + t))) continue;
      let seen = 0;
      for (let j = i + 1; j < tailLines.length && seen < 4; j++) {
        if (!tailLines[j].trim()) continue;
        seen++;
        const cand = cleanSignerName(tailLines[j]);
        if (cand) return cand;
        const stripped = stripSignerPrefix(tailLines[j]);
        if (stripped && prefixAllowed(stripped)) {
          const c2 = cleanSignerName(stripped.rest);
          if (c2) return c2;
        }
      }
    }
    // Bước B: vùng sau khối "Nơi nhận", quét từ cuối lên
    let regionStart = 0;
    for (let i = 0; i < tailLines.length; i++) {
      if (noAccent(tailLines[i]).includes('noi nhan')) regionStart = i + 1;
    }
    for (let i = tailLines.length - 1; i >= regionStart; i--) {
      const raw = tailLines[i];
      if (!raw.trim()) continue;
      const isBullet = /^[-–—•]/.test(raw.trim());
      // Dòng gạch đầu dòng là mục nơi nhận/tổ chức — chỉ xét khi nó mang
      // chức danh ký ở đầu (đường prefix), không xét như tên đứng riêng.
      if (!isBullet) {
        const cand = cleanSignerName(raw);
        if (cand) return cand;
      }
      const stripped = stripSignerPrefix(raw);
      if (stripped && prefixAllowed(stripped)) {
        const c2 = cleanSignerName(stripped.rest);
        if (c2) return c2;
      }
    }
    return '';
  }

  // --- Căn cứ pháp lý: các đoạn "Căn cứ ..." trong phần đầu, trước QUYẾT ĐỊNH
  // (tìm "QUYẾT ĐỊNH" khoan dung dấu vì OCR hay rớt dấu: "QUYET ĐỊNH")
  const qdMatch = /QUY[ÊẾE]T\s*Đ[ỊI]NH/.exec(text);
  const preambleEnd = qdMatch ? qdMatch.index : -1;
  const preamble = preambleEnd >= 0 ? text.slice(0, preambleEnd) : text.slice(0, 3000);
  // Tách tại mỗi điểm bắt đầu mục: "Căn cứ ..." hoặc "Theo đề nghị ..."
  // (các mục "Theo đề nghị" cũng là căn cứ pháp lý của giấy phép; trước đây
  // chúng bị dính vào mục Căn cứ phía trước rồi bị loại vì quá dài).
  // Các mẫu nới lỏng dấu ("Can cứ", "Theo đê nghị") vì OCR hay rớt dấu.
  const canCuParts = preamble
    .split(/(?=C[aă]n c[ứu]\s+)|(?=[Tt]heo đ[ềê] nghị\s+)/)
    .filter((p) => /^(C[aă]n c[ứu]|[Tt]heo đ[ềê] nghị)\s+/.test(p.trim()));
  f.canCuPhapLy = canCuParts
    .map((p) => {
      const cut = p.split(/;/)[0];
      const t = collapseWs(cut);
      return /^C[aă]n c[ứu]\s/.test(t) ? 'Căn cứ ' + t.replace(/^C[aă]n c[ứu]\s+/, '') : t;
    })
    .filter((s) => s.length > 20 && s.length < 1200)
    .slice(0, 10);

  return f;
}

// Số giấy phép đọc được tại nhãn "Số:" ở đầu văn bản (nguồn đáng tin nhất
// cho trường này). Trả '' nếu không thấy — khi đó số GP bắt được có thể là
// số của giấy phép khác được viện dẫn trong phần căn cứ/nội dung.
function licenseNumberFromLabel(rawText) {
  const m = /Số:\s*(\d+)\s*[-.]?\s*\/\s*(GP-[A-Z]+)/.exec(String(rawText || ''));
  return m ? m[1] + '/' + m[2] : '';
}

// Đối chiếu chéo cho người duyệt (bản 2): quét toàn văn tìm MỌI chuỗi dạng
// số giấy phép (\d+/GP-...) và số văn bản liên quan (1093/CT-TH,
// 2020/TT-BTTTT...), phân loại ngữ cảnh xuất hiện của từng số GP
// ('label' = tại dòng "Số:", 'citation' = ngữ cảnh viện dẫn/thay thế,
// 'body' = thân văn bản), rồi so với số GP đã trích để sinh cảnh báo.
// Hàm này KHÔNG sửa giá trị trường nào — chỉ cung cấp bằng chứng đối
// chiếu, vì số GP/ngày cấp trên giấy phép là chữ viết tay mà OCR không
// đọc tin cậy được. Đối chiếu với hồ sơ đã có trong store do worker làm
// (trường storeMatches được worker gắn thêm vào kết quả hàm này).
function buildCrossCheck(rawText, fields) {
  const text = String(rawText || '');
  const f = fields || {};
  const CITATION_RE = /(can cu|thay the|quyet dinh|thong tu|nghi dinh|cong van|de nghi|van ban)/;

  function contextOf(idx) {
    const lineStart = text.lastIndexOf('\n', idx) + 1;
    const nl = text.indexOf('\n', idx);
    const line = text.slice(lineStart, nl === -1 ? text.length : nl);
    if (/^\s*S[ốôo]\s*:/.test(line)) return { context: 'label', line };
    const before = stripAccents(line.slice(0, idx - lineStart)).trim();
    if (/(^|\s)so\s*:?\s*$/.test(before) || CITATION_RE.test(stripAccents(line))) {
      return { context: 'citation', line };
    }
    return { context: 'body', line };
  }

  // --- Mọi số dạng giấy phép trong văn bản (cho phép ký tự "-" / "."
  // thừa giữa phần số và "/GP-" như regex nhãn "Số:" của parser)
  const byValue = new Map();
  const gpRe = /(\d{1,6})\s*[-.]?\s*\/\s*(GP-[A-ZĐ][A-ZĐ-]*)/g;
  let m;
  while ((m = gpRe.exec(text)) !== null) {
    const value = m[1] + '/' + m[2];
    const { context, line } = contextOf(m.index);
    let entry = byValue.get(value);
    if (!entry) {
      entry = { value, count: 0, contexts: [], example: collapseWs(line).slice(0, 140) };
      byValue.set(value, entry);
    }
    entry.count++;
    if (!entry.contexts.includes(context)) entry.contexts.push(context);
  }
  const candidates = [...byValue.values()].sort((a, b) => b.count - a.count);

  // --- Số văn bản liên quan (không phải số GP): quyết định, thông tư,
  // công văn đề nghị... để người duyệt có thêm mốc đối chiếu ngày/số.
  const related = [];
  const seenRelated = new Map();
  const relRe = /(\d{1,6})\/([A-ZĐ]{2,}(?:-[A-ZĐ0-9]+)+)/g;
  while ((m = relRe.exec(text)) !== null) {
    const value = m[1] + '/' + m[2];
    if (value.includes('/GP-')) continue;
    seenRelated.set(value, (seenRelated.get(value) || 0) + 1);
  }
  for (const [value, count] of seenRelated) {
    related.push({ value, count });
    if (related.length >= 10) break;
  }

  // --- Cảnh báo về ngày cấp: mốc ngày ở đầu văn bản mà parser phải bỏ
  // qua vì không phải ngày có thật (OCR đọc sai chữ viết tay).
  const dateWarnings = [];
  const dre = /ngày\s+(\d{1,2})\s+tháng\s+(\d{1,2})\s+năm\s+(\d{4})/gi;
  const head = text.slice(0, 3000);
  let dm;
  while ((dm = dre.exec(head)) !== null) {
    if (!isoDateOrEmpty(dm[3], dm[2], dm[1])) {
      dateWarnings.push(
        `Văn bản có mốc "ngày ${dm[1]} tháng ${dm[2]} năm ${dm[3]}" không phải ngày có thật — parser đã bỏ qua, không dùng làm ngày cấp (OCR thường đọc sai ngày viết tay ở đầu văn bản).`
      );
    }
  }

  // --- Cảnh báo về số GP
  const warnings = [];
  const so = String(f.soGiayPhep || '').trim();
  const citedOthers = candidates.filter((c) => c.value !== so && c.contexts.includes('citation'));
  if (so) {
    const entry = byValue.get(so);
    if (!entry) {
      warnings.push(
        `Số GP đã trích (${so}) không tìm thấy nguyên dạng trong text OCR — có thể OCR đã đọc lệch ký tự; cần đối chiếu bản gốc.`
      );
    } else if (entry.count <= 1) {
      warnings.push(
        `Số GP ${so} chỉ xuất hiện 1 lần trong văn bản (tại dòng "Số:") và không được trích dẫn lại ở đâu khác để đối chiếu. Số GP trên giấy phép là chữ viết tay — hãy nhìn bản gốc trước khi lưu.`
      );
    }
    if (citedOthers.length) {
      warnings.push(
        `Văn bản còn trích dẫn số GP khác: ${citedOthers.map((c) => c.value).join(', ')} — đây thường là giấy phép gốc hoặc giấy phép được thay thế, KHÔNG phải số của văn bản này. Chỉ kiểm tra lại nếu nghi ngờ số đã trích.`
      );
    }
  } else {
    const cited = candidates.filter((c) => c.contexts.includes('citation'));
    if (cited.length) {
      warnings.push(
        `Không đọc được số GP tại dòng "Số:" (thường do số viết tay bị mờ). Các số GP tìm thấy trong văn bản đều ở ngữ cảnh trích dẫn (${cited.map((c) => c.value).join(', ')}) nên KHÔNG được dùng làm số GP của văn bản này — hãy nhập tay từ bản gốc.`
      );
    } else if (candidates.length) {
      warnings.push(
        `Không đọc được số GP tại dòng "Số:". Các số dạng GP tìm thấy: ${candidates.map((c) => c.value).join(', ')} — cần đối chiếu bản gốc trước khi dùng.`
      );
    } else {
      warnings.push('Không tìm thấy số giấy phép nào trong văn bản — cần nhập tay từ bản gốc.');
    }
  }

  return {
    candidates,
    related,
    warnings,
    dateWarnings,
    note: 'Số giấy phép và ngày cấp trên giấy phép mẫu hiện hành là CHỮ VIẾT TAY điền vào biểu mẫu in sẵn — không model OCR offline nào đọc tin cậy được. Kết quả trích xuất ở hai trường này chỉ là gợi ý; người duyệt phải đối chiếu bản gốc và các ứng viên dưới đây.',
  };
}

// Đánh giá độ tin cậy từng trường đã trích xuất — bản đồ đơn giản, có cơ sở
// theo CÁCH trường được bắt được, để màn hình duyệt/API đánh dấu trường nào
// "cần kiểm tra" thay vì tin tất cả như nhau. Mức: 'high' | 'medium' | 'low' | 'none'.
//   - high:   bắt bằng mẫu chặt, khó nhầm (số GP đúng dạng \d+/GP-XXX VÀ
//             khớp số tại nhãn "Số:" — truyền opts.soFromLabel, ngày cấp
//             đã chuẩn hoá ISO, cơ quan cấp suy ra từ mã GP theo bảng cố định,
//             email theo regex chặt).
//   - medium: bắt theo nhãn mục trong văn bản (Tên cơ quan chủ quản:, Tổng biên
//             tập:, Địa chỉ:...). Đúng vị trí nhưng nội dung vẫn có thể sai ký tự
//             nếu nguồn là OCR.
//   - low:    đoạn text tự do cắt theo mục (hiệu lực, tôn chỉ, đối tượng) khi
//             nguồn là OCR — dài nên dễ lẫn lỗi ký tự/dấu, phải đọc lại.
//             Riêng số GP + ngày cấp (chữ viết tay trên biểu mẫu) và tên
//             người ký (bắt từ khối ký) thì nguồn OCR LUÔN 'low' bất kể
//             khớp mẫu chặt đến đâu — xem case tương ứng ở dưới.
//   - none:   trường trống (không trích được).
function fieldConfidence(fields, opts) {
  const fromOcr = Boolean(opts && opts.fromOcr);
  const f = fields || {};
  const conf = {};
  const has = (k) => (Array.isArray(f[k]) ? f[k].length > 0 : String(f[k] || '').trim() !== '');
  const CANONICAL_ISSUERS = ['Bộ Thông tin và Truyền thông', 'Cục Báo chí'];

  for (const key of Object.keys(emptyFields())) {
    if (!has(key)) {
      conf[key] = 'none';
      continue;
    }
    switch (key) {
      case 'soGiayPhep':
        if (!/^\d+\/GP-[A-Z]+$/.test(String(f[key]).trim())) conf[key] = 'low';
        // Nguồn OCR: số GP trên giấy phép là CHỮ VIẾT TAY điền vào biểu
        // mẫu in sẵn — benchmark 5 model cho thấy không model offline nào
        // đọc tin cậy được (485 bị đọc thành 496/486/766). Dù khớp mẫu
        // chặt đến đâu cũng LUÔN 'low' để người duyệt buộc phải đối chiếu
        // bản gốc — chấm dứt tình trạng "đọc sai mà vẫn high" của bản 1.
        else if (fromOcr) conf[key] = 'low';
        // Đúng dạng nhưng không khớp số tại nhãn "Số:" -> có thể là số GP
        // được viện dẫn trong văn bản: hạ xuống medium để người duyệt soi lại.
        else if (opts && opts.soFromLabel === false) conf[key] = 'medium';
        else conf[key] = 'high';
        break;
      case 'ngayCap':
        // Cùng lý do với số GP: ngày cấp cũng là chữ viết tay trên biểu
        // mẫu — nguồn OCR luôn 'low'. Nguồn lớp text/gateway giữ logic cũ.
        if (fromOcr) conf[key] = 'low';
        else conf[key] = /^\d{4}-\d{2}-\d{2}$/.test(String(f[key]).trim()) ? 'high' : 'low';
        break;
      case 'nguoiKy':
        // Tên người ký bắt từ khối ký bằng luật nới lỏng (bản 2): nguồn
        // OCR luôn 'low' vì vùng quanh khối ký bị nét ký tay/con dấu làm
        // nhiễu nặng; nguồn lớp text giữ 'medium' như các trường nhãn mục.
        conf[key] = fromOcr ? 'low' : 'medium';
        break;
      case 'coQuanCap':
        conf[key] = CANONICAL_ISSUERS.includes(String(f[key]).trim()) ? 'high' : 'medium';
        break;
      case 'email':
        conf[key] = 'high';
        break;
      case 'hieuLuc':
      case 'tonChiMucDich':
      case 'doiTuongPhucVu':
        conf[key] = fromOcr ? 'low' : 'medium';
        break;
      default:
        // loaiVanBan, coQuanChuQuan, coQuanBaoChi, diaChi, dienThoai, fax,
        // website, tongBienTap và các trường mảng: bắt theo nhãn/mẫu mục.
        conf[key] = 'medium';
    }
  }
  return conf;
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

module.exports = { emptyFields, parseLicenseText, mergeFields, sanitizeFields, mapExternalJson, fieldConfidence, licenseNumberFromLabel, buildCrossCheck };
