// ==UserScript==
// @name         You.com Auto-Select Claude Opus 4.6
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Automatically selects Claude Opus 4.6 on You.com and focuses the text input
// @match        https://you.com/*
// @match        https://www.you.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    let done = false;

    function focusTextarea() {
        setTimeout(() => {
            const textarea = document.getElementById('search-input-textarea');
            if (textarea) {
                textarea.focus();
                console.log('[Userscript] ✅ Textarea focused!');
            } else {
                console.log('[Userscript] ❌ Textarea not found.');
            }
        }, 300);
    }

    function trySelect() {
        if (done) return;

        // Step 1: Check if already on Claude
        const activeSpan = document.querySelector('button[data-state="closed"] span.n6zur96, button[data-state="closed"] span._82ityr0');
        if (activeSpan && activeSpan.textContent.includes('Claude')) {
            done = true;
            focusTextarea();
            return;
        }

        // Step 2: Find and click the agent/mode selector button
        const modeButton = document.querySelector('#ChatQueryBar button[type="button"]');
        if (!modeButton) return;

        modeButton.click();

        // Step 3: Wait for dropdown, then click Claude
        setTimeout(() => {
            if (done) return;

            const dropdown = document.querySelector('[role="tooltip"]');
            if (!dropdown) {
                document.body.click();
                return;
            }

            const listButtons = dropdown.querySelectorAll('li button, button[role="option"]');
            for (const btn of listButtons) {
                if (btn.textContent.trim().includes('Claude Opus 4.6')) {
                    btn.click();
                    done = true;
                    console.log('[Userscript] ✅ Claude Opus 4.6 selected!');
                    // Focus the textarea after selecting Claude
                    focusTextarea();
                    return;
                }
            }

            // Close dropdown if not found
            document.body.click();
            console.log('[Userscript] ❌ Claude not found in dropdown.');
        }, 500);
    }

    // Run repeatedly until successful
    const interval = setInterval(() => {
        if (done) {
            clearInterval(interval);
            return;
        }
        trySelect();
    }, 1500);

    // Stop trying after 30 seconds
    setTimeout(() => {
        clearInterval(interval);
    }, 30000);

    // Also re-run on URL changes (SPA navigation)
    let lastUrl = location.href;
    new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            done = false;
        }
    }).observe(document.body, { childList: true, subtree: true });
})();
