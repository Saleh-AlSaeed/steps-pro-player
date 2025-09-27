// worker/src/index.js
// build-405-fix-02: HEAD بلا اتصال بالأصل، تحصين manifest، كاش للشرائح، Debug headers

const BUILD_ID = "build-405-fix-02";

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

function addCors(h){
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Headers", "Range, Accept, Origin, Referer, User-Agent, Cache-Control");
  h.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  h.set("Access-Control-Expose-Headers",
        "Accept-Ranges, Content-Range, Content-Length, X-Worker-Build, X-Upstream-Path, X-Origin-Prefix");
  h.set("X-Worker-Build", BUILD_ID);
  return h;
}

function joinPath(a,b){ const A=(a||"").replace(/\/+$/,""), B=(b||"").replace(/^\/+/,""); return `${A}/${B}`; }
function stripProxyPrefix(p){ return p.replace(/^\/hls/i,""); }

function refToProxy(ref, baseAbsUrl){
  try{
    const abs = new URL(ref, baseAbsUrl);
    const p = abs.pathname.replace(/^\/hls/i, "");
    return `/hls${p}${abs.search||""}`;
  }catch{
    if (typeof ref === "string" && ref.startsWith("/")){
      const p = ref.replace(/^\/hls/i,"");
      return `/hls${p}`;
    }
    return ref;
  }
}

function rewriteManifest(text, baseAbsUrl){
  return text.split("\n").map(line=>{
    const t=line.trim();
    if (TAGS_RE.test(t)){
      return line.replace(/URI="([^"]+)"/gi, (_m,uri)=> `URI="${refToProxy(uri, baseAbsUrl)}"`);
    }
    if (!t || t.startsWith("#")) return line;
    return refToProxy(t, baseAbsUrl);
  }).join("\n");
}

function basicHeaders(init, pathname){
  const h = new Headers(init.headers||{});
  const ct = mimeFor(pathname);

  if (isM3U8(pathname)){
    h.set("Content-Type", ct);
    h.set("Cache-Control", "no-store, must-revalidate");
  } else if (isTS(pathname) || isM4S(pathname) || isMP4(pathname)){
    if (!h.has("Content-Type")) h.set("Content-Type", ct);
    if (!h.has("Cache-Control")) h.set("Cache-Control", "public, max-age=15, immutable");
  } else if (isKEY(pathname)){
    h.set("Content-Type", ct);
    h.set("Cache-Control", "no-store");
  }

  addCors(h);
  return h;
}

async function fetchUpstream(req, env, method, isSegment){
  const originBase = new URL(env.ORIGIN_BASE);
  const originPrefix = env.ORIGIN_PATH_PREFIX || ""; // مثل "/hls"
  const inUrl = new URL(req.url);

  const incoming = stripProxyPrefix(inUrl.pathname);          // /live/playlist.m3u8
  const upstreamPath = joinPath(originPrefix, incoming);      // /hls/live/playlist.m3u8
  const upstream = new URL(upstreamPath + inUrl.search, originBase);

  const hdrs = new Headers();
  hdrs.set("Accept", "*/*");
  hdrs.set("User-Agent", req.headers.get("user-agent") || "Mozilla/5.0");
  const r = req.headers.get("range");
  if (r) hdrs.set("Range", r);

  const controller = new AbortController();
  const to = Number(env.PROXY_TIMEOUT_MS || 20000);
  const id = setTimeout(()=>controller.abort("proxy timeout"), to);

  let res;
  try{
    res = await fetch(upstream, {
      method,
      headers: hdrs,
      redirect: "follow",
      signal: controller.signal,
      cf: isSegment
        ? { cacheEverything: true, cacheTtl: Number(env.CACHE_SEGMENT_SECONDS || 25) }
        : { cacheEverything: false, cacheTtl: 0 },
    });
  } finally { clearTimeout(id); }

  return { res, upstreamPath: upstream.pathname, upstreamUrl: upstream.href };
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);

    // OPTIONS (CORS)
    if (req.method === "OPTIONS"){
      return new Response(null, { status: 204, headers: addCors(new Headers()) });
    }

    // Health
    if (url.pathname === "/health"){
      return new Response("ok", { status: 200, headers: addCors(new Headers({ "content-type":"text/plain" })) });
    }

    if (!url.pathname.startsWith("/hls/")){
      return new Response("Not Found", { status: 404, headers: addCors(new Headers({ "content-type":"text/plain" })) });
    }

    const isSegment = isTS(url.pathname) || isM4S(url.pathname) || isMP4(url.pathname);

    // HEAD: لا نتصل بالأصل إطلاقًا (لمنع 405/502)
    if (req.method === "HEAD"){
      const h = basicHeaders({ headers: {} }, url.pathname);
      h.set("X-Origin-Prefix", env.ORIGIN_PATH_PREFIX || "");
      h.set("X-Upstream-Path", joinPath(env.ORIGIN_PATH_PREFIX || "", stripProxyPrefix(url.pathname)));
      return new Response(null, { status: 200, headers: h });
    }

    // GET
    let upstream;
    try{
      upstream = await fetchUpstream(req, env, "GET", isSegment);
    }catch(e){
      const h = addCors(new Headers({ "content-type":"text/plain" }));
      h.set("X-Origin-Prefix", env.ORIGIN_PATH_PREFIX || "");
      return new Response("Upstream fetch failed: "+String(e), { status: 502, headers: h });
    }

    const { res, upstreamPath, upstreamUrl } = upstream;

    if (res.status >= 400){
      const h = basicHeaders({ headers: { "content-type":"text/plain" } }, url.pathname);
      h.set("X-Origin-Prefix", env.ORIGIN_PATH_PREFIX || "");
      h.set("X-Upstream-Path", upstreamPath);
      return new Response(`Upstream error ${res.status} for ${upstreamUrl}`, { status: res.status, headers: h });
    }

    // manifest
    if (isM3U8(url.pathname)){
      const h = basicHeaders({ headers: { "content-type":"application/vnd.apple.mpegurl" } }, url.pathname);
      h.set("X-Origin-Prefix", env.ORIGIN_PATH_PREFIX || "");
      h.set("X-Upstream-Path", upstreamPath);

      try{
        const raw = await res.text();
        const out = rewriteManifest(raw, res.url);
        return new Response(out, { status: 200, headers: h });
      }catch(e){
        // لو فشل التحويل لأي سبب، أعِد الخام بدل 500
        const fallback = await res.arrayBuffer();
        return new Response(fallback, { status: 200, headers: h });
      }
    }

    // segments / keys / غيرها
    const h = basicHeaders({ headers: {} }, url.pathname);
    const copy = (k)=>{ const v=res.headers.get(k); if(v) h.set(k.replace(/\b\w/g,m=>m.toUpperCase()), v); };
    ["content-type","accept-ranges","content-range","content-length"].forEach(copy);
    h.set("X-Origin-Prefix", env.ORIGIN_PATH_PREFIX || "");
    h.set("X-Upstream-Path", upstreamPath);

    return new Response(res.body, { status: res.status, headers: h });
  }
};
