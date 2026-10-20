/**
 * 나의 맛집 다이어리 - 네이버 지역검색 프록시 (Google Apps Script)
 * NAVER API HUB(네이버 클라우드 플랫폼) 지역 API 사용
 *
 * 브라우저는 네이버 API를 직접 부를 수 없어서(CORS), 이 스크립트가 대신 불러 줍니다.
 * 응답: { items: [ { name, addr, lat, lng } ] }
 *
 * 설정 (프로젝트 설정 > 스크립트 속성)
 *   NAVER_ID     = Application 인증 정보의 Client ID
 *   NAVER_SECRET = Application 인증 정보의 Client Secret
 * 키는 코드에 적지 않고 '스크립트 속성'에만 넣습니다.
 */
function doGet(e) {
  // 음식점 사진: ?img=검색어  (네이버 이미지 검색 API, 스크립트 속성 IMG_ID / IMG_SECRET 사용)
  if (e && e.parameter && e.parameter.img) return imgThumb_(String(e.parameter.img).trim(), e.parameter.u);
  // 리뷰 글 조회(블로그/카페): ?rv=검색어
  if (e && e.parameter && e.parameter.rv) return reviews_(String(e.parameter.rv).trim());
  // 공유방 사진 내려받기: ?pic=드라이브파일ID  (우리 폴더 안의 이미지 파일만)
  if (e && e.parameter && e.parameter.pic) return picGet_(String(e.parameter.pic).trim());
  var q = ((e && e.parameter && e.parameter.q) || '').trim();
  if (!q) return out_({ items: [] });

  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('NAVER_ID');
  var secret = props.getProperty('NAVER_SECRET');
  if (!id || !secret) return out_({ items: [], error: 'missing keys' });

  var url = 'https://naverapihub.apigw.ntruss.com/search/v1/local?display=5&sort=random&query=' + encodeURIComponent(q);
  var res = UrlFetchApp.fetch(url, {
    headers: { 'X-NCP-APIGW-API-KEY-ID': id, 'X-NCP-APIGW-API-KEY': secret },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    return out_({ items: [], error: 'naver ' + res.getResponseCode(), body: res.getContentText().slice(0, 200) });
  }

  var json = JSON.parse(res.getContentText());
  var list = json.items || (json.result && json.result.items) || [];
  var items = list.map(function (i) {
    return {
      name: String(i.title || '').replace(/<[^>]+>/g, ''),
      addr: i.roadAddress || i.address || '',
      lng: deg_(i.mapx, 124, 132),
      lat: deg_(i.mapy, 33, 39)
    };
  });
  return out_({ items: items });
}

// 좌표가 도(degree)이면 그대로, 10^7 배 정수이면 나눠서 반환
function deg_(v) {
  var n = Number(v);
  return Math.abs(n) > 1000 ? n / 1e7 : n;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function reviews_(q) {
  var props = PropertiesService.getScriptProperties();
  var keys = [['NAVER', props.getProperty('NAVER_ID'), props.getProperty('NAVER_SECRET')], ['IMG', props.getProperty('IMG_ID'), props.getProperty('IMG_SECRET')]];
  var result = {};
  ['blog', 'cafearticle', 'kin'].forEach(function (kind) {
    keys.forEach(function (k) {
      if (!k[1] || !k[2] || result[kind] && result[kind].items) return;
      try {
        var res = UrlFetchApp.fetch('https://naverapihub.apigw.ntruss.com/search/v1/' + kind + '?display=5&sort=sim&query=' + encodeURIComponent(q),
          { headers: { 'X-NCP-APIGW-API-KEY-ID': k[1], 'X-NCP-APIGW-API-KEY': k[2] }, muteHttpExceptions: true });
        var code = res.getResponseCode();
        if (code === 200) {
          var items = (JSON.parse(res.getContentText()).items || []).map(function (x) {
            return { t: String(x.title || '').replace(/<[^>]+>/g, ''), d: String(x.description || '').replace(/<[^>]+>/g, '').slice(0, 140) };
          });
          result[kind] = { key: k[0], items: items };
        } else if (!result[kind]) result[kind] = { err: code + ' ' + res.getContentText().slice(0, 120) };
      } catch (err) { result[kind] = { err: String(err).slice(0, 100) }; }
    });
  });
  return out_(result);
}

function imgThumb_(q, urlOnly) {
  if (!q) return out_({ error: 'empty' });
  var props = PropertiesService.getScriptProperties();
  // 이미지 검색은 별도 Application 키(IMG_ID / IMG_SECRET)를 사용
  var id = props.getProperty('IMG_ID'), secret = props.getProperty('IMG_SECRET');
  if (!id || !secret) return out_({ error: 'missing img keys' });
  var hdr = { 'X-NCP-APIGW-API-KEY-ID': id, 'X-NCP-APIGW-API-KEY': secret };
  var res = UrlFetchApp.fetch('https://naverapihub.apigw.ntruss.com/search/v1/image?display=5&filter=large&sort=sim&query=' + encodeURIComponent(q),
    { headers: hdr, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return out_({ error: 'image ' + res.getResponseCode(), body: res.getContentText().slice(0, 200) });
  var items = JSON.parse(res.getContentText()).items || [];
  if (urlOnly) {
    var urls = items.map(function (x) { return x.thumbnail; }).filter(function (u) { return u && String(u).indexOf('https://') === 0; });
    return urls.length ? out_({ urls: urls }) : out_({ error: 'no image' });
  }
  for (var k = 0; k < items.length; k++) {
    var t = items[k].thumbnail;
    if (!t) continue;
    try {
      var r = UrlFetchApp.fetch(t, { muteHttpExceptions: true });
      var ct = String(r.getHeaders()['Content-Type'] || '');
      if (r.getResponseCode() === 200 && ct.indexOf('image') === 0) {
        return out_({ img: 'data:' + ct.split(';')[0] + ';base64,' + Utilities.base64Encode(r.getBlob().getBytes()), title: String(items[k].title || '').replace(/<[^>]+>/g, '') });
      }
    } catch (err) {}
  }
  return out_({ error: 'no image' });
}

// 간판 사진 → 가게 이름 / 오늘의 추천 (POST, 스크립트 속성 ANTHROPIC_KEY 필요)
function doPost(e) {
  try {
    var b = JSON.parse(e.postData.contents || '{}');
    if (b.pick) return out_(pick_(b.pick));
    if (b.destiny) return out_(destiny_(b.destiny));
    if (b.room) return out_(room_(b.room));
    if (b.photoUp) return out_(picUp_(b.photoUp));
    var m = String(b.ocr || '').match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    if (!m) return out_({ error: 'bad image' });
    var k = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_KEY');
    if (!k) return out_({ error: 'missing ANTHROPIC_KEY' });
    // Haiku 고정
    var a = sign_('claude-haiku-5-5', k, m);
    if (a.error) return out_({ error: a.error });
    return out_({ name: a.name || '', raw: a.raw, model: 'haiku' });
  } catch (err) { return out_({ error: 'ocr failed' }); }
}

// 오늘의 추천: 후보 목록 + 취향(맛/배고픔/기분/날씨)을 Haiku에 보내 상위 3곳을 순위대로 고르게 함
function pick_(p) {
  var k = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_KEY');
  if (!k) return { error: 'missing ANTHROPIC_KEY' };
  var cands = p.cands || [];
  if (!cands.length) return { error: 'no candidates' };
  var excl = p.exclude || [];
  var pool = cands.filter(function (c) { return excl.indexOf(c.id) === -1; });
  if (!pool.length) pool = cands;
  pool = pool.slice().sort(function (x, y) { return (x.dist || 0) - (y.dist || 0); }).slice(0, 12);
  var n = Math.min(3, pool.length);
  var lines = pool.map(function (c) {
    return c.id + '|' + c.name + '|' + (c.cat || '') + '|' + (c.dist != null ? Math.round(c.dist) + 'm' : '');
  }).join('\n');
  var ctx = [p.taste, p.hunger, p.feel, p.weather, p.time].filter(function (x) { return x && x !== '상관없음'; }).join(', ');
  var q = '후보(id|이름|종류|거리):\n' + lines + '\n오늘 상황: ' + (ctx || '특별한 조건 없음') +
    '\n\n위 상황에 가장 어울리는 ' + n + '곳을 순위대로 골라, 한 줄씩 정확히 이 형식으로만 답해: 순위|id|추천사유\n' +
    '규칙:\n' +
    '1) 추천사유는 반드시 50~75자의 한 문장(쉼표로 이어도 됨), 절대 80자를 넘기지 마. 앞부분=오늘 상황(맛·배고픔·기분·날씨·시간대 중 가장 강한 것)에서 이 가게 종류/거리로 이어지는 납득 가는 근거, 뒷부분=짧고 재치 있는 한마디(상황극·과장·비유·의인화 중 하나)로 마무리.\n' +
    '2) 장황한 설명, 억지 말장난, 앞뒤 안 맞는 농담, 가게 이름 말장난 금지. 웃기되 고개가 끄덕여져야 해. 스타일 예시(내용 베끼지 말 것): "비 오는 저녁엔 멀리 가는 것보다 가까운 게 정답이죠. 우산 쓰고 10분이면 도착, 허기도 감동할 거리예요."\n' +
    '3) 각 추천사유는 그 가게 하나만 보고 독립적으로 읽혀야 해. 다른 순위·가게를 언급하거나 비교 금지. 단점·부정 표현("멀지만", "아쉽지만") 금지. 세 곳의 근거와 말투는 서로 다르게.\n' +
    '4) 근거는 이름·종류·거리·날씨·시간대뿐. 종류가 "음식점"처럼 막연하면 메뉴·맛·국물·분위기를 절대 짐작하지 마. 이동수단(차·도보)도 단정하지 마. 거리가 멀어도 "멀다"고 하지 말고 거리 숫자는 그대로 장점으로 풀어. 거리는 800m, 5.4km처럼 읽기 쉽게. 이모지 최대 1개, 존댓말.\n' +
    '5) 시간대에 안 맞는 곳(아침에 술집 등)은 제외. 다른 말 금지.';
  var body = {
    model: 'claude-haiku-5-5', max_tokens: 480, thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: [{ type: 'text', text: q }] }]
  };
  var items = [], rawOrig = '';
  var r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) rawOrig = 'HTTP ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200);
  if (r.getResponseCode() === 200) {
    var cs = JSON.parse(r.getContentText()).content || [];
    rawOrig = cs.filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('\n');
    var seen = {};
    rawOrig.replace(/[*`]/g, '').split(/\r?\n/).forEach(function (ln) {
      var m = ln.match(/^\s*\d+\s*[|.)]\s*([^|]+?)\s*\|\s*(.+)$/);
      if (!m || items.length >= n) return;
      var tok = m[1].trim();
      var hit = pool.filter(function (c) { return String(c.id) === tok; })[0] ||
        pool.filter(function (c) { return tok.indexOf(String(c.id)) !== -1; })[0];
      if (!hit || seen[hit.id]) return;
      seen[hit.id] = true;
      items.push({ id: String(hit.id), reason: m[2].trim().slice(0, 100) });
    });
  }
  var used = {};
  items.forEach(function (x) { used[x.id] = 1; });
  for (var j = 0; j < pool.length && items.length < n; j++) {
    if (!used[String(pool[j].id)]) items.push({ id: String(pool[j].id), reason: '' });
  }
  return { items: items, raw: rawOrig.slice(0, 400) };
}

// 운명의 랜덤픽: 별자리/MBTI/혈액형/바이오리듬/시간/날씨를 바탕으로 Haiku가 저장된 맛집 중 한 곳을 골라줌
function destiny_(p) {
  var k = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_KEY');
  if (!k) return { error: 'missing ANTHROPIC_KEY' };
  var cands = p.cands || [];
  if (!cands.length) return { error: 'no candidates' };
  var lines = cands.map(function (c) {
    return c.id + ' | ' + c.name + ' | ' + (c.cat || '') + ' | ' + (c.dist != null ? Math.round(c.dist) + 'm' : '');
  }).join('\n');
  var q = '당신은 재미있는 운세 기반 맛집 추천가입니다. 아래는 사용자가 저장해 둔 맛집 후보 목록입니다 (형식: id | 가게이름 | 종류 | 거리).\n' + lines +
    '\n\n사용자 정보:\n' +
    (p.name ? '- 이름: ' + p.name + '\n' : '') +
    (p.zodiac ? '- 별자리: ' + p.zodiac + '\n' : '') +
    (p.mbti ? '- MBTI: ' + p.mbti + '\n' : '') +
    (p.blood ? '- 혈액형: ' + p.blood + '형\n' : '') +
    (p.birthTime ? '- 태어난 시간: ' + p.birthTime + '\n' : '') +
    (p.biorhythm ? '- 오늘의 바이오리듬: ' + p.biorhythm + '\n' : '') +
    (p.time ? '- 현재 시간대: ' + p.time + '\n' : '') +
    (p.weather ? '- 현재 날씨: ' + p.weather + '\n' : '') +
    '\n위 정보(별자리, MBTI, 혈액형, 바이오리듬, 시간대, 날씨)를 재미있게 엮어서 오늘 "운명적으로" 가장 잘 맞는 곳을 후보 중 딱 한 곳만 골라 주세요. ' +
    '시간대에 안 맞는 곳(예: 아침에 술집)은 고르지 마세요. 과학적 사실이 아니어도 괜찮으니 운세처럼 재미있게 이유를 쓰세요(헛소리 환영, 진지할 필요 없음). ' +
    '정확히 아래 형식으로만, 다른 말 없이 답하세요:\n' +
    'ID: <고른 id>\n' +
    'DESC: <그 가게가 어떤 곳인지 20~40자 내외로 짧게 설명>\n' +
    'REASON: <사용자 정보를 엮어 운명적으로 왜 이 집을 골랐는지, 80자 이내 한두 문장, 존댓말, 운세스럽고 재밌게>';
  var body = {
    model: 'claude-haiku-5-5', max_tokens: 1024,
    messages: [{ role: 'user', content: [{ type: 'text', text: q }] }]
  };
  var r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) return { error: 'api ' + r.getResponseCode(), body: r.getContentText().slice(0, 500) };
  var parsed = JSON.parse(r.getContentText());
  var cs = parsed.content || [];
  var raw = cs.filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('\n');
  var clean = raw.replace(/[*_`#]/g, '');
  var idm = clean.match(/ID\s*:\s*([^\n\r]+)/i);
  var dem = clean.match(/DESC\s*:\s*([^\n\r]+)/i);
  var rem = clean.match(/REASON\s*:\s*([^\n\r]+)/i);
  if (!idm) return { error: 'no id', raw: raw.slice(0, 300) };
  var id = idm[1].replace(/["'\s]/g, '').trim();
  var picked = null;
  for (var i = 0; i < cands.length; i++) { if (String(cands[i].id) === id) { picked = cands[i]; break; } }
  if (!picked) return { error: 'bad id', raw: raw.slice(0, 300) };
  var naverUrl = 'https://map.naver.com/p/search/' + encodeURIComponent(picked.name + (picked.addr ? ' ' + picked.addr : ''));
  return {
    id: id,
    desc: dem ? dem[1].trim().slice(0, 60) : '',
    reason: rem ? rem[1].trim().slice(0, 100) : '',
    naverUrl: naverUrl
  };
}

// 친구와 맛집 리스트 공유: 코드(방) 기준으로 Script Properties에 저장/조회
// save: {code, action:'save', data:[place,...]}  load: {code, action:'load'}
function room_(p) {
  var code = String(p.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return { error: 'bad code' };
  var props = PropertiesService.getScriptProperties();
  var key = 'ROOM_' + code;
  if (p.action === 'save') {
    var data = p.data;
    if (!Array.isArray(data)) return { error: 'bad data' };
    // 사진(photo/thumb)은 용량이 커서 공유에서는 제외
    var slim = data.map(function (d) {
      return { id: d.id, name: d.name, addr: d.addr, lat: d.lat, lng: d.lng, memo: d.memo, naver: d.naver, visited: !!d.visited, createdAt: d.createdAt, pic: d.pic || null };
    });
    var json = JSON.stringify(slim);
    while (json.length > 8500 && slim.length > 1) { slim.pop(); json = JSON.stringify(slim); }
    if (json.length > 8500) return { error: 'too large' };
    props.setProperty(key, json);
    props.setProperty(key + '_AT', String(Date.now()));
    return { ok: true, count: slim.length, trimmed: slim.length < data.length };
  }
  if (p.action === 'load') {
    var saved = props.getProperty(key);
    if (!saved) return { error: 'not found' };
    var at = props.getProperty(key + '_AT');
    return { items: JSON.parse(saved), updatedAt: at ? Number(at) : null };
  }
  return { error: 'bad action' };
}

function sign_(model, k, m) {
    var q = '사진 속에서 음식점 간판(상호)을 찾아 가게 이름을 읽어 주세요. 사진이 어둡거나 휴대폰 화면 캡처여도 간판 글자가 보이면 최대한 읽으세요. 지점명(예: 부평점)이 보이면 함께 적으세요. 설명 없이 가게 이름 한 줄만 답하세요. 예: 계림원 누룽지통닭구이 부평점. 간판 글자가 전혀 없을 때만 NONE 이라고 답하세요.';
    var body = { model: model, max_tokens: 400, messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }, { type: 'text', text: q }] }] };
    var r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', { method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' }, payload: JSON.stringify(body), muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return { error: 'api ' + r.getResponseCode() };
    var cs = JSON.parse(r.getContentText()).content || [];
    var raw = cs.filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('\n');
    var t = raw.split('\n').map(function (s) { return s.replace(/[*"'`]/g, '').trim(); }).filter(function (s) { return s; })[0] || '';
    return { name: /^NONE/i.test(t) ? '' : t, raw: raw.slice(0, 80) };
}


// ---- 공유방 사진 보관 (구글 드라이브 폴더 'matjip-diary-photos') ----
function picFolder_() {
  var props = PropertiesService.getScriptProperties();
  var fid = props.getProperty('PIC_FOLDER');
  if (fid) { try { return DriveApp.getFolderById(fid); } catch (e) {} }
  var f = DriveApp.createFolder('matjip-diary-photos');
  props.setProperty('PIC_FOLDER', f.getId());
  return f;
}
// 올리기: { code, id, data:'data:image/jpeg;base64,...' }  → { pic: 파일ID }
function picUp_(p) {
  var code = String(p.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return { error: 'bad code' };
  var pid = String(p.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  if (!pid) return { error: 'bad id' };
  var m = String(p.data || '').match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!m) return { error: 'bad photo' };
  if (m[2].length > 120000) return { error: 'too big' };
  var folder = picFolder_();
  var name = code + '_' + pid + '.jpg';
  var old = folder.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);
  var blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name);
  var file = folder.createFile(blob);
  return { pic: file.getId() };
}
// 내려받기: 폴더 안의 이미지 파일만 허용
function picGet_(fileId) {
  try {
    if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) return out_({ error: 'bad id' });
    var file = DriveApp.getFileById(fileId);
    var folder = picFolder_(), ok = false, ps = file.getParents();
    while (ps.hasNext()) { if (ps.next().getId() === folder.getId()) { ok = true; break; } }
    if (!ok) return out_({ error: 'forbidden' });
    var blob = file.getBlob(), ct = blob.getContentType();
    if (String(ct).indexOf('image/') !== 0) return out_({ error: 'not image' });
    return out_({ img: 'data:' + ct + ';base64,' + Utilities.base64Encode(blob.getBytes()) });
  } catch (err) { return out_({ error: 'not found' }); }
}
