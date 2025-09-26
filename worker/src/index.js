// worker/src/index.js
// بروكسي HLS مع CORS شامل، كاش شرائح Edge، إعادة كتابة روابط m3u8

const TAGS = [
  "EXT-X-KEY","EXT-X-SESSION-KEY","EXT-X-MAP",
  "EXT-X-MEDIA","EXT-X-I-FRAME-STREAM-INF","EXT-X-SESSION-DATA",
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

// ===== CORS helpers =====
function corsHeaders(extra = {}){
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Accept, Origin, Referer, User-Agent, Cache-Control",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length",
    "Timing-Allow-Origin": "*",
    ...extra,
  };
}
function withCORS(res, extra = {}){
  const h = new Headers(res.headers);
  for (const [k,v] of Object.entries(corsHeaders(extra))) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}
function preflight(){
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function baseHeadersFor(pathname, segTTL){
  const h = {};
  const ct = mimeFor(pathname);

  if (isM3U8(pathname)){
    h["Content-Type"]  = ct;
    h["Cache-Control"] = "no-store, must-revalidate";
  } else if (isTS(pathname) || isM4S(pathname) || isMP4(pathname)){
    h["Content-Type"]  = ct;
    h["Cache-Control"] = `public, max-age=${Number(segTTL||25)}, immutable`;
  } else if (isKEY(pathname)){
    h["Content-Type"]  = ct;
    h["Cache-Control"] = "no-store";
  } else {
    h["Content-Type"]  = ct;
  }
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

    // CORS preflight
    if (req.method === "OPTIONS") return preflight();

    if (url.pathname === "/health"){
      return withCORS(new Response("ok", { status: 200, headers: { "content-type":"text/plain" } }));
    }
    if (req.method !== "GET"){
      return withCORS(new Response("Method Not Allowed", { status: 405 }));
    }
    if (!url.pathname.startsWith("/hls/")){
      return withCORS(new Response("Not Found", { status: 404 }));
    }

    const originBase = new URL(env.ORIGIN_BASE || "http://46.152.17.35");
    const upstream = upstreamURL(req.url, originBase);
    const segTTL = Number(env.CACHE_SEGMENT_SECONDS || 25);
    const wantRange = !!req.headers.get("range");
    const path = url.pathname;

    // Cache API للشرائح فقط (بدون Range)
    if ((isTS(path) || isM4S(path) || isMP4(path)) && !wantRange){
      const cache = caches.default;
      const cached = await cache.match(req);
      if (cached){
        return withCORS(
          new Response(cached.body, {
            status: cached.status,
            headers: new Headers({
              ...Object.fromEntries(cached.headers),
              ...baseHeadersFor(path, segTTL),
            }),
          })
        );
      }
    }

    // Upstream
    let res;
    try{
      res = await fetchUpstream(upstream, req, env);
    }catch(e){
      return withCORS(new Response("Upstream fetch failed: "+String(e), {
        status: 502,
        headers: { "content-type":"text/plain" }
      }));
    }

    if (res.status >= 400){
      return withCORS(new Response(`Upstream error ${res.status}`, {
        status: res.status,
        headers: { "content-type":"text/plain", ...baseHeadersFor(path, segTTL) }
      }));
    }

    // m3u8: rewrite + CORS
    if (isM3U8(path)){
      const raw = await res.text();
      const out = rewriteManifest(raw, res.url);
      return withCORS(new Response(out, {
        status: 200,
        headers: baseHeadersFor(path, segTTL),
      }));
    }

    // segments/keys: مرِّر بعض الرؤوس
    const pass = ["content-type","accept-ranges","content-range","content-length","etag","last-modified"];
    const h = new Headers(baseHeadersFor(path, segTTL));
    for (const k of pass){ const v = res.headers.get(k); if (v) h.set(k, v); }

    const final = withCORS(new Response(res.body, { status: res.status, headers: h }));

    // خزّن الشرائح الكاملة فقط
    if ((isTS(path) || isM4S(path) || isMP4(path)) && !wantRange && res.status === 200){
      try{
        const cache = caches.default;
        await cache.put(req, final.clone());
      }catch{}
    }

    return final;
  }
};
