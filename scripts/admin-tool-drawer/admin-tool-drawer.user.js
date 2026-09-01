// ==UserScript==
// @name         Canvas Admin Tool Drawer
// @namespace    https://uwm.edu/
// @version      0.14.1
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
    termsCacheKeyPrefix: 'uwm-canvas-admin-tool-drawer:terms:v2:',
    termsCacheTtlMs: 15 * 60 * 1000,
    holdingCourseIdKey: 'uwm-canvas-admin-tool-drawer:holding-course-id:v1',
    cloneReportCacheKeyPrefix: 'uwm-canvas-admin-tool-drawer:clone-report:v1:',
    cloneReportCacheTtlMs: 15 * 60 * 1000,
    cloneReportMinimumSections: 25,
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

  function readHoldingCourseId() {
    try {
      const value = window.localStorage.getItem(CONFIG.holdingCourseIdKey) || '';
      return /^\d+$/.test(value) ? value : '';
    } catch {
      return '';
    }
  }

  function saveHoldingCourseId(value) {
    try {
      if (value) window.localStorage.setItem(CONFIG.holdingCourseIdKey, value);
      else window.localStorage.removeItem(CONFIG.holdingCourseIdKey);
    } catch {
      // Persistence is optional. The common field still works for this page.
    }
  }

  function cloneReportCacheKey(accountId, termId) {
    return `${CONFIG.cloneReportCacheKeyPrefix}${accountId}:${termId}`;
  }

  function readCachedCloneReport(accountId, termId) {
    const key = cloneReportCacheKey(accountId, termId);
    try {
      const cached = JSON.parse(window.sessionStorage.getItem(key) || 'null');
      if (!cached?.reportId || cached.expiresAt <= Date.now()) {
        window.sessionStorage.removeItem(key);
        return null;
      }
      return cached;
    } catch {
      return null;
    }
  }

  function cacheCloneReport(accountId, termId, reportId) {
    try {
      window.sessionStorage.setItem(
        cloneReportCacheKey(accountId, termId),
        JSON.stringify({
          reportId,
          expiresAt: Date.now() + CONFIG.cloneReportCacheTtlMs
        })
      );
    } catch {
      // Report reuse is optional. A fresh report remains a safe fallback.
    }
  }

  function clearCachedCloneReport(accountId, termId) {
    try {
      window.sessionStorage.removeItem(cloneReportCacheKey(accountId, termId));
    } catch {
      // No action is required when storage is unavailable.
    }
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
      const { onPage, itemsKey, ...requestOptions } = options;
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
        const pageItems = itemsKey ? result.data?.[itemsKey] : result.data;
        if (!Array.isArray(pageItems)) {
          throw new Error(`Expected a paginated array from Canvas API: ${nextUrl}`);
        }

        pageNumber++;
        totalItems += pageItems.length;
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
          items: pageItems,
          pageNumber,
          pageItems: pageItems.length,
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

  function parseCsvText(text) {
    const matrix = [];
    let row = [];
    let cell = '';
    let inQuotes = false;

    for (let index = 0; index < text.length; index++) {
      const character = text[index];

      if (inQuotes) {
        if (character === '"') {
          if (text[index + 1] === '"') {
            cell += '"';
            index++;
          } else {
            inQuotes = false;
          }
        } else {
          cell += character;
        }
        continue;
      }

      if (character === '"' && cell === '') {
        inQuotes = true;
      } else if (character === ',') {
        row.push(cell);
        cell = '';
      } else if (character === '\n' || character === '\r') {
        if (character === '\r' && text[index + 1] === '\n') index++;
        row.push(cell);
        matrix.push(row);
        row = [];
        cell = '';
      } else {
        cell += character;
      }
    }

    if (inQuotes) throw new Error('The CSV ends inside a quoted field.');
    if (cell !== '' || row.length) {
      row.push(cell);
      matrix.push(row);
    }
    if (!matrix.length) throw new Error('The CSV is empty.');

    const headers = matrix.shift().map((header, index) => (
      index === 0 ? header.replace(/^\uFEFF/, '') : header
    ));
    if (headers.some(header => !header.trim())) {
      throw new Error('Every CSV column must have a header.');
    }
    const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
    if (duplicateHeaders.length) {
      throw new Error(`Duplicate CSV header: ${duplicateHeaders[0]}`);
    }

    const rows = matrix
      .filter(values => values.some(value => value !== ''))
      .map((values, index) => {
        const record = { 'input.row': index + 2 };
        for (let columnIndex = 0; columnIndex < headers.length; columnIndex++) {
          record[headers[columnIndex]] = values[columnIndex] ?? '';
        }
        return record;
      });

    return { headers, rows };
  }

  function parseCanvasBoolean(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'false') return false;
    if (normalized === 'true') return true;
    return null;
  }

  function canvasSectionId(value) {
    const identifier = String(value ?? '').trim();
    if (!identifier) throw new Error('Canvas section ID is blank.');
    if (!/^\d+$/.test(identifier)) throw new Error('Canvas section ID must be numeric.');
    return identifier;
  }

  function cloneSectionMarker(sourceSectionId) {
    return `[src ${sourceSectionId}]`;
  }

  function cloneSectionName(sourceSection) {
    const suffix = ` - Copy ${cloneSectionMarker(sourceSection.id)}`;
    const maximumNameLength = 255;
    const sourceName = String(sourceSection.name || `Section ${sourceSection.id}`).trim();
    return `${sourceName.slice(0, Math.max(1, maximumNameLength - suffix.length)).trimEnd()}${suffix}`;
  }

  function cloneSourceSectionId(sectionName) {
    return String(sectionName || '').match(/\[src (\d+)\]$/)?.[1] || '';
  }

  function enrollmentRoleKey(enrollment) {
    return [enrollment.type || '', enrollment.role_id || ''].join('|');
  }

  function enrollmentIdentityKey(enrollment) {
    return [
      enrollment.user_id || '',
      enrollment.type || '',
      enrollment.role_id || '',
      enrollment.associated_user_id || ''
    ].join('|');
  }

  function cloneSectionFromProvisioning(row) {
    return {
      id: row.canvas_section_id || '',
      sis_section_id: row.section_id || '',
      integration_id: row.integration_id || '',
      name: row.name || '',
      course_id: row.canvas_course_id || '',
      account_id: row.canvas_account_id || '',
      workflow_state: row.status || '',
      start_at: row.start_date || null,
      end_at: row.end_date || null
    };
  }

  function cloneEnrollmentFromProvisioning(row) {
    return {
      id: row.canvas_enrollment_id || '',
      user_id: row.canvas_user_id || '',
      type: row.base_role_type || '',
      role: row.role || row.base_role_type || '',
      role_id: row.role_id || '',
      enrollment_state: row.status || '',
      associated_user_id: row.canvas_associated_user_id || '',
      limit_privileges_to_course_section:
        parseCanvasBoolean(row.limit_section_privileges)
    };
  }

  function requireCsvHeaders(parsed, fileName, requiredHeaders) {
    const missingHeader = requiredHeaders.find(header => !parsed.headers.includes(header));
    if (missingHeader) {
      throw new Error(`${fileName} is missing the expected ${missingHeader} column.`);
    }
  }

  async function extractZipEntryTexts(arrayBuffer, expectedFileNames) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const expectedNames = new Map(expectedFileNames.map(fileName => (
      [fileName.toLowerCase(), fileName]
    )));
    const extracted = {};
    const minimumEocdOffset = Math.max(0, bytes.length - 65557);
    let eocdOffset = -1;

    for (let offset = bytes.length - 22; offset >= minimumEocdOffset; offset--) {
      if (view.getUint32(offset, true) === 0x06054b50) {
        eocdOffset = offset;
        break;
      }
    }
    if (eocdOffset < 0) throw new Error('Canvas report ZIP directory was not found.');

    const entryCount = view.getUint16(eocdOffset + 10, true);
    let directoryOffset = view.getUint32(eocdOffset + 16, true);
    const decoder = new TextDecoder();

    for (let index = 0; index < entryCount; index++) {
      if (view.getUint32(directoryOffset, true) !== 0x02014b50) {
        throw new Error('Canvas report ZIP directory is invalid.');
      }

      const compressionMethod = view.getUint16(directoryOffset + 10, true);
      const compressedSize = view.getUint32(directoryOffset + 20, true);
      const fileNameLength = view.getUint16(directoryOffset + 28, true);
      const extraLength = view.getUint16(directoryOffset + 30, true);
      const commentLength = view.getUint16(directoryOffset + 32, true);
      const localHeaderOffset = view.getUint32(directoryOffset + 42, true);
      const fileName = decoder.decode(
        bytes.slice(directoryOffset + 46, directoryOffset + 46 + fileNameLength)
      );

      const requestedName = expectedNames.get(fileName.split('/').pop()?.toLowerCase());
      if (requestedName) {
        if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
          throw new Error(`Canvas report ZIP entry is invalid: ${fileName}`);
        }
        const localNameLength = view.getUint16(localHeaderOffset + 26, true);
        const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
        const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
        const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);

        if (compressionMethod === 0) {
          extracted[requestedName] = decoder.decode(compressed);
        } else {
          if (compressionMethod !== 8 || typeof DecompressionStream !== 'function') {
            throw new Error(`Unsupported Canvas report ZIP compression method: ${compressionMethod}`);
          }

          const stream = new Blob([compressed])
            .stream()
            .pipeThrough(new DecompressionStream('deflate-raw'));
          extracted[requestedName] = decoder.decode(await new Response(stream).arrayBuffer());
        }
      }

      directoryOffset += 46 + fileNameLength + extraLength + commentLength;
    }

    const missingFileName = expectedFileNames.find(fileName => !(fileName in extracted));
    if (missingFileName) {
      throw new Error(`${missingFileName} was not included in the Canvas report.`);
    }
    return extracted;
  }

  async function canvasReportCsvFiles(report, fileNames) {
    const attachmentUrl = report?.attachment?.url;
    if (!attachmentUrl) throw new Error('Canvas completed the report without a download URL.');

    const url = new URL(attachmentUrl, window.location.origin);
    if (url.origin !== window.location.origin) {
      throw new Error('Canvas returned an unexpected report download origin.');
    }

    const response = await window.fetch(url.href, { credentials: 'same-origin' });
    if (!response.ok) {
      throw new Error(`Canvas report download failed with HTTP ${response.status}.`);
    }
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength < 4) {
      throw new Error('Canvas returned an empty or invalid report download.');
    }
    const signature = new DataView(arrayBuffer).getUint32(0, true);
    if (signature === 0x04034b50) {
      return extractZipEntryTexts(arrayBuffer, fileNames);
    }
    if (fileNames.length !== 1) {
      throw new Error('Canvas returned one CSV when multiple report files were expected.');
    }
    return { [fileNames[0]]: new TextDecoder().decode(arrayBuffer) };
  }

  async function canvasReportCsv(report, fileName) {
    const files = await canvasReportCsvFiles(report, [fileName]);
    return files[fileName];
  }

  const NAVIGATION_LINK_COLUMNS = [
    'run.generated_at',
    'scope.account_id',
    'scope.published',
    'scope.enrollment_term_ids',
    'scope.enrollment_term_names',
    'course.id',
    'course.sis_course_id',
    'course.name',
    'course.course_code',
    'course.workflow_state',
    'course.account_id',
    'course.enrollment_term_id',
    'term.id',
    'term.sis_term_id',
    'term.name',
    'tab.id',
    'tab.label',
    'tab.type',
    'tab.position',
    'tab.hidden',
    'tab.visibility',
    'tab.html_url',
    'tab.full_url',
    'tab.url',
    'tab.unused',
    'run.status',
    'run.error'
  ].map(key => ({ key, label: key }));

  const SECTION_REPORT_COLUMNS = [
    'input.row',
    'run.generated_at',
    'scope.account_id',
    'scope.published',
    'scope.report_type',
    'scope.enrollment_term_ids',
    'scope.enrollment_term_names',
    'match.class_number',
    'match.class_number_count',
    'course.id',
    'course.sis_course_id',
    'course.account_id',
    'course.enrollment_term_id',
    'term.id',
    'term.sis_term_id',
    'term.name',
    'section.id',
    'section.sis_section_id',
    'section.integration_id',
    'section.name',
    'section.workflow_state',
    'section.created_by_sis',
    'section.course_id',
    'section.sis_course_id',
    'section.start_at',
    'section.end_at',
    'account.id',
    'account.sis_account_id',
    'run.report_id',
    'run.status',
    'run.error'
  ].map(key => ({ key, label: key }));

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
    const holdingCourseId = readHoldingCourseId();
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
        .term-select:focus-visible,
        .field-select:focus-visible,
        .csv-file:focus-visible,
        .scope-checkbox:focus-visible,
        .role-checkbox:focus-visible,
        .report-trigger:focus-visible,
        .action-accordion-trigger:focus-visible,
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

        .account-scope-row {
          align-items: center;
          display: grid;
          gap: 12px;
          grid-template-columns: max-content minmax(0, 1fr);
        }

        .account-scope-row .context-label {
          margin: 0;
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

        .term-scope {
          margin-top: 13px;
        }

        .term-select {
          background: #fffaf4;
          border: 2px solid transparent;
          border-radius: 8px;
          color: #2a1012;
          font: inherit;
          font-size: 0.84rem;
          line-height: 1.35;
          min-height: 95px;
          padding: 5px;
          width: 100%;
        }

        .term-select:hover:not(:disabled) {
          border-color: rgb(244 185 66 / 70%);
        }

        .term-select:disabled {
          cursor: not-allowed;
          opacity: 0.65;
        }

        .term-status {
          color: var(--uwm-muted);
          font-size: 0.75rem;
          line-height: 1.4;
          margin: 7px 0 0;
        }

        .term-status.is-error {
          color: #ffd8dc;
        }

        .csv-scope {
          border-top: 1px solid rgb(244 185 66 / 25%);
          margin-top: 13px;
          padding-top: 13px;
        }

        .course-csv-scope {
          border-top: 0;
          margin-top: 0;
          padding-top: 0;
        }

        .course-actions {
          margin-top: 15px;
        }

        .scope-section-title {
          color: var(--uwm-text);
          font-size: 0.82rem;
          font-weight: 800;
          margin: 0 0 8px;
        }

        .csv-file {
          color: var(--uwm-muted);
          display: block;
          font: inherit;
          font-size: 0.78rem;
          max-width: 100%;
          width: 100%;
        }

        .csv-file::file-selector-button {
          background: transparent;
          border: 1px solid rgb(255 247 237 / 45%);
          border-radius: 7px;
          color: var(--uwm-text);
          cursor: pointer;
          font: inherit;
          font-weight: 800;
          margin-right: 8px;
          padding: 7px 9px;
        }

        .mapping-grid {
          display: grid;
          gap: 10px;
          margin-top: 11px;
        }

        .field-select {
          background: #fffaf4;
          border: 2px solid transparent;
          border-radius: 7px;
          color: #2a1012;
          font: inherit;
          font-size: 0.82rem;
          padding: 8px 9px;
          width: 100%;
        }

        .field-select:hover:not(:disabled) {
          border-color: rgb(244 185 66 / 70%);
        }

        .field-select:disabled {
          cursor: not-allowed;
          opacity: 0.65;
        }

        .field-label {
          color: var(--uwm-text);
          display: grid;
          font-size: 0.78rem;
          font-weight: 700;
          gap: 5px;
        }

        .csv-mappings[hidden],
        .action-accordion-panel[hidden],
        .analysis-summary[hidden] {
          display: none;
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

        .workflow-heading {
          color: var(--uwm-text);
          font-size: 0.86rem;
          font-weight: 800;
          line-height: 1.3;
          margin: 0;
        }

        .clone-stage {
          margin-top: 14px;
        }

        .clone-stage + .clone-stage {
          border-top: 1px solid rgb(255 247 237 / 14%);
          padding-top: 14px;
        }

        .clone-stage .mapping-grid {
          margin-top: 9px;
        }

        .clone-note {
          border-left: 3px solid rgb(244 185 66 / 55%);
          margin-top: 10px;
          padding-left: 9px;
        }

        .action-accordions {
          display: grid;
          gap: 8px;
        }

        .action-accordion-item {
          border: 1px solid rgb(255 247 237 / 17%);
          border-radius: 7px;
          overflow: hidden;
        }

        .action-accordion-item.is-active {
          border-color: rgb(244 185 66 / 38%);
        }

        .action-accordion-trigger {
          align-items: center;
          background: rgb(255 255 255 / 3%);
          border: 0;
          color: var(--uwm-text);
          cursor: pointer;
          display: flex;
          font: inherit;
          font-size: 0.83rem;
          font-weight: 800;
          justify-content: space-between;
          padding: 11px 12px;
          text-align: left;
          width: 100%;
        }

        .action-accordion-trigger:hover {
          background: rgb(255 255 255 / 7%);
        }

        .action-accordion-trigger[aria-expanded="true"] .accordion-chevron {
          transform: rotate(90deg);
        }

        .action-accordion-panel {
          background: rgb(0 0 0 / 12%);
          border-top: 1px solid rgb(255 247 237 / 12%);
          padding: 12px;
        }

        .action-button {
          background: var(--uwm-warning);
          border: 1px solid var(--uwm-warning);
          border-radius: 7px;
          color: #2a1012;
          cursor: pointer;
          font: inherit;
          font-size: 0.8rem;
          font-weight: 800;
          margin-top: 11px;
          padding: 8px 11px;
        }

        .action-button.secondary {
          background: transparent;
          border-color: rgb(255 247 237 / 45%);
          color: var(--uwm-text);
        }

        .action-button:disabled {
          cursor: not-allowed;
          opacity: 0.55;
        }

        .analysis-summary {
          background: rgb(244 185 66 / 8%);
          border: 1px solid rgb(244 185 66 / 28%);
          border-radius: 7px;
          margin-top: 11px;
          padding: 10px;
        }

        .clone-review {
          background: transparent;
          border: 0;
          border-top: 1px solid rgb(255 247 237 / 14%);
          border-radius: 0;
          margin-top: 15px;
          padding: 14px 0 0;
        }

        .clone-review > .workflow-heading {
          margin-bottom: 8px;
        }

        .analysis-summary p {
          color: var(--uwm-muted);
          font-size: 0.78rem;
          line-height: 1.45;
          margin: 0;
        }

        .role-selector {
          border: 1px solid rgb(244 185 66 / 28%);
          border-radius: 7px;
          display: grid;
          gap: 8px;
          margin: 11px 0 0;
          padding: 10px;
        }

        .role-selector[hidden] {
          display: none;
        }

        .role-selector legend {
          color: var(--uwm-text);
          font-size: 0.8rem;
          font-weight: 800;
          padding: 0 4px;
        }

        .role-option {
          align-items: flex-start;
          color: var(--uwm-text);
          cursor: pointer;
          display: flex;
          font-size: 0.78rem;
          gap: 8px;
          line-height: 1.35;
        }

        .role-checkbox {
          accent-color: var(--uwm-warning);
          flex: 0 0 auto;
          height: 16px;
          margin: 1px 0 0;
          width: 16px;
        }

        .role-count {
          color: var(--uwm-muted);
          font-weight: 400;
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

        .confirmation .workflow-heading,
        .run-status .workflow-heading {
          margin-bottom: 7px;
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

        .run-status[data-state="success"] {
          background: rgb(33 113 74 / 24%);
          border-color: rgb(102 204 153 / 58%);
        }

        .run-status[data-state="success"] .workflow-heading,
        .run-status[data-state="success"] p {
          color: #d8f7e7;
        }

        .run-status[data-state="working"] .workflow-heading {
          color: var(--uwm-warning);
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
                <div class="account-scope-row">
                  <label class="context-label" for="uwm-admin-context-id">Canvas account ID</label>
                  <input class="context-id" id="uwm-admin-context-id" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="Example: 49" value="${canvasContext.accountId}">
                </div>
                <p class="context-help">${canvasContext.accountId ? 'Filled from the current Canvas account.' : 'Enter the account or subaccount ID for these tools.'}</p>

                <div class="admin-scope-filter">
                  <label class="scope-label" for="uwm-admin-published-only">
                    <input class="scope-checkbox" id="uwm-admin-published-only" type="checkbox" checked>
                    <span>Published courses only</span>
                  </label>

                  <div class="term-scope">
                    <label class="context-label" for="uwm-admin-term-scope">Terms</label>
                    <select class="term-select" id="uwm-admin-term-scope" multiple disabled aria-describedby="uwm-admin-term-status">
                      <option>Enter an account ID to load terms</option>
                    </select>
                    <p class="term-status" id="uwm-admin-term-status">Current terms are selected automatically. Hold Ctrl or Command to select more than one.</p>
                  </div>

                  <div class="csv-scope">
                    <p class="scope-section-title">CSV input</p>
                    <input class="csv-file" id="uwm-admin-csv-file" type="file" accept=".csv,text/csv">
                    <p class="term-status" id="uwm-admin-csv-status">Optional. Upload a reusable input file; each action will ask for the columns it needs.</p>
                  </div>
                </div>

                <div class="subaccordions" aria-label="Admin tool categories">
                  <section class="subaccordion-item" data-admin-category="courses">
                    <button class="subaccordion-trigger" type="button" id="uwm-admin-courses-trigger" aria-expanded="false" aria-controls="uwm-admin-courses-panel">
                      <span>Courses</span>
                      <span class="accordion-chevron" aria-hidden="true">›</span>
                    </button>
                    <div class="subaccordion-panel" id="uwm-admin-courses-panel" role="region" aria-labelledby="uwm-admin-courses-trigger" hidden>
                      <div class="action-accordions" aria-label="Course actions">
                        <section class="action-accordion-item" data-course-action="navigation-report">
                          <button class="action-accordion-trigger" type="button" id="uwm-navigation-report-trigger" aria-expanded="false" aria-controls="uwm-navigation-report-panel">
                            <span>Get all navigation links</span>
                            <span class="accordion-chevron" aria-hidden="true">›</span>
                          </button>
                          <div class="action-accordion-panel" id="uwm-navigation-report-panel" role="region" aria-labelledby="uwm-navigation-report-trigger" hidden>
                            <button class="report-trigger" id="uwm-navigation-links-report" type="button">Prepare navigation report</button>
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

                        <section class="action-accordion-item" data-course-action="section-report">
                          <button class="action-accordion-trigger" type="button" id="uwm-section-report-trigger" aria-expanded="false" aria-controls="uwm-section-report-panel">
                            <span>Get sections and class numbers</span>
                            <span class="accordion-chevron" aria-hidden="true">›</span>
                          </button>
                          <div class="action-accordion-panel" id="uwm-section-report-panel" role="region" aria-labelledby="uwm-section-report-trigger" hidden>
                            <p class="tool-description">Matches class numbers in the uploaded CSV to a Canvas Provisioning section report for the selected account and terms. This search includes both published and unpublished courses; the Published courses only setting does not apply.</p>
                            <label class="field-label" for="uwm-section-class-number-column">
                              Class number column
                              <select class="field-select" id="uwm-section-class-number-column" disabled></select>
                            </label>
                            <p class="tool-description">The value is matched to the final five digits of the Canvas section SIS ID. Input rows and columns are preserved in the result.</p>
                            <button class="report-trigger" id="uwm-sections-report" type="button" disabled>Prepare section match</button>

                            <div class="confirmation" id="uwm-sections-confirmation" hidden>
                              <p id="uwm-sections-confirmation-text"></p>
                              <div class="confirmation-actions">
                                <button class="confirmation-button primary" id="uwm-sections-continue" type="button">Continue</button>
                                <button class="confirmation-button" id="uwm-sections-cancel" type="button">Cancel</button>
                              </div>
                            </div>

                            <div class="run-status" id="uwm-sections-status" role="status" aria-live="polite" hidden>
                              <progress class="run-progress" id="uwm-sections-progress"></progress>
                              <p id="uwm-sections-status-text"></p>
                            </div>
                          </div>
                        </section>

                        <section class="action-accordion-item" data-course-action="set-navigation-visibility">
                          <button class="action-accordion-trigger" type="button" id="uwm-enable-navigation-trigger" aria-expanded="false" aria-controls="uwm-enable-navigation-panel">
                            <span>Show or hide course navigation</span>
                            <span class="accordion-chevron" aria-hidden="true">›</span>
                          </button>
                          <div class="action-accordion-panel" id="uwm-enable-navigation-panel" role="region" aria-labelledby="uwm-enable-navigation-trigger" hidden>
                            <p class="tool-description">Uses the uploaded CSV to show or hide a selected navigation tab in each listed course. Analysis is read-only until you confirm the change plan.</p>
                            <div class="mapping-grid">
                              <label class="field-label" for="uwm-admin-csv-course-column">
                                Course ID column
                                <select class="field-select" id="uwm-admin-csv-course-column" disabled></select>
                              </label>
                              <label class="field-label" for="uwm-admin-csv-course-id-type">
                                Course ID type
                                <select class="field-select" id="uwm-admin-csv-course-id-type" disabled>
                                  <option value="canvas">Canvas course ID</option>
                                  <option value="sis">SIS course ID</option>
                                </select>
                              </label>
                              <label class="field-label" for="uwm-enable-navigation-tool-column">
                                Navigation tool ID column
                                <select class="field-select" id="uwm-enable-navigation-tool-column" disabled></select>
                              </label>
                              <label class="field-label" for="uwm-enable-navigation-value-column">
                                New hidden value column
                                <select class="field-select" id="uwm-enable-navigation-value-column" disabled></select>
                              </label>
                            </div>
                            <p class="tool-description">The tool column should contain a Canvas tab ID such as <code>context_external_tool_4</code>. The hidden value must be <code>false</code> to show the tab or <code>true</code> to hide it. Those are the only accepted values.</p>
                            <button class="action-button" id="uwm-enable-navigation-analyze" type="button" disabled>Analyze CSV</button>

                            <div class="analysis-summary" id="uwm-enable-navigation-analysis" hidden>
                              <p id="uwm-enable-navigation-analysis-text"></p>
                            </div>

                            <div class="confirmation" id="uwm-enable-navigation-confirmation" hidden>
                              <p id="uwm-enable-navigation-confirmation-text"></p>
                              <div class="confirmation-actions">
                                <button class="confirmation-button primary" id="uwm-enable-navigation-continue" type="button">Apply changes</button>
                                <button class="confirmation-button" id="uwm-enable-navigation-cancel" type="button">Cancel</button>
                              </div>
                            </div>

                            <div class="run-status" id="uwm-enable-navigation-status" role="status" aria-live="polite" hidden>
                              <progress class="run-progress" id="uwm-enable-navigation-progress"></progress>
                              <p id="uwm-enable-navigation-status-text"></p>
                            </div>
                          </div>
                        </section>
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
                <div class="account-scope-row">
                  <label class="context-label" for="uwm-course-context-id">Canvas course ID</label>
                  <input class="context-id" id="uwm-course-context-id" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="Example: 900204" value="${canvasContext.courseId}">
                </div>
                <p class="context-help">${canvasContext.courseId ? 'Filled from the current Canvas course.' : 'Enter the course ID for these tools.'}</p>

                <div class="account-scope-row">
                  <label class="context-label" for="uwm-course-holding-course-id">Holding-tank Canvas course ID</label>
                  <input class="context-id" id="uwm-course-holding-course-id" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="Example: 881410" value="${holdingCourseId}">
                </div>
                <p class="context-help">Shared by Course tools and saved for this Canvas site.</p>

                <div class="admin-scope-filter">
                  <div class="csv-scope course-csv-scope">
                    <p class="scope-section-title">CSV input</p>
                    <input class="csv-file" id="uwm-course-csv-file" type="file" accept=".csv,text/csv">
                    <p class="term-status" id="uwm-course-csv-status">Upload the source-section file; each course action will ask for the columns it needs.</p>
                  </div>
                </div>

                <div class="action-accordions course-actions" aria-label="Course-context actions">
                  <section class="action-accordion-item" data-course-action="clone-sections">
                    <button class="action-accordion-trigger" type="button" id="uwm-clone-sections-trigger" aria-expanded="false" aria-controls="uwm-clone-sections-panel">
                      <span>Clone or sync sections</span>
                      <span class="accordion-chevron" aria-hidden="true">›</span>
                    </button>
                    <div class="action-accordion-panel" id="uwm-clone-sections-panel" role="region" aria-labelledby="uwm-clone-sections-trigger" hidden>
                      <p class="tool-description">Copy or refresh source sections and their selected enrollments in this course.</p>

                      <section class="clone-stage" aria-labelledby="uwm-clone-source-heading">
                        <h4 class="workflow-heading" id="uwm-clone-source-heading">1. Choose the source sections</h4>
                        <div class="mapping-grid">
                          <label class="field-label" for="uwm-clone-source-section-column">
                            CSV column containing Canvas section IDs
                            <select class="field-select" id="uwm-clone-source-section-column" disabled></select>
                          </label>
                        </div>
                        <p class="tool-description clone-note">Use <code>section.id — Canvas section ID</code> from a section-match report.</p>
                      </section>

                      <section class="clone-stage" aria-labelledby="uwm-clone-options-heading">
                        <h4 class="workflow-heading" id="uwm-clone-options-heading">2. Choose enrollment options</h4>
                        <label class="scope-label" for="uwm-clone-limit-students" style="margin-top: 9px;">
                          <input class="scope-checkbox" id="uwm-clone-limit-students" type="checkbox" checked>
                          <span>Keep students limited to their cloned section</span>
                        </label>
                        <p class="tool-description">Student notifications stay off. Student section limits are on by default for FERPA protection.</p>
                      </section>

                      <button class="action-button" id="uwm-clone-sections-analyze" type="button" disabled>Review sync</button>

                      <div class="analysis-summary clone-review" id="uwm-clone-sections-analysis" hidden>
                        <h4 class="workflow-heading">3. Review and run</h4>
                        <p id="uwm-clone-sections-analysis-text"></p>

                        <fieldset class="role-selector" id="uwm-clone-role-selector" hidden>
                          <legend>Enrollments to synchronize</legend>
                          <div id="uwm-clone-role-options"></div>
                        </fieldset>

                        <div class="confirmation" id="uwm-clone-sections-confirmation" hidden>
                          <h4 class="workflow-heading">Ready to sync</h4>
                          <p id="uwm-clone-sections-confirmation-text"></p>
                          <div class="confirmation-actions">
                            <button class="confirmation-button primary" id="uwm-clone-sections-continue" type="button">Run sync</button>
                            <button class="confirmation-button" id="uwm-clone-sections-cancel" type="button">Start over</button>
                          </div>
                        </div>
                      </div>

                      <div class="run-status" id="uwm-clone-sections-status" role="status" aria-live="polite" data-state="working" hidden>
                        <h4 class="workflow-heading" id="uwm-clone-sections-status-heading">Working</h4>
                        <progress class="run-progress" id="uwm-clone-sections-progress"></progress>
                        <p id="uwm-clone-sections-status-text"></p>
                      </div>
                    </div>
                  </section>
                </div>
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
    const courseActionItems = Array.from(shadowRoot.querySelectorAll('.action-accordion-item'));
    const adminContextInput = shadowRoot.querySelector('#uwm-admin-context-id');
    const publishedOnlyCheckbox = shadowRoot.querySelector('#uwm-admin-published-only');
    const termSelect = shadowRoot.querySelector('#uwm-admin-term-scope');
    const termStatus = shadowRoot.querySelector('#uwm-admin-term-status');
    const csvFileInput = shadowRoot.querySelector('#uwm-admin-csv-file');
    const csvCourseColumn = shadowRoot.querySelector('#uwm-admin-csv-course-column');
    const csvCourseIdType = shadowRoot.querySelector('#uwm-admin-csv-course-id-type');
    const csvStatus = shadowRoot.querySelector('#uwm-admin-csv-status');
    const courseContextInput = shadowRoot.querySelector('#uwm-course-context-id');
    const courseHoldingCourseInput = shadowRoot.querySelector('#uwm-course-holding-course-id');
    const courseCsvFileInput = shadowRoot.querySelector('#uwm-course-csv-file');
    const courseCsvStatus = shadowRoot.querySelector('#uwm-course-csv-status');
    const navigationReportTrigger = shadowRoot.querySelector('#uwm-navigation-links-report');
    const navigationConfirmation = shadowRoot.querySelector('#uwm-navigation-links-confirmation');
    const navigationConfirmationText = shadowRoot.querySelector('#uwm-navigation-links-confirmation-text');
    const navigationContinue = shadowRoot.querySelector('#uwm-navigation-links-continue');
    const navigationCancel = shadowRoot.querySelector('#uwm-navigation-links-cancel');
    const navigationStatus = shadowRoot.querySelector('#uwm-navigation-links-status');
    const navigationStatusText = shadowRoot.querySelector('#uwm-navigation-links-status-text');
    const navigationProgress = shadowRoot.querySelector('#uwm-navigation-links-progress');
    const sectionReportTrigger = shadowRoot.querySelector('#uwm-sections-report');
    const sectionConfirmation = shadowRoot.querySelector('#uwm-sections-confirmation');
    const sectionConfirmationText = shadowRoot.querySelector('#uwm-sections-confirmation-text');
    const sectionContinue = shadowRoot.querySelector('#uwm-sections-continue');
    const sectionCancel = shadowRoot.querySelector('#uwm-sections-cancel');
    const sectionStatus = shadowRoot.querySelector('#uwm-sections-status');
    const sectionStatusText = shadowRoot.querySelector('#uwm-sections-status-text');
    const sectionProgress = shadowRoot.querySelector('#uwm-sections-progress');
    const sectionClassNumberColumn = shadowRoot.querySelector('#uwm-section-class-number-column');
    const enableNavigationToolColumn = shadowRoot.querySelector('#uwm-enable-navigation-tool-column');
    const enableNavigationValueColumn = shadowRoot.querySelector('#uwm-enable-navigation-value-column');
    const enableNavigationAnalyze = shadowRoot.querySelector('#uwm-enable-navigation-analyze');
    const enableNavigationAnalysis = shadowRoot.querySelector('#uwm-enable-navigation-analysis');
    const enableNavigationAnalysisText = shadowRoot.querySelector('#uwm-enable-navigation-analysis-text');
    const enableNavigationConfirmation = shadowRoot.querySelector('#uwm-enable-navigation-confirmation');
    const enableNavigationConfirmationText = shadowRoot.querySelector('#uwm-enable-navigation-confirmation-text');
    const enableNavigationContinue = shadowRoot.querySelector('#uwm-enable-navigation-continue');
    const enableNavigationCancel = shadowRoot.querySelector('#uwm-enable-navigation-cancel');
    const enableNavigationStatus = shadowRoot.querySelector('#uwm-enable-navigation-status');
    const enableNavigationProgress = shadowRoot.querySelector('#uwm-enable-navigation-progress');
    const enableNavigationStatusText = shadowRoot.querySelector('#uwm-enable-navigation-status-text');
    const cloneSourceSectionColumn = shadowRoot.querySelector('#uwm-clone-source-section-column');
    const cloneLimitStudents = shadowRoot.querySelector('#uwm-clone-limit-students');
    const cloneAnalyze = shadowRoot.querySelector('#uwm-clone-sections-analyze');
    const cloneAnalysis = shadowRoot.querySelector('#uwm-clone-sections-analysis');
    const cloneAnalysisText = shadowRoot.querySelector('#uwm-clone-sections-analysis-text');
    const cloneRoleSelector = shadowRoot.querySelector('#uwm-clone-role-selector');
    const cloneRoleOptions = shadowRoot.querySelector('#uwm-clone-role-options');
    const cloneConfirmation = shadowRoot.querySelector('#uwm-clone-sections-confirmation');
    const cloneConfirmationText = shadowRoot.querySelector('#uwm-clone-sections-confirmation-text');
    const cloneContinue = shadowRoot.querySelector('#uwm-clone-sections-continue');
    const cloneCancel = shadowRoot.querySelector('#uwm-clone-sections-cancel');
    const cloneStatus = shadowRoot.querySelector('#uwm-clone-sections-status');
    const cloneStatusHeading = shadowRoot.querySelector('#uwm-clone-sections-status-heading');
    const cloneProgress = shadowRoot.querySelector('#uwm-clone-sections-progress');
    const cloneStatusText = shadowRoot.querySelector('#uwm-clone-sections-status-text');

    let pendingNavigationScope = null;
    let navigationReportRunning = false;
    let pendingSectionScope = null;
    let sectionReportRunning = false;
    let adminScopeLocked = false;
    let csvScope = null;
    let enableNavigationPlan = null;
    let enableNavigationRunning = false;
    let courseCsvScope = null;
    let cloneAnalysisPlan = null;
    let cloneExecutionPlan = null;
    let cloneRunning = false;
    let courseScopeLocked = false;
    let availableTerms = [];
    let termsAccountId = '';
    let termsLoadSequence = 0;
    let termsLoadTimer = null;

    function termCacheKey(accountId) {
      return `${CONFIG.termsCacheKeyPrefix}${accountId}`;
    }

    function readCachedTerms(accountId) {
      try {
        const rawValue = window.sessionStorage.getItem(termCacheKey(accountId));
        if (!rawValue) return null;

        const cached = JSON.parse(rawValue);
        if (!Array.isArray(cached?.terms) || cached.expiresAt <= Date.now()) {
          window.sessionStorage.removeItem(termCacheKey(accountId));
          return null;
        }

        return cached;
      } catch {
        return null;
      }
    }

    function cacheTerms(accountId, rootAccountId, terms) {
      try {
        window.sessionStorage.setItem(termCacheKey(accountId), JSON.stringify({
          rootAccountId,
          terms,
          expiresAt: Date.now() + CONFIG.termsCacheTtlMs
        }));
      } catch {
        // A fresh request on the next page is safe if session storage is unavailable.
      }
    }

    function termTime(term, key) {
      const value = Date.parse(term[key]);
      return Number.isFinite(value) ? value : null;
    }

    function termGroup(term, now = Date.now()) {
      if (/^default term$/i.test(String(term.name || '').trim())) return 'default';

      const start = termTime(term, 'start_at');
      const end = termTime(term, 'end_at');
      if (start === null && end === null) return 'undated';
      if (start !== null && start > now) return 'future';
      if (end !== null && end < now) return 'past';
      return 'current';
    }

    function termOptionLabel(term) {
      return term.name || `Term ${term.id}`;
    }

    function appendTermGroup(label, terms) {
      if (!terms.length) return;

      const group = document.createElement('optgroup');
      group.label = label;
      for (const term of terms) {
        const option = document.createElement('option');
        option.value = String(term.id);
        option.textContent = termOptionLabel(term);
        group.appendChild(option);
      }
      termSelect.appendChild(group);
    }

    function sortTermsForGroup(groupName, terms) {
      return [...terms].sort((left, right) => {
        if (['current', 'future', 'past'].includes(groupName)) {
          const leftDate = termTime(left, 'start_at') ?? termTime(left, 'end_at') ?? Infinity;
          const rightDate = termTime(right, 'start_at') ?? termTime(right, 'end_at') ?? Infinity;
          return leftDate - rightDate || String(left.name || '').localeCompare(String(right.name || ''));
        }
        return String(left.name || '').localeCompare(String(right.name || ''));
      });
    }

    function renderTermOptions(terms) {
      const grouped = {
        default: [],
        current: [],
        future: [],
        past: [],
        undated: []
      };

      for (const term of terms) grouped[termGroup(term)].push(term);
      termSelect.replaceChildren();

      const broadGroup = document.createElement('optgroup');
      broadGroup.label = 'Flexible scope';
      const currentOption = document.createElement('option');
      currentOption.value = '__current__';
      currentOption.textContent = 'All Current Terms';
      currentOption.disabled = grouped.current.length === 0;
      broadGroup.appendChild(currentOption);
      const allOption = document.createElement('option');
      allOption.value = '__all__';
      allOption.textContent = 'All Terms';
      broadGroup.appendChild(allOption);
      for (const term of sortTermsForGroup('default', grouped.default)) {
        const option = document.createElement('option');
        option.value = String(term.id);
        option.textContent = termOptionLabel(term);
        broadGroup.appendChild(option);
      }
      termSelect.appendChild(broadGroup);

      appendTermGroup('Current Terms', sortTermsForGroup('current', grouped.current));
      appendTermGroup('Future Terms', sortTermsForGroup('future', grouped.future));
      appendTermGroup('Past Terms', sortTermsForGroup('past', grouped.past));
      appendTermGroup('Undated Terms', sortTermsForGroup('undated', grouped.undated));

      const defaultIds = new Set(grouped.default.map(term => String(term.id)));
      const currentTermsExist = grouped.current.length > 0;
      const preferredIds = currentTermsExist ? new Set(['__current__']) : defaultIds;
      const fallbackId = terms[0] ? String(terms[0].id) : '__all__';
      for (const option of termSelect.options) {
        option.selected = preferredIds.size
          ? preferredIds.has(option.value)
          : option.value === fallbackId;
      }

      termSelect.disabled = false;
      termStatus.classList.remove('is-error');
      termStatus.textContent = currentTermsExist
        ? `All Current Terms is selected (${grouped.current.length} term${grouped.current.length === 1 ? '' : 's'} today). Hold Ctrl or Command to add other terms.`
        : 'No current dated terms were found; a safer fallback was selected. Hold Ctrl or Command to select more than one.';
    }

    async function loadTermsForAccount(accountId) {
      const loadSequence = ++termsLoadSequence;
      availableTerms = [];
      termsAccountId = '';
      termSelect.disabled = true;
      termSelect.innerHTML = '<option>Loading terms…</option>';
      termStatus.classList.remove('is-error');
      termStatus.textContent = 'Loading term scope from Canvas…';

      try {
        let cached = readCachedTerms(accountId);
        if (!cached) {
          const accountResult = await canvasApi.get(
            `/api/v1/accounts/${encodeURIComponent(accountId)}`
          );
          const account = accountResult.data || {};
          const rootAccountId = String(
            account.root_account_id ||
            window.ENV?.DOMAIN_ROOT_ACCOUNT_ID ||
            window.ENV?.ROOT_ACCOUNT_ID ||
            account.id ||
            accountId
          );
          const params = new URLSearchParams({
            subaccount_id: accountId,
            per_page: '100'
          });
          const terms = await canvasApi.getAll(
            `/api/v1/accounts/${encodeURIComponent(rootAccountId)}/terms?${params.toString()}`,
            { itemsKey: 'enrollment_terms' }
          );
          const applicableTerms = terms.filter(term => term.used_in_subaccount === true);
          cached = { rootAccountId, terms: applicableTerms };
          cacheTerms(accountId, rootAccountId, applicableTerms);
        }

        if (loadSequence !== termsLoadSequence || adminContextInput.value.trim() !== accountId) return;

        availableTerms = cached.terms;
        termsAccountId = accountId;
        renderTermOptions(availableTerms);
      } catch (error) {
        if (loadSequence !== termsLoadSequence) return;
        console.error('Canvas Admin Tool Drawer could not load terms.', error);
        termSelect.innerHTML = '<option>Terms unavailable</option>';
        termSelect.disabled = true;
        termStatus.classList.add('is-error');
        termStatus.textContent = `Terms could not be loaded: ${error.message}`;
      }
    }

    function scheduleTermsLoad() {
      window.clearTimeout(termsLoadTimer);
      const accountId = adminContextInput.value.trim();
      if (!/^\d+$/.test(accountId)) {
        termsLoadSequence++;
        availableTerms = [];
        termsAccountId = '';
        termSelect.innerHTML = '<option>Enter an account ID to load terms</option>';
        termSelect.disabled = true;
        termStatus.classList.remove('is-error');
        termStatus.textContent = 'Current terms are selected automatically. Hold Ctrl or Command to select more than one.';
        return;
      }

      termsLoadTimer = window.setTimeout(() => loadTermsForAccount(accountId), 350);
    }

    function selectedTermScope() {
      const values = Array.from(termSelect.selectedOptions, option => option.value);
      if (values.includes('__all__')) {
        return { allTerms: true, terms: [], label: 'All Terms' };
      }

      const includesCurrent = values.includes('__current__');
      const selectedIds = new Set(values.filter(value => !value.startsWith('__')));
      if (includesCurrent) {
        for (const term of availableTerms) {
          if (termGroup(term) === 'current') selectedIds.add(String(term.id));
        }
      }
      const terms = availableTerms.filter(term => selectedIds.has(String(term.id)));
      const explicitTerms = terms.filter(term => !includesCurrent || termGroup(term) !== 'current');
      const labelParts = [];
      if (includesCurrent) labelParts.push('All Current Terms');
      labelParts.push(...explicitTerms.map(term => term.name || `Term ${term.id}`));
      return {
        allTerms: false,
        terms,
        label: labelParts.join(', ')
      };
    }

    function populateColumnSelect(select, headers, labelForHeader = header => header) {
      select.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Choose a CSV column';
      select.appendChild(placeholder);

      for (const header of headers) {
        const option = document.createElement('option');
        option.value = header;
        option.textContent = labelForHeader(header);
        select.appendChild(option);
      }

      select.value = '';
      select.disabled = false;
    }

    function resetEnableNavigationAnalysis() {
      enableNavigationPlan = null;
      enableNavigationAnalysis.hidden = true;
      enableNavigationConfirmation.hidden = true;
      enableNavigationStatus.hidden = true;
      enableNavigationContinue.disabled = false;
      enableNavigationCancel.disabled = false;
    }

    function resetSectionReport() {
      pendingSectionScope = null;
      sectionConfirmation.hidden = true;
      sectionStatus.hidden = true;
      sectionContinue.disabled = false;
      sectionCancel.disabled = false;
    }

    function resetCloneAnalysis({ keepStatus = false } = {}) {
      cloneAnalysisPlan = null;
      cloneExecutionPlan = null;
      cloneAnalysis.hidden = true;
      cloneRoleSelector.hidden = true;
      cloneRoleOptions.replaceChildren();
      cloneConfirmation.hidden = true;
      cloneContinue.disabled = false;
      cloneCancel.disabled = false;
      if (!keepStatus) cloneStatus.hidden = true;
    }

    function selectedCloneRoleKeys() {
      return new Set(Array.from(
        cloneRoleOptions.querySelectorAll('.role-checkbox:checked'),
        checkbox => checkbox.value
      ));
    }

    function refreshCloneAvailability() {
      const hasCsv = Boolean(courseCsvScope?.rows.length);
      const destinationIsValid = /^\d+$/.test(courseContextInput.value.trim());
      const holdingIsValid = /^\d+$/.test(courseHoldingCourseInput.value.trim());
      cloneSourceSectionColumn.disabled = courseScopeLocked || !hasCsv;
      courseHoldingCourseInput.disabled = courseScopeLocked;
      cloneLimitStudents.disabled = courseScopeLocked;
      courseCsvFileInput.disabled = courseScopeLocked;
      cloneAnalyze.disabled = courseScopeLocked || cloneRunning || !hasCsv ||
        !cloneSourceSectionColumn.value || !destinationIsValid || !holdingIsValid;
      cloneContinue.disabled = courseScopeLocked || cloneRunning || !cloneExecutionPlan;
    }

    function setCourseScopeLocked(isLocked) {
      courseScopeLocked = isLocked;
      courseContextInput.disabled = isLocked;
      refreshCloneAvailability();
      for (const checkbox of cloneRoleOptions.querySelectorAll('.role-checkbox')) {
        checkbox.disabled = isLocked;
      }
    }

    async function loadCourseCsvScope(file) {
      resetCloneAnalysis();
      courseCsvScope = null;

      if (!file) {
        courseCsvStatus.classList.remove('is-error');
        courseCsvStatus.textContent =
          'Upload the source-section file; each course action will ask for the columns it needs.';
        refreshCloneAvailability();
        return;
      }

      if (file.size > 25 * 1024 * 1024) {
        courseCsvStatus.classList.add('is-error');
        courseCsvStatus.textContent = 'The CSV is larger than the 25 MB safety limit.';
        refreshCloneAvailability();
        return;
      }

      courseCsvStatus.classList.remove('is-error');
      courseCsvStatus.textContent = `Reading ${file.name}…`;
      try {
        const parsed = parseCsvText(await file.text());
        if (!parsed.rows.length) throw new Error('The CSV has headers but no data rows.');
        courseCsvScope = {
          fileName: file.name,
          headers: parsed.headers,
          rows: parsed.rows
        };
        populateColumnSelect(cloneSourceSectionColumn, parsed.headers, header => {
          if (header === 'section.id') return 'section.id — Canvas section ID';
          if (header === 'section.sis_section_id') {
            return 'section.sis_section_id — SIS section ID';
          }
          return header;
        });
        courseCsvStatus.textContent =
          `${file.name}: ${parsed.rows.length} data row(s), ${parsed.headers.length} column(s).`;
      } catch (error) {
        console.error('Canvas Admin Tool Drawer could not parse the course CSV.', error);
        courseCsvStatus.classList.add('is-error');
        courseCsvStatus.textContent = `CSV could not be used: ${error.message}`;
      }
      refreshCloneAvailability();
    }

    function refreshCsvActionAvailability() {
      const hasCsv = Boolean(csvScope?.rows.length);
      csvCourseColumn.disabled = adminScopeLocked || !hasCsv;
      csvCourseIdType.disabled = adminScopeLocked || !hasCsv;
      sectionClassNumberColumn.disabled = adminScopeLocked || !hasCsv;
      sectionReportTrigger.disabled = adminScopeLocked || !hasCsv ||
        !sectionClassNumberColumn.value || sectionReportRunning;
      enableNavigationToolColumn.disabled = adminScopeLocked || !hasCsv;
      enableNavigationValueColumn.disabled = adminScopeLocked || !hasCsv;
      enableNavigationAnalyze.disabled = adminScopeLocked || !hasCsv ||
        !csvCourseColumn.value ||
        !enableNavigationToolColumn.value ||
        !enableNavigationValueColumn.value ||
        enableNavigationRunning;
    }

    async function loadCsvScope(file) {
      resetEnableNavigationAnalysis();
      resetSectionReport();
      csvScope = null;

      if (!file) {
        csvStatus.classList.remove('is-error');
        csvStatus.textContent = 'Optional. Upload a reusable input file; each action will ask for the columns it needs.';
        refreshCsvActionAvailability();
        return;
      }

      if (file.size > 25 * 1024 * 1024) {
        csvStatus.classList.add('is-error');
        csvStatus.textContent = 'The CSV is larger than the 25 MB safety limit.';
        refreshCsvActionAvailability();
        return;
      }

      csvStatus.classList.remove('is-error');
      csvStatus.textContent = `Reading ${file.name}…`;

      try {
        const parsed = parseCsvText(await file.text());
        if (!parsed.rows.length) throw new Error('The CSV has headers but no data rows.');

        csvScope = {
          fileName: file.name,
          headers: parsed.headers,
          rows: parsed.rows
        };

        populateColumnSelect(
          csvCourseColumn,
          parsed.headers
        );
        populateColumnSelect(
          sectionClassNumberColumn,
          parsed.headers
        );
        populateColumnSelect(
          enableNavigationToolColumn,
          parsed.headers
        );
        populateColumnSelect(
          enableNavigationValueColumn,
          parsed.headers
        );

        if (/sis_course_id/i.test(csvCourseColumn.value)) {
          csvCourseIdType.value = 'sis';
        } else {
          csvCourseIdType.value = 'canvas';
        }

        csvStatus.textContent =
          `${file.name}: ${parsed.rows.length} data row(s), ${parsed.headers.length} column(s).`;
        refreshCsvActionAvailability();
      } catch (error) {
        console.error('Canvas Admin Tool Drawer could not parse the CSV.', error);
        csvStatus.classList.add('is-error');
        csvStatus.textContent = `CSV could not be used: ${error.message}`;
        refreshCsvActionAvailability();
      }
    }

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

    function openCourseAction(actionName) {
      for (const item of courseActionItems) {
        const isActive = item.dataset.courseAction === actionName;
        const trigger = item.querySelector('.action-accordion-trigger');
        const panel = item.querySelector('.action-accordion-panel');

        item.classList.toggle('is-active', isActive);
        trigger.setAttribute('aria-expanded', String(isActive));
        panel.hidden = !isActive;
      }
    }

    for (const item of courseActionItems) {
      item.querySelector('.action-accordion-trigger').addEventListener('click', () => {
        const isOpen = item.classList.contains('is-active');
        openCourseAction(isOpen ? '' : item.dataset.courseAction);
      });
    }

    for (const input of contextInputs) {
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '');
        input.setCustomValidity('');
      });
    }

    adminContextInput.addEventListener('input', scheduleTermsLoad);
    csvFileInput.addEventListener('change', () => loadCsvScope(csvFileInput.files?.[0]));
    courseCsvFileInput.addEventListener('change', () => loadCourseCsvScope(courseCsvFileInput.files?.[0]));
    for (const input of [courseContextInput, courseHoldingCourseInput]) {
      input.addEventListener('input', () => {
        if (input === courseHoldingCourseInput) saveHoldingCourseId(input.value.trim());
        resetCloneAnalysis();
        refreshCloneAvailability();
      });
    }
    for (const select of [cloneSourceSectionColumn]) {
      select.addEventListener('change', () => {
        resetCloneAnalysis();
        refreshCloneAvailability();
      });
    }
    cloneLimitStudents.addEventListener('change', () => {
      if (cloneAnalysisPlan) refreshCloneExecutionReview();
    });
    for (const select of [
      csvCourseColumn,
      csvCourseIdType,
      sectionClassNumberColumn,
      enableNavigationToolColumn,
      enableNavigationValueColumn
    ]) {
      select.addEventListener('change', () => {
        if (select === csvCourseColumn) {
          csvCourseIdType.value = /sis_course_id/i.test(csvCourseColumn.value) ? 'sis' : 'canvas';
        }
        if (select === sectionClassNumberColumn) resetSectionReport();
        else resetEnableNavigationAnalysis();
        refreshCsvActionAvailability();
      });
    }
    termSelect.addEventListener('change', () => {
      const selected = Array.from(termSelect.selectedOptions);
      const allTermsOption = selected.find(option => option.value === '__all__');
      if (allTermsOption && selected.length > 1) {
        for (const option of termSelect.options) option.selected = option === allTermsOption;
      }

      const scope = selectedTermScope();
      termStatus.classList.remove('is-error');
      termStatus.textContent = scope.label
        ? `Selected: ${scope.label}. Hold Ctrl or Command to select more than one.`
        : 'Select at least one term scope.';
    });

    openContext(canvasContext.activeContext);
    openAdminCategory('courses');
    scheduleTermsLoad();

    function setAdminScopeLocked(isLocked) {
      adminScopeLocked = isLocked;
      adminContextInput.disabled = isLocked;
      publishedOnlyCheckbox.disabled = isLocked;
      navigationReportTrigger.disabled = isLocked;
      csvFileInput.disabled = isLocked;
      termSelect.disabled = isLocked ||
        termsAccountId !== adminContextInput.value.trim() ||
        !availableTerms.length;
      refreshCsvActionAvailability();
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

    function navigationRowsForCourse(course, tabs, scope, generatedAt) {
      const courseTerm = scope.termById.get(String(course.enrollment_term_id)) || {};
      const baseRow = {
        'run.generated_at': generatedAt,
        'scope.account_id': scope.accountId,
        'scope.published': scope.publishedOnly,
        'scope.enrollment_term_ids': scope.allTerms
          ? 'all'
          : scope.terms.map(term => term.id).join('|'),
        'scope.enrollment_term_names': scope.termLabel,
        'course.id': course.id ?? '',
        'course.sis_course_id': course.sis_course_id ?? '',
        'course.name': course.name ?? '',
        'course.course_code': course.course_code ?? '',
        'course.workflow_state': course.workflow_state ?? '',
        'course.account_id': course.account_id ?? '',
        'course.enrollment_term_id': course.enrollment_term_id ?? '',
        'term.id': courseTerm.id ?? course.enrollment_term_id ?? '',
        'term.sis_term_id': courseTerm.sis_term_id ?? '',
        'term.name': courseTerm.name ?? course.term?.name ?? ''
      };

      if (!tabs.length) {
        return [{
          ...baseRow,
          'run.status': 'no_navigation_tabs',
          'run.error': ''
        }];
      }

      return tabs.map(tab => ({
        ...baseRow,
        'tab.id': tab.id ?? '',
        'tab.label': tab.label ?? '',
        'tab.type': tab.type ?? '',
        'tab.position': tab.position ?? '',
        'tab.hidden': Boolean(tab.hidden),
        'tab.visibility': tab.visibility ?? '',
        'tab.html_url': tab.html_url ?? '',
        'tab.full_url': tab.full_url ?? '',
        'tab.url': tab.url ?? '',
        'tab.unused': Boolean(tab.unused),
        'run.status': 'ok',
        'run.error': ''
      }));
    }

    async function runNavigationLinksReport(scope) {
      navigationReportRunning = true;
      navigationConfirmation.hidden = true;
      navigationStatus.classList.remove('is-error');
      navigationStatus.hidden = false;
      navigationProgress.removeAttribute('value');
      navigationProgress.removeAttribute('max');

      try {
        navigationStatusText.textContent = 'Loading courses from Canvas…';

        let loadedCourseCount = 0;
        let loadedCoursePages = 0;
        const termRequests = scope.allTerms ? [null] : scope.terms;
        const courseLists = await Promise.all(termRequests.map(async term => {
          const courseParams = new URLSearchParams({ per_page: '100' });
          courseParams.append('include[]', 'term');
          if (scope.publishedOnly) courseParams.set('published', 'true');
          if (term) courseParams.set('enrollment_term_id', String(term.id));

          return canvasApi.getAll(
            `/api/v1/accounts/${encodeURIComponent(scope.accountId)}/courses?${courseParams.toString()}`,
            {
              onPage: page => {
                loadedCourseCount += page.pageItems;
                loadedCoursePages++;
                const rateText = page.rateRemaining === null
                  ? ''
                  : ` Canvas quota remaining: ${page.rateRemaining}.`;
                navigationStatusText.textContent =
                  `Loading courses: ${loadedCourseCount} found across ${loadedCoursePages} page(s).${rateText}`;
              }
            }
          );
        }));
        const courses = Array.from(
          new Map(courseLists.flat().map(course => [String(course.id), course])).values()
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
              'run.generated_at': generatedAt,
              'scope.account_id': scope.accountId,
              'scope.published': scope.publishedOnly,
              'scope.enrollment_term_ids': scope.allTerms
                ? 'all'
                : scope.terms.map(term => term.id).join('|'),
              'scope.enrollment_term_names': scope.termLabel,
              'course.id': course.id ?? '',
              'course.sis_course_id': course.sis_course_id ?? '',
              'course.name': course.name ?? '',
              'course.course_code': course.course_code ?? '',
              'course.workflow_state': course.workflow_state ?? '',
              'course.account_id': course.account_id ?? '',
              'course.enrollment_term_id': course.enrollment_term_id ?? '',
              'term.id': scope.termById.get(String(course.enrollment_term_id))?.id ?? course.enrollment_term_id ?? '',
              'term.sis_term_id':
                scope.termById.get(String(course.enrollment_term_id))?.sis_term_id ?? '',
              'term.name':
                scope.termById.get(String(course.enrollment_term_id))?.name ?? course.term?.name ?? '',
              'run.status': 'error',
              'run.error': error.message
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
        const publicationLabel = scope.publishedOnly ? 'pub' : 'unpub';
        const filename =
          `nav.acct-${scope.accountId}.${publicationLabel}.${timestampForFilename()}.csv`;

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
      if (navigationReportRunning || sectionReportRunning || pendingNavigationScope ||
        pendingSectionScope || enableNavigationRunning || cloneRunning || cloneExecutionPlan) return;

      const accountId = adminContextInput.value.trim();
      if (!/^\d+$/.test(accountId)) {
        adminContextInput.setCustomValidity('Enter a numeric Canvas account ID.');
        adminContextInput.reportValidity();
        adminContextInput.focus();
        return;
      }

      if (termSelect.disabled || termsAccountId !== accountId) {
        termStatus.classList.add('is-error');
        termStatus.textContent = 'Wait for the terms for this account to finish loading.';
        return;
      }

      const termScope = selectedTermScope();
      if (!termScope.allTerms && !termScope.terms.length) {
        termStatus.classList.add('is-error');
        termStatus.textContent = 'Select at least one term scope before starting the report.';
        termSelect.focus();
        return;
      }

      pendingNavigationScope = {
        accountId,
        publishedOnly: publishedOnlyCheckbox.checked,
        allTerms: termScope.allTerms,
        terms: termScope.terms,
        termLabel: termScope.label,
        termById: new Map(availableTerms.map(term => [String(term.id), term]))
      };

      const courseScopeText = pendingNavigationScope.publishedOnly
        ? 'all published courses'
        : 'all non-deleted courses';

      navigationReportTrigger.disabled = true;
      setAdminScopeLocked(true);
      navigationStatus.hidden = true;
      navigationConfirmationText.textContent =
        `Collect navigation links for ${courseScopeText} in ${pendingNavigationScope.termLabel} for account ` +
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

    function sectionClassNumber(sisSectionId) {
      return String(sisSectionId ?? '').trim().match(/(\d{5})$/)?.[1] || '';
    }

    function normalizeInputClassNumber(value) {
      const normalized = String(value ?? '').trim();
      return /^\d{5}$/.test(normalized) ? normalized : '';
    }

    function sectionReportScopeFields(scope, generatedAt) {
      return {
        'run.generated_at': generatedAt,
        'scope.account_id': scope.accountId,
        'scope.published': false,
        'scope.report_type': 'provisioning_csv',
        'scope.enrollment_term_ids': scope.allTerms
          ? 'all'
          : scope.terms.map(term => term.id).join('|'),
        'scope.enrollment_term_names': scope.termLabel
      };
    }

    function sectionReportRowFromProvisioning(row, term, scope, generatedAt, reportId) {
      const sisSectionId = row.section_id ?? '';
      const classNumber = sectionClassNumber(sisSectionId);
      return {
        ...sectionReportScopeFields(scope, generatedAt),
        'match.class_number': classNumber,
        'match.class_number_count': '',
        'course.id': row.canvas_course_id ?? '',
        'course.sis_course_id': row.course_id ?? '',
        'course.account_id': row.canvas_account_id ?? '',
        'course.enrollment_term_id': term?.id ?? '',
        'term.id': term?.id ?? '',
        'term.sis_term_id': term?.sis_term_id ?? '',
        'term.name': term?.name ?? (scope.allTerms ? 'All Terms' : ''),
        'section.id': row.canvas_section_id ?? '',
        'section.sis_section_id': sisSectionId,
        'section.integration_id': row.integration_id ?? '',
        'section.name': row.name ?? '',
        'section.workflow_state': row.status ?? '',
        'section.created_by_sis': row.created_by_sis ?? '',
        'section.course_id': row.canvas_course_id ?? '',
        'section.sis_course_id': row.course_id ?? '',
        'section.start_at': row.start_date ?? '',
        'section.end_at': row.end_date ?? '',
        'account.id': row.canvas_account_id ?? '',
        'account.sis_account_id': row.account_id ?? '',
        'run.report_id': reportId,
        'run.status': classNumber ? 'candidate' : 'missing_class_number',
        'run.error': classNumber
          ? ''
          : 'The section SIS ID is missing or does not end in five digits.'
      };
    }

    async function waitForCanvasReport(accountId, reportId, onProgress) {
      const deadline = Date.now() + (2 * 60 * 60 * 1000);
      while (Date.now() < deadline) {
        const result = await canvasApi.get(
          `/api/v1/accounts/${encodeURIComponent(accountId)}/reports/provisioning_csv/${encodeURIComponent(reportId)}`
        );
        const report = result.data || {};
        if (typeof onProgress === 'function') onProgress(report);
        if (report.status === 'complete') return report;
        if (['error', 'errored', 'failed', 'aborted', 'canceled', 'cancelled'].includes(
          String(report.status).toLowerCase()
        )) {
          throw new Error(report.message || `Canvas report ended with status ${report.status}.`);
        }
        await new Promise(resolve => window.setTimeout(resolve, 3000));
      }
      throw new Error('Canvas provisioning report did not finish within two hours.');
    }

    async function provisioningSectionRows(scope, term, reportIndex, reportCount, generatedAt) {
      const body = { 'parameters[sections]': '1' };
      if (term) body['parameters[enrollment_term_id]'] = String(term.id);
      const termName = term?.name || 'All Terms';
      const created = await canvasApi.request(
        `/api/v1/accounts/${encodeURIComponent(scope.accountId)}/reports/provisioning_csv`,
        { method: 'POST', body }
      );
      const reportId = created.data?.id;
      if (!reportId) throw new Error('Canvas did not return an ID for the section report.');

      const report = await waitForCanvasReport(scope.accountId, reportId, current => {
        const progress = Number(current.progress);
        sectionProgress.value = ((reportIndex - 1) * 100) +
          (Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0);
        showSectionStatus(
          `Canvas report ${reportIndex} of ${reportCount}: ${termName}. ` +
          `Status: ${current.status || 'queued'}${Number.isFinite(progress) ? ` (${progress}%).` : '.'}`
        );
      });
      showSectionStatus(`Downloading Canvas section report ${reportIndex} of ${reportCount}: ${termName}.`);
      const parsed = parseCsvText(await canvasReportCsv(report, 'sections.csv'));
      const requiredHeaders = ['canvas_section_id', 'section_id', 'canvas_course_id', 'course_id'];
      const missingHeader = requiredHeaders.find(header => !parsed.headers.includes(header));
      if (missingHeader) {
        throw new Error(`Canvas sections.csv is missing the expected ${missingHeader} column.`);
      }
      sectionProgress.value = reportIndex * 100;
      return parsed.rows.map(row => (
        sectionReportRowFromProvisioning(row, term, scope, generatedAt, reportId)
      ));
    }

    function showSectionStatus(message, { isError = false } = {}) {
      sectionStatus.hidden = false;
      sectionStatus.classList.toggle('is-error', isError);
      sectionStatusText.textContent = message;
    }

    function resetSectionConfirmation() {
      pendingSectionScope = null;
      sectionConfirmation.hidden = true;
      sectionContinue.disabled = false;
      sectionCancel.disabled = false;
      setAdminScopeLocked(false);
    }

    async function runSectionReport(scope) {
      sectionReportRunning = true;
      sectionConfirmation.hidden = true;
      sectionStatus.classList.remove('is-error');
      sectionStatus.hidden = false;
      sectionProgress.removeAttribute('value');
      sectionProgress.removeAttribute('max');

      try {
        const reportRequests = scope.allTerms ? [null] : scope.terms;
        sectionProgress.max = Math.max(1, reportRequests.length * 100);
        sectionProgress.value = 0;
        const generatedAt = new Date().toISOString();
        const sectionRows = [];
        const reportErrorRows = [];
        let failedReports = 0;

        for (let index = 0; index < reportRequests.length; index++) {
          const term = reportRequests[index];
          try {
            sectionRows.push(...await provisioningSectionRows(
              scope,
              term,
              index + 1,
              reportRequests.length,
              generatedAt
            ));
          } catch (error) {
            failedReports++;
            sectionProgress.value = (index + 1) * 100;
            reportErrorRows.push({
              ...sectionReportScopeFields(scope, generatedAt),
              'match.class_number': '',
              'match.class_number_count': '',
              'term.id': term?.id ?? '',
              'term.sis_term_id': term?.sis_term_id ?? '',
              'term.name': term?.name ?? (scope.allTerms ? 'All Terms' : ''),
              'run.report_id': '',
              'run.status': 'report_error',
              'run.error': error.message
            });
          }
        }

        const sectionsByClassNumber = new Map();
        for (const row of sectionRows) {
          const classNumber = row['match.class_number'];
          if (!classNumber) continue;
          const matches = sectionsByClassNumber.get(classNumber) || [];
          matches.push(row);
          sectionsByClassNumber.set(classNumber, matches);
        }

        let matchedInputRows = 0;
        let unmatchedInputRows = 0;
        let ambiguousInputRows = 0;
        let invalidInputRows = 0;
        const rows = [];
        for (const inputRow of scope.inputRows) {
          const rawClassNumber = inputRow[scope.classNumberColumn];
          const classNumber = normalizeInputClassNumber(rawClassNumber);
          if (!classNumber) {
            invalidInputRows++;
            rows.push({
              ...inputRow,
              ...sectionReportScopeFields(scope, generatedAt),
              'match.class_number': '',
              'match.class_number_count': 0,
              'run.status': 'invalid_class_number',
              'run.error': `Expected exactly five digits; received: ${rawClassNumber ?? ''}`
            });
            continue;
          }

          const matches = sectionsByClassNumber.get(classNumber) || [];
          if (!matches.length) {
            unmatchedInputRows++;
            rows.push({
              ...inputRow,
              ...sectionReportScopeFields(scope, generatedAt),
              'match.class_number': classNumber,
              'match.class_number_count': 0,
              'run.status': failedReports ? 'no_match_in_incomplete_scope' : 'no_match',
              'run.error': failedReports
                ? `${failedReports} Canvas section report(s) failed; this no-match result is incomplete.`
                : ''
            });
            continue;
          }

          if (matches.length > 1) ambiguousInputRows++;
          else matchedInputRows++;
          for (const match of matches) {
            rows.push({
              ...inputRow,
              ...match,
              'match.class_number_count': matches.length,
              'run.status': matches.length > 1 ? 'multiple_matches' : 'matched',
              'run.error': ''
            });
          }
        }

        rows.push(...reportErrorRows);

        const outputColumnNames = [...scope.sourceHeaders];
        for (const column of SECTION_REPORT_COLUMNS) {
          if (!outputColumnNames.includes(column.key)) outputColumnNames.push(column.key);
        }
        downloadCsv({
          rows,
          columns: outputColumnNames.map(key => ({ key, label: key })),
          filename: `sec-match.acct-${scope.accountId}.unpub.${timestampForFilename()}.csv`
        });

        if (!reportRequests.length) sectionProgress.value = 1;
        showSectionStatus(
          `Complete. ${scope.inputRows.length} input row(s): ${matchedInputRows} matched, ` +
          `${ambiguousInputRows} with multiple matches, ${unmatchedInputRows} unmatched, ` +
          `${invalidInputRows} invalid. ${sectionRows.length} Canvas section row(s) loaded; ` +
          `${failedReports} report error(s). CSV downloaded.`,
          { isError: failedReports > 0 }
        );
      } catch (error) {
        console.error('Canvas section report failed.', error);
        sectionProgress.removeAttribute('value');
        sectionProgress.removeAttribute('max');
        showSectionStatus(`Report stopped: ${error.message}`, { isError: true });
      } finally {
        sectionReportRunning = false;
        pendingSectionScope = null;
        sectionContinue.disabled = false;
        sectionCancel.disabled = false;
        setAdminScopeLocked(false);
      }
    }

    sectionReportTrigger.addEventListener('click', () => {
      if (navigationReportRunning || sectionReportRunning || pendingNavigationScope ||
        pendingSectionScope || enableNavigationRunning || cloneRunning || cloneExecutionPlan ||
        !csvScope) return;

      const classNumberColumn = sectionClassNumberColumn.value;
      if (!classNumberColumn) {
        showSectionStatus('Choose the CSV class number column before preparing the match.', {
          isError: true
        });
        sectionClassNumberColumn.focus();
        return;
      }

      const accountId = adminContextInput.value.trim();
      if (!/^\d+$/.test(accountId)) {
        adminContextInput.setCustomValidity('Enter a numeric Canvas account ID.');
        adminContextInput.reportValidity();
        adminContextInput.focus();
        return;
      }
      if (termSelect.disabled || termsAccountId !== accountId) {
        termStatus.classList.add('is-error');
        termStatus.textContent = 'Wait for the terms for this account to finish loading.';
        return;
      }

      const termScope = selectedTermScope();
      if (!termScope.allTerms && !termScope.terms.length) {
        termStatus.classList.add('is-error');
        termStatus.textContent = 'Select at least one term scope before starting the report.';
        termSelect.focus();
        return;
      }

      pendingSectionScope = {
        accountId,
        allTerms: termScope.allTerms,
        terms: termScope.terms,
        termLabel: termScope.label,
        sourceHeaders: [...csvScope.headers],
        inputRows: csvScope.rows.map(row => ({ ...row })),
        classNumberColumn
      };
      setAdminScopeLocked(true);
      sectionStatus.hidden = true;
      sectionConfirmationText.textContent =
        `Match ${pendingSectionScope.inputRows.length} CSV row(s) against the Canvas Provisioning ` +
        `section data for ${pendingSectionScope.termLabel} in account ${pendingSectionScope.accountId}? ` +
        `The published-only setting is ignored. Canvas will generate one Provisioning section report ` +
        `for each selected term.`;
      sectionConfirmation.hidden = false;
      sectionContinue.focus();
    });

    sectionCancel.addEventListener('click', () => {
      if (sectionReportRunning) return;
      resetSectionConfirmation();
      sectionReportTrigger.focus();
    });

    sectionContinue.addEventListener('click', () => {
      if (!pendingSectionScope || sectionReportRunning) return;
      sectionContinue.disabled = true;
      sectionCancel.disabled = true;
      runSectionReport(pendingSectionScope);
    });

    function courseApiIdentifier(value, idType) {
      const identifier = String(value ?? '').trim();
      if (!identifier) throw new Error('Course ID is blank.');
      if (idType === 'canvas') {
        if (!/^\d+$/.test(identifier)) throw new Error('Canvas course ID must be numeric.');
        return identifier;
      }
      return `sis_course_id:${identifier}`;
    }

    function enableNavigationCounts(entries) {
      const counts = {
        willShow: 0,
        willHide: 0,
        shown: 0,
        hidden: 0,
        alreadyShown: 0,
        alreadyHidden: 0,
        unavailable: 0,
        invalid: 0,
        duplicate: 0,
        errors: 0
      };

      for (const entry of entries) {
        if (entry.status === 'will_show') counts.willShow++;
        else if (entry.status === 'will_hide') counts.willHide++;
        else if (entry.status === 'shown') counts.shown++;
        else if (entry.status === 'hidden') counts.hidden++;
        else if (entry.status === 'already_shown') counts.alreadyShown++;
        else if (entry.status === 'already_hidden') counts.alreadyHidden++;
        else if (entry.status === 'unavailable') counts.unavailable++;
        else if (entry.status === 'invalid') counts.invalid++;
        else if (entry.status === 'duplicate') counts.duplicate++;
        else if (entry.status === 'error') counts.errors++;
      }
      return counts;
    }

    function enableNavigationSummaryText(entries) {
      const counts = enableNavigationCounts(entries);
      const changedText = counts.shown || counts.hidden
        ? `${counts.shown} shown, ${counts.hidden} hidden, `
        : '';
      return `${entries.length} CSV row(s): ${changedText}${counts.willShow} will be shown, ` +
        `${counts.willHide} will be hidden, ${counts.alreadyShown} already shown, ` +
        `${counts.alreadyHidden} already hidden, ${counts.unavailable} unavailable, ` +
        `${counts.invalid} invalid, ${counts.duplicate} duplicate, ${counts.errors} API error(s).`;
    }

    function showEnableNavigationStatus(message, { isError = false } = {}) {
      enableNavigationStatus.hidden = false;
      enableNavigationStatus.classList.toggle('is-error', isError);
      enableNavigationStatusText.textContent = message;
    }

    async function analyzeEnableNavigation() {
      if (enableNavigationRunning || navigationReportRunning || sectionReportRunning || cloneRunning ||
        cloneExecutionPlan || !csvScope) return;

      const courseColumn = csvCourseColumn.value;
      const toolColumn = enableNavigationToolColumn.value;
      const valueColumn = enableNavigationValueColumn.value;
      if (!courseColumn || !toolColumn || !valueColumn) {
        showEnableNavigationStatus('Choose all three CSV columns before analyzing.', { isError: true });
        return;
      }

      enableNavigationRunning = true;
      enableNavigationPlan = null;
      enableNavigationAnalysis.hidden = true;
      enableNavigationConfirmation.hidden = true;
      enableNavigationStatus.classList.remove('is-error');
      enableNavigationProgress.removeAttribute('value');
      enableNavigationProgress.removeAttribute('max');
      showEnableNavigationStatus('Validating CSV rows…');
      navigationReportTrigger.disabled = true;
      setAdminScopeLocked(true);

      try {
        const entries = csvScope.rows.map((row, index) => {
          const entry = {
            index,
            row,
            courseValue: String(row[courseColumn] ?? '').trim(),
            tabId: String(row[toolColumn] ?? '').trim(),
            desiredHidden: parseCanvasBoolean(row[valueColumn]),
            status: '',
            error: '',
            tab: null
          };

          try {
            entry.courseRef = courseApiIdentifier(entry.courseValue, csvCourseIdType.value);
            if (!entry.tabId) throw new Error('Navigation tool ID is blank.');
            if (entry.desiredHidden === null) {
              throw new Error(`New hidden value must be true or false; received: ${row[valueColumn] ?? ''}`);
            }
          } catch (error) {
            entry.status = 'invalid';
            entry.error = error.message;
          }

          return entry;
        });

        const firstByTarget = new Map();
        for (const entry of entries) {
          if (entry.status) continue;
          const targetKey = `${entry.courseRef}\u0000${entry.tabId}`;
          if (firstByTarget.has(targetKey)) {
            const first = firstByTarget.get(targetKey);
            if (first.desiredHidden !== entry.desiredHidden) {
              const message = `Conflicting hidden values for the same course and tab in CSV rows ${first.row['input.row']} and ${entry.row['input.row']}.`;
              first.status = 'invalid';
              first.error = message;
              entry.status = 'invalid';
              entry.error = message;
            } else {
              entry.status = 'duplicate';
              entry.error = `Duplicates CSV row ${first.row['input.row']}.`;
            }
          } else {
            firstByTarget.set(targetKey, entry);
          }
        }

        const courseRefs = Array.from(new Set(
          entries.filter(entry => !entry.status).map(entry => entry.courseRef)
        ));
        const tabsByCourse = new Map();
        let analyzedCourses = 0;
        enableNavigationProgress.max = Math.max(1, courseRefs.length);
        enableNavigationProgress.value = 0;

        await Promise.all(courseRefs.map(async courseRef => {
          try {
            const tabs = await canvasApi.getAll(
              `/api/v1/courses/${encodeURIComponent(courseRef)}/tabs?per_page=100`
            );
            tabsByCourse.set(courseRef, { tabs, error: null });
          } catch (error) {
            tabsByCourse.set(courseRef, { tabs: [], error });
          } finally {
            analyzedCourses++;
            enableNavigationProgress.value = analyzedCourses;
            showEnableNavigationStatus(
              `Analyzing courses: ${analyzedCourses} of ${courseRefs.length}.`
            );
          }
        }));

        for (const entry of entries) {
          if (entry.status) continue;
          const courseResult = tabsByCourse.get(entry.courseRef);
          if (courseResult?.error) {
            entry.status = 'error';
            entry.error = courseResult.error.message;
            continue;
          }

          const tab = courseResult?.tabs.find(candidate => String(candidate.id) === entry.tabId);
          if (!tab) {
            entry.status = 'unavailable';
            entry.error = 'The navigation tool is not available in this course.';
            continue;
          }
          entry.tab = tab;

          if (['home', 'settings'].includes(entry.tabId)) {
            entry.status = 'unavailable';
            entry.error = 'Canvas does not allow this navigation tab to be hidden or moved.';
          } else if (entry.desiredHidden === true && tab.hidden === true) {
            entry.status = 'already_hidden';
          } else if (entry.desiredHidden === true) {
            entry.status = 'will_hide';
          } else if (tab.hidden === true) {
            entry.status = 'will_show';
          } else {
            entry.status = 'already_shown';
          }
        }

        enableNavigationPlan = {
          sourceFileName: csvScope.fileName,
          sourceHeaders: [...csvScope.headers],
          entries
        };
        const summaryText = enableNavigationSummaryText(entries);
        const counts = enableNavigationCounts(entries);
        enableNavigationAnalysisText.textContent = summaryText;
        enableNavigationAnalysis.hidden = false;
        showEnableNavigationStatus('Read-only analysis complete.');

        const changeCount = counts.willShow + counts.willHide;
        if (changeCount > 0) {
          enableNavigationConfirmationText.textContent =
            `Apply ${changeCount} navigation change(s) now: show ${counts.willShow} and hide ${counts.willHide}? Unchanged, unavailable, invalid, duplicate, and failed rows will not be written.`;
          enableNavigationConfirmation.hidden = false;
          enableNavigationContinue.focus();
        } else {
          setAdminScopeLocked(false);
          navigationReportTrigger.disabled = false;
        }
      } catch (error) {
        console.error('Navigation visibility analysis failed.', error);
        enableNavigationPlan = null;
        enableNavigationProgress.removeAttribute('value');
        enableNavigationProgress.removeAttribute('max');
        showEnableNavigationStatus(`Analysis stopped: ${error.message}`, { isError: true });
        setAdminScopeLocked(false);
        navigationReportTrigger.disabled = false;
      } finally {
        enableNavigationRunning = false;
        if (enableNavigationConfirmation.hidden) refreshCsvActionAvailability();
      }
    }

    function navigationActionResultRows(plan) {
      const tabKeys = Array.from(new Set([
        'hidden',
        'unused',
        ...plan.entries.flatMap(entry => Object.keys(entry.tab || {}))
      ])).sort();
      const generatedColumns = [
        'input.row',
        'run.action',
        'run.completed_at',
        'run.status',
        'run.error',
        ...tabKeys.map(key => `tab.${key}`)
      ];
      const columnNames = [...plan.sourceHeaders];
      for (const key of generatedColumns) {
        if (!columnNames.includes(key)) columnNames.push(key);
      }

      const completedAt = new Date().toISOString();
      const rows = plan.entries.map(entry => {
        const row = {
          ...entry.row,
          'run.action': 'set_navigation_hidden',
          'run.completed_at': completedAt,
          'run.status': entry.status,
          'run.error': entry.error || ''
        };
        for (const [key, value] of Object.entries(entry.tab || {})) {
          row[`tab.${key}`] = value;
        }
        if (entry.tab) {
          row['tab.hidden'] = entry.tab.hidden === true;
          row['tab.unused'] = entry.tab.unused === true;
        }
        return row;
      });

      return {
        rows,
        columns: columnNames.map(key => ({ key, label: key }))
      };
    }

    async function executeEnableNavigation() {
      if (!enableNavigationPlan || enableNavigationRunning) return;

      enableNavigationRunning = true;
      enableNavigationConfirmation.hidden = true;
      enableNavigationContinue.disabled = true;
      enableNavigationCancel.disabled = true;
      const changes = enableNavigationPlan.entries.filter(entry => (
        entry.status === 'will_show' || entry.status === 'will_hide'
      ));
      let completed = 0;
      let succeeded = 0;
      let failed = 0;
      enableNavigationProgress.max = Math.max(1, changes.length);
      enableNavigationProgress.value = 0;
      showEnableNavigationStatus(`Updating navigation: 0 of ${changes.length}.`);

      try {
        await Promise.all(changes.map(async entry => {
          try {
            const result = await canvasApi.request(
              `/api/v1/courses/${encodeURIComponent(entry.courseRef)}/tabs/${encodeURIComponent(entry.tabId)}`,
              { method: 'PUT', body: { hidden: String(entry.desiredHidden) } }
            );
            entry.tab = result.data || entry.tab;
            entry.status = entry.desiredHidden ? 'hidden' : 'shown';
            entry.error = '';
            succeeded++;
          } catch (error) {
            entry.status = 'error';
            entry.error = error.message;
            failed++;
          } finally {
            completed++;
            enableNavigationProgress.value = completed;
            const apiState = canvasApi.state();
            const rateText = apiState.rateRemaining === null
              ? ''
              : ` Canvas quota remaining: ${apiState.rateRemaining}.`;
            showEnableNavigationStatus(
              `Updating navigation: ${completed} of ${changes.length}. ` +
              `Succeeded: ${succeeded}. Errors: ${failed}.${rateText}`,
              { isError: failed > 0 }
            );
          }
        }));

        const output = navigationActionResultRows(enableNavigationPlan);
        const baseName = enableNavigationPlan.sourceFileName
          .replace(/\.csv$/i, '')
          .replace(/[^a-z0-9._-]+/gi, '-');
        downloadCsv({
          ...output,
          filename: `${baseName || 'canvas-courses'}.set-navigation-hidden.${timestampForFilename()}.csv`
        });

        enableNavigationAnalysisText.textContent = enableNavigationSummaryText(enableNavigationPlan.entries);
        enableNavigationAnalysis.hidden = false;
        showEnableNavigationStatus(
          `Complete. ${succeeded} navigation tab(s) updated; ${failed} error(s). Results CSV downloaded.`,
          { isError: failed > 0 }
        );
      } catch (error) {
        console.error('Navigation visibility action failed.', error);
        showEnableNavigationStatus(`Action stopped: ${error.message}`, { isError: true });
      } finally {
        enableNavigationRunning = false;
        enableNavigationContinue.disabled = false;
        enableNavigationCancel.disabled = false;
        navigationReportTrigger.disabled = false;
        setAdminScopeLocked(false);
        refreshCsvActionAvailability();
      }
    }

    enableNavigationAnalyze.addEventListener('click', analyzeEnableNavigation);

    enableNavigationCancel.addEventListener('click', () => {
      if (enableNavigationRunning) return;
      enableNavigationPlan = null;
      enableNavigationConfirmation.hidden = true;
      setAdminScopeLocked(false);
      navigationReportTrigger.disabled = false;
      refreshCsvActionAvailability();
      enableNavigationAnalyze.focus();
    });

    enableNavigationContinue.addEventListener('click', executeEnableNavigation);

    function showCloneStatus(message, { isError = false, state = null, heading = '' } = {}) {
      cloneStatus.hidden = false;
      cloneStatus.classList.toggle('is-error', isError);
      if (state || isError) cloneStatus.dataset.state = isError ? 'error' : state;
      if (heading) cloneStatusHeading.textContent = heading;
      cloneStatusText.textContent = message;
    }

    function cloneEnrollmentPath(sectionId) {
      const params = new URLSearchParams({ per_page: '100' });
      params.append('state[]', 'active');
      params.append('state[]', 'invited');
      return `/api/v1/sections/${encodeURIComponent(String(sectionId))}/enrollments?${params.toString()}`;
    }

    function cloneProvisioningScope(row) {
      const accountId = String(row['scope.account_id'] ?? '').trim();
      const termId = String(
        row['term.id'] ?? row['course.enrollment_term_id'] ?? ''
      ).trim();
      if (!/^\d+$/.test(accountId) || !/^\d+$/.test(termId)) return null;
      return { accountId, termId, key: `${accountId}:${termId}` };
    }

    async function cloneProvisioningData(accountId, termId) {
      let report = null;
      const cached = readCachedCloneReport(accountId, termId);
      if (cached) {
        try {
          const cachedResult = await canvasApi.get(
            `/api/v1/accounts/${encodeURIComponent(accountId)}/reports/provisioning_csv/` +
            `${encodeURIComponent(String(cached.reportId))}`
          );
          report = cachedResult.data || null;
          if (
            !report?.id ||
            ['error', 'errored', 'failed', 'aborted', 'canceled', 'cancelled'].includes(
              String(report.status).toLowerCase()
            )
          ) {
            report = null;
            clearCachedCloneReport(accountId, termId);
          }
        } catch {
          report = null;
          clearCachedCloneReport(accountId, termId);
        }
      }

      if (!report) {
        const created = await canvasApi.request(
          `/api/v1/accounts/${encodeURIComponent(accountId)}/reports/provisioning_csv`,
          {
            method: 'POST',
            body: {
              'parameters[sections]': '1',
              'parameters[enrollments]': '1',
              'parameters[enrollment_term_id]': termId,
              'parameters[enrollment_states][]': ['active', 'invited']
            }
          }
        );
        report = created.data || {};
        if (!report.id) throw new Error('Canvas did not return an enrollment report ID.');
        cacheCloneReport(accountId, termId, report.id);
      }

      if (report.status !== 'complete') {
        report = await waitForCanvasReport(accountId, report.id, current => {
          const progress = Number(current.progress);
          showCloneStatus(
            `Canvas enrollment report for account ${accountId}, term ${termId}: ` +
            `${current.status || 'queued'}${Number.isFinite(progress) ? ` (${progress}%).` : '.'}`
          );
        });
      }
      cacheCloneReport(accountId, termId, report.id);

      showCloneStatus(
        `Downloading Canvas enrollment report for account ${accountId}, term ${termId}.`
      );
      const files = await canvasReportCsvFiles(report, ['sections.csv', 'enrollments.csv']);
      const sections = parseCsvText(files['sections.csv']);
      const enrollments = parseCsvText(files['enrollments.csv']);
      requireCsvHeaders(sections, 'sections.csv', [
        'canvas_section_id',
        'canvas_course_id',
        'name',
        'status'
      ]);
      requireCsvHeaders(enrollments, 'enrollments.csv', [
        'canvas_enrollment_id',
        'canvas_section_id',
        'canvas_user_id',
        'role_id',
        'base_role_type',
        'status',
        'canvas_associated_user_id',
        'limit_section_privileges'
      ]);

      const sectionsById = new Map();
      for (const row of sections.rows) {
        if (!/^\d+$/.test(String(row.canvas_section_id || ''))) continue;
        sectionsById.set(String(row.canvas_section_id), cloneSectionFromProvisioning(row));
      }

      const enrollmentsBySectionId = new Map();
      for (const row of enrollments.rows) {
        const sectionId = String(row.canvas_section_id || '');
        if (!/^\d+$/.test(sectionId) || !['active', 'invited'].includes(row.status)) continue;
        const enrollment = cloneEnrollmentFromProvisioning(row);
        if (!enrollment.id || !enrollment.user_id || !enrollment.type || !enrollment.role_id) {
          throw new Error('enrollments.csv contains a row without required Canvas enrollment fields.');
        }
        const sectionEnrollments = enrollmentsBySectionId.get(sectionId) || [];
        sectionEnrollments.push(enrollment);
        enrollmentsBySectionId.set(sectionId, sectionEnrollments);
      }

      return {
        reportId: report.id,
        sectionsById,
        enrollmentsBySectionId
      };
    }

    function cloneRoleDefinitions(entries) {
      const definitions = new Map();
      for (const entry of entries) {
        for (const [location, enrollments] of [
          ['source', entry.sourceEnrollments || []],
          ['clone', entry.cloneEnrollments || []]
        ]) {
          for (const enrollment of enrollments) {
            const key = enrollmentRoleKey(enrollment);
            const definition = definitions.get(key) || {
              key,
              type: enrollment.type || '',
              roleId: enrollment.role_id || '',
              label: enrollment.role || enrollment.type || 'Unknown role',
              sourceCount: 0,
              cloneCount: 0,
              active: 0,
              invited: 0
            };
            if (location === 'source') {
              definition.sourceCount++;
              if (enrollment.enrollment_state === 'active') definition.active++;
              if (enrollment.enrollment_state === 'invited') definition.invited++;
            } else {
              definition.cloneCount++;
            }
            definitions.set(key, definition);
          }
        }
      }
      return Array.from(definitions.values()).sort((left, right) => (
        left.type.localeCompare(right.type) || left.label.localeCompare(right.label)
      ));
    }

    function renderCloneRoleOptions(roles) {
      cloneRoleOptions.replaceChildren();
      for (const role of roles) {
        const label = document.createElement('label');
        label.className = 'role-option';
        const checkbox = document.createElement('input');
        checkbox.className = 'role-checkbox';
        checkbox.type = 'checkbox';
        checkbox.value = role.key;
        checkbox.checked = role.type === 'StudentEnrollment';
        const text = document.createElement('span');
        const roleDetails = role.label === role.type
          ? role.label
          : `${role.label} (${role.type})`;
        text.textContent = `${roleDetails} `;
        const count = document.createElement('span');
        count.className = 'role-count';
        count.textContent = `${role.sourceCount} source (${role.active} active, ` +
          `${role.invited} invited); ${role.cloneCount} currently in managed clones`;
        text.appendChild(count);
        label.append(checkbox, text);
        cloneRoleOptions.appendChild(label);
        checkbox.addEventListener('change', () => {
          refreshCloneExecutionReview();
        });
      }
      cloneRoleSelector.hidden = roles.length === 0;
    }

    function classifyClone(entry, destinationSections, holdingSections, holdingCourseId) {
      const sourceId = String(entry.sourceSection.id);
      const destinationMatches = destinationSections.filter(section => (
        cloneSourceSectionId(section.name) === sourceId
      ));
      const holdingMatches = holdingSections.filter(section => (
        cloneSourceSectionId(section.name) === sourceId
      ));
      const validDestination = destinationMatches.filter(section => (
        String(section.nonxlist_course_id || '') === holdingCourseId
      ));
      const invalidDestination = destinationMatches.filter(section => (
        String(section.nonxlist_course_id || '') !== holdingCourseId
      ));

      if (invalidDestination.length || validDestination.length + holdingMatches.length > 1) {
        entry.cloneState = 'ambiguous';
        entry.status = 'ambiguous_clone';
        entry.error = invalidDestination.length
          ? 'A matching source marker exists in the destination but was not cross-listed from the selected holding course.'
          : 'More than one matching clone exists across the destination and holding courses.';
        return;
      }
      if (validDestination.length === 1) {
        entry.cloneState = 'existing';
        entry.cloneSection = validDestination[0];
        return;
      }
      if (holdingMatches.length === 1) {
        entry.cloneState = 'resumable';
        entry.cloneSection = holdingMatches[0];
        return;
      }
      entry.cloneState = 'new';
      entry.cloneSection = null;
    }

    function cloneAnalysisSummary(entries) {
      const uniqueEntries = entries.filter(entry => entry.status !== 'duplicate_source');
      const count = state => uniqueEntries.filter(entry => entry.cloneState === state).length;
      const errors = uniqueEntries.filter(entry => entry.status && entry.status !== 'ready').length;
      const duplicates = entries.length - uniqueEntries.length;
      const enrollments = uniqueEntries.reduce(
        (total, entry) => total + (entry.sourceEnrollments?.length || 0),
        0
      );
      return `${uniqueEntries.length} sections checked: ${count('new')} new, ` +
        `${count('existing')} already here, ${count('resumable')} waiting in the holding course, ` +
        `and ${errors} needing attention. ${enrollments} active or invited enrollments found` +
        `${duplicates ? `; ${duplicates} repeated CSV rows ignored` : ''}.`;
    }

    async function analyzeCloneSections() {
      if (cloneRunning || navigationReportRunning || sectionReportRunning ||
        enableNavigationRunning || adminScopeLocked || !courseCsvScope) return;

      const destinationCourseId = courseContextInput.value.trim();
      const holdingCourseId = courseHoldingCourseInput.value.trim();
      const sourceColumn = cloneSourceSectionColumn.value;
      if (!/^\d+$/.test(destinationCourseId) || !/^\d+$/.test(holdingCourseId) || !sourceColumn) {
        showCloneStatus('Choose a source section column and enter both numeric course IDs.', {
          isError: true
        });
        return;
      }
      if (destinationCourseId === holdingCourseId) {
        showCloneStatus('The destination and holding-tank courses must be different.', { isError: true });
        return;
      }

      cloneRunning = true;
      resetCloneAnalysis({ keepStatus: true });
      cloneProgress.removeAttribute('value');
      cloneProgress.removeAttribute('max');
      setCourseScopeLocked(true);
      showCloneStatus('Checking the destination, holding course, and source sections…', {
        state: 'working',
        heading: 'Checking your sync'
      });

      try {
        const [destinationResult, holdingResult, destinationSections, holdingSections] =
          await Promise.all([
            canvasApi.get(`/api/v1/courses/${encodeURIComponent(destinationCourseId)}`),
            canvasApi.get(`/api/v1/courses/${encodeURIComponent(holdingCourseId)}`),
            canvasApi.getAll(
              `/api/v1/courses/${encodeURIComponent(destinationCourseId)}/sections?per_page=100`
            ),
            canvasApi.getAll(
              `/api/v1/courses/${encodeURIComponent(holdingCourseId)}/sections?per_page=100`
            )
          ]);
        const destinationCourse = destinationResult.data || {};
        const holdingCourse = holdingResult.data || {};
        if (String(destinationCourse.root_account_id) !== String(holdingCourse.root_account_id)) {
          throw new Error('The destination and holding courses are not in the same Canvas root account.');
        }

        const entries = courseCsvScope.rows.map(row => ({
          row,
          sourceValue: String(row[sourceColumn] ?? '').trim(),
          sourceRef: '',
          sourceSection: null,
          sourceEnrollments: [],
          cloneSection: null,
          cloneEnrollments: [],
          cloneState: '',
          status: '',
          error: ''
        }));
        const firstBySource = new Map();
        for (const entry of entries) {
          try {
            entry.sourceRef = canvasSectionId(entry.sourceValue);
            if (firstBySource.has(entry.sourceRef)) {
              entry.status = 'duplicate_source';
              entry.error = `Duplicates CSV row ${firstBySource.get(entry.sourceRef).row['input.row']}.`;
            } else {
              firstBySource.set(entry.sourceRef, entry);
            }
          } catch (error) {
            entry.status = 'invalid_source';
            entry.error = error.message;
          }
        }

        const uniqueEntries = entries.filter(entry => !entry.status);
        const sourceReadStats = {
          reportGroups: 0,
          reportSections: 0,
          directSections: 0,
          reportIds: [],
          reportFallbacks: []
        };
        const reportGroups = new Map();
        const directEntries = [];
        for (const entry of uniqueEntries) {
          const scope = cloneProvisioningScope(entry.row);
          if (!scope) {
            directEntries.push(entry);
            continue;
          }
          const group = reportGroups.get(scope.key) || { ...scope, entries: [] };
          group.entries.push(entry);
          reportGroups.set(scope.key, group);
        }

        let completed = 0;
        cloneProgress.max = Math.max(1, uniqueEntries.length);
        cloneProgress.value = 0;

        const finishSourceEntry = (entry, sourceSection, sourceEnrollments, readMode) => {
          entry.sourceSection = sourceSection || {};
          if (!entry.sourceSection.id) throw new Error('Canvas did not return a source section ID.');
          entry.sourceEnrollments = sourceEnrollments || [];
          entry.sourceReadMode = readMode;
          entry.desiredName = cloneSectionName(entry.sourceSection);
          classifyClone(entry, destinationSections, holdingSections, holdingCourseId);
          if (!entry.status) entry.status = 'ready';
        };

        for (const group of reportGroups.values()) {
          if (group.entries.length < CONFIG.cloneReportMinimumSections) {
            directEntries.push(...group.entries);
            continue;
          }

          let reportData;
          try {
            reportData = await cloneProvisioningData(group.accountId, group.termId);
            sourceReadStats.reportGroups++;
            sourceReadStats.reportIds.push(String(reportData.reportId));
          } catch (error) {
            console.warn(
              'Canvas enrollment report could not accelerate section-clone analysis; using direct APIs.',
              error
            );
            sourceReadStats.reportFallbacks.push({
              accountId: group.accountId,
              termId: group.termId,
              error: error.message
            });
            directEntries.push(...group.entries);
            showCloneStatus(
              `Canvas enrollment report was unavailable for account ${group.accountId}, term ` +
              `${group.termId}; falling back to direct section reads.`
            );
            continue;
          }

          for (const entry of group.entries) {
            const sourceSection = reportData.sectionsById.get(entry.sourceRef);
            if (!sourceSection) {
              directEntries.push(entry);
              continue;
            }
            try {
              finishSourceEntry(
                entry,
                sourceSection,
                reportData.enrollmentsBySectionId.get(entry.sourceRef) || [],
                'provisioning_report'
              );
              sourceReadStats.reportSections++;
              completed++;
              cloneProgress.value = completed;
              showCloneStatus(
                `Reading source sections: ${completed} of ${uniqueEntries.length}.`
              );
            } catch (error) {
              entry.status = 'source_error';
              entry.error = error.message;
              completed++;
              cloneProgress.value = completed;
            }
          }
        }

        await Promise.all(directEntries.map(async entry => {
          try {
            const sectionResult = await canvasApi.get(
              `/api/v1/sections/${encodeURIComponent(entry.sourceRef)}`
            );
            const sourceSection = sectionResult.data || {};
            const sourceEnrollments = await canvasApi.getAll(
              cloneEnrollmentPath(sourceSection.id || entry.sourceRef)
            );
            finishSourceEntry(entry, sourceSection, sourceEnrollments, 'direct_api');
            sourceReadStats.directSections++;
          } catch (error) {
            entry.status = 'source_error';
            entry.error = error.message;
          } finally {
            completed++;
            cloneProgress.value = completed;
            showCloneStatus(`Reading source sections: ${completed} of ${uniqueEntries.length}.`);
          }
        }));

        const clonesToRead = uniqueEntries.filter(entry => (
          entry.status === 'ready' && entry.cloneSection?.id
        ));
        let cloneReads = 0;
        cloneProgress.max = Math.max(1, clonesToRead.length);
        cloneProgress.value = 0;
        await Promise.all(clonesToRead.map(async entry => {
          try {
            entry.cloneEnrollments = await canvasApi.getAll(
              cloneEnrollmentPath(entry.cloneSection.id)
            );
          } catch (error) {
            entry.status = 'clone_error';
            entry.error = error.message;
          } finally {
            cloneReads++;
            cloneProgress.value = cloneReads;
            showCloneStatus(`Reading existing clones: ${cloneReads} of ${clonesToRead.length}.`);
          }
        }));

        const roles = cloneRoleDefinitions(entries.filter(entry => entry.status === 'ready'));
        cloneAnalysisPlan = {
          sourceFileName: courseCsvScope.fileName,
          sourceHeaders: [...courseCsvScope.headers],
          destinationCourse,
          holdingCourse,
          destinationCourseId,
          holdingCourseId,
          sourceColumn,
          entries,
          roles,
          sourceReadStats
        };
        cloneAnalysisText.textContent = cloneAnalysisSummary(entries);
        cloneAnalysis.hidden = false;
        renderCloneRoleOptions(roles);
        refreshCloneExecutionReview();
        cloneStatus.hidden = true;
      } catch (error) {
        console.error('Section clone analysis failed.', error);
        resetCloneAnalysis({ keepStatus: true });
        cloneProgress.removeAttribute('value');
        cloneProgress.removeAttribute('max');
        showCloneStatus(`Analysis stopped: ${error.message}`, {
          isError: true,
          heading: 'Couldn’t review this sync'
        });
      } finally {
        cloneRunning = false;
        setCourseScopeLocked(false);
        refreshCloneAvailability();
        if (cloneExecutionPlan) cloneContinue.focus();
      }
    }

    function buildCloneExecutionPlan() {
      if (!cloneAnalysisPlan) return null;
      const selectedRoles = selectedCloneRoleKeys();
      if (cloneAnalysisPlan.roles.length && !selectedRoles.size) return null;

      const entries = cloneAnalysisPlan.entries.map(entry => {
        if (entry.status !== 'ready') {
          return { ...entry, adds: [], updates: [], removals: [], unchanged: [] };
        }
        const desiredByIdentity = new Map();
        for (const enrollment of entry.sourceEnrollments) {
          if (!selectedRoles.has(enrollmentRoleKey(enrollment))) continue;
          desiredByIdentity.set(enrollmentIdentityKey(enrollment), enrollment);
        }
        const actualByIdentity = new Map();
        for (const enrollment of entry.cloneEnrollments) {
          if (!selectedRoles.has(enrollmentRoleKey(enrollment))) continue;
          actualByIdentity.set(enrollmentIdentityKey(enrollment), enrollment);
        }
        const adds = [];
        const updates = [];
        const removals = [];
        const unchanged = [];
        for (const [identity, enrollment] of desiredByIdentity) {
          if (!actualByIdentity.has(identity)) {
            adds.push(enrollment);
            continue;
          }
          const cloneEnrollment = actualByIdentity.get(identity);
          const studentLimitDiffers = enrollment.type === 'StudentEnrollment' &&
            Boolean(cloneEnrollment.limit_privileges_to_course_section) !== cloneLimitStudents.checked;
          const pair = { source: enrollment, clone: cloneEnrollment };
          if (studentLimitDiffers) updates.push(pair);
          else unchanged.push(pair);
        }
        for (const [identity, enrollment] of actualByIdentity) {
          if (!desiredByIdentity.has(identity)) removals.push(enrollment);
        }
        return {
          ...entry,
          adds,
          updates,
          removals,
          unchanged,
          rename: Boolean(entry.cloneSection && entry.cloneSection.name !== entry.desiredName)
        };
      });
      return {
        ...cloneAnalysisPlan,
        selectedRoles,
        limitStudents: cloneLimitStudents.checked,
        entries
      };
    }

    function cloneExecutionCounts(plan) {
      const ready = plan.entries.filter(entry => entry.status === 'ready');
      return {
        ready: ready.length,
        newSections: ready.filter(entry => entry.cloneState === 'new').length,
        resumedSections: ready.filter(entry => entry.cloneState === 'resumable').length,
        existingSections: ready.filter(entry => entry.cloneState === 'existing').length,
        existingMoves: ready.filter(entry => (
          entry.cloneState === 'existing' && (
            entry.rename || entry.adds.length || entry.updates.length || entry.removals.length
          )
        )).length,
        renamedSections: ready.filter(entry => entry.rename).length,
        adds: ready.reduce((total, entry) => total + entry.adds.length, 0),
        updates: ready.reduce((total, entry) => total + entry.updates.length, 0),
        removals: ready.reduce((total, entry) => total + entry.removals.length, 0),
        unchanged: ready.reduce((total, entry) => total + entry.unchanged.length, 0),
        deduplicated: plan.entries.filter(entry => entry.status === 'duplicate_source').length,
        blocked: plan.entries.filter(entry => (
          entry.status !== 'ready' && entry.status !== 'duplicate_source'
        )).length
      };
    }

    function refreshCloneExecutionReview() {
      const plan = buildCloneExecutionPlan();
      if (!plan) {
        cloneExecutionPlan = null;
        cloneConfirmation.hidden = false;
        cloneConfirmationText.textContent = 'Select at least one enrollment role to continue.';
        cloneContinue.disabled = true;
        return;
      }
      const counts = cloneExecutionCounts(plan);
      if (!counts.ready) {
        cloneExecutionPlan = null;
        cloneConfirmation.hidden = false;
        cloneConfirmationText.textContent =
          'Nothing can be synchronized yet. Review the sections needing attention in the results.';
        cloneContinue.disabled = true;
        return;
      }
      cloneExecutionPlan = plan;
      cloneConfirmationText.textContent =
        `${counts.ready} sections will sync to course ${plan.destinationCourseId}: ` +
        `${counts.newSections} new, ${counts.resumedSections} resumed, and ` +
        `${counts.existingSections} already here. Enrollments: ${counts.adds} add, ` +
        `${counts.updates} update, ${counts.removals} remove, and ${counts.unchanged} already correct.` +
        (counts.existingMoves
          ? ` ${counts.existingMoves} changed sections will briefly return to holding course ` +
            `${plan.holdingCourseId} while they are updated.`
          : '') +
        ' Notifications stay off.';
      cloneConfirmation.hidden = false;
      cloneContinue.disabled = courseScopeLocked || cloneRunning;
    }

    cloneAnalyze.addEventListener('click', analyzeCloneSections);

    function cloneResultRow(plan, entry, {
      action,
      status,
      error = '',
      enrollment = null,
      cloneSection = entry.cloneSection
    }) {
      const source = entry.sourceSection || {};
      const enrollmentData = enrollment || {};
      return {
        ...entry.row,
        'scope.destination_course_id': plan.destinationCourseId,
        'scope.holding_course_id': plan.holdingCourseId,
        'scope.limit_students_to_section': plan.limitStudents,
        'scope.source_read_mode': entry.sourceReadMode || '',
        'scope.source_report_ids': plan.sourceReadStats?.reportIds.join('|') || '',
        'src.id': source.id ?? '',
        'src.sis_section_id': source.sis_section_id ?? '',
        'src.integration_id': source.integration_id ?? '',
        'src.name': source.name ?? '',
        'src.course_id': source.course_id ?? '',
        'clone.id': cloneSection?.id ?? '',
        'clone.sis_section_id': cloneSection?.sis_section_id ?? '',
        'clone.integration_id': cloneSection?.integration_id ?? '',
        'clone.name': cloneSection?.name ?? entry.desiredName ?? '',
        'clone.course_id': cloneSection?.course_id ?? '',
        'clone.nonxlist_course_id': cloneSection?.nonxlist_course_id ?? '',
        'enrollment.id': enrollmentData.id ?? '',
        'enrollment.user_id': enrollmentData.user_id ?? '',
        'enrollment.type': enrollmentData.type ?? '',
        'enrollment.role': enrollmentData.role ?? '',
        'enrollment.role_id': enrollmentData.role_id ?? '',
        'enrollment.enrollment_state': enrollmentData.enrollment_state ?? '',
        'enrollment.associated_user_id': enrollmentData.associated_user_id ?? '',
        'enrollment.limit_privileges_to_course_section':
          enrollmentData.limit_privileges_to_course_section ?? '',
        'run.action': action,
        'run.completed_at': new Date().toISOString(),
        'run.status': status,
        'run.error': error
      };
    }

    function cloneEnrollmentRequestBody(enrollment, limitStudents) {
      const body = {
        'enrollment[user_id]': enrollment.user_id,
        'enrollment[type]': enrollment.type,
        'enrollment[role_id]': enrollment.role_id,
        'enrollment[enrollment_state]': enrollment.enrollment_state,
        'enrollment[notify]': 'false'
      };
      if (enrollment.type === 'StudentEnrollment') {
        body['enrollment[limit_privileges_to_course_section]'] = String(limitStudents);
      }
      if (enrollment.type === 'ObserverEnrollment' && enrollment.associated_user_id) {
        body['enrollment[associated_user_id]'] = enrollment.associated_user_id;
      }
      return body;
    }

    async function addCloneEnrollments(plan, entry, enrollments, resultRows) {
      let failed = 0;
      const groups = [
        enrollments.filter(enrollment => enrollment.type === 'StudentEnrollment'),
        enrollments.filter(enrollment => enrollment.type !== 'StudentEnrollment')
      ];
      for (const group of groups) {
        await Promise.all(group.map(async enrollment => {
          try {
            const result = await canvasApi.request(
              `/api/v1/sections/${encodeURIComponent(String(entry.cloneSection.id))}/enrollments`,
              {
                method: 'POST',
                body: cloneEnrollmentRequestBody(enrollment, plan.limitStudents)
              }
            );
            resultRows.push(cloneResultRow(plan, entry, {
              action: 'add_clone_enrollment',
              status: 'added',
              enrollment: result.data || enrollment
            }));
          } catch (error) {
            failed++;
            resultRows.push(cloneResultRow(plan, entry, {
              action: 'add_clone_enrollment',
              status: 'add_error',
              error: error.message,
              enrollment
            }));
          }
        }));
        if (failed) break;
      }
      return failed;
    }

    async function updateCloneEnrollmentLimits(plan, entry, pairs, resultRows) {
      let failed = 0;
      await Promise.all(pairs.map(async pair => {
        try {
          const result = await canvasApi.request(
            `/api/v1/sections/${encodeURIComponent(String(entry.cloneSection.id))}/enrollments`,
            {
              method: 'POST',
              body: cloneEnrollmentRequestBody(pair.source, plan.limitStudents)
            }
          );
          const updated = result.data || pair.clone;
          if (Boolean(updated.limit_privileges_to_course_section) !== plan.limitStudents) {
            throw new Error('Canvas did not retain the requested student section-limit setting.');
          }
          resultRows.push(cloneResultRow(plan, entry, {
            action: 'update_clone_enrollment',
            status: 'updated',
            enrollment: updated
          }));
        } catch (error) {
          failed++;
          resultRows.push(cloneResultRow(plan, entry, {
            action: 'update_clone_enrollment',
            status: 'update_error',
            error: error.message,
            enrollment: pair.clone
          }));
        }
      }));
      return failed;
    }

    async function removeCloneEnrollments(plan, entry, enrollments, currentCourseId, resultRows) {
      let failed = 0;
      await Promise.all(enrollments.map(async enrollment => {
        try {
          await canvasApi.request(
            `/api/v1/courses/${encodeURIComponent(String(currentCourseId))}/enrollments/` +
            `${encodeURIComponent(String(enrollment.id))}`,
            { method: 'DELETE', body: { task: 'delete' } }
          );
          resultRows.push(cloneResultRow(plan, entry, {
            action: 'remove_clone_enrollment',
            status: 'removed',
            enrollment
          }));
        } catch (error) {
          failed++;
          resultRows.push(cloneResultRow(plan, entry, {
            action: 'remove_clone_enrollment',
            status: 'remove_error',
            error: error.message,
            enrollment
          }));
        }
      }));
      return failed;
    }

    async function executeCloneEntry(plan, entry, resultRows) {
      if (entry.status === 'duplicate_source') {
        resultRows.push(cloneResultRow(plan, entry, {
          action: 'sync_section_clone',
          status: 'deduplicated'
        }));
        return { succeeded: false, failed: false };
      }

      if (entry.status !== 'ready') {
        resultRows.push(cloneResultRow(plan, entry, {
          action: 'sync_section_clone',
          status: entry.status,
          error: entry.error
        }));
        return { succeeded: false, failed: true };
      }

      const startedState = entry.cloneState;
      const requiresMutation = Boolean(
        entry.rename || entry.adds.length || entry.updates.length || entry.removals.length
      );
      let currentCourseId = startedState === 'existing'
        ? plan.destinationCourseId
        : plan.holdingCourseId;
      let needsCrosslist = startedState !== 'existing';
      let operationErrors = 0;

      if (startedState === 'existing' && requiresMutation) {
        try {
          const result = await canvasApi.request(
            `/api/v1/sections/${encodeURIComponent(String(entry.cloneSection.id))}/crosslist`,
            { method: 'DELETE' }
          );
          entry.cloneSection = result.data || entry.cloneSection;
          currentCourseId = plan.holdingCourseId;
          needsCrosslist = true;
          if (String(entry.cloneSection.course_id || '') !== plan.holdingCourseId) {
            throw new Error('Canvas de-cross-listed the section but did not return it to the selected holding course.');
          }
          resultRows.push(cloneResultRow(plan, entry, {
            action: 'uncrosslist_clone_section',
            status: 'returned_to_holding'
          }));
        } catch (error) {
          resultRows.push(cloneResultRow(plan, entry, {
            action: 'uncrosslist_clone_section',
            status: 'uncrosslist_error',
            error: error.message
          }));
          return { succeeded: false, failed: true };
        }
      }

      if (startedState === 'new') {
        try {
          const result = await canvasApi.request(
            `/api/v1/courses/${encodeURIComponent(plan.holdingCourseId)}/sections`,
            { method: 'POST', body: { 'course_section[name]': entry.desiredName } }
          );
          entry.cloneSection = result.data || {};
          if (!entry.cloneSection.id) throw new Error('Canvas did not return the cloned section ID.');
          resultRows.push(cloneResultRow(plan, entry, {
            action: 'create_clone_section',
            status: 'created'
          }));
        } catch (error) {
          resultRows.push(cloneResultRow(plan, entry, {
            action: 'create_clone_section',
            status: 'create_error',
            error: error.message
          }));
          return { succeeded: false, failed: true };
        }
      }

      if (entry.rename) {
        try {
          const result = await canvasApi.request(
            `/api/v1/sections/${encodeURIComponent(String(entry.cloneSection.id))}`,
            { method: 'PUT', body: { 'course_section[name]': entry.desiredName } }
          );
          entry.cloneSection = result.data || entry.cloneSection;
          resultRows.push(cloneResultRow(plan, entry, {
            action: 'rename_clone_section',
            status: 'renamed'
          }));
        } catch (error) {
          operationErrors++;
          resultRows.push(cloneResultRow(plan, entry, {
            action: 'rename_clone_section',
            status: 'rename_error',
            error: error.message
          }));
        }
      }

      for (const pair of entry.unchanged) {
        resultRows.push(cloneResultRow(plan, entry, {
          action: 'sync_clone_enrollment',
          status: 'unchanged',
          enrollment: pair.clone
        }));
      }

      const addErrors = await addCloneEnrollments(plan, entry, entry.adds, resultRows);
      operationErrors += addErrors;
      if (addErrors) {
        for (const pair of entry.updates) {
          resultRows.push(cloneResultRow(plan, entry, {
            action: 'update_clone_enrollment',
            status: 'skipped_after_add_error',
            enrollment: pair.clone
          }));
        }
      }
      const updateErrors = addErrors
        ? 0
        : await updateCloneEnrollmentLimits(plan, entry, entry.updates, resultRows);
      operationErrors += updateErrors;
      let removeErrors = 0;
      if (!addErrors && !updateErrors) {
        removeErrors = await removeCloneEnrollments(
          plan,
          entry,
          entry.removals,
          currentCourseId,
          resultRows
        );
        operationErrors += removeErrors;
      } else {
        for (const enrollment of entry.removals) {
          resultRows.push(cloneResultRow(plan, entry, {
            action: 'remove_clone_enrollment',
            status: 'skipped_after_prerequisite_error',
            enrollment
          }));
        }
      }

      if (needsCrosslist) {
        if (operationErrors) {
          resultRows.push(cloneResultRow(plan, entry, {
            action: 'crosslist_clone_section',
            status: 'skipped_in_holding',
            error: 'The clone remains in the holding course because one or more prerequisite operations failed.'
          }));
          return { succeeded: false, failed: true };
        }
        try {
          const result = await canvasApi.request(
            `/api/v1/sections/${encodeURIComponent(String(entry.cloneSection.id))}/crosslist/` +
            `${encodeURIComponent(plan.destinationCourseId)}`,
            { method: 'POST', body: {} }
          );
          entry.cloneSection = result.data || entry.cloneSection;
          currentCourseId = plan.destinationCourseId;
          const originMatches = String(entry.cloneSection.nonxlist_course_id || '') ===
            plan.holdingCourseId;
          const destinationMatches = String(entry.cloneSection.course_id || '') ===
            plan.destinationCourseId;
          if (!originMatches || !destinationMatches) {
            throw new Error('Canvas cross-listed the section but returned an unexpected course or origin.');
          }
          resultRows.push(cloneResultRow(plan, entry, {
            action: 'crosslist_clone_section',
            status: 'crosslisted'
          }));
        } catch (error) {
          resultRows.push(cloneResultRow(plan, entry, {
            action: 'crosslist_clone_section',
            status: 'crosslist_error',
            error: error.message
          }));
          return { succeeded: false, failed: true };
        }
      }

      const finalStatus = operationErrors
        ? 'partial_sync'
        : (
          startedState === 'existing' && !entry.rename && !entry.adds.length &&
            !entry.updates.length && !entry.removals.length
            ? 'already_synced'
            : 'synced'
        );
      resultRows.push(cloneResultRow(plan, entry, {
        action: 'sync_section_clone',
        status: finalStatus,
        error: operationErrors ? `${operationErrors} operation(s) failed.` : ''
      }));
      return { succeeded: !operationErrors, failed: Boolean(operationErrors) };
    }

    function downloadCloneResults(plan, rows) {
      const generatedColumns = [
        'input.row',
        'scope.destination_course_id',
        'scope.holding_course_id',
        'scope.limit_students_to_section',
        'scope.source_read_mode',
        'scope.source_report_ids',
        'src.id',
        'src.sis_section_id',
        'src.integration_id',
        'src.name',
        'src.course_id',
        'clone.id',
        'clone.sis_section_id',
        'clone.integration_id',
        'clone.name',
        'clone.course_id',
        'clone.nonxlist_course_id',
        'enrollment.id',
        'enrollment.user_id',
        'enrollment.type',
        'enrollment.role',
        'enrollment.role_id',
        'enrollment.enrollment_state',
        'enrollment.associated_user_id',
        'enrollment.limit_privileges_to_course_section',
        'run.action',
        'run.completed_at',
        'run.status',
        'run.error'
      ];
      const columnNames = [...plan.sourceHeaders];
      for (const key of generatedColumns) {
        if (!columnNames.includes(key)) columnNames.push(key);
      }
      downloadCsv({
        rows,
        columns: columnNames.map(key => ({ key, label: key })),
        filename: `sec-sync.course-${plan.destinationCourseId}.${timestampForFilename()}.csv`
      });
    }

    async function executeCloneSync() {
      if (!cloneExecutionPlan || cloneRunning) return;
      cloneRunning = true;
      setCourseScopeLocked(true);
      cloneConfirmation.hidden = true;
      cloneContinue.disabled = true;
      cloneCancel.disabled = true;
      const plan = cloneExecutionPlan;
      const resultRows = [];
      let completed = 0;
      let succeeded = 0;
      let failed = 0;
      cloneProgress.max = Math.max(1, plan.entries.length);
      cloneProgress.value = 0;
      showCloneStatus(`0 of ${plan.entries.length} sections finished.`, {
        state: 'working',
        heading: 'Sync in progress'
      });

      try {
        for (const entry of plan.entries) {
          const result = await executeCloneEntry(plan, entry, resultRows);
          if (result.succeeded) succeeded++;
          if (result.failed) failed++;
          completed++;
          cloneProgress.value = completed;
          const apiState = canvasApi.state();
          const rateText = apiState.rateRemaining === null
            ? ''
            : ` Canvas quota remaining: ${apiState.rateRemaining}.`;
          showCloneStatus(
            `${completed} of ${plan.entries.length} sections finished. ` +
            `Succeeded: ${succeeded}. Blocked or failed: ${failed}.${rateText}`,
            { isError: failed > 0 }
          );
        }
        downloadCloneResults(plan, resultRows);
        showCloneStatus(
          `${succeeded} sections synchronized; ${failed} blocked or failed. The results CSV ` +
          `has downloaded${failed ? `, and incomplete sections remain safely in holding course ${plan.holdingCourseId}` : ''}.`,
          failed
            ? { isError: true, heading: 'Sync finished with issues' }
            : { state: 'success', heading: 'Sync complete' }
        );
      } catch (error) {
        console.error('Section clone sync failed.', error);
        if (resultRows.length) downloadCloneResults(plan, resultRows);
        showCloneStatus(`Action stopped: ${error.message}`, {
          isError: true,
          heading: 'Sync stopped'
        });
      } finally {
        cloneRunning = false;
        resetCloneAnalysis({ keepStatus: true });
        setCourseScopeLocked(false);
        refreshCloneAvailability();
      }
    }

    cloneCancel.addEventListener('click', () => {
      if (cloneRunning) return;
      resetCloneAnalysis();
      setCourseScopeLocked(false);
      refreshCloneAvailability();
      cloneAnalyze.focus();
    });
    cloneContinue.addEventListener('click', executeCloneSync);

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
