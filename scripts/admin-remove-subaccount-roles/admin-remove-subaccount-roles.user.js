// ==UserScript==
// @name         Canvas - Remove User Admin Access From Account Tree
// @namespace    https://uwm.edu/
// @version      1.0
// @description  Remove a user's Canvas account-admin access from a root account/subaccount tree and download an audit CSV.
// @match        https://*.instructure.com/accounts/*/users/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    linkText: 'Remove admin access',

    // User-requested cap.
    adminLookupConcurrency: 15,

    // Deletes are intentionally sequential so stop-on-failure is real.
    deleteConcurrency: 1,

    // Canvas throttling / retry controls.
    minimumRateRemaining: 100,
    throttleSleepMs: 1500,
    maxRetries: 5,
    baseRetryMs: 1500,

    // Retry transient Canvas/edge burps.
    retryStatuses: [408, 429, 500, 502, 503, 504],

    // Logging / UX.
    logScannedAccountsWithNoMatch: false,
    reloadAfterSuccessfulCompletion: true,
    reloadDelayMs: 1800
  };

  const pageMatch = window.location.pathname.match(/^\/accounts\/([^/]+)\/users\/([^/]+)/);
  if (!pageMatch) return;

  const ROOT_ACCOUNT_ID = decodeURIComponent(pageMatch[1]);
  const TARGET_USER_ID = decodeURIComponent(pageMatch[2]);

  const state = {
    started: false,
    stopped: false,

    logRows: [],

    accountsLoaded: 0,
    accountsChecked: 0,

    matchesFound: 0,
    removalsSucceeded: 0,

    lookupErrors: 0,
    deleteErrors: 0,
    roleLookupErrors: 0,

    rateRemaining: null,
    lastRequestCost: null
  };

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function encodePathSegment(value) {
    return encodeURIComponent(String(value));
  }

  function getCsrfToken() {
    const cookieMatch = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]+)/);
    return cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value ?? null);
    } catch {
      return String(value);
    }
  }

  function csvEscape(value) {
    const str = value == null ? '' : String(value);
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function rowsToCsv(rows) {
    const headers = [
      'timestamp',
      'phase',
      'root_account_id',
      'target_user_id',
      'account_id',
      'account_name',
      'account_workflow_state',
      'admin_assignment_id',
      'admin_user_id',
      'admin_user_name',
      'admin_role',
      'resolved_role_id',
      'admin_workflow_state',
      'http_status',
      'request_cost',
      'rate_limit_remaining',
      'success',
      'message',
      'request_url',
      'response_json',
      'error'
    ];

    return [
      headers.join(','),
      ...rows.map(row => headers.map(header => csvEscape(row[header])).join(','))
    ].join('\r\n');
  }

  function downloadCsv(rows) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `canvas-remove-admin-access.user-${TARGET_USER_ID}.root-${ROOT_ACCOUNT_ID}.${timestamp}.log.csv`;
    const csv = rowsToCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();

    setTimeout(() => {
      URL.revokeObjectURL(url);
      link.remove();
    }, 1000);
  }

  function parseNextLink(linkHeader) {
    if (!linkHeader) return null;

    for (const link of linkHeader.split(',')) {
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      if (match) return match[1];
    }

    return null;
  }

  function setStatus(message) {
    const status = document.getElementById('uwm-remove-admin-access-status');
    if (status) status.textContent = message;
  }

  function makeLogRow({
    phase,
    account,
    admin,
    roleId,
    status,
    requestCost,
    rateRemaining,
    success,
    message,
    requestUrl,
    response,
    error
  }) {
    return {
      timestamp: nowIso(),
      phase: phase ?? '',
      root_account_id: ROOT_ACCOUNT_ID,
      target_user_id: TARGET_USER_ID,

      account_id: account?.id ?? '',
      account_name: account?.name ?? '',
      account_workflow_state: account?.workflow_state ?? '',

      admin_assignment_id: admin?.id ?? '',
      admin_user_id: admin?.user?.id ?? admin?.user_id ?? '',
      admin_user_name: admin?.user?.name ?? admin?.user_name ?? '',
      admin_role: admin?.role ?? '',
      resolved_role_id: roleId ?? '',
      admin_workflow_state: admin?.workflow_state ?? '',

      http_status: status ?? '',
      request_cost: requestCost ?? '',
      rate_limit_remaining: rateRemaining ?? state.rateRemaining ?? '',
      success: success ?? '',
      message: message ?? '',
      request_url: requestUrl ?? '',
      response_json: response == null ? '' : safeJson(response),
      error: error ?? ''
    };
  }

  function isRateLimitedResponse(response, data) {
    if (response.status === 429) return true;

    if (response.status !== 403) return false;

    const bodyText = typeof data === 'string'
      ? data.toLowerCase()
      : safeJson(data).toLowerCase();

    return bodyText.includes('rate limit') || bodyText.includes('throttle');
  }

  function isRetryableResponse(response, data) {
    return CONFIG.retryStatuses.includes(response.status) || isRateLimitedResponse(response, data);
  }

  async function waitForRateCapacity() {
    while (
      state.rateRemaining != null &&
      Number(state.rateRemaining) < CONFIG.minimumRateRemaining
    ) {
      if (state.stopped) {
        throw new Error('Workflow stopped.');
      }

      setStatus(`Canvas API quota is low (${state.rateRemaining}). Waiting before continuing...`);
      await sleep(CONFIG.throttleSleepMs);
    }
  }

  async function canvasFetch(urlOrPath, options = {}, attempt = 0) {
    if (state.stopped) {
      throw new Error('Workflow stopped.');
    }

    await waitForRateCapacity();

    const url = new URL(urlOrPath, window.location.origin);

    const headers = {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(options.headers || {})
    };

    const method = String(options.method || 'GET').toUpperCase();
    const csrfToken = getCsrfToken();

    if (csrfToken && method !== 'GET') {
      headers['X-CSRF-Token'] = csrfToken;
    }

    const response = await fetch(url.toString(), {
      credentials: 'same-origin',
      ...options,
      method,
      headers
    });

    const requestCost = response.headers.get('X-Request-Cost');
    const rateRemaining = response.headers.get('X-Rate-Limit-Remaining');
    const retryAfter = response.headers.get('Retry-After');

    if (requestCost != null) state.lastRequestCost = Number(requestCost);
    if (rateRemaining != null) state.rateRemaining = Number(rateRemaining);

    const text = await response.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (isRetryableResponse(response, data) && attempt < CONFIG.maxRetries) {
      const retryMs = retryAfter
        ? Number(retryAfter) * 1000
        : CONFIG.baseRetryMs * Math.pow(2, attempt);

      const reason = isRateLimitedResponse(response, data)
        ? 'Canvas throttled a request'
        : `Canvas returned HTTP ${response.status}`;

      setStatus(`${reason}. Waiting ${Math.round(retryMs / 1000)}s before retrying...`);

      await sleep(retryMs);
      return canvasFetch(url.toString(), options, attempt + 1);
    }

    if (!response.ok) {
      const error = new Error(`Canvas API request failed: HTTP ${response.status}`);
      error.status = response.status;
      error.url = url.toString();
      error.response = data;
      error.requestCost = requestCost;
      error.rateRemaining = rateRemaining;
      throw error;
    }

    return {
      status: response.status,
      data,
      nextUrl: parseNextLink(response.headers.get('Link')),
      url: url.toString(),
      requestCost,
      rateRemaining
    };
  }

  async function canvasFetchAll(urlOrPath) {
    let nextUrl = new URL(urlOrPath, window.location.origin).toString();
    const results = [];

    while (nextUrl) {
      const page = await canvasFetch(nextUrl);

      if (Array.isArray(page.data)) {
        results.push(...page.data);
      } else if (page.data != null) {
        results.push(page.data);
      }

      nextUrl = page.nextUrl;
    }

    return results;
  }

  async function runWithConcurrency(items, concurrency, worker) {
    let index = 0;
    const results = [];

    async function runWorker() {
      while (!state.stopped && index < items.length) {
        const currentIndex = index++;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    }

    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    return results;
  }

  async function getAccount(accountId) {
    try {
      const result = await canvasFetch(`/api/v1/accounts/${encodePathSegment(accountId)}`);
      return result.data;
    } catch (error) {
      state.logRows.push(makeLogRow({
        phase: 'root_account_lookup_failed',
        account: { id: accountId, name: '' },
        status: error.status,
        requestCost: error.requestCost,
        rateRemaining: error.rateRemaining,
        success: false,
        message: 'Could not retrieve root account details. Continuing with account ID from URL.',
        requestUrl: error.url,
        response: error.response,
        error: error.message
      }));

      return {
        id: accountId,
        name: '(root account from URL)'
      };
    }
  }

  async function getAccountTree(rootAccountId) {
    const rootAccount = await getAccount(rootAccountId);

    const subAccounts = await canvasFetchAll(
      `/api/v1/accounts/${encodePathSegment(rootAccountId)}/sub_accounts?recursive=true&per_page=100`
    );

    const accountsById = new Map();

    for (const account of [rootAccount, ...subAccounts]) {
      const accountId = String(account.id ?? account.account_id ?? '');
      if (accountId) accountsById.set(accountId, account);
    }

    return Array.from(accountsById.values());
  }

  async function getAdminsForUser(accountId, userId) {
    const params = new URLSearchParams();
    params.append('user_id[]', userId);
    params.set('per_page', '100');

    return canvasFetchAll(
      `/api/v1/accounts/${encodePathSegment(accountId)}/admins?${params.toString()}`
    );
  }

  async function getRolesForAccount(accountId) {
    return canvasFetchAll(
      `/api/v1/accounts/${encodePathSegment(accountId)}/roles?show_inherited=true&per_page=100`
    );
  }

  function resolveRoleId(admin, roles) {
    if (admin.role_id != null) return admin.role_id;
    if (admin.roleId != null) return admin.roleId;

    const adminRole = String(admin.role || '').trim();
    if (!adminRole) return null;

    const match = roles.find(role => {
      return String(role.id) === adminRole ||
        String(role.label || '').trim() === adminRole ||
        String(role.role || '').trim() === adminRole ||
        String(role.base_role_type || '').trim() === adminRole;
    });

    return match ? match.id : null;
  }

  async function deleteAdminRole(accountId, userId, admin, roleId) {
    const params = new URLSearchParams();

    if (roleId != null && roleId !== '') {
      params.set('role_id', roleId);
    } else if (admin.role) {
      params.set('role', admin.role);
    } else {
      throw new Error('Could not resolve role_id or role name for admin assignment.');
    }

    return canvasFetch(
      `/api/v1/accounts/${encodePathSegment(accountId)}/admins/${encodePathSegment(userId)}?${params.toString()}`,
      { method: 'DELETE' }
    );
  }

  async function scanAccountForAdminAccess(account, index, totalAccounts) {
    const accountId = account.id;

    state.accountsChecked++;

    setStatus(
      `Checking account ${state.accountsChecked} of ${totalAccounts}: ` +
      `${account.name || accountId}. ` +
      `Matches: ${state.matchesFound}. ` +
      `Removed: ${state.removalsSucceeded}. ` +
      `Canvas remaining: ${state.rateRemaining ?? 'unknown'}.`
    );

    try {
      const admins = await getAdminsForUser(accountId, TARGET_USER_ID);

      if (!admins.length) {
        if (CONFIG.logScannedAccountsWithNoMatch) {
          state.logRows.push(makeLogRow({
            phase: 'no_admin_access_found',
            account,
            success: true,
            message: 'No matching account-admin access found for this account.'
          }));
        }

        return [];
      }

      const matches = admins.map(admin => ({
        account,
        admin,
        roleId: resolveRoleId(admin, [])
      }));

      for (const match of matches) {
        state.matchesFound++;

        state.logRows.push(makeLogRow({
          phase: 'admin_access_before_removal',
          account,
          admin: match.admin,
          roleId: match.roleId,
          success: true,
          message: 'Matching account-admin access found before removal.',
          response: match.admin
        }));
      }

      return matches;
    } catch (error) {
      state.lookupErrors++;

      state.logRows.push(makeLogRow({
        phase: 'account_admin_lookup_failed',
        account,
        status: error.status,
        requestCost: error.requestCost,
        rateRemaining: error.rateRemaining,
        success: false,
        message: 'Could not check account-admin access for this account after retries.',
        requestUrl: error.url,
        response: error.response,
        error: error.message
      }));

      return [];
    }
  }

  async function resolveMissingRoleIds(matches) {
    for (const match of matches) {
      if (state.stopped) break;

      if (match.roleId != null && match.roleId !== '') continue;

      const { account, admin } = match;

      try {
        setStatus(`Resolving role ID for ${account.name || account.id}: ${admin.role || 'unknown role'}`);

        const roles = await getRolesForAccount(account.id);
        match.roleId = resolveRoleId(admin, roles);

        state.logRows.push(makeLogRow({
          phase: 'role_id_resolved',
          account,
          admin,
          roleId: match.roleId,
          success: Boolean(match.roleId),
          message: match.roleId
            ? 'Resolved role ID for admin assignment.'
            : 'Could not resolve role ID. Delete will attempt role-name fallback if available.',
          response: roles
        }));
      } catch (error) {
        state.roleLookupErrors++;

        state.logRows.push(makeLogRow({
          phase: 'role_lookup_failed',
          account,
          admin,
          status: error.status,
          requestCost: error.requestCost,
          rateRemaining: error.rateRemaining,
          success: false,
          message: 'Could not retrieve roles for account. Delete will attempt role-name fallback if available.',
          requestUrl: error.url,
          response: error.response,
          error: error.message
        }));
      }
    }

    return matches;
  }

  async function stopAfterLookupErrors(triggerEl) {
    state.stopped = true;

    state.logRows.push(makeLogRow({
      phase: 'stopped_after_lookup_errors',
      success: false,
      message:
        `Scan completed with ${state.lookupErrors} account lookup error(s). ` +
        `No deletes were attempted because the scan is incomplete.`
    }));

    setStatus(`Stopped: ${state.lookupErrors} account lookup error(s). Log downloaded. No deletes attempted.`);
    downloadCsv(state.logRows);

    window.alert(
      `The scan completed with ${state.lookupErrors} account lookup error(s).\n\n` +
      `No deletes were attempted because the scan is incomplete.\n\n` +
      `A CSV log has been downloaded.`
    );

    triggerEl.classList.remove('disabled');
    triggerEl.removeAttribute('aria-disabled');
    triggerEl.textContent = CONFIG.linkText;
    state.started = false;
  }

  async function deleteMatchesSequentially(matches) {
    for (let i = 0; i < matches.length; i++) {
      if (state.stopped) break;

      const { account, admin, roleId } = matches[i];

      setStatus(
        `Removing admin access ${i + 1} of ${matches.length}: ` +
        `${account.name || account.id} / ${admin.role || 'unknown role'}`
      );

      try {
        const deleteResult = await deleteAdminRole(
          account.id,
          TARGET_USER_ID,
          admin,
          roleId
        );

        state.removalsSucceeded++;

        state.logRows.push(makeLogRow({
          phase: 'admin_access_removed',
          account,
          admin,
          roleId,
          status: deleteResult.status,
          requestCost: deleteResult.requestCost,
          rateRemaining: deleteResult.rateRemaining,
          success: true,
          message: 'Account-admin access removal request succeeded.',
          requestUrl: deleteResult.url,
          response: deleteResult.data
        }));
      } catch (error) {
        state.deleteErrors++;
        state.stopped = true;

        state.logRows.push(makeLogRow({
          phase: 'fatal_delete_failed',
          account,
          admin,
          roleId,
          status: error.status,
          requestCost: error.requestCost,
          rateRemaining: error.rateRemaining,
          success: false,
          message: 'Delete failed. Workflow stopped immediately so the admin can recover manually.',
          requestUrl: error.url,
          response: error.response,
          error: error.stack || error.message
        }));

        state.logRows.push(makeLogRow({
          phase: 'stopped_after_delete_failure',
          success: false,
          message:
            `Stopped after delete failure. ` +
            `Removed before failure: ${state.removalsSucceeded}. ` +
            `Remaining queued removals not attempted: ${matches.length - i - 1}.`
        }));

        downloadCsv(state.logRows);

        setStatus(`Stopped: delete failed after ${state.removalsSucceeded} successful removal(s). Log downloaded.`);

        window.alert(
          `Delete failed and the workflow has stopped.\n\n` +
          `Successful removals before failure: ${state.removalsSucceeded}\n` +
          `Remaining queued removals not attempted: ${matches.length - i - 1}\n\n` +
          `A CSV log has been downloaded for recovery.`
        );

        throw error;
      }
    }
  }

  async function runRemovalWorkflow(triggerEl) {
    if (state.started) return;

    const confirmation = [
      'Remove Canvas account-admin access?',
      '',
      `Root account/subaccount from URL: ${ROOT_ACCOUNT_ID}`,
      `Target user from URL: ${TARGET_USER_ID}`,
      '',
      'This will scan the root account plus all recursive subaccounts.',
      `Account admin lookups will run with concurrency capped at ${CONFIG.adminLookupConcurrency}.`,
      'Deletes will run one at a time and stop immediately if a delete fails.',
      'If any account lookup fails after retries, no deletes will be attempted.',
      '',
      'A CSV log will download when finished.'
    ].join('\n');

    if (!window.confirm(confirmation)) return;

    state.started = true;
    state.stopped = false;

    triggerEl.classList.add('disabled');
    triggerEl.setAttribute('aria-disabled', 'true');
    triggerEl.textContent = 'Removing admin access...';

    try {
      state.logRows.push(makeLogRow({
        phase: 'started',
        success: true,
        message:
          `Workflow started. Root account: ${ROOT_ACCOUNT_ID}. ` +
          `Target user: ${TARGET_USER_ID}. Lookup concurrency: ${CONFIG.adminLookupConcurrency}.`
      }));

      setStatus('Loading recursive account tree...');

      const accounts = await getAccountTree(ROOT_ACCOUNT_ID);
      state.accountsLoaded = accounts.length;

      state.logRows.push(makeLogRow({
        phase: 'account_tree_loaded',
        success: true,
        message: `Loaded ${accounts.length} account(s), including root account.`
      }));

      setStatus(
        `Loaded ${accounts.length} account(s). Checking admin access with concurrency ${CONFIG.adminLookupConcurrency}...`
      );

      const scanResults = await runWithConcurrency(
        accounts,
        CONFIG.adminLookupConcurrency,
        (account, index) => scanAccountForAdminAccess(account, index, accounts.length)
      );

      let matches = scanResults.flat().filter(Boolean);

      state.logRows.push(makeLogRow({
        phase: 'scan_completed',
        success: state.lookupErrors === 0,
        message:
          `Scan completed. Accounts loaded: ${state.accountsLoaded}. ` +
          `Accounts checked: ${state.accountsChecked}. ` +
          `Matching admin assignment(s): ${matches.length}. ` +
          `Lookup error(s): ${state.lookupErrors}.`
      }));

      if (state.lookupErrors > 0) {
        await stopAfterLookupErrors(triggerEl);
        return;
      }

      if (!matches.length) {
        state.logRows.push(makeLogRow({
          phase: 'completed_no_matches',
          success: true,
          message: 'No matching account-admin assignments were found.'
        }));

        setStatus('No matching account-admin access found. Downloading log...');
        downloadCsv(state.logRows);

        if (CONFIG.reloadAfterSuccessfulCompletion) {
          setStatus('No matching account-admin access found. Refreshing page...');
          setTimeout(() => window.location.reload(), CONFIG.reloadDelayMs);
        }

        return;
      }

      matches = await resolveMissingRoleIds(matches);

      state.logRows.push(makeLogRow({
        phase: 'delete_phase_started',
        success: true,
        message:
          `Beginning delete phase for ${matches.length} admin assignment(s). ` +
          'Deletes are sequential and will stop on first failure.'
      }));

      await deleteMatchesSequentially(matches);

      state.logRows.push(makeLogRow({
        phase: 'completed',
        success: true,
        message:
          `Completed successfully. ` +
          `Accounts loaded: ${state.accountsLoaded}. ` +
          `Accounts checked: ${state.accountsChecked}. ` +
          `Matching admin assignment(s): ${state.matchesFound}. ` +
          `Removed assignment(s): ${state.removalsSucceeded}. ` +
          `Lookup error(s): ${state.lookupErrors}. ` +
          `Role lookup error(s): ${state.roleLookupErrors}.`
      }));

      setStatus(`Done. Removed ${state.removalsSucceeded} admin assignment(s). Downloading log...`);
      downloadCsv(state.logRows);

      if (CONFIG.reloadAfterSuccessfulCompletion) {
        setStatus(`Done. Removed ${state.removalsSucceeded} admin assignment(s). Refreshing page...`);
        setTimeout(() => window.location.reload(), CONFIG.reloadDelayMs);
      }
    } catch (error) {
      if (!state.stopped) {
        state.stopped = true;

        state.logRows.push(makeLogRow({
          phase: 'fatal_error',
          success: false,
          message: 'Workflow stopped because of a fatal error.',
          requestUrl: error.url,
          status: error.status,
          requestCost: error.requestCost,
          rateRemaining: error.rateRemaining,
          response: error.response,
          error: error.stack || error.message
        }));

        downloadCsv(state.logRows);

        setStatus('Stopped because of an error. Log downloaded.');

        window.alert(
          `The workflow stopped because of an error.\n\n` +
          `${error.message}\n\n` +
          `A CSV log has been downloaded.`
        );
      }

      triggerEl.classList.remove('disabled');
      triggerEl.removeAttribute('aria-disabled');
      triggerEl.textContent = CONFIG.linkText;
      state.started = false;
    }
  }

  function addRemoveAdminAccessLink() {
    if (document.getElementById('uwm-remove-admin-access-wrapper')) return;

    const accountsHeading = document.querySelector('#content > h3');
    if (!accountsHeading) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'uwm-remove-admin-access-wrapper';
    wrapper.style.margin = '0.25rem 0 0.75rem 0';

    const link = document.createElement('a');
    link.id = 'uwm-remove-admin-access-link';
    link.href = '#';
    link.className = 'btn Button';
    link.textContent = CONFIG.linkText;
    link.style.marginRight = '0.5rem';

    const status = document.createElement('span');
    status.id = 'uwm-remove-admin-access-status';
    status.style.fontSize = '0.85rem';
    status.style.color = '#555';

    link.addEventListener('click', event => {
      event.preventDefault();

      if (link.getAttribute('aria-disabled') === 'true') return;

      runRemovalWorkflow(link);
    });

    wrapper.appendChild(link);
    wrapper.appendChild(status);

    accountsHeading.insertAdjacentElement('afterend', wrapper);
  }

  function waitForTargetAndAddLink() {
    addRemoveAdminAccessLink();

    if (!document.getElementById('uwm-remove-admin-access-wrapper')) {
      setTimeout(waitForTargetAndAddLink, 500);
    }
  }

  waitForTargetAndAddLink();
})();