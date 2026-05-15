// ==UserScript==
// @name         Canvas – Export Grades With Emails and Completion Dates
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  Adds an “Export With Completion Dates” button to Canvas gradebook that downloads Student, Login ID, Email, assignment scores, assignment completion dates, and final grade in one CSV
// @author       Catarino David Delgado
// @match        https://*.instructure.com/courses/*/gradebook?*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

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

        label.textContent = 'Export With Completion Dates';
        btn.appendChild(label);
        btn.appendChild(counter);

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
                    '⚠️  This export includes student emails, raw scores, and completion timestamps.\n' +
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
                label.textContent = 'Export With Completion Dates';
                counter.textContent = '';
            }
        };

        return btn;
    }

    async function canvasApiGetAllPages(firstUrl, arrayKey = null) {
        const out = [];
        let next = firstUrl;
        let prev = null;

        while (next && next !== prev) {
            const res = await fetch(next, {
                credentials: 'include',
                headers: { Accept: 'application/json' },
            });
            if (!res.ok) throw new Error(`Canvas API error: ${res.status} for ${next}`);

            const data = await res.json();
            if (Array.isArray(data)) {
                out.push(...data);
            } else if (arrayKey && Array.isArray(data[arrayKey])) {
                out.push(...data[arrayKey]);
            } else {
                throw new Error(`Canvas API response was not an array${arrayKey ? ` or ${arrayKey} wrapper` : ''}.`);
            }

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

    async function fetchCourseUsers(courseId) {
        const url =
            `/api/v1/courses/${courseId}/users` +
            '?include[]=email' +
            '&include[]=enrollments' +
            '&enrollment_type[]=student' +
            '&per_page=100';

        return await canvasApiGetAllPages(url);
    }

    async function buildUserDirectory(courseId) {
        const users = await fetchCourseUsers(courseId);
        const map = new Map();

        for (const u of users) {
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
                grades: {},
                completedAt: {}
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

    async function fetchClassicQuizSubmissions(courseId, quizId) {
        const url = `/api/v1/courses/${courseId}/quizzes/${quizId}/submissions?per_page=100`;
        return await canvasApiGetAllPages(url, 'quiz_submissions');
    }

    function isClassicQuizAssignment(asg) {
        return Boolean(
            asg.quiz_id &&
            Array.isArray(asg.submission_types) &&
            asg.submission_types.includes('online_quiz')
        );
    }

    function formatTimestampForCsv(value) {
        if (!value) return '';
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return value;

        const pad = n => String(n).padStart(2, '0');
        return [
            d.getFullYear(),
            '-',
            pad(d.getMonth() + 1),
            '-',
            pad(d.getDate()),
            ' ',
            pad(d.getHours()),
            ':',
            pad(d.getMinutes()),
            ':',
            pad(d.getSeconds())
        ].join('');
    }

    function setLatestCompletion(student, assignmentId, candidate) {
        if (!candidate) return;

        const existing = student.completedAt[assignmentId];
        if (!existing || new Date(candidate).getTime() > new Date(existing).getTime()) {
            student.completedAt[assignmentId] = candidate;
        }
    }

    async function exportAllSubmissions(courseId, onProgress = () => { }) {
        const studentMap = await buildUserDirectory(courseId);

        const assignments = await fetchAssignments(courseId);
        const total = assignments.length;
        let done = 0;
        onProgress(done, total);

        const assignmentColumns = [];

        for (const asg of assignments) {
            assignmentColumns.push({
                id: asg.id,
                scoreTitle: asg.name,
                completedTitle: `${asg.name} Completed At`
            });

            const subs = await fetchSubmissionsForAssignment(courseId, asg.id);
            for (const sub of subs) {
                const uid = sub.user_id ?? sub.user?.id;
                if (!studentMap.has(uid)) continue;

                const student = studentMap.get(uid);
                student.grades[asg.id] = sub.score ?? '';

                setLatestCompletion(student, asg.id, sub.submitted_at);
            }

            if (isClassicQuizAssignment(asg)) {
                try {
                    const quizSubs = await fetchClassicQuizSubmissions(courseId, asg.quiz_id);
                    for (const qs of quizSubs) {
                        if (qs.workflow_state !== 'complete') continue;
                        if (!studentMap.has(qs.user_id)) continue;

                        setLatestCompletion(studentMap.get(qs.user_id), asg.id, qs.finished_at);
                    }
                } catch (e) {
                    console.warn(`Could not fetch Classic Quiz completion dates for assignment ${asg.id} / quiz ${asg.quiz_id}. Falling back to assignment submitted_at.`, e);
                }
            }

            onProgress(++done, total);
        }

        const rows = [[
            'Student',
            'Login ID',
            'Email',
            ...assignmentColumns.flatMap(a => [a.scoreTitle, a.completedTitle]),
            'Final Grade'
        ]];

        for (const s of studentMap.values()) {
            const hasGrade = Object.values(s.grades).some(
                v => v !== '' && v != null
            );
            const hasCompletion = Object.values(s.completedAt).some(
                v => v !== '' && v != null
            );
            if (!hasGrade && !hasCompletion) continue;

            rows.push([
                s.name,
                s.loginId,
                s.email,
                ...assignmentColumns.flatMap(a => [
                    s.grades[a.id] ?? '',
                    formatTimestampForCsv(s.completedAt[a.id])
                ]),
                s.letter
            ]);
        }

        const csv = rows
            .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
            .join('\n');

        downloadCsv(csv, 'canvas_assignment_submissions_with_completion_dates.csv');
    }

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
        nativeExportBtn.parentElement.parentElement.appendChild(createCustomButton());
    });
})();