const CACHE='apex-report-v6';
const STATIC=[
  './',
  './index.html',
  // Google Fonts CSS
  'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,700;0,9..40,800;1,9..40,400&family=DM+Mono:wght@400;500&display=swap',
  // CDN scripts — cached so app works offline (html2canvas/jsPDF no longer used, removed)
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);

  // Let Supabase calls pass through — never cache API responses
  if(url.hostname.includes('supabase.co')){e.respondWith(fetch(e.request));return;}

  // CDN scripts — cache first (pinned versions, safe to serve stale)
  if(url.hostname==='cdnjs.cloudflare.com'||url.hostname==='cdn.jsdelivr.net'){
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{
      const clone=res.clone();
      caches.open(CACHE).then(c=>c.put(e.request,clone));
      return res;
    })));
    return;
  }

  // Fonts — cache first
  if(url.hostname.includes('fonts.g')){
    e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{
      const clone=res.clone();
      caches.open(CACHE).then(c=>c.put(e.request,clone));
      return res;
    })));
    return;
  }

  // HTML (index.html / root) — network first, fall back to cache
  e.respondWith(
    fetch(e.request)
      .then(res=>{
        const clone=res.clone();
        caches.open(CACHE).then(c=>c.put(e.request,clone));
        return res;
      })
      .catch(()=>caches.match(e.request)||caches.match('./index.html'))
  );
});
