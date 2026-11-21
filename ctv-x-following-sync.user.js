// ==UserScript==
// @name         CTV News TV — Sync @alexkillby X Following List
// @namespace    https://github.com/alexkillby/ctv-x-feeds
// @version      1.2.3
// @description  Syncs @alexkillby's followed X accounts and long-form videos (5m+, last 30 days) automatically once per day to GitHub for CTV News Android TV.
// @author       Alex Killby
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.github.com
// @downloadURL  https://github.com/alexkillby/ctv-x-feeds/raw/main/ctv-x-following-sync.user.js
// @updateURL    https://github.com/alexkillby/ctv-x-feeds/raw/main/ctv-x-following-sync.user.js
// ==/UserScript==

(function () {
  'use strict';

  const TARGET_USERNAME = 'alexkillby';
  const GITHUB_OWNER = 'alexkillby';
  const GITHUB_REPO = 'ctv-x-feeds';
  const GITHUB_FILE_PATH = 'x-following.json';
  const GITHUB_VIDEOS_FILE_PATH = 'x-videos.json';
  const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // Once every 24 hours
  const AUTO_CHECK_MS = 30 * 60 * 1000;          // Re-check every 30 min on long-lived tabs
  const SYNC_LOCK_MS = 3 * 60 * 1000;
  const MIN_LONG_FORM_VIDEO_MS = 5 * 60 * 1000;  // 5 minutes threshold
  const VIDEO_WINDOW_DAYS = 30;
  const VIDEO_WINDOW_MS = VIDEO_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const MSG_SOURCE = 'ctv-x-following-sync';

  // X's public web client bearer token + 2026 x-web persisted followingQuery ID
  const X_WEB_BEARER =
    'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const DEFAULT_FOLLOWING_QUERY_ID = 'ouGZAdSKJFzWYnUkMUBSog';

  // Optional baked-in Fine-Grained GitHub PAT (use private Google Drive copy so GitHub Secret Scanning never revokes it)
  const BAKED_GITHUB_PAT = '';

  const STORAGE_KEYS = {
    GITHUB_PAT: 'ctv_github_pat',
    LAST_SYNC_MS: 'ctv_last_sync_ms',
    LAST_SYNC_STATUS: 'ctv_last_sync_status',
    SYNC_LOCK_UNTIL: 'ctv_sync_lock_until',
    MIN_FOLLOWERS: 'ctv_min_followers',
    PINNED_HANDLES: 'ctv_pinned_handles',
    CACHED_QUERY_ID: 'ctv_following_query_id',
    CACHED_SEARCH_QUERY_ID: 'ctv_search_query_id'
  };

  function getGithubToken() {
    return (GM_getValue(STORAGE_KEYS.GITHUB_PAT, '') || '').trim() || BAKED_GITHUB_PAT.trim();
  }

  const DEFAULT_PINNED = [
    { handle: 'SpaceX', name: 'SpaceX', subtitle: 'Live Launch Coverage • X (@SpaceX)' },
    { handle: 'TWiT', name: 'TWiT', subtitle: 'Live Broadcast • X (@TWiT)' }
  ];

  const RESERVED_PATHS = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'settings',
    'search', 'compose', 'intent', 'tos', 'privacy', 'jobs', 'lists',
    'communities', 'bookmarks', 'premium', 'grok', 'logout', 'login', 'signup'
  ]);

  // ============================================================================
  // SHARED ACCOUNT & GRAPHQL / SSR PARSERS (Supports 2026 x-web + Legacy Schemas)
  // ============================================================================
  function recordAccountIntoMap(collected, raw) {
    if (!raw || !raw.handle) return;
    const cleanHandle = String(raw.handle).replace(/^@+/, '').trim();
    if (!cleanHandle || !/^[A-Za-z0-9_]{1,15}$/.test(cleanHandle)) return;
    const lower = cleanHandle.toLowerCase();
    if (lower === TARGET_USERNAME.toLowerCase() || RESERVED_PATHS.has(lower)) return;
    if (raw.protected === true) return; // Protected accounts cannot be probed unauthenticated by TV

    const existing = collected.get(lower);
    const incomingFollowers =
      typeof raw.followers_count === 'number' ? raw.followers_count : (existing?.followers_count || 0);
    const incomingStatuses =
      typeof raw.statuses_count === 'number' ? raw.statuses_count : (existing?.statuses_count ?? -1);

    if (!existing || incomingFollowers >= (existing.followers_count || 0)) {
      collected.set(lower, {
        handle: cleanHandle,
        name: (raw.name && String(raw.name).trim()) || existing?.name || cleanHandle,
        followers_count: Math.max(incomingFollowers, existing?.followers_count || 0),
        statuses_count: incomingStatuses,
        verified: Boolean(raw.verified || existing?.verified)
      });
    }
  }

  function parseTimelinePayload(rootNode, collected) {
    let bottomCursor = null;
    let reachedEnd = false;

    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }

      // Detect bottom cursor across 2026 x-web (`cursor_type`) and legacy (`cursorType`)
      const cType = node.cursor_type || node.cursorType;
      if (cType === 'Bottom' && typeof node.value === 'string') {
        bottomCursor = node.value;
        if (node.value.startsWith('0|')) {
          reachedEnd = true;
        }
      }

      // Extract User across 2026 x-web (`core` + `relationship_counts`), legacy GraphQL, and v1.1 REST
      const handle = node.core?.screen_name || node.legacy?.screen_name || node.screen_name;
      const isUserObject =
        handle &&
        (node.__typename === 'User' ||
          node.core?.screen_name ||
          node.legacy?.screen_name ||
          typeof node.followers_count === 'number');

      if (isUserObject) {
        const name = node.core?.name || node.legacy?.name || node.name || handle;
        const isProtected = Boolean(
          node.privacy?.protected ?? node.legacy?.protected ?? node.protected ?? false
        );
        const followersCount =
          node.relationship_counts?.followers ??
          node.legacy?.followers_count ??
          node.followers_count ??
          0;
        const statusesCount =
          node.tweet_counts?.tweets ??
          node.legacy?.statuses_count ??
          node.statuses_count ??
          -1;
        const verified = Boolean(
          node.verification?.is_blue_verified ||
            node.verification?.verified_type ||
            node.is_blue_verified ||
            node.legacy?.verified ||
            node.verified
        );

        recordAccountIntoMap(collected, {
          handle,
          name,
          protected: isProtected,
          followers_count: followersCount,
          statuses_count: statusesCount,
          verified
        });
      }

      for (const key of Object.keys(node)) {
        walk(node[key]);
      }
    }

    walk(rootNode);
    return { bottomCursor, reachedEnd };
  }

  // Extract dehydrated Relay JSON payloads embedded inside 2026 x-web TanStack Router SSR HTML
  function parseSsrHtmlFollowingData(htmlText, collected) {
    let bottomCursor = null;
    let reachedEnd = false;
    if (!htmlText) return { bottomCursor, reachedEnd };

    // Match `value:"{\"data\":...}"` string literals inside inline SSR `$R` scripts
    const valueRegex = /value:("(?:\\.|[^"\\])*")/g;
    let match;
    while ((match = valueRegex.exec(htmlText)) !== null) {
      try {
        const jsonStr = JSON.parse(match[1]);
        if (!jsonStr || !jsonStr.includes('following_timeline')) continue;
        const parsed = JSON.parse(jsonStr);
        const timeline =
          parsed?.data?.user_result_by_screen_name?.result?.following_timeline ||
          parsed?.user_result_by_screen_name?.result?.following_timeline;
        if (timeline) {
          const res = parseTimelinePayload(timeline, collected);
          if (res.bottomCursor) bottomCursor = res.bottomCursor;
          if (res.reachedEnd) reachedEnd = true;
        }
      } catch (_) {}
    }
    return { bottomCursor, reachedEnd };
  }

  // Scan rendered 2026 x-web Tailwind user rows + legacy [data-testid="UserCell"] inside <main>
  function scanModernDomUsers(doc, collected) {
    const mainEl = doc.querySelector('main') || doc.body;
    if (!mainEl) return;

    // 1. Legacy selector (if present)
    const legacyCells = mainEl.querySelectorAll('[data-testid="UserCell"]');
    for (const cell of legacyCells) {
      if (cell.closest('aside, [aria-label*="Who to follow" i]')) continue;
      const a = cell.querySelector('a[href^="/"]');
      const hrefMatch = (a?.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
      if (hrefMatch) {
        const handle = hrefMatch[1];
        const name = cell.querySelector('span')?.textContent?.trim() || handle;
        recordAccountIntoMap(collected, { handle, name });
      }
    }

    // 2. 2026 x-web Tailwind user list rows: profile links inside <main> paired with @handle text
    const links = mainEl.querySelectorAll('a[href^="/"]');
    for (const a of links) {
      if (a.closest('aside, nav, [role="tablist"], [aria-label*="Who to follow" i]')) continue;
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
      if (!m) continue;
      const handle = m[1];
      if (RESERVED_PATHS.has(handle.toLowerCase())) continue;

      const text = (a.textContent || '').trim();
      const atMention = `@${handle}`.toLowerCase();
      if (text.toLowerCase().includes(atMention)) {
        // Stacked x-web user link contains DisplayName followed by @handle
        const idx = text.toLowerCase().indexOf(atMention);
        const displayName = idx > 0 ? text.slice(0, idx).trim() : handle;
        recordAccountIntoMap(collected, {
          handle,
          name: displayName || handle
        });
      }
    }
  }

  // ============================================================================
  // IFRAME FALLBACK WORKER MODE (?ctv_sync=1)
  // ============================================================================
  const isSyncIframe = window.self !== window.top && location.search.includes('ctv_sync=1');
  if (isSyncIframe) {
    const collected = new Map();

    const startIframeHarvest = () => {
      // Parse initial SSR scripts already present in document
      parseSsrHtmlFollowingData(document.documentElement?.innerHTML || '', collected);
      scanModernDomUsers(document, collected);

      let idleTicks = 0;
      let lastSize = collected.size;
      let ticks = 0;
      const MAX_TICKS = 65;

      const timer = setInterval(() => {
        ticks++;
        scanModernDomUsers(document, collected);
        window.scrollBy(0, 1100);
        if (document.scrollingElement) {
          document.scrollingElement.scrollTop += 1100;
        }

        if (collected.size === lastSize) {
          idleTicks++;
        } else {
          lastSize = collected.size;
          idleTicks = 0;
        }

        if ((collected.size > 0 && idleTicks >= 7) || idleTicks >= 11 || ticks >= MAX_TICKS) {
          clearInterval(timer);
          scanModernDomUsers(document, collected);
          window.parent.postMessage(
            {
              source: MSG_SOURCE,
              type: 'FOLLOWING_HARVEST_COMPLETE',
              accounts: Array.from(collected.values())
            },
            location.origin
          );
        }
      }, 1000);
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(startIframeHarvest, 3000);
    } else {
      window.addEventListener('DOMContentLoaded', () => setTimeout(startIframeHarvest, 3000), { once: true });
    }
    return;
  }

  // ============================================================================
  // VIDEO SEARCH IFRAME WORKER MODE (?ctv_video_sync=1)
  // Intercepts X's own live 2026 Search GraphQL responses as the iframe scrolls
  // ============================================================================
  const isVideoSyncIframe = window.self !== window.top && location.search.includes('ctv_video_sync=1');
  if (isVideoSyncIframe) {
    const cutoffMs = Date.now() - VIDEO_WINDOW_MS;
    const collectedVideos = new Map();
    let apiResponsesSeen = 0;
    let oldestSeenMs = Infinity;
    let lastActivityTick = 0;

    const handleApiJson = (json) => {
      if (!json || typeof json !== 'object') return;
      apiResponsesSeen++;
      const res = extractLongFormVideosFromPayload(json, null, collectedVideos, cutoffMs);
      if (res.oldestSeenMs < oldestSeenMs) {
        oldestSeenMs = res.oldestSeenMs;
      }
    };

    // Hook page-world fetch & XHR at document-start (CSP-safe via unsafeWindow)
    const targetWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    try {
      const origFetch = targetWin.fetch;
      if (typeof origFetch === 'function') {
        targetWin.fetch = function (...args) {
          const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
          const p = origFetch.apply(this, args);
          if (reqUrl.includes('/i/api/graphql/') || reqUrl.includes('/i/api/2/search/')) {
            p.then((resp) => {
              if (resp && resp.ok) {
                resp
                  .clone()
                  .json()
                  .then(handleApiJson)
                  .catch(() => {});
              }
            }).catch(() => {});
          }
          return p;
        };
      }
    } catch (_) {}

    try {
      const OrigXHR = targetWin.XMLHttpRequest;
      if (OrigXHR && OrigXHR.prototype) {
        const origOpen = OrigXHR.prototype.open;
        const origSend = OrigXHR.prototype.send;
        OrigXHR.prototype.open = function (method, url, ...rest) {
          this.__ctvUrl = String(url || '');
          return origOpen.call(this, method, url, ...rest);
        };
        OrigXHR.prototype.send = function (...args) {
          if (this.__ctvUrl && (this.__ctvUrl.includes('/i/api/graphql/') || this.__ctvUrl.includes('/i/api/2/search/'))) {
            this.addEventListener('load', () => {
              try {
                if (this.status >= 200 && this.status < 300 && this.responseText) {
                  handleApiJson(JSON.parse(this.responseText));
                }
              } catch (_) {}
            });
          }
          return origSend.apply(this, args);
        };
      }
    } catch (_) {}

    const startVideoScroll = () => {
      parseSsrHtmlVideos(document.documentElement?.innerHTML || '', null, collectedVideos, cutoffMs);
      let ticks = 0;
      let lastResponseCount = apiResponsesSeen;
      let lastVideoCount = collectedVideos.size;
      const MAX_TICKS = 35;

      const timer = setInterval(() => {
        ticks++;
        window.scrollBy(0, 1800);
        if (document.scrollingElement) {
          document.scrollingElement.scrollTop += 1800;
        }

        if (apiResponsesSeen !== lastResponseCount || collectedVideos.size !== lastVideoCount) {
          lastResponseCount = apiResponsesSeen;
          lastVideoCount = collectedVideos.size;
          lastActivityTick = ticks;
        }

        const idleTicks = ticks - lastActivityTick;
        const reachedCutoff = oldestSeenMs < cutoffMs && ticks >= 4;
        if (reachedCutoff || (apiResponsesSeen > 0 && idleTicks >= 6) || idleTicks >= 10 || ticks >= MAX_TICKS) {
          clearInterval(timer);
          window.parent.postMessage(
            {
              source: MSG_SOURCE,
              type: 'VIDEO_HARVEST_COMPLETE',
              videos: Array.from(collectedVideos.values())
            },
            location.origin
          );
        }
      }, 1200);
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(startVideoScroll, 3000);
    } else {
      window.addEventListener('DOMContentLoaded', () => setTimeout(startVideoScroll, 3000), { once: true });
    }
    return;
  }

  if (window.self !== window.top) return;

  // ============================================================================
  // TOP WINDOW: UI BANNER, TOKEN MODAL, DIRECT API HARVESTERS & DAILY SCHEDULER
  // ============================================================================
  let activeBannerEl = null;
  let bannerHideTimer = null;

  function showBanner(msg, { isError = false, durationMs = 7500 } = {}) {
    const render = () => {
      if (bannerHideTimer) {
        clearTimeout(bannerHideTimer);
        bannerHideTimer = null;
      }
      if (!activeBannerEl || !activeBannerEl.isConnected) {
        activeBannerEl = document.createElement('div');
        document.body.appendChild(activeBannerEl);
      }
      activeBannerEl.textContent = `📺 CTV X Sync: ${msg}`;
      Object.assign(activeBannerEl.style, {
        position: 'fixed',
        top: '16px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: '2147483647',
        padding: '10px 18px',
        borderRadius: '999px',
        background: isError ? '#7f1d1d' : '#0f172a',
        color: '#f8fafc',
        border: `1.5px solid ${isError ? '#f87171' : '#38bdf8'}`,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '13.5px',
        fontWeight: '600',
        boxShadow: '0 10px 28px rgba(0,0,0,0.55)',
        opacity: '1',
        pointerEvents: 'none',
        transition: 'opacity 0.3s ease',
        maxWidth: '90vw',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      });

      if (durationMs > 0) {
        bannerHideTimer = setTimeout(() => {
          if (activeBannerEl) {
            activeBannerEl.style.opacity = '0';
            setTimeout(() => {
              activeBannerEl?.remove();
              activeBannerEl = null;
            }, 350);
          }
        }, durationMs);
      }
    };

    if (document.body) render();
    else document.addEventListener('DOMContentLoaded', render, { once: true });
  }

  function getCsrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function buildXAuthHeaders(ct0) {
    return {
      authorization: X_WEB_BEARER,
      'x-csrf-token': ct0,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      accept: 'application/json'
    };
  }

  async function discoverFollowingQueryId() {
    const cached = GM_getValue(STORAGE_KEYS.CACHED_QUERY_ID, '');
    try {
      const htmlResp = await fetch(`${location.origin}/${TARGET_USERNAME}/following`, {
        credentials: 'include',
        headers: { accept: 'text/html' }
      });
      if (htmlResp.ok) {
        const html = await htmlResp.text();
        // Check SSR query key if present
        const ssrMatch = html.match(/key:"([A-Za-z0-9_-]{18,30})\{[^"]*screenName\\?":\\?"alexkillby/i);
        if (ssrMatch && ssrMatch[1] !== 'nmw74gYGNm3howcAcWyswA' && ssrMatch[1] !== 'mmbsPcfJHQll75bMpNZ9_w') {
          GM_setValue(STORAGE_KEYS.CACHED_QUERY_ID, ssrMatch[1]);
          return { queryId: ssrMatch[1], ssrHtml: html };
        }
      }
    } catch (_) {}
    return { queryId: cached || DEFAULT_FOLLOWING_QUERY_ID, ssrHtml: null };
  }

  // Strategy 1: Direct 2026 x-web Relay `followingQuery` pagination (~1 second, zero iframes)
  async function harvestViaRelayGraphql(collected) {
    const ct0 = getCsrfToken();
    if (!ct0) return false;

    let queryId = GM_getValue(STORAGE_KEYS.CACHED_QUERY_ID, '') || DEFAULT_FOLLOWING_QUERY_ID;
    let cursor = null;

    for (let page = 0; page < 40; page++) {
      const variables = {
        __relay_internal__pv__liveeventpostcontextenabledrelayprovider: true,
        __relay_internal__pv__postctafetchenabledrelayprovider: true,
        __relay_internal__pv__replydownvoteenabledrelayprovider: false,
        __relay_internal__pv__sportspostcontextenabledrelayprovider: true,
        __relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider: true,
        __relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider: true,
        __relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider: true,
        __relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider: true,
        count: 50,
        cursor,
        screenName: TARGET_USERNAME
      };

      const url = `${location.origin}/i/api/graphql/${queryId}/followingQuery?variables=${encodeURIComponent(
        JSON.stringify(variables)
      )}`;

      let resp = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: buildXAuthHeaders(ct0)
      });

      // If X rotated the persisted queryId, auto-discover the new ID once
      if ((resp.status === 400 || resp.status === 404) && page === 0) {
        const discovered = await discoverFollowingQueryId();
        if (discovered.ssrHtml) {
          parseSsrHtmlFollowingData(discovered.ssrHtml, collected);
        }
        if (discovered.queryId && discovered.queryId !== queryId) {
          queryId = discovered.queryId;
          const retryUrl = `${location.origin}/i/api/graphql/${queryId}/followingQuery?variables=${encodeURIComponent(
            JSON.stringify(variables)
          )}`;
          resp = await fetch(retryUrl, {
            method: 'GET',
            credentials: 'include',
            headers: buildXAuthHeaders(ct0)
          });
        }
      }

      if (!resp.ok) break;
      const json = await resp.json();
      const timeline =
        json?.data?.user_result_by_screen_name?.result?.following_timeline || json;

      const beforeSize = collected.size;
      const { bottomCursor, reachedEnd } = parseTimelinePayload(timeline, collected);

      if (reachedEnd || !bottomCursor || bottomCursor === cursor) break;
      if (page > 0 && collected.size === beforeSize) break;
      cursor = bottomCursor;
    }

    return collected.size > 0;
  }

  // Strategy 2: Direct REST v1.1 `friends/list.json` pagination (200 accounts per request)
  async function harvestViaRestV1(collected) {
    const ct0 = getCsrfToken();
    if (!ct0) return false;

    let cursor = '-1';
    for (let page = 0; page < 20; page++) {
      const url =
        `${location.origin}/i/api/1.1/friends/list.json` +
        `?screen_name=${encodeURIComponent(TARGET_USERNAME)}` +
        `&count=200&skip_status=true&include_user_entities=false&cursor=${encodeURIComponent(cursor)}`;

      const resp = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: buildXAuthHeaders(ct0)
      });
      if (!resp.ok) break;

      const json = await resp.json();
      if (Array.isArray(json?.users)) {
        parseTimelinePayload(json.users, collected);
      }

      const nextCursor = json?.next_cursor_str;
      if (!nextCursor || nextCursor === '0' || nextCursor === cursor) break;
      cursor = nextCursor;
    }

    return collected.size > 0;
  }

  // Strategy 3: SSR HTML Fetch + In-Viewport 2026 x-web Live Iframe Scroller Fallback
  async function harvestViaSsrAndIframe(collected) {
    let ssrComplete = false;
    try {
      const resp = await fetch(`${location.origin}/${TARGET_USERNAME}/following`, {
        credentials: 'include',
        headers: { accept: 'text/html' }
      });
      if (resp.ok) {
        const html = await resp.text();
        const { bottomCursor, reachedEnd } = parseSsrHtmlFollowingData(html, collected);
        if (collected.size > 0 && (reachedEnd || !bottomCursor)) {
          ssrComplete = true;
        }
      }
    } catch (_) {}

    if (ssrComplete) return true;

    // If user is ALREADY viewing /alexkillby/following right now, scan current DOM too
    if (location.pathname.toLowerCase().startsWith(`/${TARGET_USERNAME.toLowerCase()}/following`)) {
      parseSsrHtmlFollowingData(document.documentElement?.innerHTML || '', collected);
      scanModernDomUsers(document, collected);
    }

    // Spawn an in-viewport near-transparent iframe so IntersectionObserver & virtual list scroll properly
    await new Promise((resolve) => {
      const attach = () => {
        const iframe = document.createElement('iframe');
        iframe.src = `${location.origin}/${TARGET_USERNAME}/following?ctv_sync=1`;
        Object.assign(iframe.style, {
          position: 'fixed',
          width: '380px',
          height: '520px',
          right: '0px',
          bottom: '0px',
          opacity: '0.01',
          pointerEvents: 'none',
          zIndex: '-1',
          border: 'none'
        });

        const cleanup = () => {
          window.removeEventListener('message', onMsg);
          clearTimeout(safetyTimer);
          iframe.remove();
          resolve();
        };

        const onMsg = (event) => {
          if (event.origin !== location.origin) return;
          const data = event.data;
          if (!data || data.source !== MSG_SOURCE || data.type !== 'FOLLOWING_HARVEST_COMPLETE') return;
          if (Array.isArray(data.accounts)) {
            for (const acc of data.accounts) {
              recordAccountIntoMap(collected, acc);
            }
          }
          cleanup();
        };

        const safetyTimer = setTimeout(cleanup, 75000);
        window.addEventListener('message', onMsg);
        document.body.appendChild(iframe);
      };

      if (document.body) attach();
      else document.addEventListener('DOMContentLoaded', attach, { once: true });
    });

    return collected.size > 0;
  }

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function githubRequest(method, url, token, bodyObj = null) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        data: bodyObj ? JSON.stringify(bodyObj) : undefined,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              resolve(res.responseText ? JSON.parse(res.responseText) : {});
            } catch (_) {
              resolve({});
            }
          } else {
            const err = new Error(`GitHub HTTP ${res.status}: ${(res.responseText || '').slice(0, 160)}`);
            err.status = res.status;
            reject(err);
          }
        },
        onerror: () => reject(new Error('Network error contacting api.github.com'))
      });
    });
  }

  async function githubPutFileWithRetry(filePath, commitMessage, contentStr, token, maxAttempts = 4) {
    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
    const encodedContent = utf8ToBase64(contentStr);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let existingSha = undefined;
      try {
        // Cache-bust GET so browser/CDN never hands back a stale SHA
        const existing = await githubRequest('GET', `${apiUrl}?_=${Date.now()}`, token);
        existingSha = existing?.sha;
      } catch (err) {
        if (err.status !== 404 && !String(err.message).includes('404')) throw err;
      }

      try {
        await githubRequest('PUT', apiUrl, token, {
          message: commitMessage,
          content: encodedContent,
          ...(existingSha ? { sha: existingSha } : {})
        });
        return;
      } catch (err) {
        const isConflict = err.status === 409 || String(err.message).includes('HTTP 409');
        if (isConflict && attempt < maxAttempts) {
          const backoffMs = 450 * attempt + Math.floor(Math.random() * 400);
          console.warn(`[CTV X Sync] HTTP 409 SHA conflict on ${filePath} (attempt ${attempt}/${maxAttempts}); retrying in ${backoffMs}ms...`);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        throw err;
      }
    }
  }

  async function uploadAccountsToGitHub(rawAccounts) {
    const token = getGithubToken();
    if (!token) throw new Error('Missing GitHub token');

    const minFollowers = Number(GM_getValue(STORAGE_KEYS.MIN_FOLLOWERS, 0)) || 0;
    const customPinnedStr = GM_getValue(STORAGE_KEYS.PINNED_HANDLES, 'SpaceX,TWiT');
    const pinnedSet = new Set(
      String(customPinnedStr)
        .split(',')
        .map((s) => s.trim().replace(/^@/, '').toLowerCase())
        .filter(Boolean)
    );

    const byHandle = new Map();

    // Seed pinned defaults so custom subtitles are preserved
    for (const p of DEFAULT_PINNED) {
      if (pinnedSet.has(p.handle.toLowerCase())) {
        byHandle.set(p.handle.toLowerCase(), {
          handle: p.handle,
          name: p.name,
          followers_count: 0,
          verified: true,
          subtitle: p.subtitle
        });
      }
    }

    for (const acc of rawAccounts) {
      if (!acc || !acc.handle) continue;
      const lower = acc.handle.toLowerCase();
      const isPinned = pinnedSet.has(lower);

      if (!isPinned && acc.statuses_count === 0) continue;
      if (!isPinned && minFollowers > 0 && (acc.followers_count || 0) < minFollowers) continue;

      const prev = byHandle.get(lower);
      byHandle.set(lower, {
        handle: acc.handle,
        name: acc.name || prev?.name || acc.handle,
        followers_count: Math.max(acc.followers_count || 0, prev?.followers_count || 0),
        verified: Boolean(acc.verified || prev?.verified),
        subtitle: prev?.subtitle || `Live Broadcast • X (@${acc.handle})`
      });
    }

    const sortedAccounts = Array.from(byHandle.values()).sort((a, b) => {
      const aPin = pinnedSet.has(a.handle.toLowerCase()) ? 1 : 0;
      const bPin = pinnedSet.has(b.handle.toLowerCase()) ? 1 : 0;
      if (aPin !== bPin) return bPin - aPin;
      if (a.verified !== b.verified) return (b.verified ? 1 : 0) - (a.verified ? 1 : 0);
      return (b.followers_count || 0) - (a.followers_count || 0);
    });

    const payload = {
      version: 1,
      source_account: TARGET_USERNAME,
      updated_at: new Date().toISOString(),
      total_following_scanned: rawAccounts.length,
      accounts: sortedAccounts
    };

    await githubPutFileWithRetry(
      GITHUB_FILE_PATH,
      `chore(sync): update @${TARGET_USERNAME} following list (${sortedAccounts.length} accounts)`,
      JSON.stringify(payload, null, 2) + '\n',
      token
    );

    const now = Date.now();
    GM_setValue(STORAGE_KEYS.LAST_SYNC_MS, now);
    GM_setValue(
      STORAGE_KEYS.LAST_SYNC_STATUS,
      `Synced ${sortedAccounts.length} accounts at ${new Date(now).toLocaleString()}`
    );
    return { count: sortedAccounts.length, accounts: sortedAccounts };
  }

  // ============================================================================
  // LONG-FORM VIDEO HARVESTER (>= 5 MIN, LAST 30 DAYS, REVERSE CHRONOLOGICAL)
  // ============================================================================
  function pickBestVideoStreamUrl(variants) {
    if (!Array.isArray(variants)) return '';
    let hlsUrl = '';
    let bestMp4Url = '';
    let bestMp4Bitrate = -1;
    for (const v of variants) {
      if (!v || typeof v.url !== 'string' || !v.url.startsWith('http')) continue;
      const ct = String(v.content_type || v.type || '').toLowerCase();
      if (ct.includes('mpegurl') || v.url.includes('.m3u8')) {
        if (!hlsUrl) hlsUrl = v.url;
      } else if (ct.includes('mp4') || v.url.includes('.mp4')) {
        const br = Number(v.bitrate) || 0;
        if (br >= bestMp4Bitrate) {
          bestMp4Bitrate = br;
          bestMp4Url = v.url;
        }
      }
    }
    return hlsUrl || bestMp4Url;
  }

  function cleanVideoTitle(rawText, authorName, handle) {
    const cleanedFull = String(rawText || '')
      .replace(/https?:\/\/t\.co\/[A-Za-z0-9]+/g, '')
      .trim();
    if (!cleanedFull) {
      return `${authorName || '@' + handle} • Long-Form Video`;
    }
    const firstLine = cleanedFull
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) || cleanedFull;
    const candidate = (firstLine.length >= 12 ? firstLine : cleanedFull).replace(/\s+/g, ' ').trim();
    return candidate.length > 110 ? candidate.slice(0, 107).trimEnd() + '…' : candidate;
  }

  function extractLongFormVideosFromPayload(rootNode, followedSet, collectedVideos, cutoffMs) {
    let bottomCursor = null;
    let reachedEnd = false;
    let oldestSeenMs = Infinity;

    const recordCandidate = ({
      tweetId,
      handle,
      authorName,
      fullText,
      publishedAtMs,
      durationMs,
      streamUrl,
      thumbnailUrl
    }) => {
      if (!tweetId || !handle || !streamUrl) return;
      const cleanHandle = String(handle).replace(/^@+/, '').trim();
      if (!cleanHandle) return;
      if (followedSet && followedSet.size > 0 && !followedSet.has(cleanHandle.toLowerCase())) return;
      if (publishedAtMs > 0 && publishedAtMs < oldestSeenMs) {
        oldestSeenMs = publishedAtMs;
      }
      if (!publishedAtMs || publishedAtMs < cutoffMs) return;
      if (!durationMs || durationMs < MIN_LONG_FORM_VIDEO_MS) return;

      const durationSeconds = Math.floor(durationMs / 1000);
      if (!collectedVideos.has(tweetId)) {
        collectedVideos.set(tweetId, {
          tweet_id: String(tweetId),
          handle: cleanHandle,
          author_name: String(authorName || cleanHandle).trim(),
          title: cleanVideoTitle(fullText, authorName, cleanHandle),
          published_at_ms: publishedAtMs,
          published_at: new Date(publishedAtMs).toISOString(),
          duration_seconds: durationSeconds,
          stream_url: streamUrl,
          ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {})
        });
      }
    };

    // Handle REST v2 adaptive search globalObjects format if present
    if (rootNode?.globalObjects?.tweets && rootNode?.globalObjects?.users) {
      const users = rootNode.globalObjects.users;
      for (const t of Object.values(rootNode.globalObjects.tweets)) {
        if (!t || t.retweeted_status_id_str) continue;
        const fullText = t.full_text || t.text || '';
        if (fullText.startsWith('RT @')) continue;
        const user = users[t.user_id_str];
        const handle = user?.screen_name || '';
        const authorName = user?.name || handle;
        const publishedAtMs = t.created_at ? Date.parse(t.created_at) : 0;
        const media = t.extended_entities?.media || t.entities?.media || [];
        for (const m of media) {
          if (!m?.video_info) continue;
          const durationMs = Number(m.video_info.duration_millis) || 0;
          const streamUrl = pickBestVideoStreamUrl(m.video_info.variants);
          recordCandidate({
            tweetId: t.id_str,
            handle,
            authorName,
            fullText,
            publishedAtMs,
            durationMs,
            streamUrl,
            thumbnailUrl: m.media_url_https || ''
          });
          break;
        }
      }
    }

    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }

      const cType = node.cursor_type || node.cursorType;
      if (cType === 'Bottom' && typeof node.value === 'string') {
        bottomCursor = node.value;
        if (node.value.startsWith('0|')) reachedEnd = true;
      }

      // Inspect 2026 x-web and legacy GraphQL Tweet objects
      const isTweet =
        node.__typename === 'Tweet' ||
        (node.rest_id && (node.media_entities2 || node.details || node.legacy?.extended_entities));

      if (isTweet && !node.retweeted_status_result && !node.legacy?.retweeted_status_result) {
        const tweetId = String(node.rest_id || node.legacy?.id_str || '').trim();
        const userRes = node.core?.user_results?.result;
        const handle = userRes?.core?.screen_name || userRes?.legacy?.screen_name || '';
        const authorName = userRes?.core?.name || userRes?.legacy?.name || handle;
        const fullText =
          node.note_tweet?.note_tweet_results?.result?.text ||
          node.details?.full_text ||
          node.legacy?.full_text ||
          '';

        if (!fullText.startsWith('RT @')) {
          const publishedAtMs =
            Number(node.details?.created_at_ms) ||
            (node.legacy?.created_at ? Date.parse(node.legacy.created_at) : 0) ||
            0;
          const mediaArr =
            node.media_entities2 ||
            node.legacy?.extended_entities?.media ||
            node.legacy?.entities?.media ||
            [];

          for (const m of mediaArr) {
            if (!m?.video_info) continue;
            // Ensure video belongs to this tweet's author, not an embedded third-party video
            const expUrl = String(m.expanded_url || '');
            const urlMatch = expUrl.match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/status\//i);
            if (urlMatch && handle && urlMatch[1].toLowerCase() !== handle.toLowerCase()) continue;

            const durationMs = Number(m.video_info.duration_millis) || 0;
            const streamUrl = pickBestVideoStreamUrl(m.video_info.variants);
            recordCandidate({
              tweetId,
              handle,
              authorName,
              fullText,
              publishedAtMs,
              durationMs,
              streamUrl,
              thumbnailUrl: m.media_url_https || ''
            });
            break;
          }
        }
      }

      for (const key of Object.keys(node)) {
        if (key === 'quoted_status_result' || key === 'retweeted_status_result') continue;
        walk(node[key]);
      }
    }

    walk(rootNode);
    return { bottomCursor, reachedEnd, oldestSeenMs };
  }

  function parseSsrHtmlVideos(htmlText, followedSet, collectedVideos, cutoffMs) {
    let bottomCursor = null;
    let reachedEnd = false;
    let oldestSeenMs = Infinity;
    let discoveredSearchQueryId = null;

    if (!htmlText) return { bottomCursor, reachedEnd, oldestSeenMs, discoveredSearchQueryId };

    // Auto-discover active 2026 x-web Search Relay queryId if present in SSR HTML
    const qMatch = htmlText.match(/key:"([A-Za-z0-9_-]{18,30})\{[^"]*(?:rawQuery|query)\\?":/i);
    if (qMatch) {
      discoveredSearchQueryId = qMatch[1];
      GM_setValue(STORAGE_KEYS.CACHED_SEARCH_QUERY_ID, discoveredSearchQueryId);
    }

    let searchIdx = 0;
    const marker = 'value:"';
    while (searchIdx < htmlText.length) {
      const start = htmlText.indexOf(marker, searchIdx);
      if (start < 0) break;
      const literalStart = start + 6;
      let i = literalStart + 1;
      let escaped = false;
      while (i < htmlText.length) {
        const c = htmlText[i];
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') break;
        i++;
      }
      if (i >= htmlText.length) break;
      const literal = htmlText.substring(literalStart, i + 1);
      searchIdx = i + 1;
      if (!literal.includes('video_info') && !literal.includes('duration_millis') && !literal.includes('cursor')) {
        continue;
      }
      try {
        const jsonStr = JSON.parse(literal);
        const parsed = JSON.parse(jsonStr);
        const res = extractLongFormVideosFromPayload(parsed, followedSet, collectedVideos, cutoffMs);
        if (res.bottomCursor) bottomCursor = res.bottomCursor;
        if (res.reachedEnd) reachedEnd = true;
        if (res.oldestSeenMs < oldestSeenMs) oldestSeenMs = res.oldestSeenMs;
      } catch (_) {}
    }

    return { bottomCursor, reachedEnd, oldestSeenMs, discoveredSearchQueryId };
  }

  async function harvestLongFormVideos(accounts) {
    const ct0 = getCsrfToken();
    const nowMs = Date.now();
    const cutoffMs = nowMs - VIDEO_WINDOW_MS;
    const sinceDate = new Date(cutoffMs).toISOString().slice(0, 10);
    const followedSet = new Set(
      (accounts || []).map((a) => String(a.handle || '').replace(/^@+/, '').toLowerCase()).filter(Boolean)
    );
    const collectedVideos = new Map();
    const searchQuery = `filter:follows filter:native_video -filter:retweets since:${sinceDate}`;

    // Strategy 1: Live 2026 x-web Search iframe (intercepts X's own authenticated Search GraphQL responses)
    await new Promise((resolve) => {
      const attach = () => {
        const iframe = document.createElement('iframe');
        iframe.src = `${location.origin}/search?q=${encodeURIComponent(searchQuery)}&src=typed_query&f=live&ctv_video_sync=1`;
        Object.assign(iframe.style, {
          position: 'fixed',
          width: '420px',
          height: '620px',
          right: '0px',
          bottom: '0px',
          opacity: '0.01',
          pointerEvents: 'none',
          zIndex: '-1',
          border: 'none'
        });

        const cleanup = () => {
          window.removeEventListener('message', onMsg);
          clearTimeout(safetyTimer);
          iframe.remove();
          resolve();
        };

        const onMsg = (event) => {
          if (event.origin !== location.origin) return;
          const data = event.data;
          if (!data || data.source !== MSG_SOURCE || data.type !== 'VIDEO_HARVEST_COMPLETE') return;
          if (Array.isArray(data.videos)) {
            for (const v of data.videos) {
              if (!v || !v.tweet_id || !v.handle || !v.stream_url) continue;
              if (followedSet.size > 0 && !followedSet.has(String(v.handle).toLowerCase())) continue;
              if ((v.duration_seconds || 0) * 1000 < MIN_LONG_FORM_VIDEO_MS) continue;
              if ((v.published_at_ms || 0) < cutoffMs) continue;
              if (!collectedVideos.has(v.tweet_id)) {
                collectedVideos.set(v.tweet_id, v);
              }
            }
          }
          cleanup();
        };

        const safetyTimer = setTimeout(cleanup, 55000);
        window.addEventListener('message', onMsg);
        document.body.appendChild(iframe);
      };

      if (document.body) attach();
      else document.addEventListener('DOMContentLoaded', attach, { once: true });
    });

    // Strategy 2: Logged-out SSR profile scan fallback if live Search iframe yielded nothing
    if (collectedVideos.size === 0 && accounts && accounts.length > 0) {
      const sampleAccounts = accounts.slice(0, 35);
      for (const acc of sampleAccounts) {
        if (!acc?.handle) continue;
        try {
          const resp = await fetch(`${location.origin}/${encodeURIComponent(acc.handle)}`, {
            credentials: 'omit',
            headers: { accept: 'text/html' }
          });
          if (resp.status === 429) break;
          if (!resp.ok) continue;
          const html = await resp.text();
          parseSsrHtmlVideos(html, followedSet, collectedVideos, cutoffMs);
        } catch (_) {}
      }
    }

    // Sort strictly reverse chronological (newest first)
    return Array.from(collectedVideos.values()).sort((a, b) => {
      if (b.published_at_ms !== a.published_at_ms) return b.published_at_ms - a.published_at_ms;
      return b.tweet_id.localeCompare(a.tweet_id);
    });
  }

  async function uploadVideosToGitHub(videos) {
    const token = getGithubToken();
    if (!token) throw new Error('Missing GitHub token');

    const payload = {
      version: 1,
      source_account: TARGET_USERNAME,
      updated_at: new Date().toISOString(),
      min_duration_seconds: Math.floor(MIN_LONG_FORM_VIDEO_MS / 1000),
      window_days: VIDEO_WINDOW_DAYS,
      total_videos: videos.length,
      videos
    };

    await githubPutFileWithRetry(
      GITHUB_VIDEOS_FILE_PATH,
      `chore(sync): update @${TARGET_USERNAME} long-form X videos (${videos.length} videos)`,
      JSON.stringify(payload, null, 2) + '\n',
      token
    );

    return videos.length;
  }

  let syncInFlight = false;

  async function runFollowingSync({ manual = false, videosOnly = false } = {}) {
    const token = getGithubToken();
    if (!token) {
      if (manual) openTokenModal();
      return;
    }

    if (syncInFlight) {
      if (manual) showBanner('Sync is already running...');
      return;
    }

    const now = Date.now();
    const lockUntil = Number(GM_getValue(STORAGE_KEYS.SYNC_LOCK_UNTIL, 0)) || 0;
    if (!manual && now < lockUntil) return;

    if (!getCsrfToken()) {
      if (manual) showBanner('Please sign in to X.com first so your following list can be read.', { isError: true });
      return;
    }

    syncInFlight = true;
    GM_setValue(STORAGE_KEYS.SYNC_LOCK_UNTIL, now + SYNC_LOCK_MS);
    if (manual) {
      showBanner(
        videosOnly
          ? `Scanning @${TARGET_USERNAME} followed accounts for 5m+ videos (last 30 days)...`
          : `Scanning @${TARGET_USERNAME} following list & long-form videos...`,
        { durationMs: 0 }
      );
    }

    try {
      const collected = new Map();

      // 1. Fast direct 2026 x-web Relay GraphQL pagination
      try {
        await harvestViaRelayGraphql(collected);
      } catch (e) {
        console.warn('[CTV X Sync] Relay GraphQL strategy error:', e);
      }

      // 2. Fallback to REST v1.1 friends/list.json
      if (collected.size === 0) {
        try {
          await harvestViaRestV1(collected);
        } catch (e) {
          console.warn('[CTV X Sync] REST v1.1 strategy error:', e);
        }
      }

      // 3. Fallback to SSR HTML + live 2026 x-web iframe scroller
      if (collected.size === 0) {
        await harvestViaSsrAndIframe(collected);
      }

      const accounts = Array.from(collected.values());
      if (accounts.length === 0) {
        GM_setValue(
          STORAGE_KEYS.LAST_SYNC_STATUS,
          `Failed at ${new Date().toLocaleString()}: 0 followed accounts detected`
        );
        if (manual) {
          showBanner('Could not detect followed accounts — make sure you are logged in to @alexkillby on X.', {
            isError: true
          });
        }
        return;
      }

      let accountCount = accounts.length;
      let sortedAccounts = accounts;
      if (!videosOnly) {
        const res = await uploadAccountsToGitHub(accounts);
        accountCount = res.count;
        sortedAccounts = res.accounts;
      }

      if (manual) {
        showBanner(`Scanning ${accountCount} followed accounts for 5m+ videos (last 30 days)...`, { durationMs: 0 });
      }

      let videoCount = 0;
      try {
        const videos = await harvestLongFormVideos(sortedAccounts);
        videoCount = await uploadVideosToGitHub(videos);
      } catch (vidErr) {
        console.warn('[CTV X Sync] Long-form video sync error:', vidErr);
      }

      const doneAt = Date.now();
      GM_setValue(STORAGE_KEYS.LAST_SYNC_MS, doneAt);
      GM_setValue(
        STORAGE_KEYS.LAST_SYNC_STATUS,
        `Synced ${accountCount} accounts & ${videoCount} long-form videos at ${new Date(doneAt).toLocaleString()}`
      );

      showBanner(
        videosOnly
          ? `Synced ${videoCount} long-form X videos (5m+, 30d) to CTV News TV!`
          : `Synced ${accountCount} accounts & ${videoCount} long-form X videos to CTV News TV!`,
        { durationMs: manual ? 8000 : 4500 }
      );
    } catch (err) {
      console.error('[CTV X Sync] Sync error:', err);
      GM_setValue(
        STORAGE_KEYS.LAST_SYNC_STATUS,
        `Error at ${new Date().toLocaleString()}: ${err.message}`
      );
      showBanner(`Sync failed: ${err.message}`, { isError: true, durationMs: 9000 });
    } finally {
      syncInFlight = false;
      GM_setValue(STORAGE_KEYS.SYNC_LOCK_UNTIL, 0);
    }
  }

  // Clean inline modal for setting GitHub PAT (never blocked by Violentmonkey popup focus)
  function openTokenModal() {
    const attach = () => {
      document.getElementById('ctv-x-token-modal')?.remove();

      const backdrop = document.createElement('div');
      backdrop.id = 'ctv-x-token-modal';
      Object.assign(backdrop.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483646',
        background: 'rgba(0, 0, 0, 0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, -apple-system, sans-serif'
      });

      const card = document.createElement('div');
      Object.assign(card.style, {
        width: 'min(460px, 92vw)',
        background: '#0f172a',
        color: '#f8fafc',
        border: '1px solid #38bdf8',
        borderRadius: '14px',
        padding: '20px',
        boxShadow: '0 20px 50px rgba(0,0,0,0.65)'
      });

      const title = document.createElement('div');
      title.textContent = '📺 CTV News TV — GitHub Sync Token';
      Object.assign(title.style, { fontSize: '16px', fontWeight: '700', marginBottom: '8px' });

      const desc = document.createElement('div');
      desc.textContent = `Paste a GitHub Personal Access Token with Contents (Read & Write) permission on ${GITHUB_OWNER}/${GITHUB_REPO}. Once saved, syncing runs automatically once per day whenever X.com is open.`;
      Object.assign(desc.style, { fontSize: '13px', color: '#cbd5e1', lineHeight: '1.45', marginBottom: '14px' });

      const input = document.createElement('input');
      input.type = 'password';
      input.placeholder = 'github_pat_... or ghp_...';
      input.value = getGithubToken();
      Object.assign(input.style, {
        width: '100%',
        boxSizing: 'border-box',
        padding: '10px 12px',
        borderRadius: '8px',
        border: '1px solid #475569',
        background: '#1e293b',
        color: '#f8fafc',
        fontSize: '13.5px',
        marginBottom: '14px',
        outline: 'none'
      });

      const btnRow = document.createElement('div');
      Object.assign(btnRow.style, { display: 'flex', justifyContent: 'flex-end', gap: '10px' });

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      Object.assign(cancelBtn.style, {
        padding: '8px 14px',
        borderRadius: '8px',
        border: '1px solid #475569',
        background: 'transparent',
        color: '#cbd5e1',
        cursor: 'pointer',
        fontSize: '13px'
      });
      cancelBtn.onclick = () => backdrop.remove();

      const saveBtn = document.createElement('button');
      saveBtn.textContent = 'Save & Sync Now';
      Object.assign(saveBtn.style, {
        padding: '8px 16px',
        borderRadius: '8px',
        border: 'none',
        background: '#0284c7',
        color: '#ffffff',
        fontWeight: '600',
        cursor: 'pointer',
        fontSize: '13px'
      });
      saveBtn.onclick = () => {
        const cleaned = input.value.trim().replace(/^["']+|["']+$/g, '');
        GM_setValue(STORAGE_KEYS.GITHUB_PAT, cleaned);
        backdrop.remove();
        if (cleaned) {
          runFollowingSync({ manual: true });
        } else {
          showBanner('GitHub token cleared.');
        }
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveBtn.click();
        if (e.key === 'Escape') backdrop.remove();
      });

      btnRow.append(cancelBtn, saveBtn);
      card.append(title, desc, input, btnRow);
      backdrop.appendChild(card);
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.remove();
      });
      document.body.appendChild(backdrop);
      setTimeout(() => input.focus(), 50);
    };

    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
  }

  function promptForMinFollowers() {
    const current = GM_getValue(STORAGE_KEYS.MIN_FOLLOWERS, 0);
    const input = window.prompt(
      'Optional minimum follower count filter (0 = include all public accounts you follow):',
      String(current)
    );
    if (input !== null && !Number.isNaN(Number(input))) {
      GM_setValue(STORAGE_KEYS.MIN_FOLLOWERS, Math.max(0, Math.floor(Number(input))));
      showBanner(`Minimum followers filter set to ${GM_getValue(STORAGE_KEYS.MIN_FOLLOWERS, 0)}.`);
    }
  }

  function showLastSyncStatus() {
    const status = GM_getValue(STORAGE_KEYS.LAST_SYNC_STATUS, 'Never synced yet');
    const hasToken = Boolean(getGithubToken());
    showBanner(`${status} • Token: ${hasToken ? 'Configured' : 'Not set'}`, { durationMs: 8000 });
  }

  // Register Violentmonkey / Tampermonkey toolbar commands
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('🔑 Set GitHub Token (ctv-x-feeds)', openTokenModal);
    GM_registerMenuCommand(`🔄 Sync @${TARGET_USERNAME} Following & Videos Now`, () => runFollowingSync({ manual: true }));
    GM_registerMenuCommand('🎬 Sync X Long-Form Videos (5m+, 30d) Now', () =>
      runFollowingSync({ manual: true, videosOnly: true })
    );
    GM_registerMenuCommand('📊 View Last Sync Status', showLastSyncStatus);
    GM_registerMenuCommand('⚙️ Set Minimum Follower Filter', promptForMinFollowers);
  }

  // Automatic hands-free daily check (on page load, tab focus/visibility, and every 30 min on open tabs)
  function maybeAutoSync() {
    const token = getGithubToken();
    if (!token) {
      if (!sessionStorage.getItem('ctv_pat_reminded')) {
        sessionStorage.setItem('ctv_pat_reminded', '1');
        showBanner('Click Violentmonkey icon → "🔑 Set GitHub Token" once to enable automatic daily TV sync.');
      }
      return;
    }

    const lastSync = Number(GM_getValue(STORAGE_KEYS.LAST_SYNC_MS, 0)) || 0;
    if (Date.now() - lastSync >= SYNC_INTERVAL_MS) {
      runFollowingSync({ manual: false });
    }
  }

  setTimeout(maybeAutoSync, 3500);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      setTimeout(maybeAutoSync, 1500);
    }
  });
  setInterval(maybeAutoSync, AUTO_CHECK_MS);
})();
