// ==UserScript==
// @name         CTV News TV — Sync @alexkillby X Following List
// @namespace    https://github.com/alexkillby/ctv-x-feeds
// @version      1.0.0
// @description  Syncs @alexkillby's followed X accounts at most once per day to GitHub so CTV News Android TV can independently probe them for live broadcasts.
// @author       Alex Killby
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
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
  const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // At most once every 24 hours
  const SYNC_LOCK_MS = 5 * 60 * 1000;           // Prevent concurrent tabs from syncing simultaneously
  const MSG_SOURCE = 'ctv-x-following-sync';

  const STORAGE_KEYS = {
    GITHUB_PAT: 'ctv_github_pat',
    LAST_SYNC_MS: 'ctv_last_sync_ms',
    SYNC_LOCK_UNTIL: 'ctv_sync_lock_until',
    MIN_FOLLOWERS: 'ctv_min_followers',
    PINNED_HANDLES: 'ctv_pinned_handles'
  };

  const DEFAULT_PINNED = [
    { handle: 'SpaceX', name: 'SpaceX', subtitle: 'Live Launch Coverage • X (@SpaceX)' },
    { handle: 'TWiT', name: 'TWiT', subtitle: 'Live Broadcast • X (@TWiT)' }
  ];

  const RESERVED_PATHS = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'settings',
    'search', 'compose', 'intent', 'tos', 'privacy', 'jobs', 'lists', 'communities'
  ]);

  const isSyncIframe = window.self !== window.top && location.search.includes('ctv_sync=1');

  // ============================================================================
  // IFRAME WORKER MODE: Captures X's native GraphQL Following pages + DOM fallback
  // ============================================================================
  if (isSyncIframe) {
    const collected = new Map(); // lowerHandle -> accountObj
    let reachedBottom = false;

    function recordAccount(raw) {
      if (!raw || !raw.handle) return;
      const cleanHandle = String(raw.handle).replace(/^@+/, '').trim();
      if (!cleanHandle || !/^[A-Za-z0-9_]{1,15}$/.test(cleanHandle)) return;
      const lower = cleanHandle.toLowerCase();
      if (lower === TARGET_USERNAME.toLowerCase() || RESERVED_PATHS.has(lower)) return;
      if (raw.protected === true) return; // Protected accounts cannot be probed unauthenticated by TV

      const existing = collected.get(lower);
      if (!existing || (raw.followers_count || 0) > (existing.followers_count || 0)) {
        collected.set(lower, {
          handle: cleanHandle,
          name: (raw.name && String(raw.name).trim()) || cleanHandle,
          followers_count: typeof raw.followers_count === 'number' ? raw.followers_count : (existing?.followers_count || 0),
          statuses_count: typeof raw.statuses_count === 'number' ? raw.statuses_count : (existing?.statuses_count ?? -1),
          verified: Boolean(raw.verified || existing?.verified)
        });
      }
    }

    function walkGraphqlNode(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walkGraphqlNode(item);
        return;
      }

      // Check for end-of-timeline bottom cursor ("0|...")
      if (
        (node.entryType === 'TimelineTimelineCursor' || node.__typename === 'TimelineTimelineCursor') &&
        node.cursorType === 'Bottom' &&
        typeof node.value === 'string' &&
        node.value.startsWith('0|')
      ) {
        reachedBottom = true;
      }

      // Extract User objects across both legacy and 2026 `core` X GraphQL schemas
      const isUserNode =
        node.__typename === 'User' ||
        (node.legacy && typeof node.legacy.screen_name === 'string') ||
        (node.core && typeof node.core.screen_name === 'string');

      if (isUserNode) {
        const handle = node.core?.screen_name || node.legacy?.screen_name || node.screen_name;
        const name = node.core?.name || node.legacy?.name || node.name;
        const isProtected = node.privacy?.protected ?? node.legacy?.protected ?? false;
        const followersCount = node.legacy?.followers_count ?? node.followers_count ?? 0;
        const statusesCount = node.legacy?.statuses_count ?? node.statuses_count ?? -1;
        const verified = Boolean(node.is_blue_verified || node.legacy?.verified || node.verified);

        if (handle) {
          recordAccount({
            handle,
            name,
            protected: Boolean(isProtected),
            followers_count: followersCount,
            statuses_count: statusesCount,
            verified
          });
        }
      }

      for (const key of Object.keys(node)) {
        walkGraphqlNode(node[key]);
      }
    }

    function inspectFollowingUrlAndBody(url, responseText) {
      if (!url || !/\/graphql\/[^/]+\/Following\b/i.test(String(url))) return;
      try {
        const json = JSON.parse(responseText);
        walkGraphqlNode(json);
      } catch (_) {}
    }

    // Hook unsafeWindow.fetch & XMLHttpRequest before X's bundle runs
    try {
      const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

      const origFetch = pageWin.fetch;
      if (typeof origFetch === 'function') {
        pageWin.fetch = async function (...args) {
          const resp = await origFetch.apply(this, args);
          try {
            const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
            if (reqUrl && /\/graphql\/[^/]+\/Following\b/i.test(reqUrl)) {
              resp.clone().text().then((txt) => inspectFollowingUrlAndBody(reqUrl, txt)).catch(() => {});
            }
          } catch (_) {}
          return resp;
        };
      }

      const origOpen = pageWin.XMLHttpRequest.prototype.open;
      const origSend = pageWin.XMLHttpRequest.prototype.send;
      pageWin.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__ctvUrl = url;
        return origOpen.call(this, method, url, ...rest);
      };
      pageWin.XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', function () {
          try {
            if (this.__ctvUrl && /\/graphql\/[^/]+\/Following\b/i.test(this.__ctvUrl)) {
              inspectFollowingUrlAndBody(this.__ctvUrl, this.responseText);
            }
          } catch (_) {}
        });
        return origSend.apply(this, args);
      };
    } catch (_) {}

    // Fallback DOM scraper for rendered [data-testid="UserCell"] rows
    function scanRenderedDomCells() {
      const cells = document.querySelectorAll('[data-testid="UserCell"]');
      for (const cell of cells) {
        const links = cell.querySelectorAll('a[href^="/"]');
        for (const a of links) {
          const href = a.getAttribute('href') || '';
          const match = href.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
          if (match) {
            const handle = match[1];
            const nameSpan = cell.querySelector('span');
            recordAccount({
              handle,
              name: nameSpan?.textContent?.trim() || handle
            });
            break;
          }
        }
      }
    }

    function startAutoScrollHarvest() {
      let idleTicks = 0;
      let lastSize = 0;
      let ticks = 0;
      const MAX_TICKS = 90; // Cap at ~100 seconds max

      const timer = setInterval(() => {
        ticks++;
        scanRenderedDomCells();
        window.scrollBy(0, 1400);

        if (collected.size === lastSize) {
          idleTicks++;
        } else {
          lastSize = collected.size;
          idleTicks = 0;
        }

        // Stop once X marks bottom cursor OR count stabilizes after initial load
        if (reachedBottom || (collected.size > 0 && idleTicks >= 5) || idleTicks >= 10 || ticks >= MAX_TICKS) {
          clearInterval(timer);
          scanRenderedDomCells();
          window.parent.postMessage(
            {
              source: MSG_SOURCE,
              type: 'FOLLOWING_HARVEST_COMPLETE',
              accounts: Array.from(collected.values())
            },
            location.origin
          );
        }
      }, 1100);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(startAutoScrollHarvest, 1800));
    } else {
      setTimeout(startAutoScrollHarvest, 1800);
    }
    return;
  }

  // ============================================================================
  // TOP WINDOW MODE: Daily Scheduler, Menu Commands & GitHub Repo Uploader
  // ============================================================================
  if (window.self !== window.top) return;

  function showBanner(msg, isError = false) {
    const attach = () => {
      const el = document.createElement('div');
      el.textContent = `📺 CTV X Sync: ${msg}`;
      Object.assign(el.style, {
        position: 'fixed',
        bottom: '18px',
        right: '18px',
        zIndex: '2147483647',
        padding: '10px 14px',
        borderRadius: '8px',
        background: isError ? '#7f1d1d' : '#0f172a',
        color: '#f8fafc',
        border: `1px solid ${isError ? '#ef4444' : '#38bdf8'}`,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '13px',
        boxShadow: '0 8px 20px rgba(0,0,0,0.45)',
        transition: 'opacity 0.3s ease'
      });
      document.body.appendChild(el);
      setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 350);
      }, 4500);
    };
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
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
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        data: bodyObj ? JSON.stringify(bodyObj) : undefined,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              resolve(res.responseText ? JSON.parse(res.responseText) : {});
            } catch (e) {
              resolve({});
            }
          } else {
            reject(new Error(`GitHub HTTP ${res.status}: ${res.responseText?.slice(0, 180)}`));
          }
        },
        onerror: () => reject(new Error('Network error contacting api.github.com'))
      });
    });
  }

  async function uploadAccountsToGitHub(rawAccounts, manual = false) {
    const token = (GM_getValue(STORAGE_KEYS.GITHUB_PAT, '') || '').trim();
    if (!token) {
      if (manual) promptForToken();
      return;
    }

    const minFollowers = Number(GM_getValue(STORAGE_KEYS.MIN_FOLLOWERS, 0)) || 0;
    const customPinnedStr = GM_getValue(STORAGE_KEYS.PINNED_HANDLES, 'SpaceX,TWiT');
    const pinnedSet = new Set(
      String(customPinnedStr)
        .split(',')
        .map((s) => s.trim().replace(/^@/, '').toLowerCase())
        .filter(Boolean)
    );

    const byHandle = new Map();

    // Seed pinned defaults first so custom subtitles are preserved
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

      // Skip accounts with 0 tweets or below optional follower filter (unless pinned)
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

    // Sort: pinned first, then verified broadcasters, then highest follower count
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

    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
    let existingSha = undefined;
    try {
      const existing = await githubRequest('GET', apiUrl, token);
      existingSha = existing?.sha;
    } catch (err) {
      if (!String(err.message).includes('404')) throw err;
    }

    await githubRequest('PUT', apiUrl, token, {
      message: `chore(sync): update @${TARGET_USERNAME} following list (${sortedAccounts.length} accounts)`,
      content: utf8ToBase64(JSON.stringify(payload, null, 2) + '\n'),
      ...(existingSha ? { sha: existingSha } : {})
    });

    GM_setValue(STORAGE_KEYS.LAST_SYNC_MS, Date.now());
    if (manual) {
      showBanner(`Synced ${sortedAccounts.length} followed accounts to GitHub!`);
    }
  }

  function runFollowingSync({ manual = false } = {}) {
    const token = (GM_getValue(STORAGE_KEYS.GITHUB_PAT, '') || '').trim();
    if (!token) {
      if (manual) {
        promptForToken();
      }
      return;
    }

    const now = Date.now();
    const lockUntil = Number(GM_getValue(STORAGE_KEYS.SYNC_LOCK_UNTIL, 0)) || 0;
    if (!manual && now < lockUntil) return;

    GM_setValue(STORAGE_KEYS.SYNC_LOCK_UNTIL, now + SYNC_LOCK_MS);
    if (manual) {
      showBanner(`Scanning @${TARGET_USERNAME} following list...`);
    }

    const attachIframe = () => {
      const iframe = document.createElement('iframe');
      iframe.src = `https://x.com/${TARGET_USERNAME}/following?ctv_sync=1`;
      Object.assign(iframe.style, {
        position: 'fixed',
        width: '420px',
        height: '700px',
        left: '-9999px',
        top: '-9999px',
        opacity: '0',
        pointerEvents: 'none'
      });

      const cleanup = () => {
        window.removeEventListener('message', onMsg);
        clearTimeout(safetyTimer);
        iframe.remove();
        GM_setValue(STORAGE_KEYS.SYNC_LOCK_UNTIL, 0);
      };

      const onMsg = async (event) => {
        if (event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.source !== MSG_SOURCE || data.type !== 'FOLLOWING_HARVEST_COMPLETE') return;
        cleanup();

        if (!Array.isArray(data.accounts) || data.accounts.length === 0) {
          if (manual) showBanner('No accounts found (make sure you are signed in to X).', true);
          return;
        }

        try {
          await uploadAccountsToGitHub(data.accounts, manual);
        } catch (err) {
          console.error('[CTV X Sync] Upload failed:', err);
          if (manual) showBanner(`Upload failed: ${err.message}`, true);
        }
      };

      const safetyTimer = setTimeout(() => {
        cleanup();
      }, 120000);

      window.addEventListener('message', onMsg);
      document.body.appendChild(iframe);
    };

    if (document.body) attachIframe();
    else document.addEventListener('DOMContentLoaded', attachIframe, { once: true });
  }

  function promptForToken() {
    const current = GM_getValue(STORAGE_KEYS.GITHUB_PAT, '');
    const input = window.prompt(
      `Enter a Fine-Grained GitHub Personal Access Token with Contents Read/Write on ${GITHUB_OWNER}/${GITHUB_REPO}:`,
      current
    );
    if (input !== null) {
      GM_setValue(STORAGE_KEYS.GITHUB_PAT, input.trim());
      if (input.trim()) {
        showBanner('GitHub token saved! Starting initial sync...');
        runFollowingSync({ manual: true });
      }
    }
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

  // Register Tampermonkey / Violentmonkey extension menu commands
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('🔑 Set GitHub Token (ctv-x-feeds)', promptForToken);
    GM_registerMenuCommand(`🔄 Sync @${TARGET_USERNAME} Following Now`, () => runFollowingSync({ manual: true }));
    GM_registerMenuCommand('⚙️ Set Minimum Follower Filter', promptForMinFollowers);
  }

  // Automatic daily check (runs at most once per 24 hours when browsing x.com)
  const token = (GM_getValue(STORAGE_KEYS.GITHUB_PAT, '') || '').trim();
  const lastSync = Number(GM_getValue(STORAGE_KEYS.LAST_SYNC_MS, 0)) || 0;
  if (!token) {
    // Remind once per browser session until configured
    if (!sessionStorage.getItem('ctv_pat_reminded')) {
      sessionStorage.setItem('ctv_pat_reminded', '1');
      setTimeout(() => {
        showBanner('Click Tampermonkey icon → "Set GitHub Token" to enable daily TV sync.');
      }, 4000);
    }
  } else if (Date.now() - lastSync >= SYNC_INTERVAL_MS) {
    setTimeout(() => runFollowingSync({ manual: false }), 5000);
  }
})();
