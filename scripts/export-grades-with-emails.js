// ==UserScript==
// @name         Canvas - Export Grades With Email
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Adds a custom export button to Canvas gradebook for enhanced data export
// @author       Catarino David Delgado
// @match        https://*.instructure.com/courses/*/gradebook
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    function waitForExportButton(callback) {
        const interval = setInterval(() => {
            const exportBtn = document.querySelector('[data-position="export_btn"]');
            if (exportBtn) {
                clearInterval(interval);
                callback(exportBtn);
            }
        }, 500);
    }

    function createCustomButton() {
        const btn = document.createElement('button');
        btn.style.marginLeft = '10px';
        btn.className = 'css-10xwpqb-view--inlineBlock-baseButton';

        // static label + dynamic counter (hidden from AT)
        const labelSpan    = document.createElement('span');
        const counterSpan  = document.createElement('span');
        counterSpan.setAttribute('aria-hidden', 'true');
        counterSpan.style.marginLeft = '4px';

        labelSpan.textContent   = 'Export With Emails';
        btn.appendChild(labelSpan);
        btn.appendChild(counterSpan);

        /* ---- single live region for the whole page ---- */
        let live = document.getElementById('csv-export-live');
        if (!live) {
            live = Object.assign(document.createElement('div'), {
                id: 'csv-export-live',
                style: 'position:absolute;left:-9999px;',
            });
            live.setAttribute('aria-live', 'polite');
            document.body.appendChild(live);
        }

        let busy = false;

        btn.onclick = async () => {
            if (busy) return;
            if (!confirm("⚠️ This export includes student emails and raw scores. It is *not* re-importable into Canvas.\n\nContinue?")) return;

            busy = true;
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
            labelSpan.textContent = 'Exporting…';
            counterSpan.textContent = '';
            live.textContent = 'Generating report…';

            /* callback that updates the counter but stays invisible to AT */
            const updateProgress = (done, total) => {
                counterSpan.textContent = `(${done}/${total})`;
            };

            const courseId = window.location.pathname.match(/courses\/(\d+)/)?.[1];
            if (!courseId) {
                alert('Could not determine course ID from URL.');
                reset();
                return;
            }

            try {
                await exportAllSubmissions(courseId, updateProgress);
                live.textContent = 'Report ready — download started.';
            } catch (err) {
                console.error('Export failed:', err);
                alert('Failed to export submissions. See console for details.');
                live.textContent = 'Export failed.';
            } finally {
                reset();
            }
        };

        function reset() {
            busy = false;
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            labelSpan.textContent = 'Export With Emails';
            counterSpan.textContent = '';
        }

        return btn;
    }

    async function canvasApiGetAllPages(initialUrl) {
      const results = [];
      let nextUrl = initialUrl;
      let lastUrl = null;

      while (nextUrl && nextUrl !== lastUrl) {
          const response = await fetch(nextUrl, {
              method: 'GET',
              credentials: 'include',
              headers: {
                  'Accept': 'application/json'
              }
          });

          if (!response.ok) {
              throw new Error(`Canvas API request failed: ${response.status}`);
          }

          const data = await response.json();
          results.push(...data);

          // Prepare for next iteration
          lastUrl = nextUrl;
          nextUrl = null;

          const linkHeader = response.headers.get('Link');
          if (linkHeader) {
              const links = linkHeader.split(',').map(part => part.trim());
              for (const link of links) {
                  const [urlPart, relPart] = link.split(';');
                  if (relPart && relPart.includes('rel="next"')) {
                      const match = urlPart.match(/<(.+)>/);
                      if (match && match[1] !== lastUrl) {
                          nextUrl = match[1];
                      }
                  }
              }
          }
      }

      return results;
    }

    async function fetchAssignments(courseId) {
        const url = `/api/v1/courses/${courseId}/assignments`;
        return await canvasApiGetAllPages(url);
    }

    async function fetchSubmissionsForAssignment(courseId, assignmentId) {
        const url = `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions?include[]=user`;
        return await canvasApiGetAllPages(url);
    }

    /**
     * Fetch all assignments, then every submission (with user objects),
     * merge the data into a single CSV, and download it.
     *
     * @param {number|string} courseId              Canvas course ID
     * @param {function}      onProgress            Callback (done, total) – optional
     *                                             Fires once at start, then after each assignment
     */
    async function exportAllSubmissions(courseId, onProgress = () => {}) {
        const assignments = await fetchAssignments(courseId);  
        const total       = assignments.length;
        let   done        = 0;
        onProgress(done, total);

        const studentMap       = new Map();
        const assignmentTitles = [];

        for (const asg of assignments) {
            assignmentTitles.push(asg.name);
            const subs = await fetchSubmissionsForAssignment(courseId, asg.id);

            for (const sub of subs) {
                const u    = sub.user ?? {};
                const uid  = u.id ?? sub.user_id;
                if (!studentMap.has(uid)) {
                    studentMap.set(uid, {
                        name:  u.name      ?? `ID ${uid}`,
                        email: u.email     ?? u.login_id ?? '',
                        grades: {}
                    });
                }
                studentMap.get(uid).grades[asg.name] = sub.score ?? '';
            }

            done += 1;
            onProgress(done, total);
        }

        const rows = [
            ['Student', 'Email', ...assignmentTitles]
        ];

        for (const student of studentMap.values()) {
            rows.push([
                student.name,
                student.email,
                ...assignmentTitles.map(t => student.grades[t] ?? '')
            ]);
        }

        const csv = rows
            .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
            .join('\n');

        downloadCsv(csv, 'canvas_assignment_submissions.csv');
    }


    function downloadCsv(csv, filename = 'export.csv') {
        // Pre-pend UTF-8 BOM so Excel opens UTF-8 correctly
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    waitForExportButton((exportBtn) => {
        const customBtn = createCustomButton();
        exportBtn.parentElement.appendChild(customBtn);
    });

})();
