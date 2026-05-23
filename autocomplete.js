// ==UserScript==
// @name         Auto-Coder v12
// @namespace    http://tampermonkey.net/
// @version      12.0
// @description  Auto-continue with robust completion detection. FIXED: premature stopping, early harvest, settling detection, streaming awareness, multiple completion checks, longer settle times, retry logic.
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
var FINISH = '!!!!!' + 'AUTOCODER_FINISHED' + '!!!!!';
var CODE_START = '!!!!!' + 'CODEBLOCK_STARTS' + '!!!!!';
var CODE_END = '!!!!!' + 'CODEBLOCK_ENDS' + '!!!!!';

var DELAY_MS = 25000;
var MAX = 25; // FIX #1: Increased max continues from 15 to 25 to allow longer generations
var POLL_MS = 2000; // FIX #2: Poll more frequently to catch state changes faster
var AUTO_HARVEST_SETTLE_MS = 12000; // FIX #3: Increased from 5000 to 12000 - wait much longer before auto-harvesting
var RESPONSE_SETTLE_MS = 4000; // FIX #4: New constant - wait after generation stops before processing
var STREAM_CHECK_INTERVAL = 1500; // FIX #5: How often to re-check if streaming is truly done
var STREAM_STABLE_CHECKS = 3; // FIX #6: Require N consecutive stable checks before considering settled
var MIN_CODE_LENGTH_FOR_COMPLETE = 500; // FIX #7: Don't consider code "complete" if it's very short

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
var lastSeenTextLength = 0; // FIX #8: Track text length changes to detect ongoing streaming
var stableCheckCount = 0; // FIX #9: Count consecutive stable checks
var lastResponseText = ''; // FIX #10: Track last response text for change detection
var responseHandleTimeout = null; // FIX #11: Debounce response handling
var isProcessingResponse = false; // FIX #12: Prevent re-entrant response handling

// ============================================================
// DOM QUERY HELPERS
// ============================================================

function qs(sel) { return document.querySelector(sel); }
function qsa(sel) { return document.querySelectorAll(sel); }
function getTurns() { return qsa('[data-testid^="youchat-answer-turn-"]').length; }

function isGenerating() {
    // Check multiple indicators of generation in progress
    if (qsa('[data-testid^="step-"][data-finished="false"]').length > 0) return true;
    // Check for stop button
    var stopBtn = qs('[data-testid="stop-button"], [aria-label="Stop generating"]');
    if (stopBtn) return true;
    // FIX #13: Check for any loading/streaming indicators
    var loadingEls = qsa('[class*="loading"], [class*="streaming"], [class*="typing"]');
    if (loadingEls.length > 0) return true;
    // FIX #14: Check for cursor/caret blinking indicators that suggest streaming
    var caretEls = qsa('[class*="caret"], [class*="cursor"], [class*="blink"]');
    if (caretEls.length > 0) return true;
    return false;
}

function isTextStillChanging() {
    // FIX #15: Detect if the response text is still growing (streaming without UI indicators)
    var el = getLastTurnEl();
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

function getLastTurnEl() {
    var all = qsa('[data-testid^="youchat-answer-turn-"]');
    return all.length ? all[all.length - 1] : null;
}

function getLastTurnText() {
    var el = getLastTurnEl();
    return el ? el.innerText : '';
}

// ============================================================
// CODE FROM DOM
// ============================================================

function getCodeFromTurnEl(el) {
    if (!el) return '';
    var codeEls = el.querySelectorAll('pre code');
    if (codeEls.length === 0) return '';
    var parts = [];
    for (var i = 0; i < codeEls.length; i++) {
        var text = codeEls[i].textContent || '';
        if (text.trim().length > 50) {
            parts.push(text);
        }
    }
    return parts.join('\n');
}

function getLastCodeFromDOM() {
    return getCodeFromTurnEl(getLastTurnEl());
}

// ============================================================
// FORM SUBMISSION
// ============================================================

function getTextarea() { return qs('#search-input-textarea'); }

function setNativeValue(ta, text) {
    var nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    nativeInputValueSetter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
}

function clickSend(ta) {
    var form = ta.closest('form');
    if (!form) return;
    var btn = form.querySelector('button[type="submit"]') ||
              form.querySelector('[data-testid="search-input-send-button"]') ||
              form.querySelector('button[aria-label*="Send"]') ||
              form.querySelector('button[aria-label*="send"]');
    if (btn) {
        btn.disabled = false;
        btn.click();
    } else {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
}

function submit(text) {
    var ta = getTextarea();
    if (!ta) {
        log('ERROR: textarea not found');
        return;
    }
    setNativeValue(ta, text);
    setTimeout(function() { clickSend(ta); }, 500);
}

// ============================================================
// LOGGING
// ============================================================

function log(msg) {
    console.log('[AutoCoder] ' + msg);
}

// ============================================================
// STRING HELPERS
// ============================================================

function unescapeBackticks(code) {
    return code.replace(/!!!!!BACKTICK!!!!!/g, BT);
}

function getLastNLines(text, n) {
    var lines = text.split('\n');
    var out = [];
    for (var i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim().length > 0 || out.length > 0) {
            out.unshift(lines[i]);
        }
        if (out.length >= n) break;
    }
    return out.join('\n');
}

function countMatches(str, regex) {
    return (str.match(regex) || []).length;
}

// ============================================================
// AUDIO FEEDBACK
// ============================================================

function getAudioCtx() {
    if (!audioCtx) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch(e) { return null; }
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
        gain.gain.setValueAtTime(0.3, now + startOffset);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + startOffset);
        osc.stop(now + startOffset + dur);
    } catch(e) {}
}

function playChord(tones) {
    for (var i = 0; i < tones.length; i++) {
        playTone(tones[i][0], tones[i][1], tones[i][2]);
    }
}

function playProcessingSound() { playChord([[440, 0, 0.2], [554.37, 0.1, 0.2]]); }
function playSuccessSound() { playChord([[523.25, 0, 0.15], [659.25, 0.1, 0.15], [783.99, 0.2, 0.3]]); }

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

function incrementProcessing() {
    processingCount++;
    totalGenerations++;
    updateCounter();
    playProcessingSound();
}

function markDone() {
    if (processingCount > 0) processingCount--;
    doneCount++;
    updateCounter();
    playSuccessSound();
}

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
    // FIX #16: More comprehensive cut-off detection - also check for string literals that are unclosed
    if (/[+\-*\/=,({;|&:]$/.test(lastLine)) return true;
    if (/['"][^'"]*$/.test(lastLine) && !/['"];\s*$/.test(lastLine)) return true;
    return false;
}

function prevNonEmptyLineIsCutOff(trimmed) {
    var lines = trimmed.split('\n');
    if (lines[lines.length - 1].trim() !== '' || lines.length <= 5) return false;
    for (var i = lines.length - 2; i >= 0; i--) {
        var l = lines[i].trim();
        if (l.length > 0) return /[+\-*\/=,({;|&:]$/.test(l);
    }
    return false;
}

function hasUnclosedHtml(t) { return /<!DOCTYPE/i.test(t) && !/<\/html>/i.test(t); }

function hasUnbalancedBraces(t) {
    var opens = countMatches(t, /\{/g);
    var closes = countMatches(t, /\}/g);
    // FIX #17: More sensitive brace detection - even 1 unclosed brace in substantial code is suspicious
    if (t.length > 2000 && (opens - closes) > 1) return true;
    return (opens - closes) > 2;
}

function hasUnclosedScript(t) { return countMatches(t, /<script/gi) > countMatches(t, /<\/script>/gi); }
function hasUnclosedStyle(t) { return countMatches(t, /<style/gi) > countMatches(t, /<\/style>/gi); }

function hasUnclosedParens(t) {
    // FIX #18: Check for unclosed parentheses which indicate incomplete function calls/definitions
    var opens = countMatches(t, /\(/g);
    var closes = countMatches(t, /\)/g);
    if (t.length > 2000 && (opens - closes) > 2) return true;
    return (opens - closes) > 3;
}

function hasUnclosedBrackets(t) {
    // FIX #19: Check for unclosed square brackets (arrays)
    var opens = countMatches(t, /\[/g);
    var closes = countMatches(t, /\]/g);
    return (opens - closes) > 2;
}

function endsAbruptlyMidBlock(trimmed) {
    var lines = trimmed.split('\n');
    if (lines.length < 20) return false;
    var lastFew = lines.slice(-3).join('\n').trim();
    if (/[}\])];\s*$/.test(lastFew)) return false;
    if (/[}\])]\s*$/.test(lastFew)) return false;
    if (/<\/html>\s*$/i.test(lastFew)) return false;
    if (/^\s*\*\/\s*$/.test(lines[lines.length - 1])) return false;
    if ((countMatches(trimmed, /\{/g) - countMatches(trimmed, /\}/g)) > 1) return true;
    if ((countMatches(trimmed, /\(/g) - countMatches(trimmed, /\)/g)) > 3) return true;
    return false;
}

function hasUnclosedIIFE(trimmed) {
    if (!/^\s*\(\s*function\s*\(/.test(trimmed)) return false;
    var lastChunk = trimmed.slice(-50).trim();
    return !/\}\s*\)\s*\(\s*\)\s*;?\s*$/.test(lastChunk);
}

function hasUnclosedTemplateLiteral(trimmed) {
    // FIX #20: Detect unclosed template literals
    var backtickCount = 0;
    var inTemplate = false;
    for (var i = 0; i < trimmed.length; i++) {
        if (trimmed[i] === BT && (i === 0 || trimmed[i-1] !== '\\')) {
            inTemplate = !inTemplate;
            backtickCount++;
        }
    }
    return backtickCount % 2 !== 0;
}

function looksLikeIncompleteResponse(code, responseText) {
    if (!code || code.trim().length < 200) return false;
    if (responseText && responseText.indexOf('AUTOCODER_FINISHED') !== -1) return false;
    var trimmed = code.trim();
    var lastLine = trimmed.split('\n').pop().trim();
    if (/\}\s*\)\s*\(\s*\)\s*;?\s*$/.test(lastLine)) return false;
    if (/<\/html>\s*$/i.test(lastLine)) return false;
    if (/^\/\//.test(lastLine) && trimmed.length > 5000) return false;
    if (hasUnclosedIIFE(trimmed)) return true;
    if (hasUnclosedHtml(trimmed)) return true;
    // FIX: Also check brace balance for incomplete response detection
    if (hasUnbalancedBraces(trimmed)) return true;
    if (hasUnclosedParens(trimmed)) return true;
    return false;
}

function isCodeIncomplete(code) {
    if (!code || code.trim().length === 0) return false;
    var trimmed = code.trim();
    // Don't mark as complete if code is too short (likely truncated early)
    if (trimmed.length < MIN_CODE_LENGTH_FOR_COMPLETE && continues > 0) return true;
    if (endsWithHtmlClose(trimmed)) return false;
    if (trimmed.indexOf('AUTOCODER_FINISHED') !== -1) return false;
    if (/\}\s*\)\s*\(\s*\)\s*;?\s*$/.test(trimmed.slice(-20))) return false;
    return lastLineIsCutOff(trimmed) ||
           prevNonEmptyLineIsCutOff(trimmed) ||
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
// STREAMING / SETTLING DETECTION (HEAVILY IMPROVED)
// ============================================================

function countFences(text) {
    var count = 0, idx = 0;
    while (true) {
        var pos = text.indexOf(BT + BT + BT, idx);
        if (pos === -1) break;
        count++;
        idx = pos + 3;
    }
    return count;
}

function isResponseFullySettled() {
    // FIX: Much more robust settling detection
    // Must pass ALL checks to be considered settled

    // Check 1: No generation indicators
    if (isGenerating()) return false;

    // Check 2: Must have a turn element
    var el = getLastTurnEl();
    if (!el) return false;

    // Check 3: Text must not be changing
    if (isTextStillChanging()) return false;

    // Check 4: Must have had N consecutive stable checks
    if (stableCheckCount < STREAM_STABLE_CHECKS) return false;

    // Check 5: Fence count must be even (all code blocks closed)
    var text = el.innerText || '';
    if (countFences(text) % 2 !== 0) return false;

    return true;
}

function isResponseSettled() {
    // Lighter version for auto-harvest (doesn't require stable checks)
    if (isGenerating()) return false;
    var el = getLastTurnEl();
    if (!el) return false;
    var text = el.innerText || '';
    if (countFences(text) % 2 !== 0) return false;
    if (isTextStillChanging()) return false;
    return true;
}

// ============================================================
// MERGE OVERLAP
// ============================================================

function fixTruncatedTail(aLines, bLines) {
    if (aLines.length === 0 || bLines.length === 0) return false;
    var lastA = aLines[aLines.length - 1].trim();
    if (lastA.length === 0) return false;
    var firstBIdx = 0;
    while (firstBIdx < bLines.length && bLines[firstBIdx].trim() === '') firstBIdx++;
    if (firstBIdx >= bLines.length) return false;
    var firstB = bLines[firstBIdx].trim();
    if (firstB.length > lastA.length && firstB.indexOf(lastA) === 0) {
        aLines.pop();
        return true;
    }
    return false;
}

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
    for (var startB = 0; startB < Math.min(5, bLines.length); startB++) {
        if (bLines[startB].trim() === '') continue;
        for (var posA = Math.max(0, aLines.length - 30); posA < aLines.length; posA++) {
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

function mergeOverlap(existing, fragment) {
    if (!existing) return fragment;
    if (!fragment) return existing;
    if (fragment.trim().length < 50 && existing.trim().length > 200) return existing;

    var aLines = existing.split('\n');
    var bLines = fragment.split('\n');

    fixTruncatedTail(aLines, bLines);
    var aText = aLines.join('\n');
    aLines = aText.split('\n');

    var exact = findExactOverlap(aLines, bLines);
    if (exact > 0) return aLines.join('\n') + '\n' + bLines.slice(exact).join('\n');

    var partial = findPartialOverlap(aLines, bLines);
    if (partial) return aLines.slice(0, partial.posA).join('\n') + '\n' + bLines.slice(partial.startB).join('\n');

    return existing + '\n' + fragment;
}

// ============================================================
// RAW TAIL FOR CONTINUE PROMPT
// ============================================================

function getRawTail() {
    var code = getLastCodeFromDOM();
    var source = (code && code.trim().length > 0) ? code : accumulated;
    return source ? getLastNLines(source, 5) : '';
}

// ============================================================
// DONE DETECTION
// ============================================================

function isDone(text) {
    if (text.indexOf('AUTOCODER_FINISHED') !== -1) return true;
    var el = getLastTurnEl();
    if (!el) return false;
    var allText = el.textContent || '';
    if (allText.indexOf('AUTOCODER_FINISHED') !== -1) return true;
    return false;
}

// ============================================================
// FENCE STRIPPING
// ============================================================

function stripFence(block) {
    var lines = block.split('\n');
    var inFence = false, out = [], hasFence = false;
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (!inFence && l.trim().indexOf(FENCE) === 0) { inFence = true; hasFence = true; continue; }
        if (inFence && l.trim() === FENCE) { inFence = false; continue; }
        if (inFence) out.push(l);
    }
    if (hasFence && out.length > 0) return out.join('\n');
    var start = 0, end = lines.length;
    if (lines.length > 0 && /^\s*$/.test(lines[0])) start = 1;
    if (end > 0 && /^\s*$/.test(lines[end - 1])) end--;
    return lines.slice(start, end).join('\n');
}

// ============================================================
// CODE EXTRACTION
// ============================================================

function findMarker(text, markers, fromIdx) {
    var best = -1, bestLen = 0;
    for (var i = 0; i < markers.length; i++) {
        var pos = text.indexOf(markers[i], fromIdx);
        if (pos !== -1 && (best === -1 || pos < best)) { best = pos; bestLen = markers[i].length; }
    }
    return { pos: best, len: bestLen };
}

function extractFromMarkers(text) {
    var startMarkers = [CODE_START, 'CODEBLOCK_STARTS!!!!!'];
    var endMarkers = [CODE_END, 'CODEBLOCK_ENDS!!!!!'];
    var result = '', idx = 0, found = false;

    while (true) {
        var s = findMarker(text, startMarkers, idx);
        if (s.pos === -1) break;
        found = true;
        var e = findMarker(text, endMarkers, s.pos + s.len);
        var raw = (e.pos === -1) ? text.substring(s.pos + s.len) : text.substring(s.pos + s.len, e.pos);
        prevHadUnclosedBlock = (e.pos === -1);
        var code = stripFence(raw);
        if (code) result += (result ? '\n' : '') + code;
        if (e.pos === -1) break;
        idx = e.pos + e.len;
    }
    return { code: result, found: found };
}

function extractCode(text) {
    var fromMarkers = extractFromMarkers(text);
    if (fromMarkers.found) return unescapeBackticks(fromMarkers.code);

    var domCode = getLastCodeFromDOM();
    if (domCode && domCode.trim().length > 50) {
        if (isCodeIncomplete(domCode)) prevHadUnclosedBlock = true;
        return unescapeBackticks(domCode);
    }
    return '';
}

// ============================================================
// MARKER CLEANING
// ============================================================

var MARKER_PATTERNS = [
    /^.*!!!!!CODEBLOCK_STARTS!!!!!.*$/gm,
    /^.*!!!!!CODEBLOCK_ENDS!!!!!.*$/gm,
    /^.*!!!!!AUTOCODER_FINISHED!!!!!.*$/gm,
    /^.*CODE STARTS<<<.*$/gm,
    /^.*CODE ENDS<<<.*$/gm,
    /^.*>>>CODE STARTS<<<.*$/gm,
    /^.*>>>CODE ENDS<<<.*$/gm,
    /^.*>>>FINISHED<<<.*$/gm,
    /^.*FINISHED<<<.*$/gm,
    /^html\s*$/gm
];

function cleanMarkers(code) {
    var cleaned = code;
    for (var i = 0; i < MARKER_PATTERNS.length; i++) {
        cleaned = cleaned.replace(MARKER_PATTERNS[i], '');
    }
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.replace(/^\n+/, '').replace(/\n+$/, '');
}

// ============================================================
// HARVEST
// ============================================================

function harvestFromElements(codeEls) {
    var allCode = '';
    for (var i = 0; i < codeEls.length; i++) {
        var raw = codeEls[i].textContent || '';
        if (raw.trim().length < 50) continue;
        var cleaned = cleanMarkers(raw);
        if (cleaned.trim().length > 50) {
            allCode = mergeOverlap(allCode, cleaned);
        }
    }
    return allCode;
}

function getCodeElements(container) {
    var els = container.querySelectorAll('pre code');
    if (els.length === 0) els = container.querySelectorAll('pre');
    return els;
}

function harvestAllCode() {
    var turns = qsa('[data-testid^="youchat-answer-turn-"]');
    if (!turns || turns.length === 0) {
        turns = qsa('[class*="answer"], [class*="response"], [data-testid*="answer"]');
    }
    if (!turns || turns.length === 0) {
        var allEls = getCodeElements(document);
        if (allEls.length === 0) return '';
        return unescapeBackticks(harvestFromElements(allEls)).trim();
    }

    var allCode = '';
    for (var i = 0; i < turns.length; i++) {
        var codeEls = getCodeElements(turns[i]);
        var turnCode = harvestFromElements(codeEls);
        if (turnCode && turnCode.trim().length > 50) {
            allCode = mergeOverlap(allCode, turnCode);
        }
    }
    return unescapeBackticks(allCode).trim();
}

function isValidHarvest(code) {
    if (!code || code.trim().length < 100) return false;
    var lines = code.split('\n');
    if (lines.length < 3) return false;
    var longLines = 0;
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].trim().length > 10) longLines++;
    }
    return longLines >= 3;
}

function doHarvest() {
    setStatus('\uD83C\uDF3E Harvesting...');
    var code = harvestAllCode();
    if (!isValidHarvest(code)) {
        setStatus('\u26A0 No valid code found. ' + qsa('pre code').length + ' code elements on page.');
        return;
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
// CLIPBOARD HELPER
// ============================================================

function copyToClipboard(text, onSuccess, onFail) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(onSuccess || function(){}).catch(onFail || function(){});
    } else if (onFail) {
        onFail();
    }
}

// ============================================================
// AUTO-HARVEST OBSERVER
// ============================================================

function cancelPendingAutoHarvest() {
    if (autoHarvestPending) { clearTimeout(autoHarvestPending); autoHarvestPending = null; }
}

function tryAutoHarvest() {
    // FIX: Don't auto-harvest while running or while response is still settling
    if (running) return;
    if (isGenerating()) {
        autoHarvestPending = setTimeout(tryAutoHarvest, 2000);
        return;
    }
    if (!isResponseSettled()) {
        autoHarvestPending = setTimeout(tryAutoHarvest, 2000);
        return;
    }
    // FIX: Additional delay after settling to make sure nothing else is coming
    setTimeout(function() {
        if (!isResponseSettled() || running || isGenerating()) return;
        // FIX: Check text stability one more time
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
    }, 3000); // FIX: Extra 3s buffer after settling
}

function onAutoHarvestMutation() {
    // FIX: Never auto-harvest while generating or running
    if (isGenerating() || running) return;
    var currentTurns = getTurns();
    if (currentTurns > lastAutoHarvestTurns) {
        lastAutoHarvestTurns = currentTurns;
        cancelPendingAutoHarvest();
        // FIX: Much longer settle time before auto-harvest triggers
        autoHarvestPending = setTimeout(tryAutoHarvest, AUTO_HARVEST_SETTLE_MS);
    }
}

function startAutoHarvest() {
    if (autoHarvestObserver) return;
    autoHarvestObserver = new MutationObserver(onAutoHarvestMutation);
    autoHarvestObserver.observe(document.body, { childList: true, subtree: true });
    log('Auto-harvest observer started');
}

// ============================================================
// INJECTED CODE BLOCK UI
// ============================================================

function injectCodeBlock(code) {
    var lastTurn = getLastTurnEl();
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
// MAIN FLOW: POLLING (HEAVILY IMPROVED)
// ============================================================

function poll() {
    if (!running) return;

    // FIX: If still generating, keep polling
    if (isGenerating()) {
        // Reset stable check count since we know it's still going
        stableCheckCount = 0;
        lastSeenTextLength = 0;
        pollTimeout = setTimeout(poll, POLL_MS);
        return;
    }

    // FIX: Check if text is still changing even without generation indicators
    if (isTextStillChanging()) {
        pollTimeout = setTimeout(poll, STREAM_CHECK_INTERVAL);
        return;
    }

    // FIX: Require multiple stable checks before proceeding
    if (stableCheckCount < STREAM_STABLE_CHECKS) {
        pollTimeout = setTimeout(poll, STREAM_CHECK_INTERVAL);
        return;
    }

    // FIX: Check turn count - must have a new turn
    var t = getTurns();
    if (t <= lastTurns) {
        pollTimeout = setTimeout(poll, POLL_MS);
        return;
    }

    // FIX: Check fence balance before processing
    var el = getLastTurnEl();
    if (el) {
        var text = el.innerText || '';
        if (countFences(text) % 2 !== 0) {
            // Odd fence count means a code block is still open/streaming
            log('Fence count odd - still streaming, waiting...');
            stableCheckCount = 0;
            pollTimeout = setTimeout(poll, STREAM_CHECK_INTERVAL);
            return;
        }
    }

    lastTurns = t;
    // FIX: Longer delay before handling response to ensure DOM is fully updated
    if (responseHandleTimeout) clearTimeout(responseHandleTimeout);
    responseHandleTimeout = setTimeout(function() {
        handleResponseSafe();
    }, RESPONSE_SETTLE_MS);
}

// ============================================================
// MAIN FLOW: RESPONSE HANDLING (WITH SAFETY CHECKS)
// ============================================================

function handleResponseSafe() {
    if (!running) return;
    if (isProcessingResponse) return; // Prevent re-entrant calls
    isProcessingResponse = true;

    // FIX: Double-check that generation is truly done before processing
    if (isGenerating()) {
        isProcessingResponse = false;
        pollTimeout = setTimeout(poll, POLL_MS);
        return;
    }

    // FIX: One final text stability check
    if (isTextStillChanging()) {
        isProcessingResponse = false;
        stableCheckCount = 0;
        pollTimeout = setTimeout(poll, STREAM_CHECK_INTERVAL);
        return;
    }

    // FIX: Verify fence balance one more time
    var el = getLastTurnEl();
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

    // FIX: Check if this is the same response we already processed
    if (text === lastResponseText && text.length > 0) {
        log('Same response text detected, skipping duplicate processing');
        pollTimeout = setTimeout(poll, POLL_MS);
        return;
    }
    lastResponseText = text;

    var newCode = extractCode(text);

    if ((!newCode || newCode.trim().length === 0)) {
        var domCode = getLastCodeFromDOM();
        if (domCode && domCode.trim().length > 50) newCode = domCode;
    }

    if (newCode && newCode.trim().length > 50) {
        accumulated = mergeOverlap(accumulated, newCode);
    }

    lastRawTail = getRawTail();
    if (isValidHarvest(accumulated.trim())) {
        injectCodeBlock(accumulated.trim());
    }
    decideNextAction(text);
}

function decideNextAction(text) {
    // FIX: Check isDone first - this is the explicit signal
    if (isDone(text)) {
        log('FINISHED marker detected - completing.');
        finish();
        return;
    }

    // FIX: Check max continues
    if (continues >= MAX) {
        log('Max continues reached (' + MAX + ') - completing.');
        finish();
        return;
    }

    // FIX: More thorough incomplete detection
    var accTrimmed = accumulated.trim();

    // If we have accumulated code, check if it's incomplete
    if (accTrimmed.length > 0) {
        if (isCodeIncomplete(accTrimmed)) {
            log('Code incomplete (structural check) - continuing. Accumulated: ' + accTrimmed.length + ' chars');
            setStatus('\u26A0 Code incomplete (' + accTrimmed.split('\n').length + ' lines so far), auto-continuing...');
            scheduleNext();
            return;
        }

        if (looksLikeIncompleteResponse(accTrimmed, text)) {
            log('Response looks truncated - continuing.');
            setStatus('\u26A0 Response looks truncated, auto-continuing...');
            scheduleNext();
            return;
        }

        // FIX: Check if the response itself was cut off (no proper ending)
        if (prevHadUnclosedBlock) {
            log('Previous had unclosed block marker - continuing.');
            setStatus('\u26A0 Unclosed code block detected, auto-continuing...');
            scheduleNext();
            return;
        }

        // FIX: If code is very short relative to what we'd expect, it might be incomplete
        if (accTrimmed.length < MIN_CODE_LENGTH_FOR_COMPLETE && continues === 0) {
            // Only on first response - if it's suspiciously short, check harder
            var domCode = getLastCodeFromDOM();
            if (domCode && isCodeIncomplete(domCode)) {
                log('First response code is short and incomplete - continuing.');
                setStatus('\u26A0 Short incomplete code, auto-continuing...');
                scheduleNext();
                return;
            }
        }

        // Code looks complete
        log('Code appears complete. ' + accTrimmed.split('\n').length + ' lines.');
        finish();
    } else {
        // No code accumulated
        setStatus('\u26A0 No code detected, stopping.');
        finish();
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
    // FIX: Reset tracking state for next response
    stableCheckCount = 0;
    lastSeenTextLength = 0;
    lastResponseText = '';
    isProcessingResponse = false;

    setStatus('\u23F3 Continuing (' + continues + '/' + MAX + ')...');
    submit(buildContinuePrompt());
    // FIX: Longer initial wait before polling to give the AI time to start generating
    setTimeout(poll, 6000);
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
    var tail = lastRawTail || accumulated.split('\n').slice(-5).join('\n');
    return [
        'Continue EXACTLY where you left off. Your last lines were:',
        '', FENCE, tail, FENCE, '',
        'Continue from there. Do NOT repeat those lines. Just write the next code.',
        'When you are 100% completely done with the ENTIRE file, write this AFTER your code block on its own line:',
        FINISH, '',
        'If you are NOT done yet, just stop mid-code. I will ask you to continue.',
        'Do NOT write ' + FINISH + ' unless the code is truly 100% complete.'
    ].join('\n');
}

function buildInitialPrompt(userText) {
    return [
        userText, '',
        '=== RULES ===',
        'Write the complete code in a single code block.',
        'If you run out of space, just stop mid-code. I will ask you to continue.',
        'When you are 100% completely finished with the ENTIRE file, write this AFTER your code block on its own line:',
        FINISH, '',
        'Do NOT write ' + FINISH + ' unless the code is truly 100% complete.',
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
        setStatus('\u2705 Done! ' + code.split('\n').length + ' lines \u2014 copied! (' + (continues) + ' continues)');
    }, function() {
        setStatus('\u2705 Done! ' + code.split('\n').length + ' lines. (' + (continues) + ' continues)');
    });
}

function start(prompt) {
    running = true;
    continues = 0;
    accumulated = '';
    lastRawTail = '';
    prevHadUnclosedBlock = false;
    lastHarvestedText = '';
    lastTurns = getTurns();
    lastSeenTextLength = 0;
    stableCheckCount = 0;
    lastResponseText = '';
    isProcessingResponse = false;
    if (responseHandleTimeout) { clearTimeout(responseHandleTimeout); responseHandleTimeout = null; }
    incrementProcessing();
    updateBtn();
    setStatus('\u23F3 Submitting...');
    submit(buildInitialPrompt(prompt));
    // FIX: Longer initial wait to give AI time to start
    setTimeout(poll, 7000);
}

function stop() {
    running = false;
    clearWait();
    if (responseHandleTimeout) { clearTimeout(responseHandleTimeout); responseHandleTimeout = null; }
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

// FIX: Periodic health check - re-init UI if removed, update padding
setInterval(function() {
    if (!qs('#acl-bar') && document.body) initUI();
    updateBodyPadding();
}, 3000);

// FIX: Periodic streaming stability check while running
setInterval(function() {
    if (!running) return;
    // Keep checking text stability even between polls
    isTextStillChanging();
}, STREAM_CHECK_INTERVAL);

})();
