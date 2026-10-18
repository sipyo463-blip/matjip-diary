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
    if (b.destiny) return out_(destiny_(b.destiny));
    if (b.room) return out_(room_(b.room));
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
  var n = Math.min(3, pool.length);
  var lines = pool.map(function (c) {
    return c.id + ' | ' + c.name + ' | ' + (c.cat || '') + ' | ' + (c.dist != null ? Math.round(c.dist) + 'm' : '');
  }).join('\n');
  var fmtEx = [];
  for (var i = 1; i <= n; i++) fmtEx.push('RANK' + i + '_ID: <고른 id>\nRANK' + i + '_REASON: <왜 어울리는지, 100자 이내, 존댓말>');
  var q = '아래는 사용자 근처에 저장된 맛집 후보 목록입니다 (형식: id | 가게이름 | 종류 | 거리).\n' + lines +
    '\n\n사용자 취향(복수 선택 가능, 쉼표로 구분):\n- 오늘 먹고 싶은 맛: ' + (p.taste || '상관없음') +
    '\n- 배고픈 정도: ' + (p.hunger || '상관없음') +
    '\n- 오늘 기분: ' + (p.feel || '상관없음') +
    (p.weather ? '\n- 현재 날씨: ' + p.weather : '') +
    (p.time ? '\n- 현재 시간대: ' + p.time : '') +
    (p.time ? '\n\n시간대를 반드시 고려하세요. 예를 들어 아침/브런치 시간대에는 술집·포차·호프 등 음주 중심 장소를 추천하지 말고, 밤/야식 시간대에는 아침식사 전문점을 추천하지 마세요. 시간대에 안 맞는 후보보다 조금 덜 맞아도 시간대에 맞는 곳을 우선하세요.' : '') +
    '\n\n위 취향에 가장 잘 맞는 곳을 후보 중 ' + n + '곳을 골라 순위를 매기고, 정확히 아래 형식으로만 답하세요. 다른 말이나 설명은 절대 쓰지 마세요. 각 REASON은 반드시 60자 이내의 한 문장으로 짧게 쓰세요:\n' +
    fmtEx.join('\n');
  var body = {
    model: 'claude-haiku-5-5', max_tokens: 1200,
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
  var items = [];
  var seen = {};
  for (var i = 1; i <= n; i++) {
    var idm = raw.match(new RegExp('RANK' + i + '_ID:\\s*([^\\n\\r]+)', 'i'));
    var rem = raw.match(new RegExp('RANK' + i + '_REASON:\\s*([^\\n\\r]+)', 'i'));
    if (!idm) continue;
    var id = idm[1].replace(/[*"'`]/g, '').trim();
    if (!pool.some(function (c) { return String(c.id) === id; })) continue;
    if (seen[id]) continue;
    seen[id] = true;
    items.push({ id: id, reason: rem ? rem[1].trim().slice(0, 60) : '' });
  }
  if (!items.length) {
    for (var j = 0; j < n; j++) items.push({ id: pool[j].id, reason: '' });
  }
  return { items: items };
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
      return { id: d.id, name: d.name, addr: d.addr, lat: d.lat, lng: d.lng, memo: d.memo, naver: d.naver, visited: !!d.visited, createdAt: d.createdAt };
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
