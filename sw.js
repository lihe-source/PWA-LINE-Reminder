const CACHE = 'rex-reminder-v1.0.1';
const ASSETS = ['./','./index.html','./styles.css','./app.js','./live.js','./mic-worklet.js','./config.js','./icon.svg','./icon-maskable.svg','./icon-180.png','./icon-192.png','./icon-512.png','./icon-maskable-512.png','./manifest.webmanifest','./version.json'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if (event.request.method!=='GET' || new URL(event.request.url).origin!==self.location.origin) return;
  if (event.request.mode==='navigate' || /(?:config\.js|version\.json)$/.test(new URL(event.request.url).pathname)) {
    event.respondWith(fetch(event.request).catch(()=>caches.match(event.request))); return;
  }
  event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request)));
});
