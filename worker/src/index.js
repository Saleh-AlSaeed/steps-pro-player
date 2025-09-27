// worker/src/index.js

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

/* ===== CORS & Headers ===== */
const CORS_EXPOSE = "Accept-Ranges, Content-Range, Content-Length";
const CORS_ALLOWH = "Range, User-Agent, Referer, Origin, Cache-Control, Content-Type";

function corsPreflight(){
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": CORS_ALLOWH,
      "Access-Control-Max-Age": "86400",
    },
  });
}

function basicHeaders(init, pathname){
  const h = new Headers(init.headers || {});
  const ct = mimeFor(pathname);

  if (isM3U8(pathname)){
    h.set("Content-Type", ct);
    h.set("Cache-Control", "no-store, must-revalidate");
  } else if (isTS(pathname) || isM4S(pathname) || isMP4(pathname)){
    // إن لم يأتِ من الأصل
    if (!h.has("Content-Type")) h.set("Content-Type", ct);
    if (!h.has("Cache-Control")) h.set("Cache-Control", "public, max-age=15, immutable");
  } else if (isKEY(pathname)){
    h.set("Content-Type", ct);
    h.set("Cache-Control", "no-store");
  }

  // CORS
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Expose-Headers", CORS_EXPOSE);
  return h;
}

/* ===== Upstream Fetch ===== */
async function fetchUpstream(req, env){
  const originBase = new URL(env.ORIGIN_BASE || "http://46.152.17.35");
  const inUrl = new URL(req.url);

  // ازل /hls من المسار عند الطلب للأصل
  const upstreamPath = inUrl.pathname.replace(/^\/hls/i, "") || "/";
  const upstream = new URL(upstreamPath + inUrl.search, originBase);

  const isSegment = isTS(inUrl.pathname) || isM4S(inUrl.pathname) || isMP4(inUrl.pathname);

  const hdrs = new Headers();
  hdrs.set("Accept", "*/*");
  hdrs.set("User-Agent", req.headers.get("user-agent") || "Mozilla/5.0");
  const range = req.headers.get("range");
  if (range) hdrs.set("Range", range);

  const controller = new AbortController();
  const to = Number(env.PROXY_TIMEOUT_MS || 15000);
  const id = setTimeout(()=>controller.abort("proxy timeout"), to);

  const cfOpts = {};
  if (env.UPSTREAM_RESOLVE_IP) {
    // اتصل بالـ IP مع الإبقاء على Host من ORIGIN_BASE
    cfOpts.resolveOverride = String(env.UPSTREAM_RESOLVE_IP);
  }
  if (isSegment) {
    const ttl = Number(env.CACHE_SEGMENT_SECONDS || 0);
    if (ttl > 0) {
      cfOpts.cacheEverything = true;
      cfOpts.cacheTtl = ttl;
    }
  } else {
    cfOpts.cacheEverything = false;
    cfOpts.cacheTtl = 0;
  }

  let res;
  try{
    res = await fetch(upstream, {
      method: "GET",
      headers: hdrs,
      redirect: "follow",
      signal: controller.signal,
      cf: cfOpts,
    });
  } finally { clearTimeout(id); }

  return { res, finalUrl: res.url };
}

/* ===== Worker Entrypoint ===== */
export default {
  async fetch(req, env){
    const url = new URL(req.url);

    // Health
    if (url.pathname === "/health"){
      return new Response("ok", { status: 200, headers: { "content-type":"text/plain" } });
    }

    // CORS preflight
    if (req.method === "OPTIONS"){
      return corsPreflight();
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
      // مرر 4xx/5xx كما هي ليتضح السبب
      const h = basicHeaders({ headers: { "content-type":"text/plain" } }, url.pathname);
      return new Response(`Upstream error ${res.status}`, { status: res.status, headers: h });
    }

    // M3U8: أعد كتابة الروابط لتعود عبر /hls
    if (isM3U8(url.pathname)){
      const raw = await res.text();
      const out = rewriteManifest(raw, finalUrl);
      return new Response(out, {
        status: 200,
        headers: basicHeaders({ headers: { "content-type":"application/vnd.apple.mpegurl" } }, url.pathname),
      });
    }

    // تمرير البيانات الثنائية مع بعض رؤوس الأصل
    const h = basicHeaders({ headers: {} }, url.pathname);
    const ct = res.headers.get("content-type");
    const ar = res.headers.get("accept-ranges");
    const cr = res.headers.get("content-range");
    const cl = res.headers.get("content-length");
    if (ct) h.set("Content-Type", ct);
    if (ar) h.set("Accept-Ranges", ar);
    if (cr) h.set("Content-Range", cr);
    if (cl) h.set("Content-Length", cl);

    return new Response(res.body, { status: res.status, headers: h });
  }
};
