// ==UserScript==
// @name         You.com Auto-Select Claude Opus 4.6
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Automatically selects Claude Opus 4.6 on You.com
// @match        https://you.com/*
// @match        https://www.you.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    let done = false;

    function trySelect() {
        if (done) return;

        // Step 1: Check if already on Claude
        const activeSpan = document.querySelector('button[data-state="closed"] span.n6zur96, button[data-state="closed"] span._82ityr0');
        if (activeSpan && activeSpan.textContent.includes('Claude')) {
            done = true;
            return;
        }

        // Step 2: Find and click the agent/mode selector button (first button in the toolbar area)
        // This is the "Auto" / "Express" / model name button
        const modeButton = document.querySelector('#ChatQueryBar button[type="button"]');
        if (!modeButton) return;

        modeButton.click();

        // Step 3: Wait for dropdown, then click Claude
        setTimeout(() => {
            if (done) return;

            // Look through all buttons and list items in the tooltip/dropdown
            const dropdown = document.querySelector('[role="tooltip"]');
            if (!dropdown) {
                // Try again — dropdown may not have appeared
                document.body.click(); // close anything
                return;
            }

            // Find Claude in the recents list
            const listButtons = dropdown.querySelectorAll('li button, button[role="option"]');
            for (const btn of listButtons) {
                if (btn.textContent.trim().includes('Claude Opus 4.6')) {
                    btn.click();
                    done = true;
                    console.log('[Userscript] ✅ Claude Opus 4.6 selected!');
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
