/**
 * 漫舍（api.manshe.top）— Venera 漫画源
 *
 * 包名 com.math.master，App 内显示名「漫舍」，站点 lizimh.com / m2.lizimh.com。
 *
 * ── 实测记录（2026-10，改动前请先复测）────────────────────────────
 * 后端基址：http://api.manshe.top   ← 必须用 http + api 子域，详见注释
 *   ✗ https://app.manshe.top      → /app/api/* 全部 404
 *   ✗ https://api.manshe.top      → TLS 握手失败（TLSV1_ALERT_INTERNAL_ERROR）
 *   ✓ http://api.manshe.top       → 正常
 *
 * 接口（全部免签名、免 Cookie，只需普通 UA）：
 *   GET /app/api/config           → 广告/更新/常规配置，含图片线路定义
 *   GET /app/api/home/data        → 首页分区（热播日漫/精选国漫/精选韩漫）
 *   GET /app/api/rank/list        → 排行榜（日漫/国漫）
 *   GET /app/api/category/list    → 综合列表（固定 15 条）
 *   GET /app/api/search/full?q=   → 搜索，**参数名是 q，不是 keyword**（用 keyword 恒返回空）
 *   GET /app/api/detail/{id}      → 详情 + 完整章节表
 *   GET /app/api/chapter/v3/{cid} → 章节图片
 *
 * 注意几个坑：
 *   1. 未知路由一律返回 200 + {"data":null}，不能靠状态码判断接口是否存在。
 *   2. 搜索固定返回 100 条，page/limit/offset 全部无效，无法真分页。
 *   3. rank/list 固定返回 3 个榜单，id/type 参数无效。
 *   4. 章节 id 是**全局唯一**的，所以 epId 记作 `comicID@chapterID`，
 *      取图时只打一次请求，不必先查详情。
 *   5. 图片是相对路径（如 /3/57/841832/1.jpg），要拼线路域名。
 *
 * 免责声明：本源仅做接口解析，不存储、不转载任何作品内容。
 */

class ManShe extends ComicSource {
  name = "漫舍";
  key = "manshe";
  version = "1.0.3";
  minAppVersion = "1.0.0";
  url = "";

  // ---------------- 站点常量 ----------------
  // 站点页（分享链接用）
  site = "https://lizimh.com";
  // 后端基址（实测只有这个通）
  apiBase = "http://api.manshe.top";

  // 图片线路：实测 1/2/3 号线均返回 200 image/jpeg，内容一致
  // （线路 4/5 走百度/QQ 中转，依赖 r 标志，这里不用，直接取源）
  imgHosts = [
    "https://cdn.lzimg.xyz",
    "https://i.lzimg.xyz",
    "http://img.mechat.fun",
  ];

  init() {
    this.headers = {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 12; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
    };
  }

  // ---------------- 基础工具 ----------------

  getApiBase() {
    const v = this.loadSetting("api_url");
    const s = v == null ? "" : String(v).trim();
    return (s || this.apiBase).replace(/\/+$/, "");
  }

  /** 图片线路序号（1 基），默认 1 */
  getImgHost() {
    const v = parseInt(this.loadSetting("img_line"), 10);
    const idx = isNaN(v) ? 0 : Math.max(0, Math.min(v - 1, this.imgHosts.length - 1));
    return this.imgHosts[idx];
  }

  /** 相对图片路径 → 完整 URL */
  imgUrl(rel) {
    const s = rel == null ? "" : String(rel).trim();
    if (!s) return "";
    if (s.indexOf("http") === 0) return s;
    return this.getImgHost() + (s.charAt(0) === "/" ? s : "/" + s);
  }

  /** 请求接口。注意未知路由也会返回 200，所以还要判 data */
  async apiGet(path) {
    const url = this.getApiBase() + path;
    const res = await Network.get(url, this.headers);
    if (!res || res.status !== 200 || !res.body) {
      throw new Error("接口请求失败: " + (res ? res.status : "无响应"));
    }
    let json;
    try {
      json = JSON.parse(String(res.body));
    } catch (e) {
      throw new Error("接口返回不是合法 JSON");
    }
    if (!json || json.data === null || typeof json.data === "undefined") {
      throw new Error("接口无数据（该路由可能不存在）");
    }
    return json.data;
  }

  /** 从列表条目构造 Comic。列表条目字段见 home/rank/category 的 comic_list */
  parseComic(item) {
    if (!item || item.id === null || typeof item.id === "undefined") return null;
    const bits = [];
    if (item.author) bits.push(String(item.author).split(",")[0]);
    if (item.nums) bits.push(item.nums + " 话");
    if (item.score) bits.push(item.score + " 分");
    const tags = item.tags
      ? String(item.tags).split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    return new Comic({
      id: String(item.id),
      title: item.name || String(item.id),
      subTitle: bits.join(" · "),
      cover: this.imgUrl(item.picY || item.picX || ""),
      tags: tags,
      description: item.content || "",
    });
  }

  parseComicList(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const it of list) {
      const c = this.parseComic(it);
      if (c) out.push(c);
    }
    return out;
  }

  // ---------------- 探索页 ----------------

  explore = [
    {
      // 首页三个分区（热播日漫 / 精选国漫 / 精选韩漫）
      title: "漫舍",
      type: "singlePageWithMultiPart",
      load: async () => {
        const data = await this.apiGet("/app/api/home/data");
        const result = {};
        const segs = data.home_content_list;
        if (Array.isArray(segs)) {
          for (const seg of segs) {
            const title = seg && seg.title ? String(seg.title) : "";
            if (!title) continue;
            const comics = this.parseComicList(seg.comic_list);
            if (comics.length > 0) result[title] = comics;
          }
        }
        if (Object.keys(result).length === 0) throw new Error("首页暂无内容");
        return result;
      },
    },
    {
      // 排行榜：日漫 / 国漫 / 韩漫
      //
      // 「查看更多」跳转到分类页的对应榜单查看完整列表。
      // viewMore 用**字符串格式**（旧版编码，所有 App 版本都支持）：
      //   category:分类名@参数
      // 注意：VeneraX 旧版解析时可能丢 @参数，所以 categoryComics.load
      // 里对「日漫榜/国漫榜/韩漫榜」分类名本身也做了识别（双保险），
      // 即使只传来分类名也能正确加载对应榜单。
      // 不要改成 {page, attributes} 对象格式——那是较新版本才支持的，
      // 旧版 App 解析不了会落到 "Invalid Data"，点击完全无响应。
      title: "漫舍 · 排行榜",
      type: "multiPartPage",
      load: async () => {
        const data = await this.apiGet("/app/api/rank/list");
        const out = [];
        const lists = Array.isArray(data.rank_list) ? data.rank_list : [];
        const names = ["日漫榜", "国漫榜", "韩漫榜"];
        for (let i = 0; i < lists.length; i++) {
          const seg = lists[i];
          const title = seg && seg.name ? String(seg.name) : (names[i] || "榜单");
          const comics = this.parseComicList(seg && seg.comic_list);
          if (comics.length > 0) {
            out.push({
              title: title,
              // 只展示前 8 条作预览，完整榜单走「查看更多」
              comics: comics.slice(0, 8),
              viewMore: "category:" + (names[i] || title) + "@rank:" + (i + 1),
            });
          }
        }
        if (out.length === 0) throw new Error("排行榜暂无数据");
        return out;
      },
    },
    {
      // 综合列表（接口固定 15 条，无法翻页）
      title: "漫舍 · 综合",
      type: "multiPageComicList",
      load: async (page) => {
        if (page > 1) return { comics: [], maxPage: 1 };
        const data = await this.apiGet("/app/api/category/list");
        return { comics: this.parseComicList(data.category_list), maxPage: 1 };
      },
    },
  ];

  // ---------------- 分类页 ----------------

  category = {
    title: "漫舍",
    parts: [
      {
        // 站点把作品分为国漫/日漫/韩漫/美漫/精选推荐
        name: "地区",
        type: "fixed",
        categories: ["全部", "国漫", "日漫", "韩漫", "美漫", "精选推荐"],
        categoryParams: ["0", "1", "2", "3", "4", "5"],
        itemType: "category",
      },
      {
        // 排行榜三个榜单。「查看更多」跳转的目标分类就在这里
        name: "排行榜",
        type: "fixed",
        categories: ["日漫榜", "国漫榜", "韩漫榜"],
        categoryParams: ["rank:1", "rank:2", "rank:3"],
        itemType: "category",
      },
    ],
    enableRankingPage: true,
  };

  categoryComics = {
    /**
     * 说明：这个后端没有提供可筛选、可翻页的分类接口
     * （/app/api/comic/list 等一律返回 data:null）。
     * 所以普通分类退化为「综合列表」：所有分类都返回同一批数据，
     * 真正的筛选请走搜索。这是接口能力所限，不是解析问题。
     *
     * 排行榜命中做**双保险**（VeneraX 旧版解析字符串 viewMore 时不支持
     * `@参数` 后缀，param 可能是 null）：
     *   1. param 形如 "rank:N"（新版解析出 @参数）
     *   2. category 为「日漫榜/国漫榜/韩漫榜」之一（旧版只传了分类名）
     * 两种情况都走 loadRanking，保证「查看更多」不会落到综合列表。
     */
    load: async (category, param, options, page) => {
      const p = param == null ? "" : String(param);
      if (p.indexOf("rank:") === 0) {
        return await this.loadRanking(parseInt(p.substring(5), 10));
      }
      const cat = category == null ? "" : String(category);
      const rankIdx = ["日漫榜", "国漫榜", "韩漫榜"].indexOf(cat);
      if (rankIdx >= 0) {
        return await this.loadRanking(rankIdx + 1);
      }
      if (page > 1) return { comics: [], maxPage: 1 };
      const data = await this.apiGet("/app/api/category/list");
      return { comics: this.parseComicList(data.category_list), maxPage: 1 };
    },
    ranking: {
      // 三个榜单与接口实际一致（原 day/week 与站点对不上、只有 2 项，故修正为 r1/r2/r3）
      options: ["r1-日漫榜", "r2-国漫榜", "r3-韩漫榜"],
      load: async (option, page) => {
        const m = /^r([0-9]+)$/.exec(String(option == null ? "" : option));
        const n = m ? parseInt(m[1], 10) : 1;
        return await this.loadRanking(n);
      },
    },
  };

  /**
   * 取第 n 个榜单（1 基）。rank/list 固定返回 3 个榜单、每个 32 条，
   * 无法翻页，所以 maxPage 恒为 1。
   */
  async loadRanking(n) {
    const idx = isNaN(n) || n < 1 ? 0 : n - 1;
    const data = await this.apiGet("/app/api/rank/list");
    const lists = Array.isArray(data.rank_list) ? data.rank_list : [];
    const seg = lists[idx] || lists[0];
    return { comics: this.parseComicList(seg && seg.comic_list), maxPage: 1 };
  }

  // ---------------- 搜索 ----------------

  search = {
    load: async (keyword, options, page) => {
      const kw = keyword == null ? "" : String(keyword).trim();
      if (!kw) return { comics: [], maxPage: 1 };
      const data = await this.apiGet("/app/api/search/full?q=" + encodeURIComponent(kw));
      const list = data.search_full;
      const comics = this.parseComicList(list);
      // 接口固定返回 100 条且无法翻页：本源自己按 20 条切页，避免一次刷 100 个
      const perPage = 20;
      const maxPage = Math.max(1, Math.ceil(comics.length / perPage));
      const p = page && page > 0 ? page : 1;
      if (p > maxPage) return { comics: [], maxPage: maxPage };
      return {
        comics: comics.slice((p - 1) * perPage, p * perPage),
        maxPage: maxPage,
      };
    },
    optionList: [],
    enableTagsSuggestions: false,
  };

  // ---------------- 详情 / 阅读 ----------------

  comic = {
    loadInfo: async (id) => {
      const cid = this.parseComicId(id);
      if (!cid) throw new Error("无效的漫画 ID");
      const d = await this.apiGet("/app/api/detail/" + cid);

      // 标签
      const tags = {};
      if (d.author) tags["作者"] = String(d.author).split(",").map((s) => s.trim()).filter(Boolean);
      const tagList = d.tags
        ? String(d.tags).split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      if (tagList.length) tags["标签"] = tagList;
      tags["状态"] = [d.isend ? "已完结" : "连载中"];
      if (d.score) tags["评分"] = [String(d.score)];
      const cls = this.className(d["class"]);
      if (cls) tags["地区"] = [cls];

      // 章节：接口已按 order 升序给出（oldest → newest）
      const chapters = new Map();
      const list = Array.isArray(d.chapters) ? d.chapters : [];
      for (const ch of list) {
        if (!ch || ch.id === null || typeof ch.id === "undefined") continue;
        // 全局唯一章节 id；带上漫画 id 便于直接取图
        const epId = cid + "@" + ch.id;
        const name = ch.name ? String(ch.name) : "第 " + (ch.order || "?") + " 话";
        if (chapters.has(epId)) continue;
        chapters.set(epId, name);
      }
      this.applyChapterOrder(chapters, list);

      const desc = d.content || "";
      const alias = d.alias ? "别名：" + d.alias + "\n\n" : "";

      return new ComicDetails({
        title: d.name || String(cid),
        cover: this.imgUrl(d.picY || d.picX || ""),
        description: alias + desc,
        tags: tags,
        chapters: chapters,
        subId: String(cid),
        url: this.site,
      });
    },

    loadEp: async (comicId, epId) => {
      const cid = this.parseComicId(comicId);
      const chId = this.parseChapterId(epId);
      if (!cid || !chId) throw new Error("缺少章节信息");
      const d = await this.apiGet("/app/api/chapter/v3/" + chId);
      const pics = d && d.pics;
      const images = [];
      if (Array.isArray(pics)) {
        for (const p of pics) {
          const u = this.imgUrl(typeof p === "string" ? p : p && p.url);
          if (u) images.push(u);
        }
      }
      if (images.length === 0) {
        throw new Error("未解析到图片（该话可能需要 VIP）");
      }
      return { images: images };
    },

    // 实测图片域名无防盗链，带上 Referer 更保险
    onImageLoad: (url) => {
      const u = String(url == null ? "" : url);
      if (/lzimg\.xyz|mechat\.fun/.test(u)) {
        return { headers: { Referer: this.site + "/" } };
      }
      return {};
    },

    onThumbnailLoad: (url) => {
      const u = String(url == null ? "" : url);
      if (/lzimg\.xyz|mechat\.fun/.test(u)) {
        return { headers: { Referer: this.site + "/" } };
      }
      return {};
    },

    idMatch: "^[0-9]{1,12}$",

    link: {
      domains: ["lizimh.com", "m2.lizimh.com", "manshe.top"],
      linkToId: (url) => {
        const m = String(url == null ? "" : url).match(/(?:detail|comic)\/([0-9]{1,12})/);
        if (m) return m[1];
        const q = String(url).match(/[?&]id=([0-9]{1,12})/);
        return q ? q[1] : null;
      },
    },

    enableTagsTranslate: false,
  };

  /** 地区 id → 名称（配置里的 cfg_comic_class） */
  className(id) {
    const map = { "1": "国漫", "2": "日漫", "3": "韩漫", "4": "美漫", "5": "精选推荐" };
    return map[String(id)] || "";
  }

  /** comicId 兼容：纯数字 / "cid@..." 形式 */
  parseComicId(id) {
    const s = String(id == null ? "" : id).trim();
    if (!s) return "";
    const m = s.match(/^([0-9]{1,12})/);
    return m ? m[1] : "";
  }

  /** epId 形态为 "comicID@chapterID"；也兼容纯 chapterID */
  parseChapterId(epId) {
    const s = String(epId == null ? "" : epId).trim();
    if (!s) return "";
    const parts = s.split("@");
    const last = parts[parts.length - 1];
    const m = last.match(/^([0-9]{1,12})$/);
    return m ? m[1] : "";
  }

  /**
   * 章节顺序：站点接口按 order **升序**给出（1 → 34，oldest → newest）。
   *
   * 这里保持升序输出，和 comick / zaimanhua / manhuagui 三个成熟源一致 ——
   * Venera 是按源给的顺序显示的（comick 源码注释：「API 按最新在前，反转便于正序浏览」），
   * 所以想要什么顺序就得在源里定好。
   * 开关关掉可改成「新 → 旧」。
   */
  applyChapterOrder(chapters, rawList) {
    if (!chapters || typeof chapters.size !== "number" || chapters.size < 2) return;
    let ascending = true;
    try {
      const v = this.loadSetting("chapter_ascending");
      if (v === false || v === "false" || v === 0 || v === "0") ascending = false;
    } catch (e) {
      // 读不到就用默认（升序）
    }
    if (ascending) return; // 接口本来就是升序，无需重排

    // 接口是升序，要降序就整体反转（保持 Map 引用不变）
    const entries = [];
    chapters.forEach((v, k) => entries.push([k, v]));
    chapters.clear();
    for (let i = entries.length - 1; i >= 0; i--) {
      chapters.set(entries[i][0], entries[i][1]);
    }
  }

  // ---------------- 设置 ----------------

  settings = {
    api_url: {
      title: "接口地址",
      type: "input",
      validator: "^https?://",
      default: "http://api.manshe.top",
    },
    img_line: {
      title: "图片线路",
      type: "select",
      options: [
        { value: "1", text: "线路1 cdn.lzimg.xyz" },
        { value: "2", text: "线路2 i.lzimg.xyz" },
        { value: "3", text: "线路3 img.mechat.fun" },
      ],
      default: "1",
    },
    chapter_ascending: {
      title: "章节按「旧 → 新」排列",
      type: "switch",
      default: true,
    },
  };

  // ---------------- 多语言 ----------------

  translation = {
    zh_CN: {
      "接口地址": "接口地址",
      "图片线路": "图片线路",
      "章节按「旧 → 新」排列": "章节按「旧 → 新」排列",
      "已完结": "已完结",
      "连载中": "连载中",
      "国漫": "国漫",
      "日漫": "日漫",
      "韩漫": "韩漫",
      "美漫": "美漫",
      "精选推荐": "精选推荐",
    },
    zh_TW: {
      "已完结": "已完結",
      "连载中": "連載中",
    },
    en: {},
  };

  t(key) {
    if (key == null) return "";
    const k = String(key);
    const zh = this.translation && this.translation.zh_CN;
    if (zh && zh[k]) return zh[k];
    return k;
  }
}
