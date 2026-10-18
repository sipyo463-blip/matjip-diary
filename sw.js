/* 갤러리의 '공유'로 들어온 사진을 원본 그대로(위치 정보 포함) 앱에 전달합니다 */
self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('fetch',function(e){
  var u=new URL(e.request.url);
  if(e.request.method==='POST'&&u.pathname.slice(-13)==='/share-target'){
    e.respondWith((async function(){
      try{
        var fd=await e.request.formData();
        var f=fd.get('photo');
        if(f&&f.size){
          var c=await caches.open('shared-photo');
          await c.put('shared',new Response(f,{headers:{'content-type':f.type||'image/jpeg','x-mod':String(f.lastModified||'')}}));
        }
      }catch(err){}
      return Response.redirect(new URL('matjip.html?shared=1',self.registration.scope).href,303);
    })());
  }
});
