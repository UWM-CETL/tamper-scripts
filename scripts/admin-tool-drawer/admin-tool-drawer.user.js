// ==UserScript==
// @name         Canvas Admin Tool Drawer
// @namespace    https://uwm.edu/
// @version      0.4.0
// @description  Adds a clearly marked admin-only tool drawer to Canvas.
// @match        https://*.instructure.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    adminCacheKey: 'uwm-canvas-admin-tool-drawer:is-admin:v1',
    adminCacheTtlMs: 15 * 60 * 1000,
    failedCheckCacheTtlMs: 60 * 1000,
    api: {
      maxConcurrency: 15,
      minimumRateRemaining: 100,
      lowRatePauseMs: 1500,
      maxRetries: 5,
      baseRetryMs: 1000,
      maxRetryMs: 30000,
      retryStatuses: [408, 429, 500, 502, 503, 504]
    }
  };

  const HOST_ID = 'uwm-canvas-admin-tool-drawer-host';

  function isCanvasApplicationPage() {
    return Boolean(document.querySelector('#header.ic-app-header'));
  }

  function idFromBodyContext(contextName) {
    const match = document.body.className.match(
      new RegExp(`(?:^|\\s)context-${contextName}_(\\d+)(?:\\s|$)`)
    );

    return match ? match[1] : '';
  }

  function detectCanvasContext() {
    const path = window.location.pathname;
    const accountMatch = path.match(/^\/accounts\/(\d+)(?:\/|$)/);
    const courseMatch = path.match(/^\/courses\/(\d+)(?:\/|$)/);

    const pagePatterns = [
      { type: 'Assignment', pattern: /\/assignments\/(\d+)(?:\/|$)/ },
      { type: 'Quiz', pattern: /\/quizzes\/(\d+)(?:\/|$)/ },
      { type: 'Discussion', pattern: /\/discussion_topics\/(\d+)(?:\/|$)/ },
      { type: 'Module', pattern: /\/modules\/(\d+)(?:\/|$)/ },
      { type: 'File', pattern: /\/files\/(\d+)(?:\/|$)/ },
      { type: 'User', pattern: /\/users\/(\d+)(?:\/|$)/ },
      { type: 'Section', pattern: /\/sections\/(\d+)(?:\/|$)/ },
      { type: 'External tool', pattern: /\/external_tools\/(\d+)(?:\/|$)/ }
    ];

    const detectedPage = pagePatterns
      .map(candidate => ({ ...candidate, match: path.match(candidate.pattern) }))
      .find(candidate => candidate.match);

    const isCanvasPage = /\/pages\/[^/]+(?:\/|$)/.test(path);
    const pageIdMatch = path.match(/\/pages\/(\d+)(?:\/|$)/);
    const pageIsObvious = Boolean(detectedPage || isCanvasPage);
    const accountId = accountMatch?.[1] || idFromBodyContext('account');
    const courseId = courseMatch?.[1] || idFromBodyContext('course');
    const pageId = detectedPage?.match?.[1] || pageIdMatch?.[1] || '';
    const pageType = detectedPage?.type || (isCanvasPage ? 'Page' : '');

    let activeContext = 'course';
    if (pageIsObvious) {
      activeContext = 'page';
    } else if (accountId) {
      activeContext = 'admin';
    } else if (courseId) {
      activeContext = 'course';
    }

    return {
      activeContext,
      accountId,
      courseId,
      pageId,
      pageType
    };
  }

  function readCachedAdminStatus() {
    try {
      const rawValue = window.sessionStorage.getItem(CONFIG.adminCacheKey);
      if (!rawValue) return null;

      const cached = JSON.parse(rawValue);
      if (typeof cached?.isAdmin !== 'boolean' || cached.expiresAt <= Date.now()) {
        window.sessionStorage.removeItem(CONFIG.adminCacheKey);
        return null;
      }

      return cached.isAdmin;
    } catch {
      return null;
    }
  }

  function cacheAdminStatus(isAdmin, ttlMs = CONFIG.adminCacheTtlMs) {
    try {
      window.sessionStorage.setItem(CONFIG.adminCacheKey, JSON.stringify({
        isAdmin,
        expiresAt: Date.now() + ttlMs
      }));
    } catch {
      // Storage can be unavailable in restricted browser contexts. The drawer
      // still works; Canvas will simply be checked again on the next load.
    }
  }

  function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  function getCsrfToken() {
    const metaToken = document.querySelector('meta[name="csrf-token"]')?.content;
    if (metaToken) return metaToken;

    const cookieMatch = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]+)/);
    return cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
  }

  function parsePaginationLinks(linkHeader) {
    const links = {};
    if (!linkHeader) return links;

    for (const part of linkHeader.split(',')) {
      const match = part.match(/<([^>]+)>;[^,]*\brel="([^"]+)"/i);
      if (!match) continue;

      for (const relation of match[2].split(/\s+/)) {
        links[relation.toLowerCase()] = match[1];
      }
    }

    return links;
  }

  function normalizedPageUrl(value) {
    if (!value) return null;

    const url = new URL(value, window.location.origin);
    url.hash = '';
    return url.href;
  }

  function parseRetryAfterMs(value) {
    if (!value) return null;

    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const dateMs = Date.parse(value);
    return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
  }

  function createCanvasApiClient(config) {
    const queue = [];
    const telemetry = {
      active: 0,
      queued: 0,
      totalRequests: 0,
      retries: 0,
      lastRequestCost: null,
      rateRemaining: null,
      pausedUntil: null
    };

    let pauseUntil = 0;
    let drainTimer = null;

    function snapshot() {
      return {
        ...telemetry,
        pausedUntil: pauseUntil > Date.now()
          ? new Date(pauseUntil).toISOString()
          : null
      };
    }

    function scheduleDrain(delayMs = 0) {
      if (drainTimer !== null) return;

      drainTimer = window.setTimeout(() => {
        drainTimer = null;
        drain();
      }, Math.max(0, delayMs));
    }

    function pauseAllRequests(delayMs) {
      if (!Number.isFinite(delayMs) || delayMs <= 0) return;

      pauseUntil = Math.max(pauseUntil, Date.now() + delayMs);
      telemetry.pausedUntil = new Date(pauseUntil).toISOString();
      scheduleDrain(pauseUntil - Date.now());
    }

    function calculateBackoffMs(attempt) {
      const exponential = Math.min(
        config.maxRetryMs,
        config.baseRetryMs * (2 ** attempt)
      );
      const jitter = Math.round(exponential * (0.15 + Math.random() * 0.2));
      return Math.min(config.maxRetryMs, exponential + jitter);
    }

    function prepareRequest(path, options = {}) {
      const url = new URL(path, window.location.origin);
      if (url.origin !== window.location.origin) {
        throw new Error('Canvas API requests must use the current Canvas origin.');
      }

      const method = String(options.method || 'GET').toUpperCase();
      const headers = new Headers(options.headers || {});
      let body = options.body;

      if (!headers.has('Accept')) {
        headers.set('Accept', 'application/json+canvas-string-ids');
      }

      const bodyIsPlainObject = body &&
        typeof body === 'object' &&
        !(body instanceof FormData) &&
        !(body instanceof URLSearchParams) &&
        !(body instanceof Blob) &&
        !(body instanceof ArrayBuffer);

      if (bodyIsPlainObject) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(body)) {
          if (value === undefined || value === null) continue;

          if (Array.isArray(value)) {
            for (const item of value) params.append(key, String(item));
          } else {
            params.append(key, String(value));
          }
        }

        body = params;
        headers.set('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
      }

      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers.has('X-CSRF-Token')) {
        const csrfToken = getCsrfToken();
        if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
      }

      return {
        url,
        method,
        fetchOptions: {
          ...options,
          method,
          headers,
          body,
          credentials: 'same-origin'
        }
      };
    }

    async function parseResponse(response) {
      const rawText = await response.text();
      if (!rawText) return { data: null, rawText: '' };

      try {
        return { data: JSON.parse(rawText), rawText };
      } catch {
        return { data: rawText, rawText };
      }
    }

    function recordResponse(response) {
      const requestCostHeader = response.headers.get('X-Request-Cost');
      const rateRemainingHeader = response.headers.get('X-Rate-Limit-Remaining');
      const requestCost = requestCostHeader === null ? null : Number(requestCostHeader);
      const rateRemaining = rateRemainingHeader === null ? null : Number(rateRemainingHeader);

      telemetry.totalRequests++;
      telemetry.lastRequestCost = Number.isFinite(requestCost) ? requestCost : null;
      telemetry.rateRemaining = Number.isFinite(rateRemaining) ? rateRemaining : null;

      if (
        Number.isFinite(rateRemaining) &&
        rateRemaining <= config.minimumRateRemaining
      ) {
        pauseAllRequests(config.lowRatePauseMs);
      }

      return {
        requestCost: telemetry.lastRequestCost,
        rateRemaining: telemetry.rateRemaining
      };
    }

    function makeApiError({ method, url, response, data, rawText, rate }) {
      const details = typeof data === 'string'
        ? data
        : JSON.stringify(data, null, 2);
      const error = new Error(
        `Canvas API request failed: ${method} ${url.pathname}${url.search}\n\n` +
        `HTTP ${response.status}\n${details || rawText || response.statusText}`
      );

      error.status = response.status;
      error.url = url.href;
      error.response = data;
      error.requestCost = rate.requestCost;
      error.rateRemaining = rate.rateRemaining;
      return error;
    }

    async function execute(path, options) {
      const prepared = prepareRequest(path, options);

      for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        const globalDelay = pauseUntil - Date.now();
        if (globalDelay > 0) await sleep(globalDelay);

        let response;

        try {
          response = await window.fetch(prepared.url.href, prepared.fetchOptions);
        } catch (error) {
          if (attempt >= config.maxRetries) throw error;

          telemetry.retries++;
          await sleep(calculateBackoffMs(attempt));
          continue;
        }

        const rate = recordResponse(response);
        const parsed = await parseResponse(response);
        const rateLimited = response.status === 429 || (
          response.status === 403 &&
          /rate.?limit|throttl/i.test(parsed.rawText)
        );
        const retryable = rateLimited || config.retryStatuses.includes(response.status);

        if (response.ok) {
          return {
            data: parsed.data,
            response,
            status: response.status,
            requestCost: rate.requestCost,
            rateRemaining: rate.rateRemaining
          };
        }

        if (retryable && attempt < config.maxRetries) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
          const delayMs = retryAfterMs ?? calculateBackoffMs(attempt);

          telemetry.retries++;
          if (rateLimited) pauseAllRequests(delayMs);
          await sleep(delayMs);
          continue;
        }

        throw makeApiError({
          method: prepared.method,
          url: prepared.url,
          response,
          data: parsed.data,
          rawText: parsed.rawText,
          rate
        });
      }

      throw new Error('Canvas API retry limit exceeded.');
    }

    function drain() {
      if (!queue.length || telemetry.active >= config.maxConcurrency) return;

      const globalDelay = pauseUntil - Date.now();
      if (globalDelay > 0) {
        scheduleDrain(globalDelay);
        return;
      }

      while (queue.length && telemetry.active < config.maxConcurrency) {
        const task = queue.shift();
        telemetry.active++;
        telemetry.queued = queue.length;

        execute(task.path, task.options)
          .then(task.resolve, task.reject)
          .finally(() => {
            telemetry.active--;
            telemetry.queued = queue.length;
            drain();
          });
      }
    }

    function request(path, options = {}) {
      return new Promise((resolve, reject) => {
        queue.push({ path, options, resolve, reject });
        telemetry.queued = queue.length;
        drain();
      });
    }

    async function* getPages(path, options = {}) {
      const { onPage, ...requestOptions } = options;
      let nextUrl = path;
      let pageNumber = 0;
      let totalItems = 0;
      let nextPageIsTerminal = false;
      const visitedUrls = new Set();

      while (nextUrl) {
        const currentUrl = normalizedPageUrl(nextUrl);
        if (visitedUrls.has(currentUrl)) {
          console.warn('Canvas pagination stopped after a repeated page URL.', currentUrl);
          break;
        }
        visitedUrls.add(currentUrl);

        const currentPageIsTerminal = nextPageIsTerminal;
        const result = await request(nextUrl, { ...requestOptions, method: 'GET' });
        if (!Array.isArray(result.data)) {
          throw new Error(`Expected a paginated array from Canvas API: ${nextUrl}`);
        }

        pageNumber++;
        totalItems += result.data.length;
        const links = parsePaginationLinks(result.response.headers.get('Link'));
        const parsedNextUrl = normalizedPageUrl(links.next);
        const parsedLastUrl = normalizedPageUrl(links.last);

        nextUrl = currentPageIsTerminal ? null : parsedNextUrl;
        nextPageIsTerminal = Boolean(
          !currentPageIsTerminal &&
          parsedNextUrl &&
          parsedLastUrl &&
          parsedNextUrl === parsedLastUrl
        );

        if (nextUrl && visitedUrls.has(nextUrl)) {
          console.warn('Canvas pagination ignored a self-repeating next link.', nextUrl);
          nextUrl = null;
          nextPageIsTerminal = false;
        }

        const page = {
          items: result.data,
          pageNumber,
          pageItems: result.data.length,
          totalItems,
          hasNextPage: Boolean(nextUrl),
          isLastPage: !nextUrl,
          requestCost: result.requestCost,
          rateRemaining: result.rateRemaining
        };

        if (typeof onPage === 'function') {
          onPage(page);
        }

        yield page;
      }
    }

    async function getAll(path, options = {}) {
      const items = [];

      for await (const page of getPages(path, options)) {
        items.push(...page.items);
      }

      return items;
    }

    return {
      request,
      get: (path, options = {}) => request(path, { ...options, method: 'GET' }),
      getPages,
      getAll,
      state: snapshot
    };
  }

  const canvasApi = createCanvasApiClient(CONFIG.api);

  function csvCell(value) {
    let text;

    if (value === undefined || value === null) {
      text = '';
    } else if (typeof value === 'object') {
      text = JSON.stringify(value);
    } else {
      text = String(value);
    }

    // Prevent spreadsheet applications from interpreting untrusted Canvas
    // labels and names as formulas when the CSV is opened.
    if (/^[=+\-@]/.test(text)) text = `'${text}`;

    return /[",\r\n]/.test(text)
      ? `"${text.replace(/"/g, '""')}"`
      : text;
  }

  function rowsToCsv(rows, columns) {
    const header = columns.map(column => csvCell(column.label)).join(',');
    const lines = rows.map(row => (
      columns.map(column => csvCell(row[column.key])).join(',')
    ));

    return [header, ...lines].join('\r\n');
  }

  function timestampForFilename() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  function downloadCsv({ rows, columns, filename }) {
    const csv = `\uFEFF${rowsToCsv(rows, columns)}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();

    window.setTimeout(() => {
      URL.revokeObjectURL(url);
      link.remove();
    }, 1000);
  }

  const NAVIGATION_LINK_COLUMNS = [
    { key: 'report_generated_at', label: 'report_generated_at' },
    { key: 'scope_account_canvas_id', label: 'scope_account_canvas_id' },
    { key: 'published_courses_only', label: 'published_courses_only' },
    { key: 'course_canvas_id', label: 'course_canvas_id' },
    { key: 'course_sis_id', label: 'course_sis_id' },
    { key: 'course_name', label: 'course_name' },
    { key: 'course_code', label: 'course_code' },
    { key: 'course_workflow_state', label: 'course_workflow_state' },
    { key: 'course_account_canvas_id', label: 'course_account_canvas_id' },
    { key: 'navigation_id', label: 'navigation_id' },
    { key: 'navigation_label', label: 'navigation_label' },
    { key: 'navigation_type', label: 'navigation_type' },
    { key: 'navigation_position', label: 'navigation_position' },
    { key: 'navigation_hidden', label: 'navigation_hidden' },
    { key: 'navigation_visibility', label: 'navigation_visibility' },
    { key: 'navigation_html_url', label: 'navigation_html_url' },
    { key: 'navigation_full_url', label: 'navigation_full_url' },
    { key: 'status', label: 'status' },
    { key: 'error', label: 'error' }
  ];

  async function currentUserIsAccountAdmin() {
    const cachedStatus = readCachedAdminStatus();
    if (cachedStatus !== null) return cachedStatus;

    try {
      const result = await canvasApi.get('/api/v1/accounts?per_page=1');
      const accounts = result.data;
      const isAdmin = Array.isArray(accounts) && accounts.length > 0;
      cacheAdminStatus(isAdmin);
      return isAdmin;
    } catch (error) {
      console.warn('Canvas Admin Tool Drawer could not check admin access.', error);
      cacheAdminStatus(false, CONFIG.failedCheckCacheTtlMs);
      return false;
    }
  }

  function createToolDrawer() {
    if (document.getElementById(HOST_ID) || !document.body) return;

    const canvasContext = detectCanvasContext();
    const host = document.createElement('div');
    host.id = HOST_ID;
    const shadowRoot = host.attachShadow({ mode: 'open' });

    shadowRoot.innerHTML = `
      <style>
        :host {
          --uwm-danger-deep: #210709;
          --uwm-danger: #5b1118;
          --uwm-danger-bright: #a92a35;
          --uwm-warning: #f4b942;
          --uwm-text: #fff7ed;
          --uwm-muted: #e7c9c9;
          color-scheme: dark;
          font-family: Lato, "Helvetica Neue", Arial, sans-serif;
        }

        *,
        *::before,
        *::after {
          box-sizing: border-box;
        }

        .launcher {
          align-items: center;
          background: var(--uwm-danger);
          border: 2px solid var(--uwm-warning);
          border-radius: 12px;
          box-shadow: 0 5px 18px rgb(25 3 6 / 35%);
          color: var(--uwm-text);
          cursor: pointer;
          display: flex;
          height: 48px;
          justify-content: center;
          padding: 0;
          position: fixed;
          right: 16px;
          top: 16px;
          transition: background 120ms ease, box-shadow 120ms ease, transform 120ms ease;
          width: 48px;
          z-index: 10002;
        }

        .launcher:hover {
          background: var(--uwm-danger-bright);
          box-shadow: 0 7px 22px rgb(25 3 6 / 45%);
          transform: translateY(-1px);
        }

        .launcher:focus-visible,
        .close-button:focus-visible,
        .accordion-trigger:focus-visible,
        .subaccordion-trigger:focus-visible,
        .context-id:focus-visible,
        .scope-checkbox:focus-visible,
        .report-trigger:focus-visible,
        .confirmation-button:focus-visible {
          outline: 3px solid var(--uwm-warning);
          outline-offset: 3px;
        }

        .launcher svg {
          height: 28px;
          width: 28px;
        }

        .backdrop {
          background: rgb(10 2 3 / 56%);
          border: 0;
          cursor: default;
          inset: 0;
          opacity: 0;
          padding: 0;
          pointer-events: none;
          position: fixed;
          transition: opacity 180ms ease;
          z-index: 10000;
        }

        .drawer {
          background:
            linear-gradient(135deg, rgb(255 255 255 / 3%), transparent 38%),
            var(--uwm-danger-deep);
          border-right: 5px solid var(--uwm-warning);
          box-shadow: 14px 0 36px rgb(0 0 0 / 42%);
          color: var(--uwm-text);
          display: flex;
          flex-direction: column;
          height: 100dvh;
          left: 0;
          max-width: 92vw;
          overflow-y: auto;
          position: fixed;
          top: 0;
          transform: translateX(-105%);
          transition: transform 220ms cubic-bezier(.2, .8, .2, 1);
          width: 420px;
          z-index: 10001;
        }

        .drawer::before {
          background: repeating-linear-gradient(
            -45deg,
            var(--uwm-warning) 0 12px,
            #17100b 12px 24px
          );
          content: "";
          display: block;
          flex: 0 0 10px;
        }

        .drawer-header {
          align-items: flex-start;
          border-bottom: 1px solid rgb(244 185 66 / 38%);
          display: flex;
          gap: 20px;
          justify-content: space-between;
          padding: 24px 24px 20px;
        }

        .eyebrow {
          color: var(--uwm-warning);
          font-size: 0.75rem;
          font-weight: 800;
          letter-spacing: 0.14em;
          margin: 0 0 7px;
          text-transform: uppercase;
        }

        h2 {
          font-size: 1.55rem;
          line-height: 1.2;
          margin: 0;
        }

        .close-button {
          align-items: center;
          background: transparent;
          border: 1px solid rgb(255 247 237 / 38%);
          border-radius: 8px;
          color: var(--uwm-text);
          cursor: pointer;
          display: flex;
          flex: 0 0 38px;
          font-size: 1.6rem;
          height: 38px;
          justify-content: center;
          line-height: 1;
          padding: 0 0 3px;
        }

        .close-button:hover {
          background: rgb(255 255 255 / 10%);
        }

        .warning {
          background: rgb(169 42 53 / 20%);
          border: 1px solid rgb(244 185 66 / 55%);
          border-radius: 10px;
          margin: 24px;
          padding: 16px;
        }

        .warning strong {
          color: var(--uwm-warning);
          display: block;
          font-size: 0.95rem;
          margin-bottom: 5px;
        }

        .warning p,
        .context-help {
          color: var(--uwm-muted);
          line-height: 1.5;
          margin: 0;
        }

        .context-accordions {
          display: grid;
          gap: 10px;
          margin: 0 24px 24px;
        }

        .accordion-item {
          background: rgb(255 255 255 / 3%);
          border: 1px solid rgb(255 247 237 / 22%);
          border-radius: 10px;
          overflow: hidden;
        }

        .accordion-item.is-active {
          border-color: rgb(244 185 66 / 58%);
          box-shadow: inset 3px 0 0 var(--uwm-warning);
        }

        .accordion-trigger {
          align-items: center;
          background: transparent;
          border: 0;
          color: var(--uwm-text);
          cursor: pointer;
          display: flex;
          font: inherit;
          font-size: 1rem;
          font-weight: 700;
          gap: 12px;
          justify-content: space-between;
          padding: 16px 17px;
          text-align: left;
          width: 100%;
        }

        .accordion-trigger:hover {
          background: rgb(255 255 255 / 6%);
        }

        .accordion-chevron {
          color: var(--uwm-warning);
          font-size: 1.15rem;
          transform: rotate(0deg);
          transition: transform 140ms ease;
        }

        .accordion-trigger[aria-expanded="true"] .accordion-chevron {
          transform: rotate(90deg);
        }

        .accordion-panel {
          border-top: 1px solid rgb(255 247 237 / 14%);
          padding: 17px;
        }

        .accordion-panel[hidden] {
          display: none;
        }

        .context-label {
          color: var(--uwm-text);
          display: block;
          font-size: 0.82rem;
          font-weight: 700;
          margin-bottom: 7px;
        }

        .context-id {
          appearance: textfield;
          background: #fffaf4;
          border: 2px solid transparent;
          border-radius: 8px;
          color: #2a1012;
          font: inherit;
          font-size: 1rem;
          padding: 10px 11px;
          width: 100%;
        }

        .context-id:hover {
          border-color: rgb(244 185 66 / 70%);
        }

        .context-help {
          font-size: 0.8rem;
          margin-top: 8px;
        }

        .context-kind {
          color: var(--uwm-warning);
          font-weight: 700;
        }

        .admin-scope-filter {
          background: rgb(244 185 66 / 9%);
          border: 1px solid rgb(244 185 66 / 32%);
          border-radius: 8px;
          margin-top: 15px;
          padding: 12px;
        }

        .scope-label {
          align-items: flex-start;
          color: var(--uwm-text);
          cursor: pointer;
          display: flex;
          font-size: 0.86rem;
          font-weight: 700;
          gap: 9px;
          line-height: 1.35;
        }

        .scope-checkbox {
          accent-color: var(--uwm-warning);
          flex: 0 0 auto;
          height: 17px;
          margin: 1px 0 0;
          width: 17px;
        }

        .subaccordions {
          display: grid;
          gap: 8px;
          margin-top: 15px;
        }

        .subaccordion-item {
          border: 1px solid rgb(255 247 237 / 18%);
          border-radius: 8px;
          overflow: hidden;
        }

        .subaccordion-item.is-active {
          border-color: rgb(244 185 66 / 42%);
        }

        .subaccordion-trigger {
          align-items: center;
          background: rgb(255 255 255 / 3%);
          border: 0;
          color: var(--uwm-text);
          cursor: pointer;
          display: flex;
          font: inherit;
          font-size: 0.9rem;
          font-weight: 700;
          justify-content: space-between;
          padding: 12px 13px;
          text-align: left;
          width: 100%;
        }

        .subaccordion-trigger:hover {
          background: rgb(255 255 255 / 7%);
        }

        .subaccordion-trigger[aria-expanded="true"] .accordion-chevron {
          transform: rotate(90deg);
        }

        .subaccordion-panel {
          background: rgb(0 0 0 / 10%);
          border-top: 1px solid rgb(255 247 237 / 12%);
          padding: 13px;
        }

        .subaccordion-panel[hidden],
        .confirmation[hidden],
        .run-status[hidden] {
          display: none;
        }

        .report-trigger {
          background: transparent;
          border: 0;
          color: var(--uwm-warning);
          cursor: pointer;
          font: inherit;
          font-size: 0.88rem;
          font-weight: 800;
          padding: 2px 0;
          text-align: left;
          text-decoration: underline;
          text-decoration-thickness: 1px;
          text-underline-offset: 3px;
        }

        .report-trigger:hover:not(:disabled) {
          color: #ffd77f;
        }

        .report-trigger:disabled {
          color: var(--uwm-muted);
          cursor: not-allowed;
          opacity: 0.7;
          text-decoration: none;
        }

        .tool-description {
          color: var(--uwm-muted);
          font-size: 0.78rem;
          line-height: 1.45;
          margin: 7px 0 0;
        }

        .confirmation,
        .run-status {
          background: rgb(169 42 53 / 17%);
          border: 1px solid rgb(244 185 66 / 38%);
          border-radius: 8px;
          margin-top: 12px;
          padding: 12px;
        }

        .confirmation p,
        .run-status p {
          color: var(--uwm-muted);
          font-size: 0.8rem;
          line-height: 1.45;
          margin: 0;
        }

        .confirmation-actions {
          display: flex;
          gap: 8px;
          margin-top: 11px;
        }

        .confirmation-button {
          background: transparent;
          border: 1px solid rgb(255 247 237 / 45%);
          border-radius: 7px;
          color: var(--uwm-text);
          cursor: pointer;
          font: inherit;
          font-size: 0.8rem;
          font-weight: 800;
          padding: 7px 11px;
        }

        .confirmation-button.primary {
          background: var(--uwm-warning);
          border-color: var(--uwm-warning);
          color: #2a1012;
        }

        .confirmation-button:hover:not(:disabled) {
          filter: brightness(1.08);
        }

        .confirmation-button:disabled {
          cursor: not-allowed;
          opacity: 0.55;
        }

        .run-progress {
          accent-color: var(--uwm-warning);
          display: block;
          height: 12px;
          margin-bottom: 9px;
          width: 100%;
        }

        .run-status.is-error {
          border-color: #e76c76;
        }

        .run-status.is-error p {
          color: #ffd8dc;
        }

        .is-open .backdrop {
          opacity: 1;
          pointer-events: auto;
        }

        .is-open .drawer {
          transform: translateX(0);
        }

        @media (prefers-reduced-motion: reduce) {
          .launcher,
          .backdrop,
          .drawer {
            transition: none;
          }
        }

        @media (max-width: 600px) {
          .launcher {
            height: 44px;
            right: 10px;
            top: 10px;
            width: 44px;
          }

          .drawer {
            width: min(380px, 92vw);
          }
        }
      </style>

      <div class="tool-drawer-shell">
        <button
          class="launcher"
          type="button"
          aria-label="Open Canvas admin tools"
          aria-controls="uwm-admin-tool-drawer"
          aria-expanded="false"
          title="Canvas admin tools"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M14.7 6.3a4.8 4.8 0 0 0-5.82 6.91l-5.9 5.9a1.35 1.35 0 0 0 1.91 1.91l5.9-5.9a4.8 4.8 0 0 0 6.91-5.82l-2.64 2.64-2.35-.65-.65-2.35L14.7 6.3Zm-10.5 13.5a.72.72 0 1 1 1.02-1.02.72.72 0 0 1-1.02 1.02Z"
            />
          </svg>
        </button>

        <button class="backdrop" type="button" aria-label="Close Canvas admin tools"></button>

        <aside
          class="drawer"
          id="uwm-admin-tool-drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="uwm-admin-tool-drawer-title"
          aria-hidden="true"
        >
          <div class="drawer-header">
            <div>
              <p class="eyebrow">Elevated access</p>
              <h2 id="uwm-admin-tool-drawer-title">Canvas Admin Tools</h2>
            </div>
            <button class="close-button" type="button" aria-label="Close Canvas admin tools">×</button>
          </div>

          <div class="warning">
            <strong>Changes here can affect live Canvas data.</strong>
            <p>Read each tool carefully and confirm the target before taking an action.</p>
          </div>

          <div class="context-accordions" aria-label="Canvas tool contexts">
            <section class="accordion-item" data-context="admin">
              <button class="accordion-trigger" type="button" id="uwm-admin-context-trigger" aria-expanded="false" aria-controls="uwm-admin-context-panel">
                <span>Admin</span>
                <span class="accordion-chevron" aria-hidden="true">›</span>
              </button>
              <div class="accordion-panel" id="uwm-admin-context-panel" role="region" aria-labelledby="uwm-admin-context-trigger" hidden>
                <label class="context-label" for="uwm-admin-context-id">Canvas account ID</label>
                <input class="context-id" id="uwm-admin-context-id" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="Example: 49" value="${canvasContext.accountId}">
                <p class="context-help">${canvasContext.accountId ? 'Filled from the current Canvas account.' : 'Enter the account or subaccount ID for these tools.'}</p>

                <div class="admin-scope-filter">
                  <label class="scope-label" for="uwm-admin-published-only">
                    <input class="scope-checkbox" id="uwm-admin-published-only" type="checkbox" checked>
                    <span>Published courses only</span>
                  </label>
                </div>

                <div class="subaccordions" aria-label="Admin tool categories">
                  <section class="subaccordion-item" data-admin-category="courses">
                    <button class="subaccordion-trigger" type="button" id="uwm-admin-courses-trigger" aria-expanded="false" aria-controls="uwm-admin-courses-panel">
                      <span>Courses</span>
                      <span class="accordion-chevron" aria-hidden="true">›</span>
                    </button>
                    <div class="subaccordion-panel" id="uwm-admin-courses-panel" role="region" aria-labelledby="uwm-admin-courses-trigger" hidden>
                      <button class="report-trigger" id="uwm-navigation-links-report" type="button">Get all navigation links</button>
                      <p class="tool-description">Downloads one CSV row for every navigation tab in every course within the selected account scope.</p>

                      <div class="confirmation" id="uwm-navigation-links-confirmation" hidden>
                        <p id="uwm-navigation-links-confirmation-text"></p>
                        <div class="confirmation-actions">
                          <button class="confirmation-button primary" id="uwm-navigation-links-continue" type="button">Continue</button>
                          <button class="confirmation-button" id="uwm-navigation-links-cancel" type="button">Cancel</button>
                        </div>
                      </div>

                      <div class="run-status" id="uwm-navigation-links-status" role="status" aria-live="polite" hidden>
                        <progress class="run-progress" id="uwm-navigation-links-progress"></progress>
                        <p id="uwm-navigation-links-status-text"></p>
                      </div>
                    </div>
                  </section>

                  <section class="subaccordion-item" data-admin-category="people">
                    <button class="subaccordion-trigger" type="button" id="uwm-admin-people-trigger" aria-expanded="false" aria-controls="uwm-admin-people-panel">
                      <span>People</span>
                      <span class="accordion-chevron" aria-hidden="true">›</span>
                    </button>
                    <div class="subaccordion-panel" id="uwm-admin-people-panel" role="region" aria-labelledby="uwm-admin-people-trigger" hidden>
                      <p class="context-help">People tools will appear here.</p>
                    </div>
                  </section>

                  <section class="subaccordion-item" data-admin-category="subaccounts">
                    <button class="subaccordion-trigger" type="button" id="uwm-admin-subaccounts-trigger" aria-expanded="false" aria-controls="uwm-admin-subaccounts-panel">
                      <span>Sub-Accounts</span>
                      <span class="accordion-chevron" aria-hidden="true">›</span>
                    </button>
                    <div class="subaccordion-panel" id="uwm-admin-subaccounts-panel" role="region" aria-labelledby="uwm-admin-subaccounts-trigger" hidden>
                      <p class="context-help">Sub-account tools will appear here.</p>
                    </div>
                  </section>
                </div>
              </div>
            </section>

            <section class="accordion-item" data-context="course">
              <button class="accordion-trigger" type="button" id="uwm-course-context-trigger" aria-expanded="false" aria-controls="uwm-course-context-panel">
                <span>Course</span>
                <span class="accordion-chevron" aria-hidden="true">›</span>
              </button>
              <div class="accordion-panel" id="uwm-course-context-panel" role="region" aria-labelledby="uwm-course-context-trigger" hidden>
                <label class="context-label" for="uwm-course-context-id">Canvas course ID</label>
                <input class="context-id" id="uwm-course-context-id" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="Example: 900204" value="${canvasContext.courseId}">
                <p class="context-help">${canvasContext.courseId ? 'Filled from the current Canvas course.' : 'Enter the course ID for these tools.'}</p>
              </div>
            </section>

            <section class="accordion-item" data-context="page">
              <button class="accordion-trigger" type="button" id="uwm-page-context-trigger" aria-expanded="false" aria-controls="uwm-page-context-panel">
                <span>Page</span>
                <span class="accordion-chevron" aria-hidden="true">›</span>
              </button>
              <div class="accordion-panel" id="uwm-page-context-panel" role="region" aria-labelledby="uwm-page-context-trigger" hidden>
                <label class="context-label" for="uwm-page-context-id">Canvas page or object ID</label>
                <input class="context-id" id="uwm-page-context-id" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="Enter a Canvas ID" value="${canvasContext.pageId}">
                <p class="context-help">${canvasContext.pageType ? '<span class="context-kind">' + canvasContext.pageType + ' context detected.</span> ' : ''}${canvasContext.pageId ? 'The ID was filled from the current URL.' : 'Enter the numeric ID for the item these tools should use.'}</p>
              </div>
            </section>
          </div>
        </aside>
      </div>
    `;

    document.body.appendChild(host);

    const shell = shadowRoot.querySelector('.tool-drawer-shell');
    const launcher = shadowRoot.querySelector('.launcher');
    const backdrop = shadowRoot.querySelector('.backdrop');
    const drawer = shadowRoot.querySelector('.drawer');
    const closeButton = shadowRoot.querySelector('.close-button');
    const accordionItems = Array.from(shadowRoot.querySelectorAll('.accordion-item'));
    const contextInputs = Array.from(shadowRoot.querySelectorAll('.context-id'));
    const subaccordionItems = Array.from(shadowRoot.querySelectorAll('.subaccordion-item'));
    const adminContextInput = shadowRoot.querySelector('#uwm-admin-context-id');
    const publishedOnlyCheckbox = shadowRoot.querySelector('#uwm-admin-published-only');
    const navigationReportTrigger = shadowRoot.querySelector('#uwm-navigation-links-report');
    const navigationConfirmation = shadowRoot.querySelector('#uwm-navigation-links-confirmation');
    const navigationConfirmationText = shadowRoot.querySelector('#uwm-navigation-links-confirmation-text');
    const navigationContinue = shadowRoot.querySelector('#uwm-navigation-links-continue');
    const navigationCancel = shadowRoot.querySelector('#uwm-navigation-links-cancel');
    const navigationStatus = shadowRoot.querySelector('#uwm-navigation-links-status');
    const navigationStatusText = shadowRoot.querySelector('#uwm-navigation-links-status-text');
    const navigationProgress = shadowRoot.querySelector('#uwm-navigation-links-progress');

    let pendingNavigationScope = null;
    let navigationReportRunning = false;

    function openContext(contextName) {
      for (const item of accordionItems) {
        const isActive = item.dataset.context === contextName;
        const trigger = item.querySelector('.accordion-trigger');
        const panel = item.querySelector('.accordion-panel');

        item.classList.toggle('is-active', isActive);
        trigger.setAttribute('aria-expanded', String(isActive));
        panel.hidden = !isActive;
      }
    }

    for (const item of accordionItems) {
      item.querySelector('.accordion-trigger').addEventListener('click', () => {
        openContext(item.dataset.context);
      });
    }

    function openAdminCategory(categoryName) {
      for (const item of subaccordionItems) {
        const isActive = item.dataset.adminCategory === categoryName;
        const trigger = item.querySelector('.subaccordion-trigger');
        const panel = item.querySelector('.subaccordion-panel');

        item.classList.toggle('is-active', isActive);
        trigger.setAttribute('aria-expanded', String(isActive));
        panel.hidden = !isActive;
      }
    }

    for (const item of subaccordionItems) {
      item.querySelector('.subaccordion-trigger').addEventListener('click', () => {
        openAdminCategory(item.dataset.adminCategory);
      });
    }

    for (const input of contextInputs) {
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '');
        input.setCustomValidity('');
      });
    }

    openContext(canvasContext.activeContext);
    openAdminCategory('courses');

    function setAdminScopeLocked(isLocked) {
      adminContextInput.disabled = isLocked;
      publishedOnlyCheckbox.disabled = isLocked;
    }

    function showNavigationStatus(message, { isError = false } = {}) {
      navigationStatus.hidden = false;
      navigationStatus.classList.toggle('is-error', isError);
      navigationStatusText.textContent = message;
    }

    function resetNavigationConfirmation() {
      pendingNavigationScope = null;
      navigationConfirmation.hidden = true;
      navigationContinue.disabled = false;
      navigationCancel.disabled = false;
      navigationReportTrigger.disabled = false;
      setAdminScopeLocked(false);
    }

    function navigationUrl(tab) {
      const value = tab.full_url || tab.html_url || '';
      if (!value) return '';

      try {
        return new URL(value, window.location.origin).href;
      } catch {
        return value;
      }
    }

    function navigationRowsForCourse(course, tabs, scope, generatedAt) {
      const baseRow = {
        report_generated_at: generatedAt,
        scope_account_canvas_id: scope.accountId,
        published_courses_only: scope.publishedOnly,
        course_canvas_id: course.id ?? '',
        course_sis_id: course.sis_course_id ?? '',
        course_name: course.name ?? '',
        course_code: course.course_code ?? '',
        course_workflow_state: course.workflow_state ?? '',
        course_account_canvas_id: course.account_id ?? ''
      };

      if (!tabs.length) {
        return [{
          ...baseRow,
          status: 'no_navigation_tabs',
          error: ''
        }];
      }

      return tabs.map(tab => ({
        ...baseRow,
        navigation_id: tab.id ?? '',
        navigation_label: tab.label ?? '',
        navigation_type: tab.type ?? '',
        navigation_position: tab.position ?? '',
        navigation_hidden: Boolean(tab.hidden),
        navigation_visibility: tab.visibility ?? '',
        navigation_html_url: tab.html_url ?? '',
        navigation_full_url: navigationUrl(tab),
        status: 'ok',
        error: ''
      }));
    }

    async function runNavigationLinksReport(scope) {
      navigationReportRunning = true;
      navigationConfirmation.hidden = true;
      navigationStatus.classList.remove('is-error');
      navigationStatus.hidden = false;
      navigationProgress.removeAttribute('value');
      navigationProgress.removeAttribute('max');

      const courseParams = new URLSearchParams({ per_page: '100' });
      if (scope.publishedOnly) courseParams.set('published', 'true');

      try {
        navigationStatusText.textContent = 'Loading courses from Canvas…';

        const courses = await canvasApi.getAll(
          `/api/v1/accounts/${encodeURIComponent(scope.accountId)}/courses?${courseParams.toString()}`,
          {
            onPage: page => {
              const rateText = page.rateRemaining === null
                ? ''
                : ` Canvas quota remaining: ${page.rateRemaining}.`;
              navigationStatusText.textContent =
                `Loading courses: ${page.totalItems} found across ${page.pageNumber} page(s).${rateText}`;
            }
          }
        );

        navigationProgress.max = Math.max(1, courses.length);
        navigationProgress.value = 0;

        let completedCourses = 0;
        let linksFound = 0;
        let failedCourses = 0;
        const generatedAt = new Date().toISOString();
        const rowsByCourse = new Array(courses.length);

        await Promise.all(courses.map(async (course, index) => {
          try {
            const tabs = await canvasApi.getAll(
              `/api/v1/courses/${encodeURIComponent(String(course.id))}/tabs?per_page=100`
            );

            linksFound += tabs.length;
            rowsByCourse[index] = navigationRowsForCourse(
              course,
              tabs,
              scope,
              generatedAt
            );
          } catch (error) {
            failedCourses++;
            rowsByCourse[index] = [{
              report_generated_at: generatedAt,
              scope_account_canvas_id: scope.accountId,
              published_courses_only: scope.publishedOnly,
              course_canvas_id: course.id ?? '',
              course_sis_id: course.sis_course_id ?? '',
              course_name: course.name ?? '',
              course_code: course.course_code ?? '',
              course_workflow_state: course.workflow_state ?? '',
              course_account_canvas_id: course.account_id ?? '',
              status: 'error',
              error: error.message
            }];
          } finally {
            completedCourses++;
            navigationProgress.value = completedCourses;

            const apiState = canvasApi.state();
            const rateText = apiState.rateRemaining === null
              ? ''
              : ` Canvas quota remaining: ${apiState.rateRemaining}.`;
            navigationStatusText.textContent =
              `Courses checked: ${completedCourses} of ${courses.length}. ` +
              `Navigation links found: ${linksFound}. Errors: ${failedCourses}.${rateText}`;
          }
        }));

        const rows = rowsByCourse.flat();
        const scopeLabel = scope.publishedOnly ? 'published' : 'all';
        const filename =
          `canvas-navigation-links.account-${scope.accountId}.${scopeLabel}.` +
          `${timestampForFilename()}.csv`;

        downloadCsv({
          rows,
          columns: NAVIGATION_LINK_COLUMNS,
          filename
        });

        if (!courses.length) {
          navigationProgress.value = 1;
        }

        showNavigationStatus(
          `Complete. ${courses.length} course(s), ${linksFound} navigation link(s), ` +
          `${failedCourses} course error(s). CSV downloaded.`,
          { isError: failedCourses > 0 }
        );
      } catch (error) {
        console.error('Canvas navigation links report failed.', error);
        navigationProgress.removeAttribute('value');
        navigationProgress.removeAttribute('max');
        showNavigationStatus(`Report stopped: ${error.message}`, { isError: true });
      } finally {
        navigationReportRunning = false;
        pendingNavigationScope = null;
        navigationReportTrigger.disabled = false;
        navigationContinue.disabled = false;
        navigationCancel.disabled = false;
        setAdminScopeLocked(false);
      }
    }

    navigationReportTrigger.addEventListener('click', () => {
      if (navigationReportRunning || pendingNavigationScope) return;

      const accountId = adminContextInput.value.trim();
      if (!/^\d+$/.test(accountId)) {
        adminContextInput.setCustomValidity('Enter a numeric Canvas account ID.');
        adminContextInput.reportValidity();
        adminContextInput.focus();
        return;
      }

      pendingNavigationScope = {
        accountId,
        publishedOnly: publishedOnlyCheckbox.checked
      };

      const courseScopeText = pendingNavigationScope.publishedOnly
        ? 'all published courses'
        : 'all non-deleted courses';

      navigationReportTrigger.disabled = true;
      setAdminScopeLocked(true);
      navigationStatus.hidden = true;
      navigationConfirmationText.textContent =
        `Collect navigation links for ${courseScopeText} in account ` +
        `${pendingNavigationScope.accountId}? This may take a long time.`;
      navigationConfirmation.hidden = false;
      navigationContinue.focus();
    });

    navigationCancel.addEventListener('click', () => {
      if (navigationReportRunning) return;
      resetNavigationConfirmation();
      navigationReportTrigger.focus();
    });

    navigationContinue.addEventListener('click', () => {
      if (!pendingNavigationScope || navigationReportRunning) return;

      navigationContinue.disabled = true;
      navigationCancel.disabled = true;
      runNavigationLinksReport(pendingNavigationScope);
    });

    function setOpen(isOpen) {
      shell.classList.toggle('is-open', isOpen);
      launcher.setAttribute('aria-expanded', String(isOpen));
      drawer.setAttribute('aria-hidden', String(!isOpen));

      if (isOpen) {
        closeButton.focus();
      } else if (shadowRoot.activeElement !== launcher) {
        launcher.focus();
      }
    }

    launcher.addEventListener('click', () => {
      setOpen(launcher.getAttribute('aria-expanded') !== 'true');
    });

    backdrop.addEventListener('click', () => setOpen(false));
    closeButton.addEventListener('click', () => setOpen(false));

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && launcher.getAttribute('aria-expanded') === 'true') {
        setOpen(false);
      }
    });
  }

  async function initialize() {
    if (isCanvasApplicationPage() && await currentUserIsAccountAdmin()) {
      createToolDrawer();
    }
  }

  initialize();
})();
