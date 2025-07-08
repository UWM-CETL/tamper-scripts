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

    /* ------------------- UI helpers ------------------- */

    function waitForExportButton(cb) {
        const iv = setInterval(() => {
            const btn = document.querySelector('[data-position="export_btn"]');
            if (btn) {
                clearInterval(iv);
                cb(btn);
            }
        }, 500);
    }

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

    /* ------------------- Canvas API helpers ------------------- */

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
                        next = urlPart.trim().slice(1, -1); // remove <>
                    }
                }
            }
        }
        return out;
    }

    /* --------  data-gathering helpers  -------- */

    async function fetchCourseUsers(courseId) {
        const url = `/api/v1/courses/${courseId}/users?include[]=email&per_page=100`;
        return await canvasApiGetAllPages(url);
    }

    async function buildUserDirectory(courseId) {
        const users = await fetchCourseUsers(courseId);
        const map = new Map();
        for (const u of users) {
            map.set(u.id, {
                name: u.name ?? `ID ${u.id}`,
                loginId: u.login_id ?? u.sis_user_id ?? '',
                email: u.email ?? '',
                grades: {},
            });
        }
        return map;
    }

    async function fetchAssignments(courseId) {
        const url = `/api/v1/courses/${courseId}/assignments?per_page=100`;
        return await canvasApiGetAllPages(url);
    }

    async function fetchSubmissionsForAssignment(courseId, asgId) {
        const url = `/api/v1/courses/${courseId}/assignments/${asgId}/submissions?include[]=user&per_page=100`;
        return await canvasApiGetAllPages(url);
    }

    /* --------------  main export routine -------------- */

    /**
    * Gather every assignment and its submissions, merge them with the
    * user directory, and download a CSV that contains only students
    * who have at least one graded submission.
    *
    * Columns: Student | Login ID | Email | <one per assignment>
    *
    * @param {number|string} courseId   Canvas course ID
    * @param {function}      onProgress Callback (done, total) – optional
    */
    async function exportAllSubmissions(courseId, onProgress = () => { }) {
        /* 1) Build a user directory once (login-ID + email) */
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
                if (!studentMap.has(uid)) continue;           // withdrawn / test users
                studentMap.get(uid).grades[asg.name] = sub.score ?? '';
            }

            onProgress(++done, total);
        }

        /* 3) Build CSV rows — skip users with no grades at all */
        const rows = [['Student', 'Login ID', 'Email', ...titles]];

        for (const s of studentMap.values()) {
            const hasGrade = Object.values(s.grades).some(
                v => v !== '' && v != null
            );
            if (!hasGrade) continue;                        // observers / teachers

            rows.push([
                s.name,
                s.loginId,
                s.email,
                ...titles.map(t => s.grades[t] ?? '')
            ]);
        }

        /* 4) Stringify and download */
        const csv = rows
            .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
            .join('\n');

        downloadCsv(csv, 'canvas_assignment_submissions.csv');
    }


    /* ------------------- download helper ------------------- */

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

    /* ------------------- boot ------------------- */

    waitForExportButton((nativeExportBtn) => {
        nativeExportBtn.parentElement.appendChild(createCustomButton());
    });
})();
