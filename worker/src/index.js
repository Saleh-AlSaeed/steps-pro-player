// worker/src/index.js
// نسخــة تُصلّح 405: تدعم HEAD/OPTIONS + تضيف ORIGIN_PATH_PREFIX + رؤوس Debug

const BUILD_ID = "build-405-fix-01";

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
  h.set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length, X-Worker-Build, X-Upstream-Path, X-Origin-Prefix");
  h.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  h.set("X-Worker-Build", BUILD_ID);
  return h;
}

function joinPath(a, b){
  const A = (a||"").replace(/\/+$/,"");
  const B = (b||"").replace(/^\/+/,"");
  return `${A}/${B}`;
}

function stripProxyPrefix(p){ return p.replace(/^\/hls/i, ""); }

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

async function fetchUpstream(method, pathWithQuery, env, req){
  const originBase = new URL(env.ORIGIN_BASE);
  const originPrefix = env.ORIGIN_PATH_PREFIX || ""; // مثال: "/hls"
  const u = new URL(req.url);

  const incoming = stripProxyPrefix(u.pathname); // "/live/playlist.m3u8"
  const upstreamPath = joinPath(originPrefix, incoming); // "/hls/live/playlist.m3u8"
  const upstream = new URL(upstreamPath + u.search, originBase);

  const hdrs = new Headers();
  hdrs.set("Accept", "*/*");
  hdrs.set("User-Agent", req.headers.get("user-agent") || "Mozilla/5.0");
  const range = req.headers.get("range");
  if (range) hdrs.set("Range", range);

  const controller = new AbortController();
  const to = Number(env.PROXY_TIMEOUT_MS || 15000);
  const id = setTimeout(()=>controller.abort("proxy timeout"), to);

  let res;
  try{
    res = await fetch(upstream, {
      method,
      headers: hdrs,
      redirect: "follow",
      signal: controller.signal,
      cf: { cacheEverything: false, cacheTtl: 0 },
    });
  } finally { clearTimeout(id); }

  return { res, upstreamPath: upstream.pathname };
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS"){
      const h = addCors(new Headers());
      return new Response(null, { status: 204, headers: h });
    }

    // Health
    if (url.pathname === "/health"){
      return new Response("ok", { status: 200, headers: addCors(new Headers({ "content-type":"text/plain" })) });
    }

    if (!url.pathname.startsWith("/hls/")){
      return new Response("Not Found", { status: 404, headers: addCors(new Headers({ "content-type":"text/plain" })) });
    }

    const wantHead = (req.method === "HEAD");
    const method   = wantHead ? "HEAD" : "GET";

    let upstream;
    try{
      upstream = await fetchUpstream(method, url.pathname + url.search, env, req);
    }catch(e){
      const h = addCors(new Headers({ "content-type":"text/plain" }));
      return new Response("Upstream fetch failed: "+String(e), { status: 502, headers: h });
    }

    const { res, upstreamPath } = upstream;

    if (wantHead){
      // نعيد 200 مع الرؤوس مهما كان ردّ الأصل على HEAD (لتفادي 405)
      const h = basicHeaders({ headers: {} }, url.pathname);
      h.set("X-Upstream-Path", upstreamPath);
      h.set("X-Origin-Prefix", env.ORIGIN_PATH_PREFIX || "");
      for (const k of ["content-type","content-length","accept-ranges","content-range"]){
        const v = res.headers.get(k);
        if (v) h.set(k.replace(/\b\w/g,m=>m.toUpperCase()), v);
      }
      return new Response(null, { status: 200, headers: h });
    }

    if (res.status >= 400){
      const h = basicHeaders({ headers: { "content-type":"text/plain" } }, url.pathname);
      h.set("X-Upstream-Path", upstreamPath);
      h.set("X-Origin-Prefix", env.ORIGIN_PATH_PREFIX || "");
      return new Response(`Upstream error ${res.status}`, { status: res.status, headers: h });
    }

    if (isM3U8(url.pathname)){
      const raw = await res.text();
      const out = rewriteManifest(raw, res.url);
      const h = basicHeaders({ headers: { "content-type":"application/vnd.apple.mpegurl" } }, url.pathname);
      h.set("X-Upstream-Path", upstreamPath);
      h.set("X-Origin-Prefix", env.ORIGIN_PATH_PREFIX || "");
      return new Response(out, { status: 200, headers: h });
    }

    const h = basicHeaders({ headers: {} }, url.pathname);
    const ct = res.headers.get("content-type");
    const ar = res.headers.get("accept-ranges");
    const cr = res.headers.get("content-range");
    const cl = res.headers.get("content-length");
    if (ct) h.set("Content-Type", ct);
    if (ar) h.set("Accept-Ranges", ar);
    if (cr) h.set("Content-Range", cr);
    if (cl) h.set("Content-Length", cl);
    h.set("X-Upstream-Path", upstreamPath);
    h.set("X-Origin-Prefix", env.ORIGIN_PATH_PREFIX || "");

    return new Response(res.body, { status: res.status, headers: h });
  }
};
