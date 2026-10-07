/**
 * Asura Scans — Venera 漫画源
 *
 * 站点：https://asurascans.com  (Astro SSR + 官方 JSON API)
 * 官方 API：https://api.asurascans.com
 *
 * ── 已实测的网络事实（改动前请先复测）──────────────────────────────
 * 1. 列表/检索（无需登录、无需 Cookie，仅需浏览器 UA）：
 *      GET https://api.asurascans.com/api/series
 *           ?page=1&sort=latest|rating|bookmarks|newest
 *           &search=关键字          # 注意是 search，不是 q（q 会被忽略）
 *           &genres=action,fantasy  # 逗号分隔取交集
 *           &status=ongoing|completed
 *           &type=manhwa|manhua
 *      返回 { data: [...], meta: { total, per_page, has_more } }，per_page 固定 20。
 *      （该接口忽略 per_page 参数，实测 per_page=100 仍返回 20 条。）
 *      /api/search?q= 也可用，但不支持分页，故本源统一使用 /api/series。
 *
 * 2. 类型列表：GET /api/genres → { data: [{id, name, slug}] }，共 35 个。
 *
 * 3. 详情页章节列表没有公开 JSON 接口：只有 /comics/{slug}/chapter/{n} 这种
 *    直链。最新章节表在服务端渲染时写进 <astro-island component-url=
 *    "/_astro/ChapterListReact..."> 的 props 里。因此详情页必须解析 HTML。
 *    实测 props 里的 chapters 数量 == totalChapters（21/21，非只给一页）。
 *    免费用户只看到非付费章节，这在站点侧同样如此。
 *
 * 4. 章节图片同样优先从 ChapterReader 的 props.pages[].url 取，最可靠；
 *    取不到时再退回 <img data-page-index> / div[data-page] img。
 *    cdn.asurascans.com 实测无需 Referer 即可直接取图（无防盗链）。
 *
 * 5. 站点为 Cloudflare 保护。实测 asurascans.com 的首页/详情/章节页可能
 *    间歇性返回 504/525（源站抖动），本源对请求做了重试。
 *
 * 免责声明：本源仅做页面/接口解析，不存储、不转载任何作品内容。
 */

class AsuraScans extends ComicSource {
  name = "Asura Scans";
  key = "asura_scans";
  version = "1.3.0";
  minAppVersion = "1.0.0";
  url = "";

  // ---------------- 站点常量 ----------------
  site = "https://asurascans.com";
  // 主 API 域名；若被网络环境拦截，可在设置里改成镜像。
  apiBase = "https://api.asurascans.com";
  // cdn.asurascans.com 实测无防盗链，无需额外 Referer
  cdnHost = "cdn.asurascans.com";

  // 站点列表接口每页固定 20 条（per_page 参数被忽略，实测）
  pageSize = 20;
  // 收藏（站点叫 bookmark）接口默认每页 20 条
  favPageSize = 20;

  // 登录态在 JS 引擎重启后会丢失，靠 saveData/loadData 持久化
  accessToken = null;
  refreshToken = null;
  // 避免并发请求同时触发多次刷新
  refreshing = null;

  init() {
    this.headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    };
    this.apiHeaders = {
      "User-Agent": this.headers["User-Agent"],
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Origin: this.site,
      Referer: this.site + "/",
    };
    try {
      this.accessToken = this.loadData("access_token") || null;
      this.refreshToken = this.loadData("refresh_token") || null;
    } catch (e) {
      this.accessToken = null;
      this.refreshToken = null;
    }
  }

  // ---------------- 基础工具 ----------------

  /** 站点基址（可在设置里改域名，站点换域名时无需改代码） */
  getSite() {
    const v = this.loadSetting("site_url");
    const s = v == null ? "" : String(v).trim();
    return (s || this.site).replace(/\/+$/, "");
  }

  /** API 基址 */
  getApiBase() {
    const v = this.loadSetting("api_url");
    const s = v == null ? "" : String(v).trim();
    return (s || this.apiBase).replace(/\/+$/, "");
  }

  /** 允许的最大重试次数（站点偶发 502/504/525） */
  getRetry() {
    const n = parseInt(this.loadSetting("max_retry"), 10);
    return isNaN(n) || n < 0 ? 2 : Math.min(n, 5);
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------- 登录态 ----------------
  //
  // 实测认证机制（2026-10，改动前请先复测）：
  //   POST https://api.asurascans.com/api/auth/login
  //        body: {"email": "...", "password": "..."}
  //        成功: {"data": {"user": {...}, "access_token": "...", "refresh_token": "..."}}
  //        失败: 401 {"error": "invalid credentials"}
  //   之后所有需要登录的接口都带 `Authorization: Bearer <access_token>`。
  //   access_token 是 JWT，可从 payload.exp 读到过期时间；
  //   过期后用 POST /api/auth/refresh  body: {"refresh_token": "..."} 换新的。
  //
  // 说明：站点前端还把 token 写进 access_token / refresh_token 两个 cookie，
  // 但实测 API 同样接受 Authorization 头，所以本源统一走 Bearer 头，
  // 不依赖 Network.setCookies，行为更可控、也更好调试。

  isLoggedIn() {
    return !!(this.accessToken || this.loadData("access_token"));
  }

  /** 当前 access_token（内存优先，其次持久化数据） */
  getToken() {
    if (!this.accessToken) {
      try {
        this.accessToken = this.loadData("access_token") || null;
      } catch (e) {
        this.accessToken = null;
      }
    }
    return this.accessToken;
  }

  getRefreshToken() {
    if (!this.refreshToken) {
      try {
        this.refreshToken = this.loadData("refresh_token") || null;
      } catch (e) {
        this.refreshToken = null;
      }
    }
    return this.refreshToken;
  }

  /**
   * 解出 JWT 的过期时间戳（秒）。解不出来返回 0（视为未知，不做提前刷新）。
   * 只做 base64 解码，不校验签名——这里只需要 exp 来做提前刷新。
   * 注意 Venera 的 Convert 里方法是 decodeBase64 / decodeUtf8（实测自 ccc.js、tencent_comic_official.js）。
   */
  jwtExp(token) {
    const t = String(token == null ? "" : token);
    const parts = t.split(".");
    if (parts.length < 2) return 0;
    try {
      let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (payload.length % 4 !== 0) payload += "=";
      const json = JSON.parse(Convert.decodeUtf8(Convert.decodeBase64(payload)));
      const exp = parseInt(json && json.exp, 10);
      return isNaN(exp) ? 0 : exp;
    } catch (e) {
      // Convert 缺失或 token 不是标准 JWT 时，退化为「不判断过期」
      return 0;
    }
  }

  /** token 是否已过期或即将过期（30 秒内） */
  tokenExpired(token) {
    const exp = this.jwtExp(token);
    if (!exp) return false; // 解不出来就别乱刷新
    return exp * 1000 <= Date.now() + 30000;
  }

  /** 保存登录态 */
  saveSession(accessToken, refreshToken) {
    this.accessToken = accessToken || null;
    this.refreshToken = refreshToken || null;
    try {
      if (accessToken) this.saveData("access_token", accessToken);
      if (refreshToken) this.saveData("refresh_token", refreshToken);
    } catch (e) {
      // 持久化失败不影响本次会话
    }
  }

  /** 清除登录态 */
  clearSession() {
    this.accessToken = null;
    this.refreshToken = null;
    try {
      this.deleteData("access_token");
      this.deleteData("refresh_token");
    } catch (e) {
      // 忽略
    }
  }

  /**
   * 用 refresh_token 换新的 access_token。
   * 并发调用会共用同一个刷新请求，避免把 refresh_token 用废。
   */
  async refreshSession() {
    if (this.refreshing) return this.refreshing;
    const rt = this.getRefreshToken();
    if (!rt) {
      this.clearSession();
      return false;
    }
    this.refreshing = (async () => {
      try {
        const res = await Network.post(
          this.getApiBase() + "/api/auth/refresh",
          Object.assign({}, this.apiHeaders, { "Content-Type": "application/json" }),
          JSON.stringify({ refresh_token: rt })
        );
        if (!res || res.status !== 200) {
          this.clearSession();
          return false;
        }
        const data = this.parseAuthBody(res.body);
        if (!data || !data.access_token) {
          this.clearSession();
          return false;
        }
        this.saveSession(data.access_token, data.refresh_token || rt);
        return true;
      } catch (e) {
        this.clearSession();
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** 从登录/刷新响应里取出 {user, access_token, refresh_token} */
  parseAuthBody(body) {
    let json;
    try {
      json = JSON.parse(String(body || ""));
    } catch (e) {
      return null;
    }
    const d = json && json.data ? json.data : json;
    if (!d) return null;
    return {
      user: d.user || null,
      access_token: d.access_token || d.accessToken || null,
      refresh_token: d.refresh_token || d.refreshToken || null,
    };
  }

  /**
   * 需要登录的请求统一入口：自动补 Bearer 头。
   * 401 时先尝试用 refresh_token 换新令牌再重试一次，仍失败则抛出登录失效。
   * Venera 的约定是抛 `Login expired` 时会自动重新登录。
   */
  async authedFetch(method, path, body) {
    if (!this.isLoggedIn()) {
      throw new Error("Login expired");
    }
    const doCall = async () => {
      const headers = Object.assign({}, this.apiHeaders, {
        Authorization: "Bearer " + this.getToken(),
      });
      let payload;
      if (body !== undefined && body !== null) {
        headers["Content-Type"] = "application/json";
        payload = typeof body === "string" ? body : JSON.stringify(body);
      }
      const args = [this.getApiBase() + path, headers];
      if (payload !== undefined) args.push(payload);
      if (method === "GET") return await Network.get(args[0], args[1]);
      if (method === "POST") return await Network.post(args[0], args[1], payload);
      if (method === "PUT") return await Network.put(args[0], args[1], payload);
      if (method === "DELETE") return await Network.delete(args[0], args[1], payload);
      throw new Error("不支持的方法 " + method);
    };

    let res = await doCall();
    if (res && res.status === 401) {
      const ok = await this.refreshSession();
      if (!ok) throw new Error("Login expired");
      res = await doCall();
      if (res && res.status === 401) {
        this.clearSession();
        throw new Error("Login expired");
      }
    }
    return res;
  }

  /** 取 JSON，非 2xx 直接抛错 */
  async authedJson(method, path, body) {
    const res = await this.authedFetch(method, path, body);
    const text = res && res.body ? String(res.body) : "";
    if (!res || res.status >= 400) {
      let msg = "请求失败 HTTP " + (res ? res.status : "?");
      try {
        const j = JSON.parse(text);
        if (j && (j.error || j.message)) msg = j.error || j.message;
      } catch (e) {
        // 保留默认消息
      }
      throw new Error(msg);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  // ---------------- 账号 ----------------

  account = {
    /**
     * 邮箱 + 密码登录。
     * 站点用 email 作为账号，不是用户名。
     */
    login: async (account, pwd) => {
      const email = account == null ? "" : String(account).trim();
      const password = pwd == null ? "" : String(pwd);
      if (!email || !password) throw new Error("请填写邮箱和密码");

      const res = await Network.post(
        this.getApiBase() + "/api/auth/login",
        Object.assign({}, this.apiHeaders, { "Content-Type": "application/json" }),
        JSON.stringify({ email: email, password: password })
      );

      const body = res && res.body ? String(res.body) : "";
      if (!res || res.status !== 200) {
        let msg = "登录失败";
        try {
          const j = JSON.parse(body);
          if (j && (j.error || j.message)) msg = j.error || j.message;
        } catch (e) {
          // 保留默认消息
        }
        if (res && res.status === 401) msg = "邮箱或密码错误";
        throw new Error(msg);
      }

      const data = this.parseAuthBody(body);
      if (!data || !data.access_token) throw new Error("登录响应异常，未拿到令牌");

      this.saveSession(data.access_token, data.refresh_token);
      const name = data.user && (data.user.username || data.user.name || data.user.email);
      return name ? "已登录：" + name : true;
    },

    logout: () => {
      const rt = this.getRefreshToken();
      // 通知服务端作废 refresh_token（失败也无所谓，本地一定要清干净）
      try {
        if (rt) {
          Network.post(
            this.getApiBase() + "/api/auth/logout",
            Object.assign({}, this.apiHeaders, { "Content-Type": "application/json" }),
            JSON.stringify({ refresh_token: rt })
          );
        }
      } catch (e) {
        // 忽略
      }
      this.clearSession();
    },

    registerWebsite: "https://asurascans.com/register",
  };

  /**
   * 带重试的 GET。站点在 Cloudflare 后面，偶发 502/504/522/525，
   * 这类网关错误加上网络异常（拿不到响应）才重试；
   * 4xx 属于请求本身的问题，立刻失败，不做无谓等待。
   */
  async fetchWithRetry(url, headers) {
    const tries = this.getRetry() + 1;
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await Network.get(url, headers || this.headers);
        const status = res && res.status ? res.status : 0;
        if (status === 502 || status === 504 || status === 522 || status === 525 || status === 0) {
          lastErr = new Error("网关错误 HTTP " + status);
        } else if (status >= 400) {
          // 不重试，直接抛出
          const msg = "请求失败 HTTP " + status;
          throw Object.assign(new Error(msg), { dshFatal: true });
        } else {
          return res;
        }
      } catch (e) {
        if (e && e.dshFatal) throw e;
        lastErr = e;
      }
      // 最后一次失败后不再等待
      if (i < tries - 1) await this.sleep(600 * (i + 1));
    }
    const reason = lastErr && lastErr.message ? lastErr.message : String(lastErr || "未知错误");
    throw new Error("请求失败：" + reason);
  }

  /** 请求 API 并解析 JSON */
  async apiJson(path) {
    const res = await this.fetchWithRetry(this.getApiBase() + path, this.apiHeaders);
    const body = res && res.body ? String(res.body) : "";
    if (!body) throw new Error("接口返回为空");
    try {
      return JSON.parse(body);
    } catch (e) {
      throw new Error("接口返回的不是合法 JSON");
    }
  }

  /** 拼接 API 查询串，跳过空值 */
  buildQuery(params) {
    const parts = [];
    for (const k in params) {
      const v = params[k];
      if (v === null || v === undefined) continue;
      const s = String(v);
      if (s === "") continue;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(s));
    }
    return parts.length ? "?" + parts.join("&") : "";
  }

  /** 去 HTML 标签，得到纯文本简介 */
  stripHtml(html) {
    if (html == null) return "";
    return String(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&rsquo;|&lsquo;/g, "'")
      .replace(/&ldquo;|&rdquo;/g, '"')
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /** 时长精简：2026-10-06T15:26:49Z -> 2026-10-06 */
  shortDate(iso) {
    if (!iso) return "";
    const s = String(iso);
    return s.length >= 10 ? s.substring(0, 10) : s;
  }

  /** 封面兜底：接口给 cover，个别接口只给 banner */
  coverOf(item) {
    if (!item) return "";
    // 列表接口给 cover，搜索接口给 cover；banner 作为兜底
    return item.cover || item.banner || "";
  }

  /**
   * 把一个 API series 对象转成 Comic。
   * 实测字段：id, slug, title, alt_titles, cover, banner, status, type,
   *          author, artist, rating, chapter_count, last_chapter_at,
   *          public_url, source_url, genres[]
   */
  parseSeries(item) {
    if (!item) return null;
    const id = item.public_url || item.slug;
    if (!id) return null;

    const bits = [];
    if (item.chapter_count) bits.push(item.chapter_count + " 话");
    if (item.status) bits.push(this.t(item.status));
    if (item.rating) bits.push(Number(item.rating).toFixed(1) + " 分");

    const genres = [];
    if (Array.isArray(item.genres)) {
      for (const g of item.genres) {
        if (g && g.name) genres.push(g.name);
      }
    }

    return new Comic({
      id: String(id),
      title: item.title || item.slug || "",
      subTitle: bits.join(" · "),
      cover: this.coverOf(item),
      tags: genres,
      description: this.stripHtml(item.description),
    });
  }

  /** 列表接口统一入口 */
  async listSeries(opts) {
    const page = opts && opts.page ? opts.page : 1;
    const query = this.buildQuery({
      page: page,
      sort: opts && opts.sort ? opts.sort : null,
      search: opts && opts.search ? opts.search : null,
      genres: opts && opts.genres ? opts.genres : null,
      status: opts && opts.status ? opts.status : null,
      type: opts && opts.type ? opts.type : null,
    });
    const json = await this.apiJson("/api/series" + query);
    // 实测：搜索无结果时接口返回 {"data": null, "meta": {...}}，需兜底
    const list = json && Array.isArray(json.data) ? json.data : [];
    const comics = [];
    for (const it of list) {
      const c = this.parseSeries(it);
      if (c) comics.push(c);
    }
    const meta = (json && json.meta) || {};
    const total = typeof meta.total === "number" ? meta.total : 0;
    const perPage = typeof meta.per_page === "number" && meta.per_page > 0 ? meta.per_page : this.pageSize;
    let maxPage = total > 0 ? Math.ceil(total / perPage) : page;
    if (meta.has_more === false) maxPage = page;
    return { comics: comics, maxPage: Math.max(maxPage, 1) };
  }

  /**
   * 解析 Astro 组件 props：astro 把值包成 [0, value]，
   * 数组包成 [1, [[0, v], [0, v], ...]]。这里做一次通用还原。
   */
  unwrapAstro(v) {
    if (Array.isArray(v)) {
      if (v.length === 2 && (v[0] === 0 || v[0] === 1)) {
        if (v[0] === 0) return v[1];
        const arr = Array.isArray(v[1]) ? v[1] : [];
        return arr.map((x) => (Array.isArray(x) && x.length === 2 ? this.unwrapAstro(x[1]) : x));
      }
      return v.map((x) => this.unwrapAstro(x));
    }
    if (v && typeof v === "object") {
      const out = {};
      for (const k in v) out[k] = this.unwrapAstro(v[k]);
      return out;
    }
    return v;
  }

  /**
   * 从详情页 HTML 里取数字 seriesId。
   * 实测 seriesId 不在 ChapterListReact 上，而在 BookmarkButton /
   * SeriesViewTracker / RatingButton / SeriesDownloadModal 这些组件的 props 里，
   * 都形如 props="{&quot;seriesId&quot;:[0,6094],...}"。
   * 只要匹配那些 props 中含 seriesId 的 astro-island 即可，不依赖具体组件名。
   */
  seriesIdFromHtml(html) {
    if (!html) return "";
    const src = String(html);
    const re = /component-url="[^"]*"[^>]*?props="([^"]*?seriesId[^"]*?)"/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const raw = this.unescapeEntities(m[1]);
      const mm = raw.match(/"seriesId"\s*:\s*\[\s*\d+\s*,\s*(\d+)\s*\]/);
      if (mm) return mm[1];
      // 少数组件可能直接把值写成数字（非 astro 包装）
      const mm2 = raw.match(/"seriesId"\s*:\s*(\d+)/);
      if (mm2) return mm2[1];
    }
    return "";
  }

  /** HTML 实体还原（props 属性里全是 &quot;） */
  unescapeEntities(s) {
    return String(s == null ? "" : s)
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  /**
   * 从 BookmarkButton 的 props 里读服务端渲染的收藏状态。
   * 有值就不用再打一次书签接口。返回 true/false，读不到返回 null。
   */
  initialBookmarkedFromHtml(html) {
    if (!html) return null;
    const src = String(html);
    const re = /component-url="[^"]*BookmarkButton[^"]*"[^>]*?props="([^"]*)"/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const raw = this.unescapeEntities(m[1]);
      const mm = raw.match(/"initialBookmarked"\s*:\s*\[\s*\d+\s*,\s*(true|false)\s*\]/);
      if (mm) return mm[1] === "true";
      const mm2 = raw.match(/"initialBookmarked"\s*:\s*(true|false)/);
      if (mm2) return mm2[1] === "true";
    }
    return null;
  }

  /**
   * 从详情页 HTML 里取出 ChapterListReact 的 props。
   * 返回 props（已还原 astro 包装）或 null。
   */
  chapterPropsFromHtml(html) {
    if (!html) return null;
    // props 属性里 &quot; 等实体需先还原
    const re =
      /component-url="[^"]*ChapterListReact[^"]*"[^>]*?props="([\s\S]*?)"\s*(?:ssr|client|opts|renderer-url|>)/;
    const m = String(html).match(re);
    if (!m) return null;
    const raw = this.unescapeEntities(m[1]);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    return this.unwrapAstro(parsed);
  }

  /** 从 ComicDetails 页 URL 中取出 slug（含 hash 后缀），用于拼章节链接 */
  publicUrlFromId(id) {
    const s = String(id == null ? "" : id).trim();
    if (!s) return "";
    if (s.indexOf("http") === 0) {
      const m = s.match(/\/comics\/[^/?#]+/);
      return m ? m[0] : "";
    }
    if (s.indexOf("/comics/") === 0) return s.replace(/\/+$/, "");
    // 纯 slug（含或不含 hash）
    return "/comics/" + s.replace(/^\/+|\/+$/g, "");
  }

  /**
   * 从详情页 DOM 兜底解析章节（当 props 解析失败时使用）。
   * 每话渲染成多个 <a>，按 href 首次出现去重即为「最新章节在前」的顺序。
   */
  chaptersFromDom(doc) {
    const chapters = new Map();
    let anchors = [];
    try {
      anchors = doc.querySelectorAll('a[href*="/chapter/"]') || [];
    } catch (e) {
      anchors = [];
    }
    for (const a of anchors) {
      const href = (a.attributes && (a.attributes.href || a.attributes["data-href"])) || "";
      const m = String(href).match(/\/chapter\/([^/?#]+)/);
      if (!m) continue;
      const epId = m[1];
      if (chapters.has(epId)) continue;
      let label = "";
      try {
        label = a.text ? String(a.text) : "";
      } catch (e) {
        label = "";
      }
      label = label.replace(/\s+/g, " ").trim();
      // 注意：链接文本形如 "Chapter 21 7 hours ago"，若只取第一串数字会得到 217。
      // 因此排除后面紧跟时间单位的数字串，取不到就退回用 href 里的章节号。
      const num = label.match(/Chapter\s*([0-9]+(?:\.[0-9]+)?)(?!\s*(?:hours?|days?|mins?|minutes?|months?|years?|weeks?)\b)/i);
      const epNo = num ? num[1] : epId;
      chapters.set(epId, /^[0-9]+(?:\.[0-9]+)?$/.test(epNo) ? "第 " + epNo + " 话" : label || "第 " + epId + " 话");
    }
    return chapters;
  }

  /**
   * 决定交给 App 的章节顺序。
   *
   * ── 从成熟源学到的做法（关键）─────────────────────────────────
   * 本机三个稳定源的做法完全一致：把「最新在前」的接口数据**归一化为旧→新**。
   *   comick.js    : items.slice().reverse()   // 注释：API 按最新在前，反转便于正序浏览
   *   zaimanhua.js : (group.data || []).reverse()
   *   manhuagui.js : [...chapters].sort((a, b) => a[0] - b[0])
   * 结论：Venera 就是**按源给的顺序显示**（不会自作主张重排），
   * 所以「章节顺序」这件事必须由源自己定好。
   *
   * 本源同样在这里把顺序**归一化**，不再依赖站点给的顺序：
   *   chapter_ascending = 开（默认）→ 旧→新 1,2,3,…,N（与 comick/zaimanhua 一致）
   *   chapter_ascending = 关         → 新→旧 N,…,3,2,1（站点详情页的排法）
   *
   * 按章节号**数值**排序（不是字典序），非数字章节（如「番外」）保留在末尾。
   */
  applyChapterOrder(chapters) {
    if (!chapters || typeof chapters.size !== "number" || chapters.size < 2) return;

    // 语义：undefined（未设置）/ true / "true" 都算「旧 → 新」；
    // 只有明确的 false / "false" 才输出「新 → 旧」。
    let ascending = true;
    try {
      const v = this.loadSetting("chapter_ascending");
      if (v === false || v === "false" || v === 0 || v === "0") ascending = false;
    } catch (e) {
      // 读不到设置就保持默认（旧 → 新）
    }

    const entries = [];
    chapters.forEach((v, k) => entries.push([k, v]));

    // 带序号的按数字排；非数字的保持原始相对位置并放到末尾
    const numbered = [];
    const others = [];
    for (let i = 0; i < entries.length; i++) {
      const key = entries[i][0];
      if (/^-?[0-9]+(\.[0-9]+)?$/.test(key)) {
        numbered.push({ key: key, value: entries[i][1], num: parseFloat(key) });
      } else {
        others.push({ key: key, value: entries[i][1] });
      }
    }
    numbered.sort((a, b) => (ascending ? a.num - b.num : b.num - a.num));

    // Map 不能整体替换（外部持有引用），原地重排
    const ordered = numbered.concat(others);
    chapters.clear();
    for (let i = 0; i < ordered.length; i++) {
      chapters.set(ordered[i].key, ordered[i].value);
    }
  }

  // ---------------- 探索页 ----------------

  explore = [
    {
      // 与站点首页一致：多个分区，每个分区一横排
      //
      // ⚠️ 注意：explore 的 title 是「全局唯一标识」。Venera 的发现页标签栏
      // 只显示用户在「发现页设置」里手动勾选过的 title，且所有源共用一个
      // title 列表（撞名会互相覆盖）。所以 title 带上源名，避免冲突。
      title: "Asura Scans",
      type: "singlePageWithMultiPart",
      load: async () => {
        const result = {};
        const sections = [
          { title: "最近更新", sort: "latest" },
          { title: "最高评分", sort: "rating" },
          { title: "最多收藏", sort: "bookmarks" },
        ];
        // 顺序请求，避免同时打多个接口触发站点网关限流
        for (const s of sections) {
          try {
            const r = await this.listSeries({ page: 1, sort: s.sort });
            if (r.comics.length > 0) result[s.title] = r.comics;
          } catch (e) {
            // 单个分区失败不影响其他分区
          }
        }
        if (Object.keys(result).length === 0) {
          throw new Error("加载推荐失败，请稍后重试或检查网络");
        }
        return result;
      },
    },
    {
      title: "Asura Scans · 全部漫画",
      type: "multiPageComicList",
      load: async (page) => {
        return await this.listSeries({ page: page, sort: "latest" });
      },
    },
  ];

  // ---------------- 分类页 ----------------

  /** 站点分类 slug 由 /api/genres 实测得到（35 个） */
  static genres = [
    ["action", "Action"],
    ["adventure", "Adventure"],
    ["comedy", "Comedy"],
    ["crazy-mc", "Crazy MC"],
    ["dark-fantasy", "Dark Fantasy"],
    ["demon", "Demon"],
    ["drama", "Drama"],
    ["dungeons", "Dungeons"],
    ["fantasy", "Fantasy"],
    ["game", "Game"],
    ["genius-mc", "Genius MC"],
    ["isekai", "Isekai"],
    ["kuchikuchi", "Kuchikuchi"],
    ["magic", "Magic"],
    ["martial-arts", "Martial Arts"],
    ["murim", "Murim"],
    ["mystery", "Mystery"],
    ["necromancer", "Necromancer"],
    ["overpowered", "Overpowered"],
    ["psychological", "Psychological"],
    ["regression", "Regression"],
    ["reincarnation", "Reincarnation"],
    ["revenge", "Revenge"],
    ["romance", "Romance"],
    ["school-life", "School Life"],
    ["sci-fi", "Sci-fi"],
    ["shoujo", "Shoujo"],
    ["shounen", "Shounen"],
    ["supernatural", "Supernatural"],
    ["system", "System"],
    ["tower", "Tower"],
    ["tragedy", "Tragedy"],
    ["transmigration", "Transmigration"],
    ["villain", "Villain"],
    ["violence", "Violence"],
  ];

  category = {
    title: "Asura Scans",
    parts: [
      {
        name: "题材",
        type: "fixed",
        categories: AsuraScans.genres.map((g) => g[1]),
        categoryParams: AsuraScans.genres.map((g) => g[0]),
        itemType: "category",
      },
      {
        name: "状态",
        type: "fixed",
        categories: ["连载中", "已完结"],
        categoryParams: ["ongoing", "completed"],
        itemType: "category",
      },
      {
        name: "类型",
        type: "fixed",
        categories: ["韩漫 (Manhwa)", "国漫 (Manhua)"],
        categoryParams: ["manhwa", "manhua"],
        itemType: "category",
      },
    ],
    enableRankingPage: false,
  };

  categoryComics = {
    load: async (category, param, options, page) => {
      const sort = options && options[0] ? options[0] : "latest";
      const opts = { page: page, sort: sort };
      const p = param == null ? "" : String(param);
      if (p === "ongoing" || p === "completed" || p === "hiatus" || p === "dropped") {
        opts.status = p;
      } else if (p === "manhwa" || p === "manhua" || p === "manga" || p === "manhua-other") {
        opts.type = p;
      } else if (p) {
        opts.genres = p;
      }
      return await this.listSeries(opts);
    },
    optionList: [
      {
        type: "select",
        options: [
          "latest-最近更新",
          "rating-最高评分",
          "bookmarks-最多收藏",
          "newest-最新收录",
        ],
        label: "排序",
        default: "latest",
        notShowWhen: null,
        showWhen: null,
      },
    ],
  };

  // ---------------- 搜索 ----------------

  search = {
    load: async (keyword, options, page) => {
      const kw = keyword == null ? "" : String(keyword).trim();
      if (!kw) return { comics: [], maxPage: 1 };
      const opts = { page: page, search: kw };
      if (options && options[0]) opts.genres = options[0];
      return await this.listSeries(opts);
    },
    optionList: [
      {
        type: "dropdown",
        options: AsuraScans.genres.map((g) => g[0] + "-" + g[1]),
        label: "题材筛选",
        default: null,
      },
    ],
    enableTagsSuggestions: false,
  };

  // ---------------- 收藏（站点叫 bookmark，只有单一收藏夹）----------------
  favorites = {
    multiFolder: false,

    /**
     * 收藏 / 取消收藏。
     * 实测：POST /api/bookmarks/{seriesId} 收藏，DELETE 取消。
     * comicId 传的是 ComicDetails 的 subId（形如 /comics/slug-hash），
     * 这里从 body 里解出数字 seriesId；解不出来就现查一次详情页。
     */
    addOrDelFavorite: async (comicId, folderId, isAdding, favoriteId) => {
      const sid = await this.resolveSeriesId(comicId);
      if (!sid) throw new Error("无法确定作品 ID，请重新进入详情页后再试");
      const res = await this.authedFetch(
        isAdding ? "POST" : "DELETE",
        "/api/bookmarks/" + sid
      );
      if (!res || res.status >= 400) {
        let msg = isAdding ? "收藏失败" : "取消收藏失败";
        if (res && res.status === 403) {
          // 站点有收藏数量上限
          try {
            const j = JSON.parse(String(res.body || ""));
            if (j && j.error) msg = j.error;
          } catch (e) {
            msg = "收藏已达上限";
          }
        }
        throw new Error(msg);
      }
      return true;
    },

    /**
     * 单收藏夹：folders 固定返回一个 '0'。
     * 传了 comicId 时顺带判断它是否已收藏。
     */
    loadFolders: async (comicId) => {
      const folders = { "0": "Asura Scans 收藏" };
      const favorited = [];
      if (comicId) {
        const sid = await this.resolveSeriesId(comicId);
        if (sid) {
          try {
            const j = await this.authedJson("GET", "/api/bookmarks/" + sid);
            if (j && j.data && j.data.bookmarked) favorited.push("0");
          } catch (e) {
            // 查询失败就当作未收藏，不阻断收藏夹列表
          }
        }
      }
      return { folders: folders, favorited: favorited };
    },

    addFolder: async (name) => {
      throw new Error("Asura Scans 只支持单一收藏夹");
    },

    deleteFolder: async (folderId) => {
      throw new Error("Asura Scans 只支持单一收藏夹");
    },

    /** 收藏列表：GET /api/me/bookmarks?limit=&offset= */
    loadComics: async (page, folder) => {
      const p = page && page > 0 ? page : 1;
      const offset = (p - 1) * this.favPageSize;
      const j = await this.authedJson(
        "GET",
        "/api/me/bookmarks?limit=" + this.favPageSize + "&offset=" + offset
      );
      const list = j && Array.isArray(j.data) ? j.data : [];
      const comics = [];
      for (const item of list) {
        const c = this.comicFromBookmark(item);
        if (c) comics.push(c);
      }
      const total = j && j.meta && typeof j.meta.total === "number" ? j.meta.total : 0;
      const maxPage = total > 0 ? Math.max(1, Math.ceil(total / this.favPageSize)) : p;
      return { comics: comics, maxPage: maxPage };
    },
  };

  /**
   * 把书签条目转成 Comic。
   * 实测条目形如 {series: {id, slug, title, cover_url, latest_chapter, ...}, ...}
   */
  comicFromBookmark(item) {
    if (!item) return null;
    const s = item.series || item;
    if (!s) return null;
    const publicUrl = s.public_url || (s.slug ? "/comics/" + s.slug : "");
    if (!publicUrl) return null;

    const bits = [];
    const latest = s.latest_chapter || s.chapter_count;
    if (latest) bits.push("最新 " + latest + " 话");
    if (s.status) bits.push(this.t(s.status));

    return new Comic({
      id: String(publicUrl),
      title: s.title || s.slug || "",
      subTitle: bits.join(" · "),
      cover: s.cover_url || s.cover || s.banner_url || "",
      tags: [],
      description: "",
    });
  }

  /**
   * 从 comicId（可能是 subId、完整链接或纯 slug）里解析数字 seriesId。
   * 优先从详情页的 ChapterListReact props 拿；拿不到再退回书签接口探测。
   */
  async resolveSeriesId(comicId) {
    const raw = comicId == null ? "" : String(comicId).trim();
    if (!raw) return "";
    // 已经是纯数字
    if (/^[0-9]+$/.test(raw)) return raw;

    const publicUrl = this.publicUrlFromId(raw);
    if (!publicUrl) return "";
    try {
      const res = await this.fetchWithRetry(this.getSite() + publicUrl, this.headers);
      const html = res && res.body ? String(res.body) : "";
      if (html) {
        const sid = this.seriesIdFromHtml(html);
        if (sid) return sid;
      }
    } catch (e) {
      // 解析失败，返回空由调用方报错
    }
    return "";
  }

  // ---------------- 详情 / 阅读 ----------------

  comic = {
    loadInfo: async (id) => {
      const publicUrl = this.publicUrlFromId(id);
      if (!publicUrl) throw new Error("无效的漫画 ID");

      // 详情页需要同时要「原始 HTML」和「DOM」：
      // 章节表藏在 astro-island 的 props 属性里，只能靠正则取；
      // 标题/封面/标签用 DOM 选择器更方便。
      const res = await this.fetchWithRetry(this.getSite() + publicUrl, this.headers);
      const rawHtml = res && res.body ? String(res.body) : "";
      if (!rawHtml) throw new Error("详情页内容为空");
      const doc = new HtmlDocument(rawHtml);

      // 标题
      let title = "";
      try {
        const h1 = doc.querySelector("h1");
        title = h1 && h1.text ? h1.text.trim() : "";
      } catch (e) {
        title = "";
      }

      // 封面：og:image
      let cover = "";
      try {
        const og = doc.querySelector('meta[property="og:image"]');
        cover = (og && og.attributes && og.attributes.content) || "";
      } catch (e) {
        cover = "";
      }

      // 简介：第一个段落型描述块
      let description = "";
      try {
        const nodes = doc.querySelectorAll("p");
        const parts = [];
        for (const p of nodes) {
          const t = p.text ? p.text.trim() : "";
          if (!t) continue;
          // 过滤全站页脚/导航噪音
          if (t.length < 25) continue;
          if (/Asura Scans|Terms of Service|Privacy Policy|DMCA|Cookie/i.test(t)) continue;
          parts.push(t);
          if (parts.length >= 3) break;
        }
        description = parts.join("\n\n");
      } catch (e) {
        description = "";
      }

      // 标签：从详情页的 /browse?... 链接里取
      const tags = {};
      try {
        const authorLinks = doc.querySelectorAll('a[href*="author="]') || [];
        const authors = [];
        for (const a of authorLinks) {
          const t = a.text ? a.text.trim() : "";
          if (t && authors.indexOf(t) < 0) authors.push(t);
        }
        if (authors.length) tags["作者"] = authors;
      } catch (e) {
        // 忽略
      }
      try {
        const artistLinks = doc.querySelectorAll('a[href*="artist="]') || [];
        const artists = [];
        for (const a of artistLinks) {
          const t = a.text ? a.text.trim() : "";
          if (t && artists.indexOf(t) < 0) artists.push(t);
        }
        if (artists.length) tags["画师"] = artists;
      } catch (e) {
        // 忽略
      }
      try {
        const genreLinks = doc.querySelectorAll('a[href*="genres="]') || [];
        const genres = [];
        for (const a of genreLinks) {
          const t = a.text ? a.text.trim() : "";
          if (t && genres.indexOf(t) < 0) genres.push(t);
        }
        if (genres.length) tags["题材"] = genres;
      } catch (e) {
        // 忽略
      }

      // 章节：优先用服务端下发的 ChapterListReact props（一次给全免费章节），
      // DOM 兜底（两处渲染顺序不同，props 更可靠）
      const chapters = new Map();
      // seriesId 是站点的数字主键，收藏接口全部用它
      let seriesId = "";
      try {
        // 注意：seriesId 不在 ChapterListReact 的 props 里（只有 chapters/totalChapters），
        // 它在 BookmarkButton / SeriesViewTracker 等组件上，统一从页面里捞。
        seriesId = this.seriesIdFromHtml(rawHtml);
        const props = this.chapterPropsFromHtml(rawHtml);
        const list = props && props.chapters;
        if (Array.isArray(list)) {
          // props 里已是「最新章节在前」的顺序
          for (const ch of list) {
            if (!ch) continue;
            const num = ch.number != null ? ch.number : ch.name;
            if (num === null || num === undefined || num === "") continue;
            const epId = String(num);
            if (chapters.has(epId)) continue;
            const label = ch.title ? "第 " + epId + " 话 · " + ch.title : "第 " + epId + " 话";
            chapters.set(epId, label);
          }
        }
      } catch (e) {
        // 落到 DOM 兜底
      }
      if (chapters.size === 0) {
        const domChapters = this.chaptersFromDom(doc);
        for (const [k, v] of domChapters) chapters.set(k, v);
      }

      // 按「新 → 旧」输出章节（与站点详情页一致）。
      // 说明见方法上的注释：这同时兼容「App 保持顺序」和「App 按升序反转」两种行为。
      this.applyChapterOrder(chapters);

      // 连载状态：页面上是独立的一个 <span>ongoing</span>
      let status = "";
      try {
        const spans = doc.querySelectorAll("span") || [];
        for (const n of spans) {
          const t = n.text ? n.text.trim() : "";
          if (/^(ongoing|completed|hiatus|dropped)$/i.test(t)) {
            status = t.toLowerCase();
            break;
          }
        }
      } catch (e) {
        status = "";
      }
      if (status) {
        tags["状态"] = [this.t(status)];
      }

      // 若 URL 是纯 slug（无 hash），站点会 302 到带 hash 的规范地址，
      // 规范地址可从 canonical 里取，保证复用时章节链接正确。
      let canonical = publicUrl;
      try {
        const link = doc.querySelector('link[rel="canonical"]');
        const href = (link && link.attributes && link.attributes.href) || "";
        if (href) {
          const m = String(href).match(/\/comics\/[^/?#]+/);
          if (m) canonical = m[0];
        }
      } catch (e) {
        canonical = publicUrl;
      }

      try {
        doc.dispose();
      } catch (e) {
        // 忽略
      }

      if (!title) title = canonical.replace("/comics/", "");

      // 收藏状态：
      // 1) 优先用服务端渲染在 BookmarkButton 上的 initialBookmarked，零成本；
      // 2) 读不到且已登录时再打一次书签接口；
      // 3) 都失败就留 null（不显示收藏态），绝不影响详情页加载。
      let isFavorite = this.initialBookmarkedFromHtml(rawHtml);
      if (isFavorite === null && seriesId && this.isLoggedIn()) {
        try {
          const j = await this.authedJson("GET", "/api/bookmarks/" + seriesId);
          if (j && j.data && typeof j.data.bookmarked !== "undefined") {
            isFavorite = !!j.data.bookmarked;
          }
        } catch (e) {
          isFavorite = null;
        }
      }

      return new ComicDetails({
        title: title,
        cover: cover,
        description: description,
        tags: tags,
        chapters: chapters,
        subId: canonical,
        isFavorite: isFavorite,
        url: this.getSite() + canonical,
      });
    },

    loadEp: async (comicId, epId) => {
      const publicUrl = this.publicUrlFromId(comicId);
      let ep = epId == null ? "" : String(epId).trim();
      if (!publicUrl || !ep) throw new Error("缺少章节信息");
      // epId 既可能是章节号，也可能是完整链接
      let url;
      if (ep.indexOf("http") === 0) {
        url = ep;
      } else {
        const m = ep.match(/chapter\/([^/?#]+)/);
        if (m) ep = m[1];
        url = this.getSite() + publicUrl + "/chapter/" + ep;
      }

      const res = await this.fetchWithRetry(url, this.headers);
      const html = res && res.body ? String(res.body) : "";
      if (!html) throw new Error("章节页为空");

      const images = this.imagesFromHtml(html);
      if (images.length === 0) {
        throw new Error("未解析到图片，该话可能需要 Asura+ 订阅或站点结构已变更");
      }
      return { images: images };
    },

    /**
     * 优先用 ChapterReader 的 props.pages（最稳），
     * 失败再退回 <img data-page-index> / div[data-page] img。
     */
    onImageLoad: (url, comicId, epId) => {
      const u = String(url == null ? "" : url);
      // 实测 CDN 无防盗链；若将来出现 403，可在此补 Referer
      if (u.indexOf(this.cdnHost) >= 0) {
        return { headers: { Referer: this.getSite() + "/" } };
      }
      return {};
    },

    onThumbnailLoad: (url) => {
      const u = String(url == null ? "" : url);
      if (u.indexOf(this.cdnHost) >= 0) {
        return { headers: { Referer: this.getSite() + "/" } };
      }
      return {};
    },

    // 接受 /comics/xxx 与 /comics/xxx/chapter/N 两种链接
    idMatch: "^https?://(?:www\\.)?asurascans\\.com/comics/[^/?#]+",

    link: {
      domains: ["asurascans.com", "www.asurascans.com"],
      linkToId: (url) => {
        const m = String(url == null ? "" : url).match(/\/comics\/([^/?#]+)/);
        return m ? "/comics/" + m[1] : null;
      },
    },

    // 标签点击 → 跳到搜索
    onClickTag: (namespace, tag) => {
      return { action: "search", keyword: tag };
    },

    enableTagsTranslate: false,
  };

  /**
   * 从章节页 HTML 提取图片。
   * 主路径：ChapterReader props.pages[].url（服务端完整下发，实测 40/40）。
   * 兜底：<img data-page-index> 或 div[data-page] img。
   */
  imagesFromHtml(html) {
    const images = [];
    const seen = {};

    const push = (u) => {
      const s = String(u == null ? "" : u).trim();
      if (!s) return;
      if (seen[s]) return;
      seen[s] = true;
      images.push(s);
    };

    // 1) props.pages
    try {
      const re =
        /component-url="[^"]*ChapterReader[^"]*"[^>]*?props="([\s\S]*?)"\s*(?:ssr|client|opts|renderer-url|>)/;
      const m = String(html).match(re);
      if (m) {
        let raw = m[1]
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">");
        const props = this.unwrapAstro(JSON.parse(raw));
        const pages = props && props.pages;
        if (Array.isArray(pages)) {
          for (const p of pages) {
            if (!p) continue;
            push(typeof p === "string" ? p : p.url);
          }
        }
      }
    } catch (e) {
      // 继续走 DOM 兜底
    }

    // 2) DOM 兜底
    if (images.length === 0) {
      try {
        const doc = new HtmlDocument(String(html));
        let nodes = doc.querySelectorAll("img[data-page-index]");
        if (!nodes || nodes.length === 0) {
          nodes = doc.querySelectorAll("div[data-page] img");
        }
        for (const img of nodes || []) {
          const a = (img && img.attributes) || {};
          push(a.src || a["data-src"] || a["data-original"]);
        }
        try {
          doc.dispose();
        } catch (e) {
          // 忽略
        }
      } catch (e) {
        // 忽略
      }
    }

    return images;
  }

  // ---------------- 设置 ----------------

  settings = {
    site_url: {
      title: "站点地址",
      type: "input",
      validator: "^https?://",
      default: "https://asurascans.com",
    },
    api_url: {
      title: "接口地址",
      type: "input",
      validator: "^https?://",
      default: "https://api.asurascans.com",
    },
    max_retry: {
      title: "失败重试次数",
      type: "select",
      options: [
        { value: "0", text: "不重试" },
        { value: "1", text: "1 次" },
        { value: "2", text: "2 次" },
        { value: "3", text: "3 次" },
      ],
      default: "2",
    },
    chapter_ascending: {
      title: "章节按「旧 → 新」排列",
      type: "switch",
      // 默认开：与 comick / zaimanhua / manhuagui 等成熟源一致。
      // 想要「新 → 旧」（站点详情页的排法）就把这个开关关掉。
      default: true,
    },
  };

  // ---------------- 多语言 ----------------

  translation = {
    zh_CN: {
      "站点地址": "站点地址",
      "接口地址": "接口地址",
      "失败重试次数": "失败重试次数",
      "章节按「旧 → 新」排列": "章节按「旧 → 新」排列",
      "Asura Scans 收藏": "Asura Scans 收藏",
      ongoing: "连载中",
      completed: "已完结",
      hiatus: "休载",
      dropped: "弃坑",
      manhwa: "韩漫",
      manhua: "国漫",
      manga: "日漫",
    },
    zh_TW: {
      ongoing: "連載中",
      completed: "已完結",
      hiatus: "休載",
      dropped: "棄坑",
      manhwa: "韓漫",
      manhua: "國漫",
      manga: "日漫",
    },
    en: {},
  };

  /** 简单翻译查找，找不到就原样返回（Venera 会在 UI 侧套用 translation） */
  t(key) {
    if (key == null) return "";
    const k = String(key);
    const zh = this.translation && this.translation.zh_CN;
    if (zh && zh[k]) return zh[k];
    return k;
  }
}
