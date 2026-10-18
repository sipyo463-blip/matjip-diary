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
