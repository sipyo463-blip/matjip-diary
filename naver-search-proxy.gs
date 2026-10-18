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
  if (e && e.parameter && e.parameter.img) return imgThumb_(String(e.parameter.img).trim());
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

function imgThumb_(q) {
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

// 오늘의 추천: 후보 목록 + 취향(맛/배고픔/기분/날씨)을 Haiku에 보내 하나를 고르게 함
function pick_(p) {
  var k = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_KEY');
  if (!k) return { error: 'missing ANTHROPIC_KEY' };
  var cands = p.cands || [];
  if (!cands.length) return { error: 'no candidates' };
  var excl = p.exclude || [];
  var pool = cands.filter(function (c) { return excl.indexOf(c.id) === -1; });
  if (!pool.length) pool = cands;
  var lines = pool.map(function (c) {
    return c.id + ' | ' + c.name + ' | ' + (c.cat || '') + ' | ' + (c.dist != null ? Math.round(c.dist) + 'm' : '');
  }).join('\n');
  var q = '아래는 사용자 근처에 저장된 맛집 후보 목록입니다 (형식: id | 가게이름 | 종류 | 거리).\n' + lines +
    '\n\n사용자 취향:\n- 오늘 먹고 싶은 맛: ' + (p.taste || '상관없음') +
    '\n- 배고픈 정도: ' + (p.hunger || '보통') +
    '\n- 오늘 기분: ' + (p.feel || '보통') +
    (p.weather ? '\n- 현재 날씨: ' + p.weather : '') +
    '\n\n위 취향에 가장 잘 맞는 곳을 후보 중 하나만 골라서, 정확히 아래 두 줄 형식으로만 답하세요(다른 말 금지):\n' +
    'ID: <고른 id>\nREASON: <왜 어울리는지 한 문장, 20자 내외, 친근한 반말 금지, 존댓말>';
  var body = {
    model: 'claude-haiku-5-5', max_tokens: 200,
    messages: [{ role: 'user', content: [{ type: 'text', text: q }] }]
  };
  var r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) return { error: 'api ' + r.getResponseCode() };
  var cs = JSON.parse(r.getContentText()).content || [];
  var raw = cs.filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('\n');
  var idm = raw.match(/ID:\s*([^\n\r]+)/i);
  var rem = raw.match(/REASON:\s*([^\n\r]+)/i);
  var id = idm ? idm[1].replace(/[*"'`]/g, '').trim() : '';
  var found = pool.some(function (c) { return String(c.id) === id; });
  if (!found) id = pool[0].id;
  return { id: id, reason: rem ? rem[1].trim() : '' };
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
