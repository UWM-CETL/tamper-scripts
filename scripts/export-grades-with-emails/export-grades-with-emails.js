// ==UserScript==
// @name         Canvas – Export Grades With Email
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  Adds an “Export With Emails” button to Canvas gradebook that downloads Student, Login ID, Email and all assignment scores in one CSV
// @author       Catarino David Delgado
// @match        https://*.instructure.com/courses/*/gradebook
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /**
     * Waits for the native Canvas export button to appear, then calls the callback with the button element.
     * @param {function(HTMLElement):void} cb - Callback to execute when the export button is found.
     */
    function waitForExportButton(cb) {
        const iv = setInterval(() => {
            const btn = document.querySelector('[data-position="export_btn"]');
            if (btn) {
                clearInterval(iv);
                cb(btn);
            }
        }, 500);
    }

    /**
     * Creates the custom "Export With Emails" button and sets up its event handlers.
     * @returns {HTMLButtonElement} The custom export button element.
     */
    function createCustomButton() {
        const btn = document.createElement('button');
        btn.style.marginLeft = '10px';
        btn.className = 'css-10xwpqb-view--inlineBlock-baseButton';

        const label = document.createElement('span');
        const counter = document.createElement('span');
        counter.setAttribute('aria-hidden', 'true');
        counter.style.marginLeft = '4px';

        label.textContent = 'Export With Emails';
        btn.appendChild(label);
        btn.appendChild(counter);

        /* live-region (one per page) */
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
            if (
                !confirm(
                    '⚠️  This export includes student emails and raw scores.\n' +
                    'It is *not* re-importable into Canvas.\n\nContinue?'
                )
            )
                return;

            busy = true;
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
            label.textContent = 'Exporting…';
            counter.textContent = '';
            live.textContent = 'Generating report…';

            const update = (d, t) => (counter.textContent = `(${d}/${t})`);

            const courseId = window.location.pathname.match(/courses\/(\d+)/)?.[1];
            if (!courseId) {
                alert('Could not determine course ID from URL.');
                reset();
                return;
            }

            try {
                await exportAllSubmissions(courseId, update);
                live.textContent = 'Report ready — download started.';
            } catch (e) {
                console.error('Export failed:', e);
                alert('Failed to export submissions. See console for details.');
                live.textContent = 'Export failed.';
            } finally {
                reset();
            }

            function reset() {
                busy = false;
                btn.disabled = false;
                btn.removeAttribute('aria-busy');
                label.textContent = 'Export With Emails';
                counter.textContent = '';
            }
        };

        return btn;
    }

    /**
     * Fetches all paginated results from a Canvas API endpoint.
     * @param {string} firstUrl - The initial API endpoint URL.
     * @returns {Promise<Array>} Resolves to an array of all results from all pages.
     */
    async function canvasApiGetAllPages(firstUrl) {
        const out = [];
        let next = firstUrl;
        let prev = null;

        while (next && next !== prev) {
            const res = await fetch(next, {
                credentials: 'include',
                headers: { Accept: 'application/json' },
            });
            if (!res.ok) throw new Error(`Canvas API error: ${res.status}`);

            const data = await res.json();
            out.push(...data);

            prev = next;
            next = null;
            const link = res.headers.get('Link');
            if (link) {
                for (const segment of link.split(',')) {
                    const [urlPart, relPart] = segment.split(';');
                    if (relPart?.includes('rel="next"')) {
                        next = urlPart.trim().slice(1, -1);
                    }
                }
            }
        }
        return out;
    }

    /**
     * Fetches all student users for a course, including their emails and enrollments.
     * @param {number|string} courseId - Canvas course ID.
     * @returns {Promise<Array>} Resolves to an array of user objects.
     */
    async function fetchCourseUsers(courseId) {
        const url =
            `/api/v1/courses/${courseId}/users` +
            '?include[]=email' +
            '&include[]=enrollments' +
            '&enrollment_type[]=student' +
            '&per_page=100';

        return await canvasApiGetAllPages(url);
    }

    /**
     * Builds a directory (Map) of student user data for the course.
     * @param {number|string} courseId - Canvas course ID.
     * @returns {Promise<Map<number, {name: string, loginId: string, email: string, letter: string, grades: Object}>>} Map of user ID to user info.
     */
    async function buildUserDirectory(courseId) {
        const users = await fetchCourseUsers(courseId);
        const map = new Map();

        for (const u of users) {
            /* pick the student enrollment (there is only one for normal students) */
            let letter = '';
            if (u.enrollments && u.enrollments.length) {
                const e = u.enrollments.find(en => en.type === 'StudentEnrollment');
                letter = e?.grades?.final_grade ?? e?.grades?.current_grade ?? '';
            }

            map.set(u.id, {
                name: u.name ?? `ID ${u.id}`,
                loginId: u.login_id ?? u.sis_user_id ?? '',
                email: u.email ?? '',
                letter: letter,
                grades: {}
            });
        }
        return map;
    }


    /**
     * Fetches all assignments for a course.
     * @param {number|string} courseId - Canvas course ID.
     * @returns {Promise<Array>} Resolves to an array of assignment objects.
     */
    async function fetchAssignments(courseId) {
        const url = `/api/v1/courses/${courseId}/assignments?per_page=100`;
        return await canvasApiGetAllPages(url);
    }

    /**
     * Fetches all submissions for a given assignment in a course.
     * @param {number|string} courseId - Canvas course ID.
     * @param {number|string} asgId - Assignment ID.
     * @returns {Promise<Array>} Resolves to an array of submission objects.
     */
    async function fetchSubmissionsForAssignment(courseId, asgId) {
        const url = `/api/v1/courses/${courseId}/assignments/${asgId}/submissions?include[]=user&per_page=100`;
        return await canvasApiGetAllPages(url);
    }

    /**
     * Gathers every assignment and its submissions, merges them with the user directory, and downloads a CSV.
     * Columns in order: Student | Login ID | Email | <one column per assignment> | Final Grade
     * Only students who have at least one graded submission are included.
     *
     * @param {number|string} courseId - Canvas course ID.
     * @param {function(number, number):void} [onProgress] - Optional callback for progress updates (done, total).
     * @returns {Promise<void>} Resolves when the CSV has been downloaded.
     */
    async function exportAllSubmissions(courseId, onProgress = () => { }) {
        /* 1) Build a user directory once (login-ID, email, letter grade) */
        const studentMap = await buildUserDirectory(courseId);

        /* 2) Get every assignment, then every submission */
        const assignments = await fetchAssignments(courseId);
        const total = assignments.length;
        let done = 0;
        onProgress(done, total);

        const titles = [];

        for (const asg of assignments) {
            titles.push(asg.name);

            const subs = await fetchSubmissionsForAssignment(courseId, asg.id);
            for (const sub of subs) {
                const uid = sub.user_id ?? sub.user?.id;
                if (!studentMap.has(uid)) continue;
                studentMap.get(uid).grades[asg.name] = sub.score ?? '';
            }

            onProgress(++done, total);
        }

        /* 3) Build CSV rows — skip users with no grades at all */
        const rows = [['Student', 'Login ID', 'Email', ...titles, 'Final Grade']];

        for (const s of studentMap.values()) {
            const hasGrade = Object.values(s.grades).some(
                v => v !== '' && v != null
            );
            if (!hasGrade) continue;

            rows.push([
                s.name,
                s.loginId,
                s.email,
                ...titles.map(t => s.grades[t] ?? ''),
                s.letter
            ]);
        }

        /* 4) Stringify and download */
        const csv = rows
            .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
            .join('\n');

        downloadCsv(csv, 'canvas_assignment_submissions.csv');
    }

    /**
     * Downloads a CSV file with the given text content and filename.
     * @param {string} text - The CSV content.
     * @param {string} [filename='export.csv'] - The filename for the downloaded file.
     */
    function downloadCsv(text, filename = 'export.csv') {
        const blob = new Blob(['\uFEFF' + text], {
            type: 'text/csv;charset=utf-8;',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    waitForExportButton((nativeExportBtn) => {
        nativeExportBtn.parentElement.appendChild(createCustomButton());
    });
})();
