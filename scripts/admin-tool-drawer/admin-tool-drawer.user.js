// ==UserScript==
// @name         Canvas Admin Tool Drawer
// @namespace    https://uwm.edu/
// @version      0.2.0
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
    failedCheckCacheTtlMs: 60 * 1000
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

  async function currentUserIsAccountAdmin() {
    const cachedStatus = readCachedAdminStatus();
    if (cachedStatus !== null) return cachedStatus;

    try {
      const response = await window.fetch('/api/v1/accounts?per_page=1', {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        },
        credentials: 'same-origin'
      });

      if (!response.ok) {
        cacheAdminStatus(false, CONFIG.failedCheckCacheTtlMs);
        return false;
      }

      const accounts = await response.json();
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
        .context-id:focus-visible {
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

    for (const input of contextInputs) {
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '');
      });
    }

    openContext(canvasContext.activeContext);

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
