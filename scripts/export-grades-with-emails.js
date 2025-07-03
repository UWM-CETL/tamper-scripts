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
        btn.textContent = 'Export With Emails';
        btn.style.marginLeft = '10px';
        btn.className = 'css-10xwpqb-view--inlineBlock-baseButton'; // mimic Canvas styling
        btn.onclick = async () => {
            const proceed = confirm(
                "⚠️ This export includes student emails and raw scores. It is not re-importable into Canvas.\n\nContinue?"
            );
            if (!proceed) return;

            const courseId = window.location.pathname.match(/courses\/(\d+)/)?.[1];
            if (!courseId) {
                alert("Could not determine course ID from URL.");
                return;
            }

            try {
                await exportAllSubmissions(courseId);
            } catch (err) {
                console.error("Export failed:", err);
                alert("Failed to export submissions. See console for details.");
            }
        };

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

    async function exportAllSubmissions(courseId) {
        const assignments = await fetchAssignments(courseId);
        const assignmentTitles = {};
        const studentMap = new Map();

        for (const assignment of assignments) {
            const submissions = await fetchSubmissionsForAssignment(courseId, assignment.id);
            assignmentTitles[assignment.id] = assignment.name;

            for (const sub of submissions) {
                const user = sub.user || {};
                const userId = user.id;
                if (!studentMap.has(userId)) {
                    studentMap.set(userId, {
                        name: user.name || `ID ${userId}`,
                        email: user.email || user.login_id || '',
                        grades: {}
                    });
                }
                const student = studentMap.get(userId);
                student.grades[assignment.name] = sub.score ?? '';
            }
        }

        // Build CSV
        const sortedAssignments = assignments.map(a => a.name);
        const headers = ['Student', 'Email', ...sortedAssignments];
        const rows = [headers];

        for (const student of studentMap.values()) {
            const row = [student.name, student.email];
            for (const title of sortedAssignments) {
                row.push(student.grades[title] ?? '');
            }
            rows.push(row);
        }

        const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
        downloadCsv(csv, 'canvas_assignment_submissions.csv');
    }

    waitForExportButton((exportBtn) => {
        const customBtn = createCustomButton();
        exportBtn.parentElement.appendChild(customBtn);
    });

})();
