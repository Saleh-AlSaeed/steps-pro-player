export default {
  async fetch(request, env, ctx) {
    // إعداد CORS
    const corsHeaders = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "Range, Accept, Origin, Referer, User-Agent, Cache-Control",
      "access-control-expose-headers":
        "Accept-Ranges, Content-Range, Content-Length",
    };

    // رد على الـ preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // اصل الفيديو يجي من متغير البيئة
    if (!env.ORIGIN_BASE) {
      return new Response("ORIGIN_BASE is not set", { status: 500 });
    }

    // حلّ مشكلة "Invalid URL" ببناء URL كامل فوق ORIGIN_BASE
    const inUrl = new URL(request.url);
    // نحتفظ بالمسار كما هو (/hls/... أو أي مسار) ونلصقه على ORIGIN_BASE
    const upstreamUrl = new URL(inUrl.pathname + inUrl.search, env.ORIGIN_BASE);

    // هيدر مناسب للأصل
    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.set("host", new URL(env.ORIGIN_BASE).host);

    // تايم آوت اختياري
    const timeoutMs = Number(env.PROXY_TIMEOUT_MS || "15000");
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort("timeout"), timeoutMs);

    let upstreamResp;
    try {
      // نمرّر نفس الميثود (HEAD/GET). للأمان نمنع body مع GET/HEAD
      const method = request.method === "HEAD" ? "HEAD" : "GET";

      upstreamResp = await fetch(upstreamUrl.toString(), {
        method,
        headers: upstreamHeaders,
        redirect: "follow",
        signal: ac.signal,
        // تحسينات شبكة من Cloudflare
        cf: {
          // اسمح بالتخزين المؤقت بشكل افتراضي لشرائح TS
          // يمكن تعديلها لاحقًا حسب احتياجك
          cacheTtlByStatus: { "200-299": 30, "404": 1, "500-599": 0 },
          cacheEverything: false,
          cacheKey: upstreamUrl.toString(),
        },
      });
    } catch (err) {
      clearTimeout(t);
      return new Response(
        `Upstream fetch failed: ${err?.message || String(err)}`,
        { status: 502, headers: corsHeaders }
      );
    }
    clearTimeout(t);

    // نضيف هيدرز CORS على الرد
    const h = new Headers(upstreamResp.headers);
    for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);

    // نُرجع الرد كما هو (ستريمنج) مع الحفاظ على الحالة
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: h,
    });
  },
};
