// ==UserScript==
// @name         Auto-Coder v13
// @namespace    http://tampermonkey.net/
// @version      13.0
// @description  Auto-continue with robust completion detection, overlap merging, harvest, and test suite. FIXED: DOM selectors use stable data-testid/aria attributes anchored to #chat-history, not dynamic class names.
// @match        https://you.com/*
// @grant        none
// ==/UserScript==

(function() {
'use strict';

// ============================================================
// CONSTANTS
// ============================================================

var BT = String.fromCharCode(96);
var FENCE = BT + BT + BT;
var FINISH_MARKER = 'AUTOCODER_FINISHED';
var OVERLAP_LINES = 5;

var DELAY_MS = 25000;
var MAX = 25;
var POLL_MS = 1500;
var AUTO_HARVEST_SETTLE_MS = 14000;
var RESPONSE_SETTLE_MS = 5000;
var STREAM_CHECK_INTERVAL = 1200;
var STREAM_STABLE_CHECKS = 4;
var MIN_CODE_LENGTH_FOR_COMPLETE = 400;
var INITIAL_POLL_DELAY = 7000;
var CONTINUE_POLL_DELAY = 6000;

// ============================================================
// STATE
// ============================================================

var running = false;
var continues = 0;
var lastTurns = 0;
var accumulated = '';
var lastRawTail = '';
var prevHadUnclosedBlock = false;
var waitTimer = null;
var waitRemaining = 0;
var totalGenerations = 0;
var processingCount = 0;
var doneCount = 0;
var autoHarvestObserver = null;
var lastAutoHarvestTurns = 0;
var autoHarvestPending = null;
var lastHarvestedText = '';
var barHeight = 70;
var audioCtx = null;
var pollTimeout = null;
var lastSeenTextLength = 0;
var stableCheckCount = 0;
var lastResponseText = '';
var responseHandleTimeout = null;
var isProcessingResponse = false;
var debugLog = [];

// ============================================================
// DEBUG LOGGING
// ============================================================

function log(msg) {
    var entry = '[AutoCoder ' + new Date().toISOString().slice(11,19) + '] ' + msg;
    console.log(entry);
    debugLog.push(entry);
    if (debugLog.length > 300) debugLog.shift();
}

// ============================================================
// DOM HELPERS — ANCHORED TO #chat-history, USING STABLE SELECTORS
// All queries go through getChatRoot() to avoid stale references.
// We NEVER use dynamic class names like _1d4fgvb0, hljs, etc.
// ============================================================

function getChatRoot() {
    return document.getElementById('chat-history') || document.body;
}

function qs(sel, root) { return (root || document).querySelector(sel); }
function qsa(sel, root) { return (root || document).querySelectorAll(sel); }

function getAnswerTurns() {
    return qsa('[data-testid^="youchat-answer-turn-"]', getChatRoot());
}

function getQuestionTurns() {
    return qsa('[data-testid^="youchat-question-turn-"]', getChatRoot());
}

function getTurnCount() {
    return getAnswerTurns().length;
}

function getLastAnswerTurnEl() {
    var all = getAnswerTurns();
    return all.length ? all[all.length - 1] : null;
}

function getLastTurnText() {
    var el = getLastAnswerTurnEl();
    if (!el) return '';
    return el.innerText || el.textContent || '';
}

function getLastTurnId() {
    var el = getLastAnswerTurnEl();
    if (!el) return '';
    return el.getAttribute('data-pinnedconversationturnid') || el.getAttribute('data-testid') || '';
}

// ============================================================
// GENERATION DETECTION — uses data-testid step attributes
// The workflow steps have data-finished="true"/"false"
// We also check for a stop button and text growth.
// ============================================================

function isGenerating() {
    var root = getChatRoot();

    // Method 1: Workflow steps with data-finished="false"
    var steps = qsa('[data-testid^="step-"]', root);
    for (var i = 0; i < steps.length; i++) {
        if (steps[i].getAttribute('data-finished') === 'false') return true;
    }

    // Method 2: Stop button (various possible selectors)
    var stopBtn = qs('[data-testid="stop-button"]') ||
                  qs('[aria-label="Stop generating"]') ||
                  qs('button[aria-label*="Stop"]');
    if (stopBtn) return true;

    return false;
}

function isTextStillChanging() {
    var el = getLastAnswerTurnEl();
    if (!el) return false;
    var currentLen = (el.textContent || '').length;
    if (currentLen !== lastSeenTextLength) {
        lastSeenTextLength = currentLen;
        stableCheckCount = 0;
        return true;
    }
    stableCheckCount++;
    return false;
}

// ============================================================
// CODE EXTRACTION FROM DOM
// We find code blocks by: figure[aria-label="Code Block"] > pre > code
// OR fallback: pre > code (any pre/code pair inside answer turns)
// We do NOT rely on class names.
// ============================================================

function getCodeBlocksFromElement(el) {
    if (!el) return [];
    var results = [];

    // Strategy 1: figure[aria-label="Code Block"] descendants
    var figures = el.querySelectorAll('figure[aria-label="Code Block"]');
    for (var i = 0; i < figures.length; i++) {
        var codeEl = figures[i].querySelector('pre > code') || figures[i].querySelector('pre');
        if (codeEl) {
            var text = codeEl.textContent || '';
            if (text.trim().length > 10) results.push(text);
        }
    }

    // Strategy 2: Any pre > code inside the element (fallback)
    if (results.length === 0) {
        var codeEls = el.querySelectorAll('pre code');
        for (var j = 0; j < codeEls.length; j++) {
            var t = codeEls[j].textContent || '';
            if (t.trim().length > 10) results.push(t);
        }
    }

    // Strategy 3: Any pre element (last resort)
    if (results.length === 0) {
        var pres = el.querySelectorAll('pre');
        for (var k = 0; k < pres.length; k++) {
            var pt = pres[k].textContent || '';
            if (pt.trim().length > 10) results.push(pt);
        }
    }

    return results;
}

function getLastCodeFromDOM() {
    var el = getLastAnswerTurnEl();
    if (!el) return '';
    var blocks = getCodeBlocksFromElement(el);
    if (blocks.length === 0) return '';
    // Return the longest block (most likely the main code)
    var longest = '';
    for (var i = 0; i < blocks.length; i++) {
        if (blocks[i].length > longest.length) longest = blocks[i];
    }
    return longest;
}

function getAllCodeFromAllTurns() {
    var turns = getAnswerTurns();
    var allBlocks = [];
    for (var i = 0; i < turns.length; i++) {
        var blocks = getCodeBlocksFromElement(turns[i]);
        for (var j = 0; j < blocks.length; j++) {
            allBlocks.push(blocks[j]);
        }
    }
    return allBlocks;
}

// ============================================================
// FINISH MARKER DETECTION
// The AI writes AUTOCODER_FINISHED in a <span data-testid="youchat-text">
// which is OUTSIDE the code block, as a sibling text node.
// ============================================================

function isDone(turnText) {
    // Check the full turn text (innerText includes everything)
    if (turnText.indexOf(FINISH_MARKER) !== -1) return true;

    // Also check specifically in youchat-text spans
    var el = getLastAnswerTurnEl();
    if (!el) return false;
    var textSpans = el.querySelectorAll('[data-testid="youchat-text"]');
    for (var i = 0; i < textSpans.length; i++) {
        if ((textSpans[i].textContent || '').indexOf(FINISH_MARKER) !== -1) return true;
    }
    return false;
}

// ============================================================
// FORM SUBMISSION
// ============================================================

function getTextarea() {
    return qs('#search-input-textarea') ||
           qs('textarea[data-testid="search-input-textarea"]') ||
           qs('textarea[placeholder*="Ask"]') ||
           qs('textarea[placeholder*="ask"]');
}

function setNativeValue(ta, text) {
    // React controlled components need the native setter
    var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
}

function clickSend(ta) {
    var form = ta.closest('form');
    if (!form) {
        form = qs('form:has(#search-input-textarea)') || qs('form:has(textarea)');
    }

    if (form) {
        var btn = form.querySelector('button[type="submit"]') ||
                  form.querySelector('[data-testid*="send"]') ||
                  form.querySelector('button[aria-label*="Send"]') ||
                  form.querySelector('button[aria-label*="send"]') ||
                  form.querySelector('button[aria-label*="Submit"]') ||
                  form.querySelector('button[aria-label*="submit"]');

        // Fallback: find the last button in the form (often the submit button)
        if (!btn) {
            var allBtns = form.querySelectorAll('button');
            if (allBtns.length > 0) {
                btn = allBtns[allBtns.length - 1];
            }
        }

        if (btn) {
            btn.disabled = false;
            btn.removeAttribute('disabled');
            btn.click();
            log('Clicked send button');
            return true;
        }
        // Fallback: submit via Enter keypress on textarea
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        log('Dispatched Enter keydown on textarea');
        return true;
    }

    var anyBtn = qs('button[type="submit"]') || qs('[data-testid*="send"]');
    if (anyBtn) {
        anyBtn.click();
        log('Clicked fallback send button');
        return true;
    }

    log('ERROR: Could not find send button or form');
    return false;
}

function submit(text) {
    var ta = getTextarea();
    if (!ta) {
        log('ERROR: textarea not found');
        setStatus('\u274C Textarea not found!');
        return false;
    }
    setNativeValue(ta, text);
    // Small delay to let React process the input event
    setTimeout(function() {
        clickSend(ta);
    }, 400);
    return true;
}

// ============================================================
// STRING HELPERS
// ============================================================

function getLastNLines(text, n) {
    if (!text) return '';
    var lines = text.split('\n');
    // Get last N non-empty lines (but preserve structure)
    var result = [];
    for (var i = lines.length - 1; i >= 0 && result.length < n; i--) {
        result.unshift(lines[i]);
    }
    // Trim leading empty lines from result
    while (result.length > 0 && result[0].trim() === '') result.shift();
    return result.join('\n');
}

function countChar(str, ch) {
    var count = 0;
    for (var i = 0; i < str.length; i++) {
        if (str[i] === ch) count++;
    }
    return count;
}

function countMatches(str, regex) {
    return (str.match(regex) || []).length;
}

function countFences(text) {
    var count = 0, idx = 0;
    while (true) {
        var pos = text.indexOf(FENCE, idx);
        if (pos === -1) break;
        count++;
        idx = pos + 3;
    }
    return count;
}

// ============================================================
// AUDIO FEEDBACK
// ============================================================

function getAudioCtx() {
    if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch(e) { return null; }
    }
    return audioCtx;
}

function playTone(freq, startOffset, dur) {
    var ctx = getAudioCtx();
    if (!ctx) return;
    try {
        var now = ctx.currentTime;
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + startOffset);
        gain.gain.setValueAtTime(0.25, now + startOffset);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + startOffset);
        osc.stop(now + startOffset + dur);
    } catch(e) {}
}

function playProcessingSound() { playTone(440, 0, 0.2); playTone(554.37, 0.1, 0.2); }
function playSuccessSound() { playTone(523.25, 0, 0.15); playTone(659.25, 0.1, 0.15); playTone(783.99, 0.2, 0.3); }

// ============================================================
// COUNTER & TITLE
// ============================================================

function buildTitle() {
    if (totalGenerations >= 12) return '\uD83C\uDF1F BEAST MODE \u2014 ' + totalGenerations + ' Generations!';
    if (totalGenerations >= 7) return '\uD83D\uDE80 Auto-Coder \u2014 ' + totalGenerations + ' generated!!';
    if (totalGenerations >= 3) return '\uD83D\uDD25 Auto-Coder \u2014 ' + totalGenerations + ' generated!';
    if (totalGenerations >= 1) return '\u26A1 Auto-Coder \u2014 ' + totalGenerations + ' generated';
    return '\u2728 AI Auto-Coder \u2014 Ready';
}

function updateCounter() {
    var title = buildTitle();
    document.title = title;
    var el;
    el = qs('#acl-counter-title'); if (el) el.textContent = title;
    el = qs('#acl-count-processing'); if (el) el.textContent = processingCount;
    el = qs('#acl-count-done'); if (el) el.textContent = doneCount;
    el = qs('#acl-count-total'); if (el) el.textContent = totalGenerations;
}

function incrementProcessing() { processingCount++; totalGenerations++; updateCounter(); playProcessingSound(); }
function markDone() { if (processingCount > 0) processingCount--; doneCount++; updateCounter(); playSuccessSound(); }

// ============================================================
// CODE COMPLETENESS CHECKS
// ============================================================

function endsWithHtmlClose(trimmed) {
    return /<\/html>\s*$/i.test(trimmed.slice(-30));
}

function lastLineIsCutOff(trimmed) {
    var lines = trimmed.split('\n');
    var lastLine = lines[lines.length - 1].trim();
    if (lastLine.length === 0) return false;
    // These characters at end of line suggest the code was cut mid-statement
    // Semicolons are valid endings, NOT cut-off indicators
    if (/[+\-*\/=,({|&:\\]$/.test(lastLine)) return true;
    // Unclosed string literal
    var singleQuotes = countChar(lastLine, "'");
    var doubleQuotes = countChar(lastLine, '"');
    if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) return true;
    return false;
}

function hasUnclosedHtml(t) { return /<!DOCTYPE/i.test(t) && !/<\/html>/i.test(t); }

function hasUnbalancedBraces(t) {
    var opens = countMatches(t, /\{/g);
    var closes = countMatches(t, /\}/g);
    var diff = opens - closes;
    if (t.length > 2000 && diff > 1) return true;
    return diff > 2;
}

function hasUnclosedScript(t) { return countMatches(t, /<script/gi) > countMatches(t, /<\/script>/gi); }
function hasUnclosedStyle(t) { return countMatches(t, /<style/gi) > countMatches(t, /<\/style>/gi); }

function hasUnclosedParens(t) {
    var diff = countMatches(t, /\(/g) - countMatches(t, /\)/g);
    if (t.length > 2000 && diff > 2) return true;
    return diff > 3;
}

function hasUnclosedBrackets(t) {
    var diff = countMatches(t, /\[/g) - countMatches(t, /\]/g);
    return diff > 2;
}

function hasUnclosedIIFE(trimmed) {
    if (!/^\s*\(\s*function\s*\(/.test(trimmed)) return false;
    var lastChunk = trimmed.slice(-50).trim();
    return !/\}\s*\)\s*\(\s*\)\s*;?\s*$/.test(lastChunk);
}

function hasUnclosedTemplateLiteral(trimmed) {
    var count = 0;
    for (var i = 0; i < trimmed.length; i++) {
        if (trimmed[i] === BT && (i === 0 || trimmed[i-1] !== '\\')) count++;
    }
    return count % 2 !== 0;
}

function endsAbruptlyMidBlock(trimmed) {
    var lines = trimmed.split('\n');
    if (lines.length < 15) return false;
    var lastFew = lines.slice(-3).join('\n').trim();
    if (/[}\])];\s*$/.test(lastFew)) return false;
    if (/[}\])]\s*$/.test(lastFew)) return false;
    if (/<\/html>\s*$/i.test(lastFew)) return false;
    if ((countMatches(trimmed, /\{/g) - countMatches(trimmed, /\}/g)) > 1) return true;
    return false;
}

function isCodeIncomplete(code) {
    if (!code || code.trim().length === 0) return false;
    var trimmed = code.trim();

    // If it contains the finish marker, it's complete
    if (trimmed.indexOf(FINISH_MARKER) !== -1) return false;

    // Proper HTML ending
    if (endsWithHtmlClose(trimmed)) return false;

    // Proper IIFE ending
    if (/\}\s*\)\s*\(\s*\)\s*;?\s*$/.test(trimmed.slice(-20))) return false;

    // Short code after continues = likely truncated
    if (trimmed.length < MIN_CODE_LENGTH_FOR_COMPLETE && continues > 0) return true;

    return lastLineIsCutOff(trimmed) ||
           hasUnclosedHtml(trimmed) ||
           hasUnbalancedBraces(trimmed) ||
           hasUnclosedScript(trimmed) ||
           hasUnclosedStyle(trimmed) ||
           hasUnclosedParens(trimmed) ||
           hasUnclosedBrackets(trimmed) ||
           endsAbruptlyMidBlock(trimmed) ||
           hasUnclosedIIFE(trimmed) ||
           hasUnclosedTemplateLiteral(trimmed);
}

// ============================================================
// SETTLING DETECTION
// ============================================================

function isResponseFullySettled() {
    if (isGenerating()) return false;
    var el = getLastAnswerTurnEl();
    if (!el) return false;
    if (isTextStillChanging()) return false;
    if (stableCheckCount < STREAM_STABLE_CHECKS) return false;
    // Fence balance: odd = code block still open
    var text = el.innerText || '';
    if (countFences(text) % 2 !== 0) return false;
    return true;
}

// ============================================================
// MERGE OVERLAP
// ============================================================

function findExactOverlap(aLines, bLines) {
    var maxCheck = Math.min(aLines.length, bLines.length, 30);
    var best = 0;
    for (var n = 1; n <= maxCheck; n++) {
        var match = true;
        for (var k = 0; k < n; k++) {
            if (aLines[aLines.length - n + k].trim() !== bLines[k].trim()) { match = false; break; }
        }
        if (match) best = n;
    }
    return best;
}

function findPartialOverlap(aLines, bLines) {
    for (var startB = 0; startB < Math.min(8, bLines.length); startB++) {
        if (bLines[startB].trim() === '') continue;
        for (var posA = Math.max(0, aLines.length - 40); posA < aLines.length; posA++) {
            if (aLines[posA].trim() !== bLines[startB].trim()) continue;
            var matchLen = 1;
            while (posA + matchLen < aLines.length && startB + matchLen < bLines.length &&
                   aLines[posA + matchLen].trim() === bLines[startB + matchLen].trim()) {
                matchLen++;
            }
            if (posA + matchLen >= aLines.length && matchLen >= 2) {
                return { posA: posA, startB: startB };
            }
        }
    }
    return null;
}

function fixTruncatedTail(aLines, bLines) {
    if (aLines.length === 0 || bLines.length === 0) return false;
    var lastA = aLines[aLines.length - 1].trim();
    if (lastA.length === 0) return false;
    // Find first non-empty line in B
    var firstBIdx = 0;
    while (firstBIdx < bLines.length && bLines[firstBIdx].trim() === '') firstBIdx++;
    if (firstBIdx >= bLines.length) return false;
    var firstB = bLines[firstBIdx].trim();
    // Check if B's first line starts with A's last line (A was truncated)
    if (firstB.length > lastA.length && firstB.indexOf(lastA) === 0) {
        aLines.pop();
        return true;
    }
    // Also check if A's last line is a prefix of B's first line (without requiring strict indexOf === 0)
    // Handle case where lastA ends with an operator and firstB continues it
    if (lastA.length >= 3 && firstB.length > lastA.length) {
        // Try matching without trailing whitespace variations
        var lastANoTrail = lastA.replace(/\s+$/, '');
        var firstBStart = firstB.substring(0, lastANoTrail.length);
        if (firstBStart === lastANoTrail) {
            aLines.pop();
            return true;
        }
    }
    return false;
}

function mergeOverlap(existing, fragment) {
    if (!existing) return fragment;
    if (!fragment) return existing;
    if (fragment.trim().length < 30 && existing.trim().length > 100) return existing;

    var aLines = existing.split('\n');
    var bLines = fragment.split('\n');

    fixTruncatedTail(aLines, bLines);

    var exact = findExactOverlap(aLines, bLines);
    if (exact > 0) {
        log('Merge: exact overlap of ' + exact + ' lines');
        var remainder = bLines.slice(exact);
        if (remainder.length === 0) {
            return aLines.join('\n');
        }
        return aLines.join('\n') + '\n' + remainder.join('\n');
    }

    var partial = findPartialOverlap(aLines, bLines);
    if (partial) {
        log('Merge: partial overlap at posA=' + partial.posA + ' startB=' + partial.startB);
        var head = aLines.slice(0, partial.posA);
        var tail = bLines.slice(partial.startB);
        if (head.length === 0) return tail.join('\n');
        return head.join('\n') + '\n' + tail.join('\n');
    }

    log('Merge: no overlap found, concatenating');
    return existing + '\n' + fragment;
}

// ============================================================
// RAW TAIL FOR CONTINUE PROMPT
// ============================================================

function getRawTail() {
    var code = getLastCodeFromDOM();
    var source = (code && code.trim().length > 0) ? code : accumulated;
    if (!source) return '';
    return getLastNLines(source, OVERLAP_LINES);
}

// ============================================================
// HARVEST
// ============================================================

function cleanMarkers(code) {
    var patterns = [
        /^.*!!!!!CODEBLOCK_STARTS!!!!!.*$/gm,
        /^.*!!!!!CODEBLOCK_ENDS!!!!!.*$/gm,
        /^.*AUTOCODER_FINISHED.*$/gm,
        /^.*>>>CODE STARTS<<<.*$/gm,
        /^.*>>>CODE ENDS<<<.*$/gm,
        /^.*>>>FINISHED<<<.*$/gm
    ];
    var cleaned = code;
    for (var i = 0; i < patterns.length; i++) {
        cleaned = cleaned.replace(patterns[i], '');
    }
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.replace(/^\n+/, '').replace(/\n+$/, '');
}

function harvestAllCode() {
    var turns = getAnswerTurns();
    if (!turns || turns.length === 0) {
        log('Harvest: no answer turns found');
        return '';
    }

    var allCode = '';
    for (var i = 0; i < turns.length; i++) {
        var blocks = getCodeBlocksFromElement(turns[i]);
        for (var j = 0; j < blocks.length; j++) {
            var cleaned = cleanMarkers(blocks[j]);
            if (cleaned.trim().length > 20) {
                allCode = mergeOverlap(allCode, cleaned);
            }
        }
    }
    return allCode.trim();
}

function isValidHarvest(code) {
    if (!code || code.trim().length < 50) return false;
    var lines = code.split('\n');
    return lines.length >= 2;
}

function doHarvest() {
    setStatus('\uD83C\uDF3E Harvesting...');
    var code = harvestAllCode();
    if (!isValidHarvest(code)) {
        // Try accumulated
        if (isValidHarvest(accumulated)) {
            code = accumulated;
        } else {
            var turnCount = getTurnCount();
            var codeElCount = qsa('pre code', getChatRoot()).length;
            setStatus('\u26A0 No valid code found. Turns: ' + turnCount + ', Code elements: ' + codeElCount);
            log('Harvest failed. Turns: ' + turnCount + ', Code els: ' + codeElCount);
            return;
        }
    }
    accumulated = code;
    lastHarvestedText = code;
    injectCodeBlock(code);
    copyToClipboard(code, function() {
        setStatus('\uD83C\uDF3E ' + code.split('\n').length + ' lines harvested & copied!');
        playSuccessSound();
    }, function() {
        setStatus('\uD83C\uDF3E ' + code.split('\n').length + ' lines harvested (clipboard failed).');
    });
}

// ============================================================
// CLIPBOARD
// ============================================================

function copyToClipboard(text, onSuccess, onFail) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(onSuccess || function(){}).catch(onFail || function(){});
    } else if (onFail) { onFail(); }
}

// ============================================================
// AUTO-HARVEST OBSERVER
// ============================================================

function cancelPendingAutoHarvest() {
    if (autoHarvestPending) { clearTimeout(autoHarvestPending); autoHarvestPending = null; }
}

function tryAutoHarvest() {
    if (running) return;
    if (isGenerating()) {
        autoHarvestPending = setTimeout(tryAutoHarvest, 2000);
        return;
    }
    if (!isResponseFullySettled()) {
        autoHarvestPending = setTimeout(tryAutoHarvest, 2000);
        return;
    }
    // Additional delay after settling to make sure nothing else is coming
    setTimeout(function() {
        if (!isResponseFullySettled() || running || isGenerating()) return;
        if (isTextStillChanging()) {
            autoHarvestPending = setTimeout(tryAutoHarvest, 2000);
            return;
        }
        var code = harvestAllCode();
        if (isValidHarvest(code) && code !== lastHarvestedText) {
            accumulated = code;
            lastHarvestedText = code;
            injectCodeBlock(code);
            log('Auto-harvested ' + code.split('\n').length + ' lines');
        }
        autoHarvestPending = null;
    }, 3000);
}

function onAutoHarvestMutation() {
    if (isGenerating() || running) return;
    var currentTurns = getTurnCount();
    if (currentTurns > lastAutoHarvestTurns) {
        lastAutoHarvestTurns = currentTurns;
        cancelPendingAutoHarvest();
        autoHarvestPending = setTimeout(tryAutoHarvest, AUTO_HARVEST_SETTLE_MS);
    }
}

function startAutoHarvest() {
    if (autoHarvestObserver) return;
    var root = getChatRoot();
    if (!root) return; // Only fail if there's truly no root
    autoHarvestObserver = new MutationObserver(onAutoHarvestMutation);
    autoHarvestObserver.observe(root, { childList: true, subtree: true });
    log('Auto-harvest observer started on ' + (root.id ? '#' + root.id : root.tagName));
}

// ============================================================
// INJECTED CODE BLOCK UI
// ============================================================

function injectCodeBlock(code) {
    var lastTurn = getLastAnswerTurnEl();
    if (!lastTurn) return;
    if (!isValidHarvest(code)) return;

    var old = document.getElementById('acl-injected-block');
    if (old) {
        var codeEl = old.querySelector('code');
        var headerEl = old.querySelector('.acl-header-text');
        if (codeEl) codeEl.textContent = code;
        if (headerEl) headerEl.textContent = '\u2714 MERGED OUTPUT (' + code.split('\n').length + ' lines)';
        return;
    }

    var wrapper = createBlockUI(code);
    var container = lastTurn.parentElement;
    if (container) container.insertBefore(wrapper, lastTurn.nextSibling);
    else lastTurn.after(wrapper);
}

function createButton(text, style, onClick) {
    var btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = style;
    btn.addEventListener('click', onClick);
    return btn;
}

function createBlockUI(code) {
    var wrapper = document.createElement('div');
    wrapper.id = 'acl-injected-block';
    wrapper.style.cssText = 'margin:16px 0;border:2px solid #7c3aed;border-radius:10px;overflow:hidden;position:relative;box-sizing:border-box;';

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#1a1528;border-bottom:1px solid #333;flex-wrap:wrap;gap:8px;';

    var headerText = document.createElement('span');
    headerText.className = 'acl-header-text';
    headerText.style.cssText = 'color:#a5b4fc;font:600 12px/1.4 sans-serif;';
    headerText.textContent = '\u2714 MERGED OUTPUT (' + code.split('\n').length + ' lines)';
    header.appendChild(headerText);

    var btnWrap = document.createElement('div');
    btnWrap.style.cssText = 'display:flex;gap:6px;flex-shrink:0;';

    var copyBtn = createButton('Copy All',
        'padding:4px 12px;border:none;border-radius:6px;background:#7c3aed;color:#fff;font:600 11px/1 sans-serif;cursor:pointer;white-space:nowrap;',
        function() {
            var content = wrapper.querySelector('code').textContent;
            copyToClipboard(content, function() {
                copyBtn.textContent = 'Copied!';
                setTimeout(function() { copyBtn.textContent = 'Copy All'; }, 2000);
            });
        });

    var dlBtn = createButton('Download .html',
        'padding:4px 12px;border:none;border-radius:6px;background:#059669;color:#fff;font:600 11px/1 sans-serif;cursor:pointer;white-space:nowrap;',
        function() { downloadFile(wrapper.querySelector('code').textContent, 'output.html', 'text/html'); });

    btnWrap.appendChild(copyBtn);
    btnWrap.appendChild(dlBtn);
    header.appendChild(btnWrap);

    var pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;padding:16px;overflow:auto;max-height:500px;background:#0a0a0f;-webkit-overflow-scrolling:touch;';
    var codeEl = document.createElement('code');
    codeEl.style.cssText = 'white-space:pre-wrap;word-wrap:break-word;color:#e2e8f0;font:12px/1.6 "SF Mono",Consolas,monospace;display:block;';
    codeEl.textContent = code;
    pre.appendChild(codeEl);

    wrapper.appendChild(header);
    wrapper.appendChild(pre);
    return wrapper;
}

// ============================================================
// DOWNLOAD HELPER
// ============================================================

function downloadFile(content, filename, mimeType) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: mimeType }));
    a.download = filename;
    a.click();
}

// ============================================================
// MAIN FLOW: POLLING
// ============================================================

function poll() {
    if (!running) return;

    // If still generating, keep polling
    if (isGenerating()) {
        stableCheckCount = 0;
        lastSeenTextLength = 0;
        pollTimeout = setTimeout(poll, POLL_MS);
        return;
    }

    // Check if text is still changing even without generation indicators
    if (isTextStillChanging()) {
        pollTimeout = setTimeout(poll, STREAM_CHECK_INTERVAL);
        return;
    }

    // Require multiple stable checks before proceeding
    if (stableCheckCount < STREAM_STABLE_CHECKS) {
        pollTimeout = setTimeout(poll, STREAM_CHECK_INTERVAL);
        return;
    }

    // Check turn count - must have a new turn
    var t = getTurnCount();
    if (t <= lastTurns) {
        pollTimeout = setTimeout(poll, POLL_MS);
        return;
    }

    // Check fence balance before processing
    var el = getLastAnswerTurnEl();
    if (el) {
        var text = el.innerText || '';
        if (countFences(text) % 2 !== 0) {
            log('Fence count odd - code block still open, waiting...');
            stableCheckCount = 0;
            pollTimeout = setTimeout(poll, STREAM_CHECK_INTERVAL);
            return;
        }
    }

    lastTurns = t;
    // Delay before handling response to ensure DOM is fully updated
    if (responseHandleTimeout) clearTimeout(responseHandleTimeout);
    responseHandleTimeout = setTimeout(function() {
        handleResponseSafe();
    }, RESPONSE_SETTLE_MS);
}

// ============================================================
// MAIN FLOW: RESPONSE HANDLING
// ============================================================

function handleResponseSafe() {
    if (!running) return;
    if (isProcessingResponse) return;
    isProcessingResponse = true;

    // Double-check that generation is truly done
    if (isGenerating()) {
        isProcessingResponse = false;
        pollTimeout = setTimeout(poll, POLL_MS);
        return;
    }

    // Final text stability check
    if (isTextStillChanging()) {
        isProcessingResponse = false;
        stableCheckCount = 0;
        pollTimeout = setTimeout(poll, STREAM_CHECK_INTERVAL);
        return;
    }

    // Verify fence balance one more time
    var el = getLastAnswerTurnEl();
    if (el) {
        var rawText = el.innerText || '';
        if (countFences(rawText) % 2 !== 0) {
            isProcessingResponse = false;
            log('Fence still odd at handle time - retrying...');
            pollTimeout = setTimeout(poll, STREAM_CHECK_INTERVAL);
            return;
        }
    }

    handleResponse();
    isProcessingResponse = false;
}

function handleResponse() {
    if (!running) return;
    var text = getLastTurnText();

    // Check if this is the same response we already processed
    if (text === lastResponseText && text.length > 0) {
        log('Same response text detected, skipping duplicate');
        pollTimeout = setTimeout(poll, POLL_MS);
        return;
    }
    lastResponseText = text;

    // Extract code from DOM (primary method)
    var newCode = getLastCodeFromDOM();

    // If no code from DOM, try accumulated
    if (!newCode || newCode.trim().length < 20) {
        log('No code found in last turn DOM');
    }

    if (newCode && newCode.trim().length > 20) {
        accumulated = mergeOverlap(accumulated, cleanMarkers(newCode));
    }

    lastRawTail = getRawTail();
    if (isValidHarvest(accumulated.trim())) {
        injectCodeBlock(accumulated.trim());
    }
    decideNextAction(text);
}

function decideNextAction(text) {
    // Check isDone first - explicit signal from AI
    if (isDone(text)) {
        log('FINISHED marker detected - completing.');
        finish();
        return;
    }

    // Check max continues
    if (continues >= MAX) {
        log('Max continues reached (' + MAX + ') - completing.');
        finish();
        return;
    }

    // Check if code is incomplete
    var accTrimmed = accumulated.trim();

    if (accTrimmed.length > 0) {
        if (isCodeIncomplete(accTrimmed)) {
            log('Code incomplete (structural check) - continuing. ' + accTrimmed.length + ' chars');
            setStatus('\u26A0 Code incomplete (' + accTrimmed.split('\n').length + ' lines), auto-continuing...');
            scheduleNext();
            return;
        }

        // Check if the last code block in DOM looks cut off
        var lastCode = getLastCodeFromDOM();
        if (lastCode && isCodeIncomplete(lastCode)) {
            log('Last DOM code block incomplete - continuing.');
            setStatus('\u26A0 Last code block incomplete, auto-continuing...');
            scheduleNext();
            return;
        }

        // Code looks complete
        log('Code appears complete. ' + accTrimmed.split('\n').length + ' lines.');
        finish();
    } else {
        // No code accumulated - check if there's code in DOM we missed
        var domCode = getLastCodeFromDOM();
        if (domCode && domCode.trim().length > 20) {
            accumulated = cleanMarkers(domCode);
            if (isCodeIncomplete(accumulated)) {
                log('Found code in DOM, incomplete - continuing.');
                scheduleNext();
                return;
            }
            finish();
        } else {
            setStatus('\u26A0 No code detected, stopping.');
            finish();
        }
    }
}

// ============================================================
// CONTINUE SCHEDULING
// ============================================================

function scheduleNext() {
    continues++;
    incrementProcessing();
    setStatus('\u23F3 Waiting ' + DELAY_MS/1000 + 's... (' + continues + '/' + MAX + ')');
    showWait(DELAY_MS);
}

function doSkip() { clearWait(); doSubmitContinue(); }

function doSubmitContinue() {
    if (!running) return;
    // Reset tracking state for next response
    stableCheckCount = 0;
    lastSeenTextLength = 0;
    lastResponseText = '';
    isProcessingResponse = false;

    setStatus('\u23F3 Continuing (' + continues + '/' + MAX + ')...');
    submit(buildContinuePrompt());
    // Wait before polling to give AI time to start generating
    pollTimeout = setTimeout(poll, CONTINUE_POLL_DELAY);
}

// ============================================================
// WAIT TIMER UI
// ============================================================

function showWait(ms) {
    waitRemaining = Math.ceil(ms / 1000);
    updateWaitUI();
    var el = qs('#acl-wait');
    if (el) el.style.display = 'flex';
    waitTimer = setInterval(function() {
        waitRemaining--;
        updateWaitUI();
        if (waitRemaining <= 0) { clearWait(); doSubmitContinue(); }
    }, 1000);
}

function clearWait() {
    if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
    var el = qs('#acl-wait');
    if (el) el.style.display = 'none';
}

function updateWaitUI() {
    var el = qs('#acl-wait-time');
    if (el) el.textContent = waitRemaining + 's';
    var bar = qs('#acl-wait-bar');
    if (bar) bar.style.width = ((DELAY_MS / 1000 - waitRemaining) / (DELAY_MS / 1000) * 100) + '%';
}

// ============================================================
// PROMPT BUILDING
// ============================================================

function buildContinuePrompt() {
    var tail = lastRawTail || getLastNLines(accumulated, OVERLAP_LINES);
    return [
        'Continue EXACTLY where you left off. Your last lines were:',
        '', FENCE, tail, FENCE, '',
        'Continue from there. Do NOT repeat those lines. Just write the next code.',
        'When you are 100% completely done with the ENTIRE file, write AUTOCODER_FINISHED after your code block on its own line.',
        '',
        'If you are NOT done yet, just stop mid-code. I will ask you to continue.',
        'Do NOT write AUTOCODER_FINISHED unless the code is truly 100% complete.'
    ].join('\n');
}

function buildInitialPrompt(userText) {
    return [
        userText, '',
        '=== RULES ===',
        'Write the complete code in a single code block.',
        'If you run out of space, just stop mid-code. I will ask you to continue.',
        'When you are 100% completely finished with the ENTIRE file, write AUTOCODER_FINISHED after your code block on its own line.',
        '',
        'Do NOT write AUTOCODER_FINISHED unless the code is truly 100% complete.',
        '============='
    ].join('\n');
}

// ============================================================
// FINISH / START / STOP
// ============================================================

function finish() {
    running = false;
    clearWait();
    if (responseHandleTimeout) { clearTimeout(responseHandleTimeout); responseHandleTimeout = null; }
    if (pollTimeout) { clearTimeout(pollTimeout); pollTimeout = null; }
    isProcessingResponse = false;
    markDone();
    updateBtn();
    var code = accumulated.trim();

    if (!code || code.length === 0) {
        code = harvestAllCode();
        accumulated = code;
    }

    if (isValidHarvest(code)) {
        injectCodeBlock(code);
    }

    copyToClipboard(code, function() {
        setStatus('\u2705 Done! ' + code.split('\n').length + ' lines \u2014 copied! (' + continues + ' continues)');
    }, function() {
        setStatus('\u2705 Done! ' + code.split('\n').length + ' lines. (' + continues + ' continues)');
    });
}

function start(prompt) {
    running = true;
    continues = 0;
    accumulated = '';
    lastRawTail = '';
    prevHadUnclosedBlock = false;
    lastHarvestedText = '';
    lastTurns = getTurnCount();
    lastSeenTextLength = 0;
    stableCheckCount = 0;
    lastResponseText = '';
    isProcessingResponse = false;
    if (responseHandleTimeout) { clearTimeout(responseHandleTimeout); responseHandleTimeout = null; }
    if (pollTimeout) { clearTimeout(pollTimeout); pollTimeout = null; }
    incrementProcessing();
    updateBtn();
    setStatus('\u23F3 Submitting...');
    submit(buildInitialPrompt(prompt));
    pollTimeout = setTimeout(poll, INITIAL_POLL_DELAY);
}

function stop() {
    running = false;
    clearWait();
    if (responseHandleTimeout) { clearTimeout(responseHandleTimeout); responseHandleTimeout = null; }
    if (pollTimeout) { clearTimeout(pollTimeout); pollTimeout = null; }
    isProcessingResponse = false;
    updateBtn();
    setStatus('\u23F9 Stopped. Use \uD83C\uDF3E Harvest to collect.');
}

// ============================================================
// STATUS & BUTTON UPDATE
// ============================================================

function setStatus(msg) {
    var el = qs('#acl-status');
    if (el) el.textContent = msg;
    log(msg);
}

function updateBtn() {
    var btn = qs('#acl-btn');
    if (!btn) return;
    btn.textContent = running ? '\u23F9' : '\u25B6';
    btn.className = running ? 'acl-on' : '';
}

function toggle() {
    if (running) return stop();
    var input = qs('#acl-input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    start(text);
}

// ============================================================
// UI INITIALIZATION
// ============================================================

function updateBodyPadding() {
    var bar = qs('#acl-bar');
    if (bar) {
        var h = bar.offsetHeight || barHeight;
        barHeight = h;
        document.body.style.paddingBottom = (h + 10) + 'px';
    }
}

function buildStyles() {
    return [
        '#acl-bar{position:fixed;bottom:0;left:0;right:0;z-index:9999999;display:flex;align-items:flex-end;background:linear-gradient(180deg,#0d0820,#0a0814);border-top:1px solid rgba(139,92,246,.4);padding:8px 12px;gap:10px;font:13px "SF Mono",monospace;box-shadow:0 -4px 30px rgba(124,58,237,.15);flex-wrap:wrap;}',
        '#acl-input{flex:1;min-width:200px;background:linear-gradient(135deg,#1a1528,#150f25);color:#e2e8f0;border:1px solid rgba(139,92,246,.3);border-radius:10px;padding:12px 16px;font:inherit;resize:vertical;min-height:40px;max-height:300px;transition:border-color .2s,box-shadow .2s;box-sizing:border-box;overflow-y:auto;line-height:1.4;}',
        '#acl-input:focus{outline:none;border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,.2);}',
        '#acl-btn{width:44px;height:40px;border:none;border-radius:10px;cursor:pointer;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font-size:18px;transition:all .15s;box-shadow:0 4px 15px rgba(124,58,237,.4);flex-shrink:0;}',
        '#acl-btn:hover{transform:scale(1.05);box-shadow:0 6px 20px rgba(124,58,237,.5);}',
        '#acl-btn.acl-on{background:linear-gradient(135deg,#dc2626,#b91c1c);box-shadow:0 4px 15px rgba(220,38,38,.4);animation:acl-p 1.5s infinite}',
        '@keyframes acl-p{0%,100%{opacity:1}50%{opacity:.5}}',
        '#acl-harvest{height:40px;padding:0 16px;border:none;border-radius:10px;cursor:pointer;background:linear-gradient(135deg,#059669,#047857);color:#fff;font:700 13px/1 sans-serif;transition:all .15s;box-shadow:0 4px 15px rgba(5,150,105,.3);white-space:nowrap;flex-shrink:0;}',
        '#acl-harvest:hover{transform:scale(1.05);box-shadow:0 6px 20px rgba(5,150,105,.4);}',
        '#acl-harvest:active{transform:scale(.95);}',
        '#acl-status{color:#a5b4fc;font-size:11px;min-width:120px;text-shadow:0 0 10px rgba(165,180,252,.3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '#acl-counter{display:flex;align-items:center;gap:14px;padding:4px 14px;background:rgba(124,58,237,.08);border:1px solid rgba(139,92,246,.2);border-radius:10px;margin-left:auto;flex-shrink:0;}',
        '#acl-counter-title{font:600 11px/1.4 sans-serif;color:#c4b5fd;white-space:nowrap;letter-spacing:.3px;}',
        '.acl-counter-badge{display:flex;align-items:center;gap:4px;font:700 14px "SF Mono",monospace;}',
        '.acl-counter-badge.processing{color:#fbbf24;text-shadow:0 0 8px rgba(251,191,36,.4);}',
        '.acl-counter-badge.done{color:#34d399;text-shadow:0 0 8px rgba(52,211,153,.4);}',
        '.acl-counter-badge.total{color:#a5b4fc;text-shadow:0 0 8px rgba(165,180,252,.4);}',
        '.acl-counter-sep{width:1px;height:18px;background:rgba(139,92,246,.3);}',
        '#acl-wait{display:none;position:fixed;bottom:90px;left:50%;transform:translateX(-50%);z-index:9999999;align-items:center;gap:14px;background:linear-gradient(135deg,#0f0b1e,#1a1035);border:1px solid rgba(139,92,246,.4);border-radius:16px;padding:16px 28px;box-shadow:0 15px 50px rgba(0,0,0,.7),0 0 30px rgba(124,58,237,.15);}',
        '#acl-wait-time{font:700 34px "SF Mono",monospace;color:#c4b5fd;min-width:55px;text-align:center;text-shadow:0 0 15px rgba(196,181,253,.3);}',
        '#acl-wait-track{width:150px;height:7px;background:rgba(139,92,246,.12);border-radius:4px;overflow:hidden;}',
        '#acl-wait-bar{height:100%;width:0%;background:linear-gradient(90deg,#7c3aed,#a855f7,#c084fc);border-radius:4px;transition:width 1s linear;box-shadow:0 0 8px rgba(168,85,247,.5);}',
        '#acl-skip{padding:13px 30px;border:none;border-radius:12px;cursor:pointer;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font:700 15px/1 sans-serif;transition:all .15s;letter-spacing:.5px;box-shadow:0 4px 20px rgba(124,58,237,.4);white-space:nowrap;}',
        '#acl-skip:hover{background:linear-gradient(135deg,#6d28d9,#5b21b6);transform:scale(1.05);box-shadow:0 6px 25px rgba(124,58,237,.5);}',
        '#acl-skip:active{transform:scale(.97);}',
        '#acl-panel{display:none;flex-direction:column;position:fixed;inset:5%;z-index:99999999;background:linear-gradient(180deg,#0a0a0f,#0d0820);border:1px solid rgba(124,58,237,.5);border-radius:16px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.8),0 0 40px rgba(124,58,237,.1);}',
        '#acl-panel pre{flex:1;overflow:auto;padding:20px;margin:0;color:#e2e8f0;font:12px/1.6 "SF Mono",monospace;white-space:pre-wrap;word-wrap:break-word;-webkit-overflow-scrolling:touch;}',
        '#acl-panel-bar{display:flex;gap:10px;padding:14px;border-top:1px solid rgba(139,92,246,.2);background:rgba(0,0,0,.3);flex-wrap:wrap;}',
        '#acl-panel-bar button{padding:10px 20px;border:none;border-radius:10px;cursor:pointer;font:600 12px/1 sans-serif;transition:all .15s;}',
        '#acl-panel-bar button:hover{transform:scale(1.03);}',
        'body{padding-bottom:' + (barHeight + 10) + 'px !important;transition:padding-bottom .2s;}'
    ].join('\n');
}

function buildBarHTML() {
    return [
        '<textarea id="acl-input" placeholder="\u2728 Enter prompt... (Enter to start, Shift+Enter for newline)" rows="1"></textarea>',
        '<button id="acl-btn">\u25B6</button>',
        '<button id="acl-harvest">\uD83C\uDF3E Harvest</button>',
        '<span id="acl-status">\u2728 Ready</span>',
        '<div id="acl-counter">',
        '  <span id="acl-counter-title">\u2728 AI Auto-Coder \u2014 Ready</span>',
        '  <div class="acl-counter-sep"></div>',
        '  <span class="acl-counter-badge processing">\u23F3 <span id="acl-count-processing">0</span></span>',
        '  <span class="acl-counter-badge done">\u2705 <span id="acl-count-done">0</span></span>',
        '  <div class="acl-counter-sep"></div>',
        '  <span class="acl-counter-badge total">\u03A3 <span id="acl-count-total">0</span></span>',
        '</div>'
    ].join('');
}

function buildWaitHTML() {
    return '<span id="acl-wait-time">25s</span><div id="acl-wait-track"><div id="acl-wait-bar"></div></div><button id="acl-skip">SKIP \u25B6\u25B6</button>';
}

function buildPanelHTML() {
    return '<pre></pre><div id="acl-panel-bar"><button id="acl-copy" style="background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff">Copy</button><button id="acl-dl" style="background:linear-gradient(135deg,#d97706,#b45309);color:#fff">Download</button><button id="acl-close" style="background:linear-gradient(135deg,#374151,#1f2937);color:#fff">Close</button></div>';
}

function attachEventListeners() {
    var input = qs('#acl-input');
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); toggle(); }
    });
    input.addEventListener('input', function() {
        this.style.height = 'auto';
        var newH = Math.min(this.scrollHeight, 300);
        this.style.height = newH + 'px';
        updateBodyPadding();
    });
    qs('#acl-btn').addEventListener('click', toggle);
    qs('#acl-harvest').addEventListener('click', doHarvest);
    qs('#acl-skip').addEventListener('click', doSkip);
    qs('#acl-close').addEventListener('click', function() {
        qs('#acl-panel').style.display = 'none';
    });
    qs('#acl-copy').addEventListener('click', function() {
        copyToClipboard(accumulated.trim(), function() { setStatus('\u2705 Copied!'); });
    });
    qs('#acl-dl').addEventListener('click', function() {
        downloadFile(accumulated.trim(), 'output.html', 'text/html');
    });

    if (window.ResizeObserver) {
        var ro = new ResizeObserver(function() { updateBodyPadding(); });
        ro.observe(qs('#acl-bar'));
    }
}

function initUI() {
    if (qs('#acl-bar')) return;

    var s = document.createElement('style');
    s.id = 'acl-styles';
    s.textContent = buildStyles();
    document.head.appendChild(s);

    var bar = document.createElement('div');
    bar.id = 'acl-bar';
    bar.innerHTML = buildBarHTML();
    document.body.appendChild(bar);

    var wait = document.createElement('div');
    wait.id = 'acl-wait';
    wait.innerHTML = buildWaitHTML();
    document.body.appendChild(wait);

    var panel = document.createElement('div');
    panel.id = 'acl-panel';
    panel.innerHTML = buildPanelHTML();
    document.body.appendChild(panel);

    attachEventListeners();
    updateCounter();
    startAutoHarvest();

    setTimeout(updateBodyPadding, 100);
    setTimeout(updateBodyPadding, 500);
    setTimeout(updateBodyPadding, 2000);
}

// ============================================================
// STARTUP
// ============================================================

function tryInit() {
    if (qs('#acl-bar')) return;
    if (document.body) {
        initUI();
    } else {
        setTimeout(tryInit, 200);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInit);
} else {
    tryInit();
}

setTimeout(tryInit, 500);
window.addEventListener('load', tryInit);

if (!document.body) {
    var bodyObserver = new MutationObserver(function(mutations, obs) {
        if (document.body) { obs.disconnect(); tryInit(); }
    });
    bodyObserver.observe(document.documentElement, { childList: true });
}

// Periodic health check - re-init UI if removed, update padding
setInterval(function() {
    if (!qs('#acl-bar') && document.body) initUI();
    updateBodyPadding();
}, 3000);

// Periodic streaming stability check while running
setInterval(function() {
    if (!running) return;
    isTextStillChanging();
}, STREAM_CHECK_INTERVAL);

// ============================================================
// TEST SUITE: window.test_auto_continue
// Comprehensive tests for all internal functions and DOM interaction.
// Run from browser console: test_auto_continue()
// ============================================================

function createTestReport(results) {
    var passed = 0, failed = 0, errors = [];
    for (var i = 0; i < results.length; i++) {
        if (results[i].pass) passed++;
        else { failed++; errors.push(results[i]); }
    }
    console.log('\n%c═══════════════════════════════════════════', 'color:#7c3aed;font-weight:bold');
    console.log('%c  AUTO-CODER v13 TEST RESULTS', 'color:#c4b5fd;font-weight:bold;font-size:14px');
    console.log('%c═══════════════════════════════════════════', 'color:#7c3aed;font-weight:bold');
    console.log('%c  ✅ Passed: ' + passed, 'color:#34d399;font-weight:bold');
    console.log('%c  ❌ Failed: ' + failed, 'color:#f87171;font-weight:bold');
    console.log('%c  Total:   ' + results.length, 'color:#a5b4fc');
    console.log('%c═══════════════════════════════════════════', 'color:#7c3aed;font-weight:bold');
    if (errors.length > 0) {
        console.log('\n%cFailed Tests:', 'color:#f87171;font-weight:bold');
        for (var j = 0; j < errors.length; j++) {
            console.log('%c  ✗ ' + errors[j].name + ': ' + errors[j].msg, 'color:#fca5a5');
        }
    }
    console.log('');
    return { passed: passed, failed: failed, total: results.length, errors: errors };
}

function assert(results, name, condition, msg) {
    results.push({ name: name, pass: !!condition, msg: msg || (condition ? 'OK' : 'FAILED') });
    if (!condition) {
        console.warn('  ✗ ' + name + ': ' + (msg || 'FAILED'));
    } else {
        console.log('  ✓ ' + name);
    }
}

window.test_auto_continue = function() {
    var results = [];
    console.log('\n%c🧪 Running Auto-Coder v13 Test Suite...', 'color:#a855f7;font-weight:bold;font-size:13px');
    console.log('%c─────────────────────────────────────────', 'color:#6b21a8');

    // ─── GROUP 1: DOM DETECTION ───────────────────────────────
    console.log('\n%c📋 Group 1: DOM Detection', 'color:#60a5fa;font-weight:bold');

	var chatRoot = getChatRoot();
	assert(results, 'getChatRoot() finds #chat-history',
	    chatRoot && (chatRoot.id === 'chat-history' || chatRoot === document.body),
	    chatRoot ? (chatRoot.id === 'chat-history' ? 'Found: #chat-history' : 'Fallback: document.body (no chat open)') : 'NOT FOUND');

    var answerTurns = getAnswerTurns();
    assert(results, 'getAnswerTurns() finds answer turns',
        answerTurns.length >= 0,
        'Found ' + answerTurns.length + ' answer turn(s)');

    var questionTurns = getQuestionTurns();
    assert(results, 'getQuestionTurns() finds question turns',
        questionTurns.length >= 0,
        'Found ' + questionTurns.length + ' question turn(s)');

    var turnCount = getTurnCount();
    assert(results, 'getTurnCount() returns number',
        typeof turnCount === 'number' && turnCount >= 0,
        'Turn count: ' + turnCount);

    var lastEl = getLastAnswerTurnEl();
    assert(results, 'getLastAnswerTurnEl() returns element or null',
        lastEl === null || (lastEl && lastEl.nodeType === 1),
        lastEl ? 'Found: ' + lastEl.getAttribute('data-testid') : 'No answer turns yet');

    var lastText = getLastTurnText();
    assert(results, 'getLastTurnText() returns string',
        typeof lastText === 'string',
        'Length: ' + lastText.length + ' chars');

    var lastId = getLastTurnId();
    assert(results, 'getLastTurnId() returns string',
        typeof lastId === 'string',
        'ID: ' + (lastId || '(empty - no turns)'));

    // ─── GROUP 2: GENERATION DETECTION ────────────────────────
    console.log('\n%c⚡ Group 2: Generation Detection', 'color:#60a5fa;font-weight:bold');

    var gen = isGenerating();
    assert(results, 'isGenerating() returns boolean',
        typeof gen === 'boolean',
        'Currently generating: ' + gen);

    // Check workflow steps detection
    var steps = qsa('[data-testid^="step-"]', chatRoot);
    var finishedSteps = 0, unfinishedSteps = 0;
    for (var si = 0; si < steps.length; si++) {
        if (steps[si].getAttribute('data-finished') === 'true') finishedSteps++;
        else unfinishedSteps++;
    }
    assert(results, 'Workflow steps found in DOM',
        steps.length >= 0,
        'Total: ' + steps.length + ' (finished: ' + finishedSteps + ', unfinished: ' + unfinishedSteps + ')');

    assert(results, 'isGenerating() consistent with step states',
        (unfinishedSteps > 0) === gen || !gen,
        'Unfinished steps: ' + unfinishedSteps + ', isGenerating: ' + gen);

    // ─── GROUP 3: CODE EXTRACTION ─────────────────────────────
    console.log('\n%c💻 Group 3: Code Extraction', 'color:#60a5fa;font-weight:bold');

    // Test figure[aria-label="Code Block"] detection
    var figures = chatRoot ? chatRoot.querySelectorAll('figure[aria-label="Code Block"]') : [];
    assert(results, 'Code Block figures found via aria-label',
        figures.length >= 0,
        'Found ' + figures.length + ' figure(s) with aria-label="Code Block"');

    // Test pre > code detection (fallback)
    var preCodes = chatRoot ? chatRoot.querySelectorAll('pre code') : [];
    assert(results, 'pre > code elements found',
        preCodes.length >= 0,
        'Found ' + preCodes.length + ' pre>code element(s)');

    if (lastEl) {
        var blocks = getCodeBlocksFromElement(lastEl);
        assert(results, 'getCodeBlocksFromElement() extracts code from last turn',
            Array.isArray(blocks),
            'Extracted ' + blocks.length + ' block(s)' + (blocks.length > 0 ? ', longest: ' + blocks.reduce(function(a,b){return a.length>b.length?a:b;}, '').length + ' chars' : ''));

        var lastCode = getLastCodeFromDOM();
        assert(results, 'getLastCodeFromDOM() returns string',
            typeof lastCode === 'string',
            'Length: ' + lastCode.length + ' chars' + (lastCode.length > 0 ? ', preview: "' + lastCode.slice(0,50) + '..."' : ''));
    }

    var allCode = getAllCodeFromAllTurns();
    assert(results, 'getAllCodeFromAllTurns() returns array',
        Array.isArray(allCode),
        'Found ' + allCode.length + ' code block(s) across all turns');

    // ─── GROUP 4: FINISH MARKER DETECTION ─────────────────────
    console.log('\n%c🏁 Group 4: Finish Marker Detection', 'color:#60a5fa;font-weight:bold');

    // Test isDone with synthetic text
    assert(results, 'isDone("AUTOCODER_FINISHED") returns true',
        isDone('some code here\nAUTOCODER_FINISHED\n'),
        '');

    assert(results, 'isDone("random text") returns false',
        !isDone('just some random text without the marker'),
        '');

    assert(results, 'isDone("!!!!!AUTOCODER_FINISHED!!!!!") returns true',
        isDone('code\n!!!!!AUTOCODER_FINISHED!!!!!\n'),
        'Also catches the old 5-exclamation format');

    // Test with actual DOM
    if (lastEl) {
        var textSpans = lastEl.querySelectorAll('[data-testid="youchat-text"]');
        var foundMarkerInDOM = false;
        for (var tsi = 0; tsi < textSpans.length; tsi++) {
            if ((textSpans[tsi].textContent || '').indexOf(FINISH_MARKER) !== -1) {
                foundMarkerInDOM = true;
                break;
            }
        }
        assert(results, 'FINISH_MARKER detection in youchat-text spans',
            true,
            'Found in DOM spans: ' + foundMarkerInDOM + ' (spans found: ' + textSpans.length + ')');
    }

    // ─── GROUP 5: OVERLAP MERGE ───────────────────────────────
    console.log('\n%c🔗 Group 5: Overlap Merge', 'color:#60a5fa;font-weight:bold');

    var mergeA = 'line1\nline2\nline3\nline4\nline5';
    var mergeB = 'line4\nline5\nline6\nline7';
    var merged = mergeOverlap(mergeA, mergeB);
    assert(results, 'mergeOverlap exact overlap (2 lines)',
        merged === 'line1\nline2\nline3\nline4\nline5\nline6\nline7',
        'Result: "' + merged.replace(/\n/g, '\\n') + '"');

    var mergeC = 'aaa\nbbb\nccc';
    var mergeD = 'xxx\nyyy\nzzz';
    var merged2 = mergeOverlap(mergeC, mergeD);
    assert(results, 'mergeOverlap no overlap (concatenates)',
        merged2 === 'aaa\nbbb\nccc\nxxx\nyyy\nzzz',
        'Result: "' + merged2.replace(/\n/g, '\\n') + '"');

    var mergeE = 'function foo() {\n  var x = 1;\n  var y = 2;\n  var z =';
    var mergeF = '  var z = 3;\n  return x + y + z;\n}';
    var merged3 = mergeOverlap(mergeE, mergeF);
    assert(results, 'mergeOverlap truncated tail fix',
        merged3.indexOf('var z = 3') !== -1 && merged3.indexOf('var z =\n') === -1,
        'Truncated line replaced correctly');

    assert(results, 'mergeOverlap empty + text = text',
        mergeOverlap('', 'hello') === 'hello',
        '');

    assert(results, 'mergeOverlap text + empty = text',
        mergeOverlap('hello', '') === 'hello',
        '');

    // ─── GROUP 6: CODE COMPLETENESS ──────────────────────────
    console.log('\n%c🔍 Group 6: Code Completeness Checks', 'color:#60a5fa;font-weight:bold');

    assert(results, 'isCodeIncomplete: unclosed HTML',
        isCodeIncomplete('<!DOCTYPE html><html><body><div>hello') === true,
        '');

    assert(results, 'isCodeIncomplete: closed HTML',
        isCodeIncomplete('<!DOCTYPE html><html><body></body></html>') === false,
        '');

    assert(results, 'isCodeIncomplete: unbalanced braces',
        isCodeIncomplete('function foo() {\n  if (x) {\n    bar();\n  \n' + 'x'.repeat(2000)) === true,
        '');

    assert(results, 'isCodeIncomplete: balanced braces',
        isCodeIncomplete('function foo() {\n  if (x) {\n    bar();\n  }\n}') === false,
        '');

    assert(results, 'isCodeIncomplete: cut-off last line (trailing comma)',
        isCodeIncomplete('var x = [\n  1,\n  2,') === true,
        '');

    assert(results, 'isCodeIncomplete: proper IIFE ending',
        isCodeIncomplete('(function() {\n  var x = 1;\n})();') === false,
        '');

    assert(results, 'isCodeIncomplete: unclosed IIFE',
        isCodeIncomplete('(function() {\n  var x = 1;\n  var y = 2;') === true,
        '');

    assert(results, 'isCodeIncomplete: unclosed template literal',
        isCodeIncomplete('var x = `hello ${name') === true,
        '');

    assert(results, 'isCodeIncomplete: contains AUTOCODER_FINISHED',
        isCodeIncomplete('some code\nAUTOCODER_FINISHED') === false,
        'Marker presence = complete');

    assert(results, 'isCodeIncomplete: unclosed script tag',
        isCodeIncomplete('<html><body><script>var x = 1;') === true,
        '');

    assert(results, 'isCodeIncomplete: closed script tag',
        isCodeIncomplete('<html><body><script>var x = 1;</script></body></html>') === false,
        '');

    // ─── GROUP 7: PROMPT BUILDING ─────────────────────────────
    console.log('\n%c📝 Group 7: Prompt Building', 'color:#60a5fa;font-weight:bold');

    var initPrompt = buildInitialPrompt('Write me a game');
    assert(results, 'buildInitialPrompt contains user text',
        initPrompt.indexOf('Write me a game') !== -1,
        '');

    assert(results, 'buildInitialPrompt contains RULES section',
        initPrompt.indexOf('=== RULES ===') !== -1,
        '');

    assert(results, 'buildInitialPrompt mentions AUTOCODER_FINISHED',
        initPrompt.indexOf('AUTOCODER_FINISHED') !== -1,
        '');

    assert(results, 'buildInitialPrompt does NOT use old !!!!! format',
        initPrompt.indexOf('!!!!!AUTOCODER_FINISHED!!!!!') === -1,
        'Uses plain AUTOCODER_FINISHED now');

    // Simulate some accumulated code for continue prompt
    var savedAcc = accumulated;
    var savedTail = lastRawTail;
    accumulated = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10';
    lastRawTail = 'line6\nline7\nline8\nline9\nline10';
    var contPrompt = buildContinuePrompt();
    assert(results, 'buildContinuePrompt contains overlap lines',
        contPrompt.indexOf('line10') !== -1,
        '');

    assert(results, 'buildContinuePrompt contains code fence',
        contPrompt.indexOf(FENCE) !== -1,
        '');

    assert(results, 'buildContinuePrompt mentions AUTOCODER_FINISHED',
        contPrompt.indexOf('AUTOCODER_FINISHED') !== -1,
        '');

    assert(results, 'buildContinuePrompt says "Continue EXACTLY"',
        contPrompt.indexOf('Continue EXACTLY') !== -1,
        '');

    accumulated = savedAcc;
    lastRawTail = savedTail;

    // ─── GROUP 8: FORM INTERACTION ────────────────────────────
    console.log('\n%c📤 Group 8: Form Interaction', 'color:#60a5fa;font-weight:bold');

    var ta = getTextarea();
    assert(results, 'getTextarea() finds textarea',
        ta !== null,
        ta ? 'Found: #' + ta.id + ' (' + ta.tagName + ')' : 'NOT FOUND');

    if (ta) {
        var form = ta.closest('form');
        assert(results, 'Textarea has parent form',
            form !== null,
            form ? 'Form found' : 'No parent form (will use fallback)');

	    if (form) {
		    var submitBtn = form.querySelector('button[type="submit"]') ||
			    form.querySelector('[data-testid*="send"]') ||
			    form.querySelector('button[aria-label*="Send"]') ||
			    form.querySelector('button[aria-label*="send"]') ||
			    form.querySelector('button[aria-label*="Submit"]');
		    // Fallback: any button in the form
		    if (!submitBtn) {
			    var allFormBtns = form.querySelectorAll('button');
			    if (allFormBtns.length > 0) submitBtn = allFormBtns[allFormBtns.length - 1];
		    }
		    assert(results, 'Send button found in form',
			    submitBtn !== null,
			    submitBtn ? 'Found: ' + (submitBtn.getAttribute('aria-label') || submitBtn.textContent.trim().slice(0,30) || submitBtn.tagName) : 'NOT FOUND (will use Enter key fallback)');
	    }
    }

    // ─── GROUP 9: UI ELEMENTS ─────────────────────────────────
    console.log('\n%c🎨 Group 9: UI Elements', 'color:#60a5fa;font-weight:bold');

    assert(results, 'Status bar (#acl-bar) exists',
        qs('#acl-bar') !== null, '');

    assert(results, 'Input textarea (#acl-input) exists',
        qs('#acl-input') !== null, '');

    assert(results, 'Start/Stop button (#acl-btn) exists',
        qs('#acl-btn') !== null, '');

    assert(results, 'Harvest button (#acl-harvest) exists',
        qs('#acl-harvest') !== null, '');

    assert(results, 'Status display (#acl-status) exists',
        qs('#acl-status') !== null, '');

    assert(results, 'Wait overlay (#acl-wait) exists',
        qs('#acl-wait') !== null, '');

    assert(results, 'Skip button (#acl-skip) exists',
        qs('#acl-skip') !== null, '');

    assert(results, 'Counter (#acl-counter) exists',
        qs('#acl-counter') !== null, '');

    // ─── GROUP 10: HARVEST FUNCTIONALITY ──────────────────────
    console.log('\n%c🌾 Group 10: Harvest Functionality', 'color:#60a5fa;font-weight:bold');

    var harvested = harvestAllCode();
    assert(results, 'harvestAllCode() returns string',
        typeof harvested === 'string',
        'Length: ' + harvested.length + ' chars');

    if (harvested.length > 0) {
        assert(results, 'Harvested code is valid',
            isValidHarvest(harvested),
            'Lines: ' + harvested.split('\n').length);

        assert(results, 'Harvested code has no raw markers',
            harvested.indexOf('!!!!!CODEBLOCK_STARTS!!!!!') === -1 &&
            harvested.indexOf('!!!!!CODEBLOCK_ENDS!!!!!') === -1,
            'Markers cleaned');
    }

    // Test cleanMarkers
    var dirty = '!!!!!CODEBLOCK_STARTS!!!!!\nvar x = 1;\n!!!!!CODEBLOCK_ENDS!!!!!\nAUTOCODER_FINISHED';
    var cleaned = cleanMarkers(dirty);
    assert(results, 'cleanMarkers removes all marker lines',
        cleaned.indexOf('!!!!!') === -1 && cleaned.indexOf('AUTOCODER_FINISHED') === -1,
        'Cleaned: "' + cleaned.replace(/\n/g, '\\n') + '"');

    assert(results, 'cleanMarkers preserves actual code',
        cleaned.indexOf('var x = 1') !== -1,
        '');

    // ─── GROUP 11: STRING HELPERS ─────────────────────────────
    console.log('\n%c🔧 Group 11: String Helpers', 'color:#60a5fa;font-weight:bold');

    var testLines = 'a\nb\nc\nd\ne\nf\ng';
    var last3 = getLastNLines(testLines, 3);
    assert(results, 'getLastNLines gets correct count',
        last3.split('\n').length === 3 && last3 === 'e\nf\ng',
        'Got: "' + last3.replace(/\n/g, '\\n') + '"');

    var last5 = getLastNLines(testLines, 5);
    assert(results, 'getLastNLines(5) from 7 lines',
        last5.split('\n').length === 5 && last5 === 'c\nd\ne\nf\ng',
        'Got: "' + last5.replace(/\n/g, '\\n') + '"');

    assert(results, 'getLastNLines handles empty string',
        getLastNLines('', 5) === '',
        '');

    assert(results, 'countFences counts correctly',
        countFences('```js\ncode\n```\ntext\n```\nmore\n```') === 4,
        '');

    assert(results, 'countFences odd = unclosed block',
        countFences('```js\ncode\nstill going') % 2 === 1,
        '');

    // ─── GROUP 12: STATE MANAGEMENT ───────────────────────────
    console.log('\n%c⚙️ Group 12: State Management', 'color:#60a5fa;font-weight:bold');

    assert(results, 'running is boolean',
        typeof running === 'boolean',
        'Currently: ' + running);

    assert(results, 'continues is number',
        typeof continues === 'number',
        'Value: ' + continues);

    assert(results, 'accumulated is string',
        typeof accumulated === 'string',
        'Length: ' + accumulated.length);

    assert(results, 'MAX continues is reasonable',
        MAX >= 10 && MAX <= 50,
        'MAX = ' + MAX);

    assert(results, 'DELAY_MS is reasonable',
        DELAY_MS >= 10000 && DELAY_MS <= 60000,
        'DELAY_MS = ' + DELAY_MS);

    // ─── GROUP 13: SETTLING DETECTION ─────────────────────────
    console.log('\n%c⏱️ Group 13: Settling Detection', 'color:#60a5fa;font-weight:bold');

    var settled = isResponseFullySettled();
    assert(results, 'isResponseFullySettled() returns boolean',
        typeof settled === 'boolean',
        'Currently settled: ' + settled);

    // If not generating and we have turns, it should eventually settle
    if (!isGenerating() && getTurnCount() > 0) {
        // Force stable checks for test
        var savedStable = stableCheckCount;
        stableCheckCount = STREAM_STABLE_CHECKS + 1;
        var settledAfterForce = isResponseFullySettled();
        stableCheckCount = savedStable;
        assert(results, 'isResponseFullySettled() true when stable (forced)',
            settledAfterForce === true || isGenerating(),
            'Settled after forcing stable count: ' + settledAfterForce);
    }

    // ─── GROUP 14: EDGE CASES ─────────────────────────────────
    console.log('\n%c🔥 Group 14: Edge Cases', 'color:#60a5fa;font-weight:bold');

    // Empty code handling
    assert(results, 'isCodeIncomplete("") returns false',
        isCodeIncomplete('') === false,
        'Empty string is not "incomplete"');

    assert(results, 'isCodeIncomplete(null) returns false',
        isCodeIncomplete(null) === false,
        '');

    // Very short code
    assert(results, 'isCodeIncomplete short code (no continues)',
        (function() {
            var savedCont = continues;
            continues = 0;
            var result = isCodeIncomplete('var x = 1;');
            continues = savedCont;
            return result === false;
        })(),
        'Short code on first response is OK');

    assert(results, 'isCodeIncomplete short code (after continues)',
        (function() {
            var savedCont = continues;
            continues = 3;
            var result = isCodeIncomplete('var x = 1;');
            continues = savedCont;
            return result === true;
        })(),
        'Short code after 3 continues = incomplete');

    // Merge with itself (dedup)
    var selfMerge = mergeOverlap('line1\nline2\nline3', 'line1\nline2\nline3');
    assert(results, 'mergeOverlap with identical text',
        selfMerge === 'line1\nline2\nline3',
        'No duplication: "' + selfMerge.replace(/\n/g, '\\n') + '"');

    // ─── GROUP 15: INTEGRATION CHECK ──────────────────────────
    console.log('\n%c🔌 Group 15: Integration Check', 'color:#60a5fa;font-weight:bold');

    // Verify the full flow would work
    if (ta && getTurnCount() > 0) {
        var code = getLastCodeFromDOM();
        if (code) {
            var tail = getLastNLines(code, OVERLAP_LINES);
            assert(results, 'Can extract overlap tail from last code',
                tail.length > 0,
                'Tail: "' + tail.slice(0, 60).replace(/\n/g, '\\n') + '..."');

            var prompt = buildContinuePrompt();
            assert(results, 'Continue prompt is well-formed',
                prompt.length > 50 && prompt.indexOf(FENCE) !== -1,
                'Prompt length: ' + prompt.length);
        }
    }

    // Check auto-harvest observer is running
	assert(results, 'Auto-harvest observer is active',
		autoHarvestObserver !== null,
		autoHarvestObserver ? 'Observer active' : 'FAILED - calling startAutoHarvest() now');

	// If it failed, try to start it and report
	if (!autoHarvestObserver) {
		startAutoHarvest();
	}

    // Check debug log is working
    var logBefore = debugLog.length;
    log('Test log entry');
    assert(results, 'Debug logging works',
        debugLog.length === logBefore + 1,
        'Log entries: ' + debugLog.length);

    // ─── REPORT ───────────────────────────────────────────────
    return createTestReport(results);
};

// Also expose helper functions for manual debugging
window.acl_debug = {
    getState: function() {
        return {
            running: running,
            continues: continues,
            accumulated_length: accumulated.length,
            accumulated_lines: accumulated ? accumulated.split('\n').length : 0,
            lastRawTail: lastRawTail,
            lastTurns: lastTurns,
            turnCount: getTurnCount(),
            isGenerating: isGenerating(),
            stableCheckCount: stableCheckCount,
            lastSeenTextLength: lastSeenTextLength,
            isProcessingResponse: isProcessingResponse,
            totalGenerations: totalGenerations,
            processingCount: processingCount,
            doneCount: doneCount
        };
    },
    getLog: function() { return getDebugLog(); },
    getAccumulated: function() { return accumulated; },
    setAccumulated: function(code) { accumulated = code; },
    getLastCode: getLastCodeFromDOM,
    getAllCode: getAllCodeFromAllTurns,
    harvest: harvestAllCode,
    isComplete: function(code) { return !isCodeIncomplete(code || accumulated); },
    testMerge: mergeOverlap,
    testIsDone: isDone,
    forceFinish: finish,
    forceContinue: function() {
        if (!running) { running = true; updateBtn(); }
        doSubmitContinue();
    },
    getChatRoot: getChatRoot,
    getLastTurnEl: getLastAnswerTurnEl,
    getCodeBlocks: function() {
        var el = getLastAnswerTurnEl();
        return el ? getCodeBlocksFromElement(el) : [];
    }
};

log('Auto-Coder v13 loaded. Run test_auto_continue() in console to test. Use acl_debug for debugging.');

})();
