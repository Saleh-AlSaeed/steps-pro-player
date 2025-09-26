// worker/src/index.js
// Proxy HLS with manifest rewrite + safe headers
const TAGS = [
  "EXT-X-KEY","EXT-X-SESSION-KEY","EXT-X-MAP",
  "EXT-X-MEDIA","EXT-X-I-FRAME-STREAM-INF","EXT-X-SESSION-DATA",
];
const TAGS_RE = new RegExp(`^#(?:${TAGS.join("|")}):`, "i");

function isM3U8(p){ return /\.m3u8(\?.*)?$/i.test(p); }
function isTS(p){ return /\.ts(\?.*)?$/i.test(p); }
function isM4S(p){ return /\.m4s(\?.*)?$/i.test(p); }
function isMP4(p){ return /\.mp4(\?.*)?$/i.test(p); }
function isKEY(p){ return /\.key(\?.*)?$/i.test(p); }

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
    let p = abs.pathname.replace(/^\/hls/i, "");
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

function basicHeaders(init, pathname){
  const h = new Headers(init.headers || {});
  const ct = mimeFor(pathname);

  // CORS
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length");

  if (isM3U8(pathname)){
    h.set("Content-Type", ct);
    // لا نخزن القائمة (live)
    h.set("Cache-Control", "no-cache, no-store, must-revalidate");
    h.set("Pragma", "no-cache");
  } else if (isTS(pathname) || isM4S(pathname) || isMP4(pathname)){
    if (!h.has("Content-Type")) h.set("Content-Type", ct);
    // اسمح بتخزين قصير للمقاطع لتخفيف الضغط (CDN only)
    if (!h.has("Cache-Control")) h.set("Cache-Control", "public, max-age=15, s-maxage=30, immutable");
  } else if (isKEY(pathname)){
    h.set("Content-Type", ct);
    h.set("Cache-Control", "no-store");
  } else {
    if (!h.has("Content-Type")) h.set("Content-Type", "application/octet-stream");
    h.set("Cache-Control", "public, max-age=60");
  }
  return h;
}

async function fetchUpstream(req, env){
  // مهم: HTTP مع IP لتجنّب TLS/SNI
  const originBase = new URL(env.ORIGIN_BASE || "http://46.152.17.35");
  const inUrl = new URL(req.url);
  // إزالة بادئة /hls/ عند التجميع
  const path = inUrl.pathname.replace(/^\/hls/, "");
  const upstream = new URL(path + inUrl.search, originBase);

  // رؤوس بسيطة
  const hdrs = new Headers();
  hdrs.set("Accept", "*/*");
  hdrs.set("User-Agent", req.headers.get("user-agent") || "Mozilla/5.0");
  hdrs.set("Connection", "keep-alive");
  const range = req.headers.get("range");
  if (range) hdrs.set("Range", range);

  const controller = new AbortController();
  const to = Number(env.PROXY_TIMEOUT_MS || 20000);
  const id = setTimeout(()=>controller.abort("proxy timeout"), to);

  let res;
  try{
    res = await fetch(upstream, {
      method: "GET",
      headers: hdrs,
      redirect: "follow",
      signal: controller.signal,
      // لا نستخدم Cache قوي من Cloudflare للمؤشرات، نتركه للمقاطع فقط عبر headers
      cf: { cacheEverything: false, cacheTtl: 0 }
    });
  } finally { clearTimeout(id); }

  return { res, finalUrl: res.url };
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
          "Access-Control-Allow-Headers": "Range, User-Agent, Accept",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    if (url.pathname === "/health"){
      return new Response("ok", { status: 200, headers: { "content-type":"text/plain" } });
    }
    if (!url.pathname.startsWith("/hls/")){
      return new Response("Not Found", { status: 404 });
    }

    let upstream;
    try{
      upstream = await fetchUpstream(req, env);
    }catch(e){
      return new Response("Upstream fetch failed: "+String(e), {
        status: 502,
        headers: { "content-type":"text/plain", "Access-Control-Allow-Origin":"*" }
      });
    }

    const { res, finalUrl } = upstream;

    if (res.status >= 400){
      const h = basicHeaders({ headers: { "content-type": "text/plain" } }, url.pathname);
      return new Response(`Upstream error ${res.status}`, { status: res.status, headers: h });
    }

    if (isM3U8(url.pathname)){
      const raw = await res.text();
      const out = rewriteManifest(raw, finalUrl);
      return new Response(out, {
        status: 200,
        headers: basicHeaders({ headers: { "content-type":"application/vnd.apple.mpegurl" } }, url.pathname),
      });
    }

    const h = basicHeaders({ headers: {} }, url.pathname);
    // مرّر بعض الرؤوس المفيدة إن وجدت
    const passthrough = ["content-type","accept-ranges","content-range","content-length"];
    for (const k of passthrough){
      const v = res.headers.get(k);
      if (v) h.set(k.replace(/\b\w/g, c=>c.toUpperCase()), v);
    }

    return new Response(res.body, { status: res.status, headers: h });
  }
};
