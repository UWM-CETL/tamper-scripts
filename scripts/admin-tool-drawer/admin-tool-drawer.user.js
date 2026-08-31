// ==UserScript==
// @name         Canvas Admin Tool Drawer
// @namespace    https://uwm.edu/
// @version      0.1.0
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
        .close-button:focus-visible {
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
        .empty-state p {
          color: var(--uwm-muted);
          line-height: 1.5;
          margin: 0;
        }

        .empty-state {
          border: 1px dashed rgb(255 247 237 / 28%);
          border-radius: 10px;
          margin: 0 24px 24px;
          padding: 22px 18px;
        }

        .empty-state h3 {
          font-size: 1rem;
          margin: 0 0 8px;
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
              d="M12 2.25 1.7 20.1a1.1 1.1 0 0 0 .95 1.65h18.7a1.1 1.1 0 0 0 .95-1.65L12 2.25Zm0 5.1c.55 0 1 .45 1 1v5.25a1 1 0 1 1-2 0V8.35c0-.55.45-1 1-1Zm0 10.5a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z"
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

          <section class="empty-state" aria-labelledby="uwm-admin-tools-heading">
            <h3 id="uwm-admin-tools-heading">Admin tools</h3>
            <p>The drawer is ready. Individual admin workflows can be added here.</p>
          </section>
        </aside>
      </div>
    `;

    document.body.appendChild(host);

    const shell = shadowRoot.querySelector('.tool-drawer-shell');
    const launcher = shadowRoot.querySelector('.launcher');
    const backdrop = shadowRoot.querySelector('.backdrop');
    const drawer = shadowRoot.querySelector('.drawer');
    const closeButton = shadowRoot.querySelector('.close-button');

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
