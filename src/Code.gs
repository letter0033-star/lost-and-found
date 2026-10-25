/**
 * 분실물 센터 — 서버 코드 (Google Apps Script)
 * v1.0
 *
 * 구성
 *  - 데이터: 이 스크립트가 연결된 Google 스프레드시트
 *      분실물목록 / 반환이력 / 설정 / 관리자관리
 *  - 사진: Google Drive 전용 폴더 (공유하지 않음, 서버가 권한 확인 후 전달)
 *  - 비밀번호: 평문 저장 안 함 (솔트 + SHA-256 반복 해시)
 *      조회 비밀번호 → 스크립트 속성(VIEW_PW)
 *      관리자 비밀번호 → 관리자관리 시트(password_hash)
 *
 * 함수 이름 규칙
 *  - 이름 끝이 _ 인 함수: 내부 전용(웹 화면에서 호출 불가)
 *  - 그 외 함수: 웹 화면(google.script.run) 또는 스프레드시트 메뉴에서 호출
 *    → 웹 화면에서 부르는 함수는 모두 첫 단계에서 토큰을 검증합니다.
 */

const APP = {
  VERSION: '1.0.0',
  SHEET_ITEMS: '분실물목록',
  SHEET_HISTORY: '반환이력',
  SHEET_SETTINGS: '설정',
  SHEET_ADMINS: '관리자관리',
  VIEW_TTL_SEC: 6 * 3600,     // 조회 로그인 유지 6시간
  ADMIN_TTL_SEC: 2 * 3600,    // 관리자 로그인 유지 2시간
  HASH_ITER: 1000,
  MAX_MAIN_B64: 4 * 1024 * 1024,   // 원본(축소본) 사진 base64 최대 4MB
  MAX_THUMB_B64: 200 * 1024,       // 썸네일 base64 최대 200KB
  BACKUP_KEEP: 30
};

const STATUS = { KEEP: '보관중', RETURNED: '반환완료', DISPOSED: '폐기', DELETED: '삭제' };
const VIS = { PUBLIC: '공개', PRIVATE: '비공개' };

const ITEM_HEADERS = ['item_id', 'item_name', 'category', 'description', 'image_file_id', 'thumb_file_id',
  'found_date', 'found_location', 'storage_location', 'visibility', 'status', 'storage_period',
  'registered_at', 'returned_at', 'updated_at', 'disposed_at', 'registered_by'];
const HISTORY_HEADERS = ['history_id', 'item_id', 'action_type', 'action_date', 'processor', 'memo'];
const ADMIN_HEADERS = ['admin_id', 'name', 'password_hash', 'active', 'created_at', 'last_login_at'];
const SETTINGS_HEADERS = ['키', '값', '설명'];

const DEFAULT_SETTINGS = [
  ['학교명', '율곡초', '화면 제목에 표시됩니다. 예: 율곡초 → "율곡초 분실물 센터"'],
  ['물품분류', ['의류', '신발 및 실내화', '학용품', '가방', '물통 및 식기', '우산 및 우비', '전자기기', '개인 소지품', '체육용품', '기타'].join('\n'), '한 줄에 하나씩'],
  ['보관장소', ['교무실', '행정실', '도서관', '체육관', '별도 분실물 보관함', '기타'].join('\n'), '한 줄에 하나씩'],
  ['습득장소', ['교실', '복도', '계단', '운동장', '체육관', '급식실', '도서관', '화장실', '교문 주변', '방과후교실'].join('\n'), '등록할 때 고를 수 있는 예시 목록(직접 입력도 가능)'],
  ['기본보관기간', '30', '일 단위. 습득 날짜부터 계산합니다.'],
  ['이용안내', '학교에서 주운 물건을 모아 두는 곳이에요.\n사진을 보고 내 물건을 찾으면, 보관 장소에 가서 담당 선생님께 물품 번호를 말해 주세요.', '첫 화면 안내 문구'],
  ['문의안내', '찾는 물건이 없으면 교무실 담당 선생님께 문의해 주세요.', '검색 결과가 없을 때 보여 주는 문구']
];

const ADMIN_HISTORY_TYPES = ['등록', '수정', '공개변경', '보관장소변경', '반환완료', '반환취소', '폐기처리', '삭제', '설정변경', '비밀번호변경', '백업', '로그인'];

/* =========================================================
 * 웹앱 진입점
 * ========================================================= */

function doGet(e) {
  const isAdmin = !!(e && e.parameter && e.parameter.page === 'admin');
  const t = HtmlService.createTemplateFromFile(isAdmin ? 'Admin' : 'Index');
  let boot = { ready: false, schoolName: '학교', guide: '', contact: '' };
  try {
    const st = getSettings_();
    boot = { ready: isReady_(), schoolName: st.schoolName, guide: st.guide, contact: st.contact };
  } catch (err) {
    boot.error = '웹앱이 데이터 시트를 읽지 못했습니다. (원인: ' + String(err && err.message || err).slice(0, 200) +
      ') — Apps Script 편집기에서 diagnose 함수를 실행해 점검해 주세요.';
  }
  t.baseUrl = ScriptApp.getService().getUrl();
  t.bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
  t.schoolName = boot.schoolName;
  return t.evaluate()
    .setTitle(boot.schoolName + ' 분실물 센터' + (isAdmin ? ' · 관리' : ''))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** HTML 템플릿 조각 포함용 (HTML 파일 내용만 반환) */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* =========================================================
 * 조회(학생·일반) API
 * ========================================================= */

function viewLogin(password, clientId) {
  const guard = loginGuard_('view', clientId);
  const stored = props_().getProperty('VIEW_PW');
  if (!stored) throw new Error('조회 비밀번호가 아직 설정되지 않았습니다. 담당 선생님께 알려 주세요.');
  if (!verifyHash_(String(password || ''), stored)) {
    guard.fail();
    throw new Error('비밀번호가 맞지 않아요. 다시 확인해 주세요.');
  }
  guard.ok();
  return { token: createSession_('view', {}, APP.VIEW_TTL_SEC), ttl: APP.VIEW_TTL_SEC };
}

function getPublicItems(token) {
  getSession_(token, 'view');
  const st = getSettings_();
  const today = today_();
  const items = readTable_(APP.SHEET_ITEMS).rows
    .filter(isPublicVisible_)
    .map(it => publicItem_(it, today))
    .sort((a, b) => cmpDesc_(a.registeredAt + a.id, b.registeredAt + b.id));
  return { items: items, categories: st.categories, contact: st.contact, schoolName: st.schoolName };
}

function getPublicThumbs(token, ids) {
  getSession_(token, 'view');
  const map = indexById_(readTable_(APP.SHEET_ITEMS).rows);
  const out = {};
  cleanIdList_(ids).forEach(id => {
    const it = map[id];
    out[id] = (it && isPublicVisible_(it)) ? imageDataUrl_(it.thumb_file_id || it.image_file_id, true) : '';
  });
  return out;
}

function getPublicImage(token, id) {
  getSession_(token, 'view');
  const it = indexById_(readTable_(APP.SHEET_ITEMS).rows)[String(id || '')];
  if (!it || !isPublicVisible_(it)) throw new Error('볼 수 없는 물품입니다.');
  return imageDataUrl_(it.image_file_id || it.thumb_file_id, false);
}

function logout(token) {
  if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) CacheService.getScriptCache().remove('sess_' + token);
  return true;
}

/* =========================================================
 * 관리자 API — 모든 함수는 requireAdmin_()으로 서버 측 인증
 * ========================================================= */

function adminLogin(name, password, clientId) {
  const guard = loginGuard_('admin', clientId);
  const nm = String(name || '').trim();
  const tbl = readTable_(APP.SHEET_ADMINS);
  const adm = tbl.rows.find(r => r.name === nm && r.active === 'Y');
  // 이름이 없거나 비밀번호가 틀려도 같은 메시지 (계정 존재 여부 노출 방지)
  if (!adm || !verifyHash_(String(password || ''), adm.password_hash)) {
    guard.fail();
    throw new Error('이름 또는 비밀번호가 맞지 않습니다.');
  }
  guard.ok();
  withLock_(() => {
    writeObj_(tbl, adm._row, Object.assign({}, adm, { last_login_at: now_() }));
    addHistory_('-', '로그인', adm.name, '관리자 로그인');
  });
  return { token: createSession_('admin', { adminId: adm.admin_id, name: adm.name }, APP.ADMIN_TTL_SEC), name: adm.name, ttl: APP.ADMIN_TTL_SEC };
}

/** 관리자 화면에 필요한 데이터 한 번에 */
function adminBootstrap(token) {
  const me = requireAdmin_(token);
  const today = today_();
  const items = readTable_(APP.SHEET_ITEMS).rows
    .filter(it => it.status !== STATUS.DELETED)
    .map(it => adminItem_(it, today))
    .sort((a, b) => cmpDesc_(a.registered_at + a.item_id, b.registered_at + b.item_id));
  const nameMap = {};
  items.forEach(i => { nameMap[i.item_id] = i.item_name; });
  const recentReturns = readTable_(APP.SHEET_HISTORY).rows
    .filter(h => h.action_type === '반환완료')
    .slice(-5).reverse()
    .map(h => Object.assign(stripRow_(h), { item_name: nameMap[h.item_id] || '' }));
  return { me: { name: me.name }, today: today, items: items, settings: getSettings_(), recentReturns: recentReturns };
}

function adminGetThumbs(token, ids) {
  requireAdmin_(token);
  const map = indexById_(readTable_(APP.SHEET_ITEMS).rows);
  const out = {};
  cleanIdList_(ids).forEach(id => {
    const it = map[id];
    out[id] = (it && it.status !== STATUS.DELETED) ? imageDataUrl_(it.thumb_file_id || it.image_file_id, true) : '';
  });
  return out;
}

function adminGetImage(token, id) {
  requireAdmin_(token);
  const it = indexById_(readTable_(APP.SHEET_ITEMS).rows)[String(id || '')];
  if (!it || it.status === STATUS.DELETED) throw new Error('물품을 찾을 수 없습니다.');
  return imageDataUrl_(it.image_file_id || it.thumb_file_id, false);
}

function adminCreateItem(token, data) {
  const me = requireAdmin_(token);
  const st = getSettings_();
  const d = validateItem_(data, st, null);
  const img = data && data.image;
  if (!img || !img.main || !img.thumb) throw new Error('물품 사진을 올려 주세요.');
  return withLock_(() => {
    const tbl = readTable_(APP.SHEET_ITEMS);
    const id = nextItemId_(tbl);
    const mainId = saveImage_(img.main, id + '.jpg', APP.MAX_MAIN_B64);
    let thumbId;
    try { thumbId = saveImage_(img.thumb, id + '_thumb.jpg', APP.MAX_THUMB_B64); }
    catch (e) { trashFile_(mainId); throw e; }
    const now = now_();
    appendObj_(tbl, Object.assign({}, d, {
      item_id: id, image_file_id: mainId, thumb_file_id: thumbId, status: STATUS.KEEP,
      registered_at: now, updated_at: now, returned_at: '', disposed_at: '', registered_by: me.name
    }));
    addHistory_(id, '등록', me.name, d.item_name + ' / ' + d.visibility + ' / 보관: ' + d.storage_location + ' / ' + d.storage_period + '일');
    return { id: id, name: d.item_name, visibility: d.visibility };
  });
}

function adminUpdateItem(token, id, data) {
  const me = requireAdmin_(token);
  const st = getSettings_();
  return withLock_(() => {
    const tbl = readTable_(APP.SHEET_ITEMS);
    const it = findItem_(tbl, id);
    if (it.status === STATUS.DELETED) throw new Error('삭제된 물품은 수정할 수 없습니다.');
    const d = validateItem_(data, st, it);
    const labels = { item_name: '물품명', category: '분류', description: '특징', found_date: '습득일', found_location: '습득장소', storage_location: '보관장소', visibility: '공개', storage_period: '보관기간' };
    const diff = Object.keys(labels).filter(k => String(it[k]) !== String(d[k]))
      .map(k => labels[k] + ': ' + (it[k] || '없음') + ' → ' + (d[k] || '없음'));
    const next = Object.assign({}, it, d, { updated_at: now_() });
    let oldFiles = [];
    const img = data && data.image;
    if (img && img.main && img.thumb) {
      const mainId = saveImage_(img.main, it.item_id + '.jpg', APP.MAX_MAIN_B64);
      let thumbId;
      try { thumbId = saveImage_(img.thumb, it.item_id + '_thumb.jpg', APP.MAX_THUMB_B64); }
      catch (e) { trashFile_(mainId); throw e; }
      oldFiles = [it.image_file_id, it.thumb_file_id];
      next.image_file_id = mainId;
      next.thumb_file_id = thumbId;
      diff.push('사진 교체');
    }
    if (!diff.length) return { id: it.item_id, changed: false };
    writeObj_(tbl, it._row, next);
    oldFiles.forEach(trashFile_);
    addHistory_(it.item_id, '수정', me.name, diff.join('; '));
    return { id: it.item_id, changed: true };
  });
}

function adminSetVisibility(token, id, visibility) {
  const me = requireAdmin_(token);
  if (visibility !== VIS.PUBLIC && visibility !== VIS.PRIVATE) throw new Error('공개 여부 값이 올바르지 않습니다.');
  return withLock_(() => {
    const tbl = readTable_(APP.SHEET_ITEMS);
    const it = findItem_(tbl, id);
    if (it.status === STATUS.DELETED) throw new Error('삭제된 물품입니다.');
    if (it.visibility === visibility) return { id: it.item_id, visibility: visibility };
    writeObj_(tbl, it._row, Object.assign({}, it, { visibility: visibility, updated_at: now_() }));
    addHistory_(it.item_id, '공개변경', me.name, it.visibility + ' → ' + visibility);
    return { id: it.item_id, visibility: visibility };
  });
}

/** 반환 완료: info = { returned_at:'yyyy-MM-dd HH:mm', processor, memo } */
function adminReturnItem(token, id, info) {
  const me = requireAdmin_(token);
  info = info || {};
  const at = info.returned_at ? normDateTime_(info.returned_at, '반환 일시') : now_();
  const processor = cleanStr_(info.processor || me.name, 30, '처리 담당자', true);
  const memo = cleanStr_(info.memo, 300, '메모', false);
  return withLock_(() => {
    const tbl = readTable_(APP.SHEET_ITEMS);
    const it = findItem_(tbl, id);
    if (it.status !== STATUS.KEEP) throw new Error('보관 중인 물품만 반환 처리할 수 있습니다. (현재: ' + it.status + ')');
    writeObj_(tbl, it._row, Object.assign({}, it, { status: STATUS.RETURNED, returned_at: at, updated_at: now_() }));
    addHistory_(it.item_id, '반환완료', processor, memo + (processor !== me.name ? ' [입력: ' + me.name + ']' : ''), at);
    return { id: it.item_id, status: STATUS.RETURNED };
  });
}

function adminUndoReturn(token, id, memo) {
  const me = requireAdmin_(token);
  const m = cleanStr_(memo, 300, '사유', true);
  return withLock_(() => {
    const tbl = readTable_(APP.SHEET_ITEMS);
    const it = findItem_(tbl, id);
    if (it.status !== STATUS.RETURNED) throw new Error('반환 완료된 물품만 취소할 수 있습니다.');
    writeObj_(tbl, it._row, Object.assign({}, it, { status: STATUS.KEEP, returned_at: '', updated_at: now_() }));
    addHistory_(it.item_id, '반환취소', me.name, m);
    return { id: it.item_id, status: STATUS.KEEP };
  });
}

/** 폐기 등 처분: info = { result:'폐기|기부|학교 비품 활용|기타', disposed_at:'yyyy-MM-dd', memo } */
function adminDisposeItem(token, id, info) {
  const me = requireAdmin_(token);
  info = info || {};
  const result = cleanStr_(info.result, 30, '처리 결과', true);
  const at = normDate_(info.disposed_at || today_(), '처리 일자');
  const memo = cleanStr_(info.memo, 300, '메모', false);
  return withLock_(() => {
    const tbl = readTable_(APP.SHEET_ITEMS);
    const it = findItem_(tbl, id);
    if (it.status !== STATUS.KEEP) throw new Error('보관 중인 물품만 처리할 수 있습니다. (현재: ' + it.status + ')');
    writeObj_(tbl, it._row, Object.assign({}, it, { status: STATUS.DISPOSED, disposed_at: at, updated_at: now_() }));
    addHistory_(it.item_id, '폐기처리', me.name, '결과: ' + result + ' / 처리일: ' + at + (memo ? ' / ' + memo : ''));
    return { id: it.item_id, status: STATUS.DISPOSED };
  });
}

/** 삭제(잘못 등록·개인정보 노출 등). confirmId에 물품 번호를 그대로 다시 입력해야 실행 */
function adminDeleteItem(token, id, confirmId, reason) {
  const me = requireAdmin_(token);
  if (String(confirmId || '').trim() !== String(id || '')) throw new Error('확인용 물품 번호가 일치하지 않습니다.');
  const r = cleanStr_(reason, 300, '삭제 사유', true);
  return withLock_(() => {
    const tbl = readTable_(APP.SHEET_ITEMS);
    const it = findItem_(tbl, id);
    if (it.status === STATUS.DELETED) throw new Error('이미 삭제된 물품입니다.');
    writeObj_(tbl, it._row, Object.assign({}, it, { status: STATUS.DELETED, visibility: VIS.PRIVATE, updated_at: now_() }));
    [it.image_file_id, it.thumb_file_id].forEach(trashFile_);
    addHistory_(it.item_id, '삭제', me.name, '사유: ' + r + ' (사진은 Drive 휴지통으로 이동)');
    return { id: it.item_id, status: STATUS.DELETED };
  });
}

function adminGetHistory(token, opts) {
  requireAdmin_(token);
  opts = opts || {};
  const itemId = String(opts.itemId || '');
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 500, 1), 2000);
  const names = {};
  readTable_(APP.SHEET_ITEMS).rows.forEach(i => { names[i.item_id] = i.item_name; });
  let rows = readTable_(APP.SHEET_HISTORY).rows;
  if (itemId) rows = rows.filter(h => h.item_id === itemId);
  return rows.slice(-limit).reverse().map(h => Object.assign(stripRow_(h), { item_name: names[h.item_id] || '' }));
}

function adminGetSettings(token) {
  requireAdmin_(token);
  return getSettings_();
}

function adminSaveSettings(token, s) {
  const me = requireAdmin_(token);
  s = s || {};
  const lists = {};
  [['categories', '물품 분류'], ['storageLocations', '보관 장소'], ['foundLocations', '습득 장소']].forEach(([k, label]) => {
    const arr = uniq_((Array.isArray(s[k]) ? s[k] : String(s[k] || '').split(/\r?\n/)).map(x => String(x).trim()).filter(Boolean));
    if (k !== 'foundLocations' && !arr.length) throw new Error(label + '을(를) 한 개 이상 입력해 주세요.');
    if (arr.length > 60) throw new Error(label + '은(는) 60개까지 등록할 수 있습니다.');
    arr.forEach(x => { if (x.length > 30) throw new Error(label + ' "' + x.slice(0, 10) + '…"은(는) 30자 이내로 입력해 주세요.'); });
    lists[k] = arr;
  });
  const period = parseInt(s.defaultPeriod, 10);
  if (!(period >= 1 && period <= 3650)) throw new Error('기본 보관 기간은 1~3650일 사이로 입력해 주세요.');
  const vals = {
    '학교명': cleanStr_(s.schoolName, 30, '학교명', true),
    '물품분류': lists.categories.join('\n'),
    '보관장소': lists.storageLocations.join('\n'),
    '습득장소': lists.foundLocations.join('\n'),
    '기본보관기간': String(period),
    '이용안내': cleanStr_(s.guide, 500, '이용 안내', false),
    '문의안내': cleanStr_(s.contact, 300, '문의 안내', false)
  };
  return withLock_(() => {
    const sh = sheet_(APP.SHEET_SETTINGS);
    const data = sh.getDataRange().getValues();
    const before = getSettings_();
    Object.keys(vals).forEach(k => {
      let row = -1;
      for (let i = 1; i < data.length; i++) if (String(data[i][0]).trim() === k) { row = i + 1; break; }
      if (row < 0) { row = sh.getLastRow() + 1; sh.getRange(row, 1).setNumberFormat('@').setValue(k); }
      sh.getRange(row, 2).setNumberFormat('@').setValue(vals[k]);
    });
    const changed = [];
    if (before.schoolName !== vals['학교명']) changed.push('학교명');
    if (before.categories.join('\n') !== vals['물품분류']) changed.push('물품분류');
    if (before.storageLocations.join('\n') !== vals['보관장소']) changed.push('보관장소');
    if (before.foundLocations.join('\n') !== vals['습득장소']) changed.push('습득장소');
    if (String(before.defaultPeriod) !== vals['기본보관기간']) changed.push('기본보관기간 ' + before.defaultPeriod + '→' + vals['기본보관기간']);
    if (before.guide !== vals['이용안내']) changed.push('이용안내');
    if (before.contact !== vals['문의안내']) changed.push('문의안내');
    if (changed.length) addHistory_('-', '설정변경', me.name, changed.join(', '));
    return getSettings_();
  });
}

/** 보관 장소 일괄 변경: 보관 중인 물품 중 from 장소에 있는 것을 to 장소로 */
function adminMoveStorage(token, from, to) {
  const me = requireAdmin_(token);
  const st = getSettings_();
  const f = String(from || '').trim(), t = String(to || '').trim();
  if (!f || !t || f === t) throw new Error('기존 장소와 새 장소를 다르게 선택해 주세요.');
  if (st.storageLocations.indexOf(t) < 0) throw new Error('새 보관 장소는 설정 목록에 있어야 합니다.');
  return withLock_(() => {
    const tbl = readTable_(APP.SHEET_ITEMS);
    const targets = tbl.rows.filter(it => it.status === STATUS.KEEP && it.storage_location === f);
    const now = now_();
    targets.forEach(it => {
      writeObj_(tbl, it._row, Object.assign({}, it, { storage_location: t, updated_at: now }));
      addHistory_(it.item_id, '보관장소변경', me.name, f + ' → ' + t + ' (일괄 변경)');
    });
    return { moved: targets.length };
  });
}

function adminChangeViewPassword(token, newPw) {
  const me = requireAdmin_(token);
  const pw = String(newPw || '');
  if (pw.length < 4 || pw.length > 50) throw new Error('조회 비밀번호는 4~50자로 정해 주세요.');
  props_().setProperty('VIEW_PW', makeHash_(pw));
  withLock_(() => addHistory_('-', '비밀번호변경', me.name, '조회 비밀번호 변경'));
  return true;
}

function adminChangeMyPassword(token, currentPw, newPw) {
  const me = requireAdmin_(token);
  const pw = String(newPw || '');
  if (pw.length < 8 || pw.length > 64) throw new Error('관리자 비밀번호는 8~64자로 정해 주세요.');
  return withLock_(() => {
    const tbl = readTable_(APP.SHEET_ADMINS);
    const adm = tbl.rows.find(r => r.admin_id === me.adminId);
    if (!adm || !verifyHash_(String(currentPw || ''), adm.password_hash)) throw new Error('현재 비밀번호가 맞지 않습니다.');
    writeObj_(tbl, adm._row, Object.assign({}, adm, { password_hash: makeHash_(pw) }));
    addHistory_('-', '비밀번호변경', me.name, '본인 관리자 비밀번호 변경');
    return true;
  });
}

function adminBackupNow(token) {
  const me = requireAdmin_(token);
  return backup_(me.name);
}

/* =========================================================
 * 스프레드시트 메뉴 (관리 담당자가 시트에서 직접 실행)
 *  - 웹앱에서는 SpreadsheetApp.getUi()가 동작하지 않으므로
 *    웹 화면에서 이 함수들을 불러도 첫 줄에서 중단됩니다.
 * ========================================================= */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('분실물센터')
    .addItem('① 초기 설정 (시트·사진 폴더 만들기)', 'menuSetup')
    .addSeparator()
    .addItem('조회 비밀번호 설정/변경', 'menuSetViewPassword')
    .addItem('관리자 추가', 'menuAddAdmin')
    .addItem('관리자 비밀번호 재설정', 'menuResetAdminPassword')
    .addSeparator()
    .addItem('지금 백업하기', 'menuBackup')
    .addItem('매일 자동 백업 켜기 (새벽 3시)', 'menuInstallBackupTrigger')
    .addToUi();
}

function menuSetup() {
  const ui = SpreadsheetApp.getUi();
  setupSheets_();
  const msgs = ['시트와 사진 폴더를 준비했습니다.'];
  if (!props_().getProperty('VIEW_PW')) {
    const pw = promptPw_(ui, '조회 비밀번호 정하기', '학생·교직원이 분실물 목록을 볼 때 쓰는 공용 비밀번호입니다. (4자 이상)', 4);
    if (pw) { props_().setProperty('VIEW_PW', makeHash_(pw)); msgs.push('조회 비밀번호를 설정했습니다.'); }
  }
  if (!readTable_(APP.SHEET_ADMINS).rows.some(r => r.active === 'Y')) {
    if (addAdminViaUi_(ui)) msgs.push('첫 관리자를 등록했습니다.');
  }
  const tz = Session.getScriptTimeZone();
  if (tz !== 'Asia/Seoul') msgs.push('⚠ 스크립트 시간대가 ' + tz + '입니다. [프로젝트 설정 → 시간대]를 (GMT+09:00) 서울로 바꿔 주세요.');
  msgs.push('', '다음 단계: 확장 프로그램 → Apps Script → [배포 → 새 배포 → 웹 앱]으로 배포하세요.');
  ui.alert('분실물센터 초기 설정', msgs.join('\n'), ui.ButtonSet.OK);
}

function menuSetViewPassword() {
  const ui = SpreadsheetApp.getUi();
  const pw = promptPw_(ui, '조회 비밀번호 설정', '새 공용 조회 비밀번호를 입력하세요. (4자 이상)', 4);
  if (!pw) return;
  props_().setProperty('VIEW_PW', makeHash_(pw));
  withLock_(() => addHistory_('-', '비밀번호변경', '시트 메뉴', '조회 비밀번호 설정'));
  ui.alert('조회 비밀번호를 저장했습니다. (평문으로 저장되지 않습니다)');
}

function menuAddAdmin() {
  const ui = SpreadsheetApp.getUi();
  if (addAdminViaUi_(ui)) ui.alert('관리자를 추가했습니다.');
}

function menuResetAdminPassword() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('관리자 비밀번호 재설정', '비밀번호를 재설정할 관리자 이름을 입력하세요.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const nm = r.getResponseText().trim();
  if (!readTable_(APP.SHEET_ADMINS).rows.some(x => x.name === nm)) { ui.alert('그 이름의 관리자가 없습니다.'); return; }
  const pw = promptPw_(ui, '새 비밀번호', nm + ' 님의 새 비밀번호 (8자 이상)', 8);
  if (!pw) return;
  withLock_(() => {
    const tbl = readTable_(APP.SHEET_ADMINS);
    const adm = tbl.rows.find(x => x.name === nm);
    writeObj_(tbl, adm._row, Object.assign({}, adm, { password_hash: makeHash_(pw), active: 'Y' }));
    addHistory_('-', '비밀번호변경', '시트 메뉴', nm + ' 관리자 비밀번호 재설정');
  });
  ui.alert('재설정했습니다.');
}

function menuBackup() {
  const ui = SpreadsheetApp.getUi();
  const r = backup_('시트 메뉴');
  ui.alert('백업 완료: ' + r.name + '\n(백업 폴더: ' + r.folderName + ')');
}

function menuInstallBackupTrigger() {
  const ui = SpreadsheetApp.getUi();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'scheduledBackup').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('scheduledBackup').timeBased().everyDays(1).atHour(3).create();
  ui.alert('매일 새벽 3시경 자동 백업을 켰습니다. (최근 ' + APP.BACKUP_KEEP + '개 보관)');
}

/** 시간 트리거용. 20시간 이내 백업이 있으면 건너뜀(외부 반복 호출 방지) */
function scheduledBackup() {
  const last = Number(props_().getProperty('LAST_BACKUP') || 0);
  if (Date.now() - last < 20 * 3600 * 1000) return { skipped: true };
  return backup_('자동 백업');
}

/**
 * 설치 점검: Apps Script 편집기에서 함수 선택 → diagnose → ▶ 실행 → 아래 [실행 로그] 확인.
 * 비밀번호·해시 등 민감 정보는 출력하지 않습니다.
 */
function diagnose() {
  const p = props_();
  const out = [];
  const line = (okv, msg) => out.push((okv ? '✅ ' : '❌ ') + msg);
  let bound = null;
  try { bound = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { }
  line(!!bound, bound ? '스프레드시트에 연결된 스크립트: ' + bound.getName() : '연결된 스프레드시트 없음 → 스프레드시트의 [확장 프로그램 → Apps Script]에서 만든 프로젝트가 아닙니다.');
  const ssId = p.getProperty('SS_ID');
  line(!!ssId, ssId ? '초기 설정 기록(SS_ID) 있음' : '초기 설정 기록 없음 → 이 프로젝트에서 [① 초기 설정]이 실행되지 않았습니다.');
  let ss = null;
  try { ss = ss_(); } catch (e) { line(false, '데이터 시트 열기 실패: ' + e.message); }
  if (ss) {
    if (bound && ssId && bound.getId() !== ssId) line(false, '주의: 연결된 시트와 초기 설정 기록의 시트가 다릅니다.');
    [APP.SHEET_ITEMS, APP.SHEET_HISTORY, APP.SHEET_SETTINGS, APP.SHEET_ADMINS].forEach(n => line(!!ss.getSheetByName(n), '시트 "' + n + '"'));
  }
  line(!!p.getProperty('VIEW_PW'), '조회 비밀번호 설정');
  line(!!p.getProperty('PHOTO_FOLDER_ID') && folderExists_(p.getProperty('PHOTO_FOLDER_ID')), '사진 폴더');
  try {
    const n = readTable_(APP.SHEET_ADMINS).rows.filter(r => r.active === 'Y').length;
    line(n > 0, '활성 관리자 ' + n + '명');
  } catch (e) { line(false, '관리자 시트 읽기 실패: ' + e.message); }
  try { getSettings_(); line(true, '설정 읽기 정상'); } catch (e) { line(false, '설정 읽기 실패: ' + e.message); }
  const tz = Session.getScriptTimeZone();
  line(tz === 'Asia/Seoul', '시간대: ' + tz);
  let url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { }
  line(!!url, url ? '이 프로젝트의 웹앱 주소: ' + url : '이 프로젝트는 아직 웹앱으로 배포되지 않았습니다.');
  const text = out.join('\n');
  Logger.log('\n' + text);
  return text;
}

/* =========================================================
 * 내부: 초기 설정 / 시트
 * ========================================================= */

function setupSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  props_().setProperty('SS_ID', ss.getId());
  ensureSheet_(ss, APP.SHEET_ITEMS, ITEM_HEADERS);
  ensureSheet_(ss, APP.SHEET_HISTORY, HISTORY_HEADERS);
  ensureSheet_(ss, APP.SHEET_ADMINS, ADMIN_HEADERS);
  const st = ensureSheet_(ss, APP.SHEET_SETTINGS, SETTINGS_HEADERS);
  const existing = st.getDataRange().getValues().slice(1).map(r => String(r[0]).trim());
  DEFAULT_SETTINGS.forEach(row => {
    if (existing.indexOf(row[0]) < 0) {
      st.getRange(st.getLastRow() + 1, 1, 1, 3).setNumberFormat('@').setValues([row]);
    }
  });
  st.setColumnWidth(2, 360);
  // 빈 기본 시트 정리
  ['Sheet1', '시트1'].forEach(n => {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });
  const p = props_();
  if (!p.getProperty('PHOTO_FOLDER_ID') || !folderExists_(p.getProperty('PHOTO_FOLDER_ID'))) {
    p.setProperty('PHOTO_FOLDER_ID', DriveApp.createFolder(ss.getName() + '_사진(공유 금지)').getId());
  }
  if (!p.getProperty('BACKUP_FOLDER_ID') || !folderExists_(p.getProperty('BACKUP_FOLDER_ID'))) {
    p.setProperty('BACKUP_FOLDER_ID', DriveApp.createFolder(ss.getName() + '_백업').getId());
  }
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#eef3f0');
    sh.setFrozenRows(1);
  } else {
    // 누락된 헤더는 오른쪽에 추가
    const cur = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    headers.filter(h => cur.indexOf(h) < 0).forEach(h => sh.getRange(1, sh.getLastColumn() + 1).setValue(h).setFontWeight('bold'));
  }
  sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), Math.max(sh.getLastColumn(), headers.length)).setNumberFormat('@');
  return sh;
}

function addAdminViaUi_(ui) {
  const r = ui.prompt('관리자 추가', '관리자 이름(로그인 아이디로 사용, 예: 김교감)을 입력하세요.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return false;
  const nm = r.getResponseText().trim();
  if (!nm || nm.length > 30) { ui.alert('이름은 1~30자로 입력해 주세요.'); return false; }
  const pw = promptPw_(ui, '관리자 비밀번호', nm + ' 님의 비밀번호 (8자 이상, 조회 비밀번호와 다르게)', 8);
  if (!pw) return false;
  const viewPw = props_().getProperty('VIEW_PW');
  if (viewPw && verifyHash_(pw, viewPw)) { ui.alert('관리자 비밀번호는 조회 비밀번호와 달라야 합니다.'); return false; }
  return withLock_(() => {
    const tbl = readTable_(APP.SHEET_ADMINS);
    if (tbl.rows.some(x => x.name === nm)) { ui.alert('같은 이름의 관리자가 이미 있습니다. [관리자 비밀번호 재설정]을 이용하세요.'); return false; }
    appendObj_(tbl, { admin_id: 'A' + Utilities.getUuid().slice(0, 8), name: nm, password_hash: makeHash_(pw), active: 'Y', created_at: now_(), last_login_at: '' });
    addHistory_('-', '설정변경', '시트 메뉴', '관리자 추가: ' + nm);
    return true;
  });
}

function promptPw_(ui, title, msg, minLen) {
  const r = ui.prompt(title, msg, ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return '';
  const pw = r.getResponseText();
  if (pw.length < minLen) { ui.alert(minLen + '자 이상으로 입력해 주세요.'); return ''; }
  const r2 = ui.prompt(title, '확인을 위해 한 번 더 입력하세요.', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return '';
  if (r2.getResponseText() !== pw) { ui.alert('두 번 입력한 비밀번호가 다릅니다.'); return ''; }
  return pw;
}

function isReady_() {
  const p = props_();
  return !!(p.getProperty('VIEW_PW') && p.getProperty('PHOTO_FOLDER_ID'));
}

function props_() { return PropertiesService.getScriptProperties(); }

function ss_() {
  const id = props_().getProperty('SS_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('"' + name + '" 시트가 없습니다. 스프레드시트 메뉴 [분실물센터 → ① 초기 설정]을 실행해 주세요.');
  return sh;
}

function readTable_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const headers = (values[0] || []).map(h => String(h).trim());
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (r.every(v => v === '' || v === null)) continue;
    const o = { _row: i + 1 };
    headers.forEach((h, j) => { if (h) o[h] = cellStr_(r[j]); });
    rows.push(o);
  }
  return { sh: sh, headers: headers, rows: rows };
}

/** 셀은 모두 '일반 텍스트(@)' 서식으로 기록 → 날짜 자동 변환·수식 해석 방지 */
function writeObj_(tbl, rowNum, obj) {
  const vals = tbl.headers.map(h => (h && obj[h] != null) ? String(obj[h]) : '');
  tbl.sh.getRange(rowNum, 1, 1, tbl.headers.length).setNumberFormat('@').setValues([vals]);
}

function appendObj_(tbl, obj) {
  const rowNum = tbl.sh.getLastRow() + 1;
  writeObj_(tbl, rowNum, obj);
  obj._row = rowNum;
  tbl.rows.push(obj);
  return obj;
}

function addHistory_(itemId, type, processor, memo, actionDate) {
  const tbl = readTable_(APP.SHEET_HISTORY);
  const hid = 'H' + Utilities.formatDate(new Date(), tz_(), 'yyyyMMddHHmmss') + '-' + Utilities.getUuid().slice(0, 4);
  appendObj_(tbl, { history_id: hid, item_id: itemId, action_type: type, action_date: actionDate || now_(), processor: processor, memo: memo || '' });
}

function getSettings_() {
  const vals = sheet_(APP.SHEET_SETTINGS).getDataRange().getValues();
  const m = {};
  for (let i = 1; i < vals.length; i++) {
    const k = String(vals[i][0]).trim();
    if (k) m[k] = cellStr_(vals[i][1]);
  }
  const list = s => uniq_(String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean));
  const def = {};
  DEFAULT_SETTINGS.forEach(r => { def[r[0]] = r[1]; });
  const pick = k => (m[k] != null && m[k] !== '') ? m[k] : def[k];
  const period = parseInt(pick('기본보관기간'), 10);
  return {
    schoolName: pick('학교명'),
    categories: list(pick('물품분류')),
    storageLocations: list(pick('보관장소')),
    foundLocations: list(m['습득장소'] != null ? m['습득장소'] : def['습득장소']),
    defaultPeriod: (period >= 1 && period <= 3650) ? period : 30,
    guide: m['이용안내'] != null ? m['이용안내'] : def['이용안내'],
    contact: m['문의안내'] != null ? m['문의안내'] : def['문의안내']
  };
}

/* =========================================================
 * 내부: 인증 · 세션 · 시도 제한
 * ========================================================= */

function authError_() { throw new Error('AUTH: 로그인 시간이 지났습니다. 다시 로그인해 주세요.'); }

function createSession_(role, payload, ttlSec) {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();
  const data = Object.assign({ role: role, exp: Date.now() + ttlSec * 1000 }, payload);
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(data), ttlSec);
  return token;
}

function getSession_(token, role) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) authError_();
  const raw = CacheService.getScriptCache().get('sess_' + token);
  if (!raw) authError_();
  const s = JSON.parse(raw);
  if (s.role !== role || !(s.exp > Date.now())) authError_();
  return s;
}

/** 관리자 세션 + 계정이 여전히 활성(active=Y)인지 확인 */
function requireAdmin_(token) {
  const s = getSession_(token, 'admin');
  const adm = readTable_(APP.SHEET_ADMINS).rows.find(r => r.admin_id === s.adminId);
  if (!adm || adm.active !== 'Y') authError_();
  return { adminId: adm.admin_id, name: adm.name };
}

/**
 * 비밀번호 시도 제한
 *  - 같은 브라우저(clientId) 5회 실패 → 10분 잠금
 *  - 전체 실패 합계(조회 40회 / 관리자 20회, 10분 창) → 해당 로그인 10분 잠금
 *  - 실패마다 0.8초 지연
 * clientId는 브라우저가 만든 값이라 바꿔 가며 우회할 수 있으므로, 전체 합계 제한이 실질적 상한입니다.
 */
function loginGuard_(scope, clientId) {
  const c = CacheService.getScriptCache();
  const cid = /^[A-Za-z0-9_-]{8,64}$/.test(String(clientId || '')) ? String(clientId) : 'anon';
  if (c.get('lockG_' + scope)) throw new Error('로그인 시도가 너무 많아 잠시 막혔습니다. 10분 뒤 다시 시도해 주세요.');
  if (c.get('lock_' + scope + '_' + cid)) throw new Error('비밀번호를 여러 번 틀려 10분 동안 로그인할 수 없습니다.');
  return {
    fail: function () {
      const k = 'fail_' + scope + '_' + cid;
      const n = Number(c.get(k) || 0) + 1;
      c.put(k, String(n), 600);
      if (n >= 5) c.put('lock_' + scope + '_' + cid, '1', 600);
      const kg = 'failG_' + scope;
      const g = Number(c.get(kg) || 0) + 1;
      c.put(kg, String(g), 600);
      if (g >= (scope === 'admin' ? 20 : 40)) c.put('lockG_' + scope, '1', 600);
      Utilities.sleep(800);
    },
    ok: function () { c.remove('fail_' + scope + '_' + cid); }
  };
}

function hashPw_(pw, salt, iter) {
  let bytes = Utilities.newBlob(salt + ':' + pw).getBytes();
  for (let i = 0; i < iter; i++) bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function makeHash_(pw) {
  const salt = Utilities.getUuid().replace(/-/g, '');
  return 'v1$' + APP.HASH_ITER + '$' + salt + '$' + hashPw_(pw, salt, APP.HASH_ITER);
}

function verifyHash_(pw, stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 4 || p[0] !== 'v1') return false;
  const h = hashPw_(pw, p[2], parseInt(p[1], 10));
  if (h.length !== p[3].length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ p[3].charCodeAt(i);
  return diff === 0;
}

/* =========================================================
 * 내부: 물품 · 검증 · 사진
 * ========================================================= */

function isPublicVisible_(it) {
  return it.visibility === VIS.PUBLIC && it.status === STATUS.KEEP;
}

function publicItem_(it, today) {
  // 일반 조회자에게는 Drive 파일 ID·등록자·내부 정보 미제공
  return {
    id: it.item_id, name: it.item_name, category: it.category, description: it.description,
    foundDate: it.found_date, foundLocation: it.found_location, storageLocation: it.storage_location,
    status: isOverdue_(it, today) ? '장기보관' : '보관중', registeredAt: it.registered_at,
    hasImage: !!(it.thumb_file_id || it.image_file_id)
  };
}

function adminItem_(it, today) {
  const o = stripRow_(it);
  delete o.image_file_id; delete o.thumb_file_id;
  o.hasImage = !!(it.thumb_file_id || it.image_file_id);
  o.expire_date = expireDate_(it);
  o.overdue = isOverdue_(it, today);
  o.overdue_days = o.overdue ? daysBetween_(o.expire_date, today) : 0;
  return o;
}

function stripRow_(o) { const c = Object.assign({}, o); delete c._row; return c; }

function indexById_(rows) { const m = {}; rows.forEach(r => { m[r.item_id] = r; }); return m; }

function cleanIdList_(ids) {
  return (Array.isArray(ids) ? ids : []).slice(0, 24).map(String).filter(x => /^[A-Za-z0-9-]{1,30}$/.test(x));
}

function findItem_(tbl, id) {
  const it = tbl.rows.find(r => r.item_id === String(id || ''));
  if (!it) throw new Error('물품을 찾을 수 없습니다: ' + id);
  return it;
}

function nextItemId_(tbl) {
  const prefix = 'L' + Utilities.formatDate(new Date(), tz_(), 'yyMMdd') + '-';
  let max = 0;
  tbl.rows.forEach(r => {
    if (String(r.item_id).indexOf(prefix) === 0) max = Math.max(max, parseInt(r.item_id.slice(prefix.length), 10) || 0);
  });
  return prefix + String(max + 1).padStart(3, '0');
}

/** prev가 있으면(수정) 목록에서 빠진 기존 분류·장소 값도 그대로 유지 허용 */
function validateItem_(d, st, prev) {
  d = d || {};
  const out = {
    item_name: cleanStr_(d.item_name, 60, '물품명', true),
    category: cleanStr_(d.category, 30, '물품 분류', true),
    description: cleanStr_(d.description, 300, '물품 특징', false),
    found_date: normDate_(d.found_date, '습득 날짜'),
    found_location: cleanStr_(d.found_location, 60, '습득 장소', true),
    storage_location: cleanStr_(d.storage_location, 30, '보관 장소', true),
    visibility: String(d.visibility || ''),
    storage_period: String(parseInt(d.storage_period, 10))
  };
  if (st.categories.indexOf(out.category) < 0 && !(prev && prev.category === out.category)) throw new Error('물품 분류를 목록에서 선택해 주세요.');
  const customOk = d.storage_custom === true && st.storageLocations.indexOf('기타') >= 0;  // [기타] → 직접 입력
  if (st.storageLocations.indexOf(out.storage_location) < 0 && !(prev && prev.storage_location === out.storage_location) && !customOk) throw new Error('보관 장소를 목록에서 선택해 주세요.');
  if (out.visibility !== VIS.PUBLIC && out.visibility !== VIS.PRIVATE) throw new Error('공개 여부를 선택해 주세요.');
  const p = parseInt(out.storage_period, 10);
  if (!(p >= 1 && p <= 3650)) throw new Error('보관 기간은 1~3650일 사이로 입력해 주세요.');
  if (out.found_date > addDays_(today_(), 1)) throw new Error('습득 날짜가 미래일 수 없습니다.');
  return out;
}

function cleanStr_(v, max, label, required) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (required && !s) throw new Error(label + '을(를) 입력해 주세요.');
  if (s.length > max) throw new Error(label + '은(는) ' + max + '자 이내로 입력해 주세요.');
  return s;
}

function normDate_(v, label) {
  const s = String(v || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(label + '를 선택해 주세요.');
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (dt.toISOString().slice(0, 10) !== s) throw new Error(label + '가 올바른 날짜가 아닙니다.');
  return s;
}

function normDateTime_(v, label) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(v || '').trim());
  if (!m) throw new Error(label + '를 올바르게 입력해 주세요.');
  normDate_(m[1], label);
  if (+m[2] > 23 || +m[3] > 59 || +(m[4] || 0) > 59) throw new Error(label + '의 시각이 올바르지 않습니다.');
  return m[1] + ' ' + m[2] + ':' + m[3] + ':' + (m[4] || '00');
}

/** 보관 만료일 = 습득 날짜 + 보관 기간(일) */
function expireDate_(it) {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(it.found_date) ? it.found_date : String(it.registered_at).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return '';
  return addDays_(base, parseInt(it.storage_period, 10) || 0);
}

function isOverdue_(it, today) {
  const e = expireDate_(it);
  return it.status === STATUS.KEEP && !!e && e < today;
}

function addDays_(ymd, n) {
  const p = ymd.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
}

function daysBetween_(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

function saveImage_(dataUrl, name, maxLen) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('사진 데이터 형식이 올바르지 않습니다. 다른 사진으로 다시 시도해 주세요.');
  if (m[2].length > maxLen) throw new Error('사진 용량이 너무 큽니다.');
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), 'image/' + m[1], name);
  try {
    return DriveApp.getFolderById(props_().getProperty('PHOTO_FOLDER_ID')).createFile(blob).getId();
  } catch (e) {
    throw new Error('사진을 Drive에 저장하지 못했습니다. 잠시 후 다시 시도해 주세요. (' + e.message + ')');
  }
}

function imageDataUrl_(fileId, useCache) {
  if (!fileId) return '';
  const c = CacheService.getScriptCache();
  const key = 'img_' + fileId;
  if (useCache) { const hit = c.get(key); if (hit) return hit; }
  try {
    const blob = DriveApp.getFileById(fileId).getBlob();
    const url = 'data:' + (blob.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(blob.getBytes());
    if (useCache && url.length < 95000) c.put(key, url, 21600);
    return url;
  } catch (e) {
    return '';
  }
}

function trashFile_(id) {
  if (!id) return;
  try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* 이미 없으면 무시 */ }
  try { CacheService.getScriptCache().remove('img_' + id); } catch (e) { }
}

function folderExists_(id) {
  try { DriveApp.getFolderById(id).getName(); return true; } catch (e) { return false; }
}

/* =========================================================
 * 내부: 백업 · 잠금 · 날짜
 * ========================================================= */

/** 데이터 시트만 새 스프레드시트로 복사(스크립트는 복사되지 않음). 사진은 Drive 폴더에 그대로 있음 */
function backup_(who) {
  return withLock_(() => {
    const src = ss_();
    const folder = DriveApp.getFolderById(props_().getProperty('BACKUP_FOLDER_ID'));
    const name = '백업_' + src.getName() + '_' + Utilities.formatDate(new Date(), tz_(), 'yyyyMMdd_HHmm');
    const bk = SpreadsheetApp.create(name);
    const first = bk.getSheets()[0];
    src.getSheets().forEach(s => { s.copyTo(bk).setName(s.getName()); });
    bk.deleteSheet(first);
    DriveApp.getFileById(bk.getId()).moveTo(folder);
    const files = [];
    const it = folder.getFiles();
    while (it.hasNext()) files.push(it.next());
    files.sort((a, b) => b.getDateCreated() - a.getDateCreated());
    files.slice(APP.BACKUP_KEEP).forEach(f => f.setTrashed(true));
    props_().setProperty('LAST_BACKUP', String(Date.now()));
    addHistory_('-', '백업', who, name);
    return { name: name, folderName: folder.getName() };
  });
}

let LOCK_DEPTH_ = 0;
function withLock_(fn) {
  if (LOCK_DEPTH_ > 0) return fn();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('다른 작업을 처리하는 중입니다. 잠시 후 다시 시도해 주세요.');
  LOCK_DEPTH_++;
  try {
    return fn();
  } finally {
    LOCK_DEPTH_--;
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

/** 최신 등록순(등록 일시가 같으면 물품 번호가 큰 것 먼저) */
function cmpDesc_(a, b) { return a < b ? 1 : a > b ? -1 : 0; }
function uniq_(arr) { return arr.filter((x, i) => arr.indexOf(x) === i); }
function tz_() { return Session.getScriptTimeZone() || 'Asia/Seoul'; }
function now_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss'); }
function today_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }

function cellStr_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    const hasTime = v.getHours() || v.getMinutes() || v.getSeconds();
    return Utilities.formatDate(v, tz_(), hasTime ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd');
  }
  return String(v);
}
