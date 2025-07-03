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
        btn.onclick = () => {
            const proceed = confirm(
                "⚠️ Warning: This export includes student emails and may not match the format required for re-import into Canvas.\n\nDo you want to continue?"
            );
            if (!proceed) return;

            // TODO: Insert API calls and CSV generation here
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


    waitForExportButton((exportBtn) => {
        const customBtn = createCustomButton();
        exportBtn.parentElement.appendChild(customBtn);
    });

})();
