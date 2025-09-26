// worker/src/index.js
// بروكسي HLS مع:
// - إعادة كتابة روابط m3u8 -> /hls/…
// - كاش قصير للشرائح (ts/m4s/mp4) عبر Cache API عند الحافة
// - عدم كاش لقوائم m3u8/مفاتيح التشفير
// - احترام Range + ترويسات CORS واضحة

const TAGS = [
  "EXT-X-KEY", "EXT-X-SESSION-KEY", "EXT-X-MAP",
  "EXT-X-MEDIA", "EXT-X-I-FRAME-STREAM-INF", "EXT-X-SESSION-DATA",
];
const TAGS_RE = new RegExp(`^#(?:${TAGS.join("|")}):`, "i");

const isM3U8 = p => /\.m3u8(\?.*)?$/i.test(p);
const isTS   = p => /\.ts(\?.*)?$/i.test(p);
const isM4S  = p => /\.m4s(\?.*)?$/i.test(p);
const isMP4  = p => /\.mp4(\?.*)?$/i.test(p);
const isKEY  = p => /\.key(\?.*)?$/i.test(p);

function mimeFor(p){
  if (isM3U8(p)) return "application/vnd.apple.mpegurl";
  if (isTS(p))   return "video/mp2t";
  if (isM4S(p))  return "video/iso.segment";
  if (isMP4(p))  return "video/mp4";
  if (isKEY(p))  return "application/octet-stream";
  return "application/octet-stream";
}

function refToProxy(ref, baseAbsUrl){
  try{
    const abs = new URL(ref, baseAbsUrl);
    const p = abs.pathname.replace(/^\/hls/i, "");
    return `/hls${p}${abs.search || ""}`;
  }catch{
    if (typeof ref === "string" && ref.startsWith("/")){
      const p = ref.replace(/^\/hls/i, "");
      return `/hls${p}`;
    }
    return ref;
  }
}

function rewriteManifest(text, baseAbsUrl){
  return text.split("\n").map(line=>{
    const t = line.trim();
    if (TAGS_RE.test(t)){
      return line.replace(/URI="([^"]+)"/gi, (_m, uri)=> `URI="${refToProxy(uri, baseAbsUrl)}"`);
    }
    if (!t || t.startsWith("#")) return line;
    return refToProxy(t, baseAbsUrl);
  }).join("\n");
}

function basicHeaders(init, pathname, segTTL){
  const h = new Headers(init?.headers || {});
  const ct = mimeFor(pathname);

  if (isM3U8(pathname)){
    h.set("Content-Type", ct);
    h.set("Cache-Control", "no-store, must-revalidate");
  } else if (isTS(pathname) || isM4S(pathname) || isMP4(pathname)){
    if (!h.has("Content-Type")) h.set("Content-Type", ct);
    const ttl = Number(segTTL || 25);
    if (!h.has("Cache-Control")) h.set("Cache-Control", `public, max-age=${ttl}, immutable`);
  } else if (isKEY(pathname)){
    h.set("Content-Type", ct);
    h.set("Cache-Control", "no-store");
  } else {
    if (!h.has("Content-Type")) h.set("Content-Type", ct);
  }

  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length");
  h.set("Timing-Allow-Origin", "*");
  return h;
}

function upstreamURL(reqUrl, originBase){
  const inUrl = new URL(reqUrl);
  const path = inUrl.pathname.replace(/^\/hls/i, "");
  return new URL(path + inUrl.search, originBase);
}

async function fetchUpstream(upstream, req, env){
  const hdrs = new Headers();
  hdrs.set("Accept", "application/vnd.apple.mpegurl,video/*;q=0.9,*/*;q=0.8");
  hdrs.set("User-Agent", req.headers.get("user-agent") || "Mozilla/5.0");
  const range = req.headers.get("range");
  if (range) hdrs.set("Range", range);

  const controller = new AbortController();
  const to = Number(env.PROXY_TIMEOUT_MS || 15000);
  const id = setTimeout(()=>controller.abort("proxy timeout"), to);

  let res;
  try{
    res = await fetch(upstream, {
      method: "GET",
      headers: hdrs,
      redirect: "follow",
      signal: controller.signal,
      cf: { cacheEverything: false, cacheTtl: 0 },
    });
  } finally { clearTimeout(id); }

  return res;
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);

    if (url.pathname === "/health"){
      return new Response("ok", { status: 200, headers: { "content-type":"text/plain" } });
    }
    if (req.method !== "GET"){
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (!url.pathname.startsWith("/hls/")){
      return new Response("Not Found", { status: 404 });
    }

    const originBase = new URL(env.ORIGIN_BASE || "http://46.152.17.35");
    const upstream = upstreamURL(req.url, originBase);
    const segTTL = Number(env.CACHE_SEGMENT_SECONDS || 25);
    const wantRange = !!req.headers.get("range");
    const path = url.pathname;

    // كاش الشرائح (بدون Range فقط)
    if ((isTS(path) || isM4S(path) || isMP4(path)) && !wantRange){
      const cache = caches.default;
      const cached = await cache.match(req);
      if (cached){
        const h = basicHeaders({ headers: Object.fromEntries(cached.headers) }, path, segTTL);
        return new Response(cached.body, { status: cached.status, headers: h });
      }
    }

    // جلب من المنبع
    let res;
    try{
      res = await fetchUpstream(upstream, req, env);
    }catch(e){
      return new Response("Upstream fetch failed: "+String(e), {
        status: 502,
        headers: { "content-type":"text/plain", "Access-Control-Allow-Origin":"*" }
      });
    }

    if (res.status >= 400){
      const h = basicHeaders({ headers: { "content-type":"text/plain" } }, path, segTTL);
      return new Response(`Upstream error ${res.status}`, { status: res.status, headers: h });
    }

    if (isM3U8(path)){
      const raw = await res.text();
      const out = rewriteManifest(raw, res.url);
      return new Response(out, {
        status: 200,
        headers: basicHeaders({ headers: { "content-type":"application/vnd.apple.mpegurl" } }, path, segTTL),
      });
    }

    const h = basicHeaders({ headers: {} }, path, segTTL);
    const passthru = ["content-type","accept-ranges","content-range","content-length","etag","last-modified"];
    for (const k of passthru){
      const v = res.headers.get(k);
      if (v) h.set(k, v);
    }

    const final = new Response(res.body, { status: res.status, headers: h });

    // خزّن الشرائح الكاملة فقط (200 وبدون Range)
    if ((isTS(path) || isM4S(path) || isMP4(path)) && !wantRange && res.status === 200){
      try{
        const cache = caches.default;
        const toCache = new Response(await final.clone().arrayBuffer(), { status: final.status, headers: final.headers });
        await cache.put(req, toCache);
      }catch{}
    }

    return final;
  }
};
