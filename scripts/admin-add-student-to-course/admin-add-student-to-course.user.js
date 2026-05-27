// ==UserScript==
// @name         Canvas Admin - Special Enrollment via Intermediate Course
// @namespace    https://uwm.edu/
// @version      1.0.0
// @description  Create an intermediate section, enroll a user, convert Observer to Student, cross-list the section, and open the section page.
// @match        https://*.instructure.com/accounts/*/users/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const BUTTON_ID = 'uwm-special-enrollment-button';
  const STATUS_ID = 'uwm-special-enrollment-status';

  function getUserIdFromUrl() {
    const match = window.location.pathname.match(/\/accounts\/[^/]+\/users\/(\d+)(?:\/|$)/);
    return match ? match[1] : null;
  }

  function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta?.content) return meta.content;

    const cookieMatch = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]+)/);
    return cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function defaultSectionName() {
    const now = new Date();
    return [
      'Special Enrollment - ',
      now.getFullYear(),
      '-',
      pad2(now.getMonth() + 1),
      '-',
      pad2(now.getDate()),
      ' ',
      pad2(now.getHours()),
      ':',
      pad2(now.getMinutes()),
      ':',
      pad2(now.getSeconds())
    ].join('');
  }

  function requireCanvasId(label, value) {
    const cleaned = String(value || '').trim();

    if (!/^\d+$/.test(cleaned)) {
      throw new Error(`${label} must be a numeric Canvas ID.`);
    }

    return cleaned;
  }

  function bodyParams(object) {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(object)) {
      if (value !== undefined && value !== null) {
        params.append(key, String(value));
      }
    }

    return params;
  }

  async function canvasApi(path, options = {}) {
    const method = options.method || 'GET';
    const headers = {
      'Accept': 'application/json'
    };

    let body;

    if (options.body) {
      body = bodyParams(options.body);
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    }

    if (method !== 'GET') {
      const csrf = getCsrfToken();
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }

    const response = await fetch(path, {
      method,
      headers,
      body,
      credentials: 'same-origin'
    });

    const rawText = await response.text();

    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = rawText;
    }

    if (!response.ok) {
      const detail = typeof data === 'string'
        ? data
        : JSON.stringify(data, null, 2);

      throw new Error(`Canvas API request failed: ${method} ${path}\n\nHTTP ${response.status}\n${detail}`);
    }

    return data;
  }

  function setStatus(message, isError = false) {
    let status = document.getElementById(STATUS_ID);

    if (!status) {
      status = document.createElement('div');
      status.id = STATUS_ID;
      status.style.marginTop = '8px';
      status.style.padding = '8px';
      status.style.fontSize = '0.9rem';
      status.style.lineHeight = '1.35';
      status.style.borderRadius = '4px';

      const sidebar = document.querySelector('#right-side > div');
      sidebar?.appendChild(status);
    }

    status.textContent = message;
    status.style.border = isError ? '1px solid #c00' : '1px solid #ccc';
    status.style.background = isError ? '#fff2f2' : '#f7f7f7';
    status.style.color = isError ? '#900' : '#333';
  }

  async function runSpecialEnrollmentWorkflow(button) {
    const userId = getUserIdFromUrl();

    if (!userId) {
      alert('Could not find the Canvas user ID in the current URL.');
      return;
    }

    let intermediateCourseId;
    let destinationCourseId;
    let sectionName;

    try {
      intermediateCourseId = requireCanvasId(
        'Intermediate course ID',
        prompt('Enter the Canvas Course ID of the intermediate course:')
      );

      destinationCourseId = requireCanvasId(
        'Destination course ID',
        prompt('Enter the Canvas Course ID of the destination course:')
      );

      sectionName = prompt(
        'Enter the name for the section to create in the intermediate course:',
        defaultSectionName()
      );

      if (!sectionName || !sectionName.trim()) {
        throw new Error('Section name is required.');
      }

      sectionName = sectionName.trim();
    } catch (error) {
      alert(error.message);
      return;
    }

    const confirmed = confirm(
      [
        'Proceed with special enrollment?',
        '',
        `User ID: ${userId}`,
        `Intermediate course ID: ${intermediateCourseId}`,
        `Destination course ID: ${destinationCourseId}`,
        `Section name: ${sectionName}`,
        '',
        'This will create a section, enroll the user, convert the enrollment to Student, cross-list the section, and open the section page.'
      ].join('\n')
    );

    if (!confirmed) return;

    button.disabled = true;

    try {
      setStatus('Creating section in intermediate course...');

      const section = await canvasApi(`/api/v1/courses/${intermediateCourseId}/sections`, {
        method: 'POST',
        body: {
          'course_section[name]': sectionName
        }
      });

      if (!section?.id) {
        throw new Error('Canvas did not return a section ID after creating the section.');
      }

      const sectionId = section.id;

      setStatus(`Created section ${sectionId}. Adding user as Observer...`);

      const observerEnrollment = await canvasApi(`/api/v1/sections/${sectionId}/enrollments`, {
        method: 'POST',
        body: {
          'enrollment[user_id]': userId,
          'enrollment[type]': 'ObserverEnrollment',
          'enrollment[enrollment_state]': 'active',
          'enrollment[limit_privileges_to_course_section]': 'true',
          'enrollment[notify]': 'false'
        }
      });

      if (!observerEnrollment?.id) {
        throw new Error('Canvas did not return an Observer enrollment ID.');
      }

      setStatus('Observer enrollment created. Creating Student enrollment...');

      await canvasApi(`/api/v1/sections/${sectionId}/enrollments`, {
        method: 'POST',
        body: {
          'enrollment[user_id]': userId,
          'enrollment[type]': 'StudentEnrollment',
          'enrollment[enrollment_state]': 'active',
          'enrollment[limit_privileges_to_course_section]': 'true',
          'enrollment[notify]': 'false'
        }
      });

      setStatus('Student enrollment created. Removing temporary Observer enrollment...');

      await canvasApi(`/api/v1/courses/${intermediateCourseId}/enrollments/${observerEnrollment.id}?task=delete`, {
        method: 'DELETE'
      });

      setStatus('Observer enrollment removed. Cross-listing section to destination course...');

      await canvasApi(`/api/v1/sections/${sectionId}/crosslist/${destinationCourseId}`, {
        method: 'POST',
        body: {
          'override_sis_stickiness': 'true'
        }
      });

      const sectionUrl = `${window.location.origin}/courses/${destinationCourseId}/sections/${sectionId}`;

      setStatus(`Done. Opening section ${sectionId} in a new tab...`);
      window.open(sectionUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
      console.error(error);
      setStatus(error.message, true);
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  }

  function addButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const sidebar = document.querySelector('#right-side > div');
    if (!sidebar) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.className = 'btn button-sidebar-wide';
    button.style.marginTop = '8px';
    button.textContent = 'Special Enrollment';

    button.addEventListener('click', () => runSpecialEnrollmentWorkflow(button));

    const firstMountPoint =
      sidebar.querySelector('#dsr-modal-mount-point') ||
      sidebar.querySelector('#manage-temp-enrollments-mount-point');

    sidebar.insertBefore(button, firstMountPoint || null);
  }

  addButton();
})();