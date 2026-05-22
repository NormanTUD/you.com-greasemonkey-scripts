// ==UserScript==
// @name         Auto-Coder v10
// @namespace    http://tampermonkey.net/
// @version      10.3
// @description  Auto-continue: detects incomplete code even without markers. Smart merge, harvest, skip timer. Refactored.
// @match        https://you.com/*
// @grant        none
// ==/UserScript==

(function() {
'use strict';

var BT = String.fromCharCode(96);
var FENCE = BT + BT + BT;

var FINISH = '!!!!!AUTOCODER_FINISHED!!!!!';
var CODE_START = '!!!!!CODEBLOCK_STARTS!!!!!';
var CODE_END = '!!!!!CODEBLOCK_ENDS!!!!!';
var BACKTICK_ESC = '!!!!!BACKTICK!!!!!';

var DELAY_MS = 25000;
var MAX = 15;
var POLL_MS = 2500;
var AUTO_HARVEST_SETTLE_MS = 3000;

var running = false, continues = 0, lastTurns = 0;
var accumulated = '', lastRawTail = '', prevHadUnclosedBlock = false;
var waitTimer = null, waitRemaining = 0;

var totalGenerations = 0;
var processingCount = 0;
var doneCount = 0;

var autoHarvestObserver = null;
var lastAutoHarvestTurns = 0;
var autoHarvestPending = null;

// ============================================================
// DOM QUERY HELPERS
// ============================================================

function qs(sel) { return document.querySelector(sel); }
function qsa(sel) { return document.querySelectorAll(sel); }

function getTurns() {
    return qsa('[data-testid^="youchat-answer-turn-"]').length;
}

function isGenerating() {
    return qsa('[data-testid^="step-"][data-finished="false"]').length > 0;
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
    var allCode = '';
    for (var i = 0; i < codeEls.length; i++) {
        allCode += (allCode ? '\n' : '') + (codeEls[i].textContent || '');
    }
    return allCode;
}

function getLastCodeFromDOM() {
    return getCodeFromTurnEl(getLastTurnEl());
}

// ============================================================
// FORM SUBMISSION
// ============================================================

function getTextarea() {
    return qs('#search-input-textarea');
}

function setNativeValue(ta, text) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function clickSend(ta) {
    var form = ta.closest('form');
    var btn = form && form.querySelector('button[type="submit"],[data-testid="search-input-send-button"]');
    if (btn) { btn.disabled = false; btn.click(); }
}

function submit(text) {
    var ta = getTextarea();
    if (!ta) return;
    setNativeValue(ta, text);
    setTimeout(function() { clickSend(ta); }, 300);
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

// ============================================================
// AUDIO FEEDBACK
// ============================================================

var audioCtx = null;

function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
}

function playTone(freq, start, dur) {
    var ctx = getAudioCtx();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.3, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur);
}

function playProcessingSound() {
    var ctx = getAudioCtx();
    var now = ctx.currentTime;
    playTone(440, now, 0.2);
    playTone(554.37, now + 0.1, 0.2);
}

function playSuccessSound() {
    var ctx = getAudioCtx();
    var now = ctx.currentTime;
    playTone(523.25, now, 0.15);
    playTone(659.25, now + 0.1, 0.15);
    playTone(783.99, now + 0.2, 0.3);
}

// ============================================================
// COUNTER & TITLE
// ============================================================

function buildTitle() {
    if (totalGenerations === 0) return '\u2728 KI Auto-Coder \u2014 Bereit';
    if (totalGenerations < 3) return '\u26A1 Auto-Coder \u2014 ' + totalGenerations + ' generiert';
    if (totalGenerations < 7) return '\uD83D\uDD25 Auto-Coder \u2014 ' + totalGenerations + ' generiert!';
    if (totalGenerations < 12) return '\uD83D\uDE80 Auto-Coder \u2014 ' + totalGenerations + ' generiert!!';
    return '\uD83C\uDF1F BEAST MODE \u2014 ' + totalGenerations + ' Generierungen!';
}

function updateCounter() {
    var title = buildTitle();
    document.title = title;
    var titleEl = qs('#acl-counter-title');
    if (titleEl) titleEl.textContent = title;
    var procEl = qs('#acl-count-processing');
    var doneEl = qs('#acl-count-done');
    var totalEl = qs('#acl-count-total');
    if (procEl) procEl.textContent = processingCount;
    if (doneEl) doneEl.textContent = doneCount;
    if (totalEl) totalEl.textContent = totalGenerations;
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
// CODE COMPLETENESS CHECKS (each is a small testable function)
// ============================================================

function endsWithHtmlClose(trimmed) {
    if (/<\/html>\s*$/i.test(trimmed.slice(-30))) return true;
    var lines = trimmed.split('\n');
    var last = lines[lines.length - 1].trim();
    return /^<\/html>$/i.test(last);
}

function lastLineIsCutOff(trimmed) {
    var lines = trimmed.split('\n');
    var last = lines[lines.length - 1].trim();
    return /[+\-*\/=,({;|&:]$/.test(last) || /\($/.test(last);
}

function prevNonEmptyLineIsCutOff(trimmed) {
    var lines = trimmed.split('\n');
    var last = lines[lines.length - 1].trim();
    if (last !== '' || lines.length <= 5) return false;
    for (var i = lines.length - 2; i >= 0; i--) {
        var l = lines[i].trim();
        if (l.length > 0) {
            return /[+\-*\/=,({;|&:]$/.test(l);
        }
    }
    return false;
}

function hasUnclosedHtml(trimmed) {
    return /<!DOCTYPE/i.test(trimmed) && !/<\/html>/i.test(trimmed);
}

function hasUnbalancedBraces(trimmed) {
    var open = (trimmed.match(/\{/g) || []).length;
    var close = (trimmed.match(/\}/g) || []).length;
    return (open - close) > 2;
}

function hasUnclosedScript(trimmed) {
    var opens = (trimmed.match(/<script/gi) || []).length;
    var closes = (trimmed.match(/<\/script>/gi) || []).length;
    return opens > closes;
}

function hasUnclosedStyle(trimmed) {
    var opens = (trimmed.match(/<style/gi) || []).length;
    var closes = (trimmed.match(/<\/style>/gi) || []).length;
    return opens > closes;
}

function isCodeIncomplete(code) {
    if (!code || code.trim().length === 0) return false;
    var trimmed = code.trim();
    if (endsWithHtmlClose(trimmed)) return false;
    if (lastLineIsCutOff(trimmed)) return true;
    if (prevNonEmptyLineIsCutOff(trimmed)) return true;
    if (hasUnclosedHtml(trimmed)) return true;
    if (hasUnbalancedBraces(trimmed)) return true;
    if (hasUnclosedScript(trimmed)) return true;
    if (hasUnclosedStyle(trimmed)) return true;
    return false;
}

// ============================================================
// STREAMING / SETTLING DETECTION (fixes premature harvest)
// ============================================================

function isResponseSettled() {
    // Must not be generating
    if (isGenerating()) return false;

    // Check for open code fences in last turn (odd number = still streaming)
    var el = getLastTurnEl();
    if (!el) return false;
    var text = el.innerText || '';
    var fenceCount = 0;
    var idx = 0;
    while (true) {
        var pos = text.indexOf(BT + BT + BT, idx);
        if (pos === -1) break;
        fenceCount++;
        idx = pos + 3;
    }
    if (fenceCount % 2 !== 0) return false;

    // Check if code looks incomplete (structural)
    var code = getLastCodeFromDOM();
    if (code && code.trim().length > 20 && isCodeIncomplete(code)) return false;

    return true;
}

// ============================================================
// MERGE OVERLAP
// ============================================================

function fixTruncatedTail(aLines, bLines) {
    var lastA = aLines[aLines.length - 1].trim();
    if (lastA.length === 0 || bLines.length === 0) return false;

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
            if (aLines[aLines.length - n + k].trim() !== bLines[k].trim()) {
                match = false;
                break;
            }
        }
        if (match) best = n;
    }
    return best;
}

function findPartialOverlap(aLines, bLines) {
    for (var startB = 0; startB < Math.min(5, bLines.length); startB++) {
        if (bLines[startB].trim() === '') continue;
        for (var posA = Math.max(0, aLines.length - 30); posA < aLines.length; posA++) {
            if (aLines[posA].trim() === bLines[startB].trim()) {
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
    }
    return null;
}

function mergeOverlap(existing, fragment) {
    if (!existing) return fragment;
    if (!fragment) return existing;

    var aLines = existing.split('\n');
    var bLines = fragment.split('\n');

    fixTruncatedTail(aLines, bLines);
    existing = aLines.join('\n');
    aLines = existing.split('\n');

    var exact = findExactOverlap(aLines, bLines);
    if (exact > 0) {
        return existing + '\n' + bLines.slice(exact).join('\n');
    }

    var partial = findPartialOverlap(aLines, bLines);
    if (partial) {
        return aLines.slice(0, partial.posA).join('\n') + '\n' + bLines.slice(partial.startB).join('\n');
    }

    return existing + '\n' + fragment;
}

// ============================================================
// RAW TAIL FOR CONTINUE PROMPT
// ============================================================

function getRawTail() {
    var code = getLastCodeFromDOM();
    if (!code || code.trim().length === 0) {
        return accumulated ? getLastNLines(accumulated, 5) : '';
    }
    return getLastNLines(code, 5);
}

// ============================================================
// DONE DETECTION
// ============================================================

function isDone(text) {
    if (text.indexOf(FINISH) !== -1) return true;
    if (text.indexOf('AUTOCODER_FINISHED') !== -1) return true;
    var el = getLastTurnEl();
    if (!el) return false;
    var spans = el.querySelectorAll('[data-testid="youchat-text"]');
    for (var i = 0; i < spans.length; i++) {
        if ((spans[i].textContent || '').indexOf('AUTOCODER_FINISHED') !== -1) return true;
    }
    return false;
}

// ============================================================
// FENCE STRIPPING
// ============================================================

function extractInsideFences(lines) {
    var inFence = false, out = [];
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (!inFence && l.trim().indexOf(FENCE) === 0) { inFence = true; continue; }
        if (inFence && l.trim() === FENCE) { inFence = false; continue; }
        if (inFence) out.push(l);
    }
    return out;
}

function trimEdgeBlankLines(lines) {
    var start = 0, end = lines.length;
    if (lines.length > 0 && /^\s*$/.test(lines[0])) start = 1;
    if (end > 0 && /^\s*$/.test(lines[end - 1])) end--;
    return lines.slice(start, end);
}

function stripFence(block) {
    var lines = block.split('\n');
    var fenced = extractInsideFences(lines);
    if (fenced.length > 0) return fenced.join('\n');
    return trimEdgeBlankLines(lines).join('\n');
}

// ============================================================
// CODE EXTRACTION (from markers or DOM fallback)
// ============================================================

function findMarker(text, markers, fromIdx) {
    var best = -1, bestLen = 0;
    for (var i = 0; i < markers.length; i++) {
        var pos = text.indexOf(markers[i], fromIdx);
        if (pos !== -1 && (best === -1 || pos < best)) {
            best = pos;
            bestLen = markers[i].length;
        }
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
        var raw;
        if (e.pos === -1) {
            raw = text.substring(s.pos + s.len);
            prevHadUnclosedBlock = true;
        } else {
            raw = text.substring(s.pos + s.len, e.pos);
            prevHadUnclosedBlock = false;
        }

        var code = stripFence(raw);
        if (code) result += (result ? '\n' : '') + code;
        if (e.pos === -1) break;
        idx = e.pos + e.len;
    }

    return { code: result, found: found };
}

function extractCodeFromDOMFallback() {
    var domCode = getLastCodeFromDOM();
    if (domCode && domCode.trim().length > 20) {
        if (isCodeIncomplete(domCode)) {
            prevHadUnclosedBlock = true;
        }
        return domCode;
    }
    return '';
}

function extractCode(text) {
    var fromMarkers = extractFromMarkers(text);
    if (fromMarkers.found) {
        return unescapeBackticks(fromMarkers.code);
    }
    return unescapeBackticks(extractCodeFromDOMFallback());
}

// ============================================================
// MARKER CLEANING (for harvest)
// ============================================================

function cleanMarkers(code) {
    return code
        .replace(/^.*!!!!!CODEBLOCK_STARTS!!!!!.*$/gm, '')
        .replace(/^.*!!!!!CODEBLOCK_ENDS!!!!!.*$/gm, '')
        .replace(/^.*!!!!!AUTOCODER_FINISHED!!!!!.*$/gm, '')
        .replace(/^.*CODE STARTS<<<.*$/gm, '')
        .replace(/^.*CODE ENDS<<<.*$/gm, '')
        .replace(/^.*>>>CODE STARTS<<<.*$/gm, '')
        .replace(/^.*>>>CODE ENDS<<<.*$/gm, '')
        .replace(/^.*>>>FINISHED<<<.*$/gm, '')
        .replace(/^.*FINISHED<<<.*$/gm, '')
        .replace(/^html\s*$/gm, '')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '');
}

// ============================================================
// HARVEST: collect all code from all turns
// ============================================================

function harvestFromElements(codeEls) {
    var allCode = '';
    for (var i = 0; i < codeEls.length; i++) {
        var raw = codeEls[i].textContent || '';
        if (raw.trim().length < 10) continue;
        var cleaned = cleanMarkers(raw);
        if (cleaned.trim().length > 0) {
            allCode = mergeOverlap(allCode, cleaned);
        }
    }
    return allCode;
}

function harvestAllCode() {
    var turns = qsa('[data-testid^="youchat-answer-turn-"]');
    if (!turns || turns.length === 0) {
        turns = qsa('[class*="answer"], [class*="response"], [data-testid*="answer"]');
    }

    // Nuclear fallback
    if (!turns || turns.length === 0) {
        var allEls = qsa('pre code');
        if (allEls.length === 0) allEls = qsa('pre');
        if (allEls.length === 0) return '';
        return unescapeBackticks(harvestFromElements(allEls)).trim();
    }

    var allCode = '';
    for (var i = 0; i < turns.length; i++) {
        var codeEls = turns[i].querySelectorAll('pre code');
        if (codeEls.length === 0) codeEls = turns[i].querySelectorAll('pre');
        var turnCode = harvestFromElements(codeEls);
        if (turnCode) allCode = mergeOverlap(allCode, turnCode);
    }
    return unescapeBackticks(allCode).trim();
}

function doHarvest() {
    status('\uD83C\uDF3E Harvesting...');
    var code = harvestAllCode();
    if (!code || code.length === 0) {
        status('\u26A0 No code found. ' + qsa('pre code').length + ' code elements on page.');
        return;
    }
    accumulated = code;
    injectCodeBlock(code);
    navigator.clipboard.writeText(code).then(function() {
        status('\uD83C\uDF3E ' + code.split('\n').length + ' lines harvested & copied!');
        playSuccessSound();
    }).catch(function() {
        status('\uD83C\uDF3E ' + code.split('\n').length + ' lines harvested!');
    });
}

// ============================================================
// AUTO-HARVEST OBSERVER (FIXED: waits for settling)
// ============================================================

function cancelPendingAutoHarvest() {
    if (autoHarvestPending) {
        clearTimeout(autoHarvestPending);
        autoHarvestPending = null;
    }
}

function tryAutoHarvest() {
    // Don't auto-harvest while auto-continue is running
    if (running) return;

    // Must be fully settled
    if (!isResponseSettled()) {
        // Re-check in 1 second
        autoHarvestPending = setTimeout(tryAutoHarvest, 1000);
        return;
    }

    var code = harvestAllCode();
    if (code && code.length > 0) {
        accumulated = code;
        injectCodeBlock(code);
    }
    autoHarvestPending = null;
}

function onAutoHarvestMutation() {
    if (isGenerating()) return;
    if (running) return;

    var currentTurns = getTurns();
    if (currentTurns > lastAutoHarvestTurns) {
        lastAutoHarvestTurns = currentTurns;
        cancelPendingAutoHarvest();
        // Wait for response to fully settle before harvesting
        autoHarvestPending = setTimeout(tryAutoHarvest, AUTO_HARVEST_SETTLE_MS);
    }
}

function startAutoHarvest() {
    if (autoHarvestObserver) return;
    autoHarvestObserver = new MutationObserver(onAutoHarvestMutation);
    autoHarvestObserver.observe(document.body, { childList: true, subtree: true });
}

// ============================================================
// INJECTED CODE BLOCK UI
// ============================================================

function updateExistingBlock(el, code) {
    var codeEl = el.querySelector('code');
    var headerEl = el.querySelector('.acl-header-text');
    if (codeEl) codeEl.textContent = code;
    if (headerEl) headerEl.textContent = '\u2714 MERGED OUTPUT (' + code.split('\n').length + ' lines)';
}

function createBlockUI(code) {
    var wrapper = document.createElement('div');
    wrapper.id = 'acl-injected-block';
    wrapper.style.cssText = 'margin:16px 0;border:2px solid #7c3aed;border-radius:10px;overflow:hidden;position:relative;';

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#1a1528;border-bottom:1px solid #333;';

    var headerText = document.createElement('span');
    headerText.className = 'acl-header-text';
    headerText.style.cssText = 'color:#a5b4fc;font:600 12px sans-serif;';
    headerText.textContent = '\u2714 MERGED OUTPUT (' + code.split('\n').length + ' lines)';
    header.appendChild(headerText);

    var btnWrap = document.createElement('div');
    btnWrap.style.cssText = 'display:flex;gap:6px;';

    var copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy All';
    copyBtn.style.cssText = 'padding:4px 12px;border:none;border-radius:6px;background:#7c3aed;color:#fff;font:600 11px sans-serif;cursor:pointer;';
    copyBtn.addEventListener('click', function() {
        var c = wrapper.querySelector('code').textContent;
        navigator.clipboard.writeText(c).then(function() {
            copyBtn.textContent = 'Copied!';
            setTimeout(function() { copyBtn.textContent = 'Copy All'; }, 2000);
        });
    });

    var dlBtn = document.createElement('button');
    dlBtn.textContent = 'Download .html';
    dlBtn.style.cssText = 'padding:4px 12px;border:none;border-radius:6px;background:#059669;color:#fff;font:600 11px sans-serif;cursor:pointer;';
    dlBtn.addEventListener('click', function() {
        var c = wrapper.querySelector('code').textContent;
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([c], {type: 'text/html'}));
        a.download = 'output.html';
        a.click();
    });

    btnWrap.appendChild(copyBtn);
    btnWrap.appendChild(dlBtn);
    header.appendChild(btnWrap);

    var pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;padding:16px;overflow:auto;max-height:500px;background:#0a0a0f;';
    var codeEl = document.createElement('code');
    codeEl.style.cssText = 'white-space:pre-wrap;color:#e2e8f0;font:12px/1.6 "SF Mono",Consolas,monospace;';
    codeEl.textContent = code;
    pre.appendChild(codeEl);

    wrapper.appendChild(header);
    wrapper.appendChild(pre);
    return wrapper;
}

function injectCodeBlock(code) {
    var lastTurn = getLastTurnEl();
    if (!lastTurn) return;

    var old = document.getElementById('acl-injected-block');
    if (old) {
        updateExistingBlock(old, code);
        return;
    }

    var wrapper = createBlockUI(code);
    var container = lastTurn.parentElement;
    if (container) {
        container.insertBefore(wrapper, lastTurn.nextSibling);
    } else {
        lastTurn.after(wrapper);
    }
}

// ============================================================
// MAIN FLOW: POLLING
// ============================================================

function poll() {
    if (!running) return;
    if (isGenerating()) { setTimeout(poll, POLL_MS); return; }
    var t = getTurns();
    if (t <= lastTurns) { setTimeout(poll, POLL_MS); return; }
    lastTurns = t;
    setTimeout(handleResponse, 2000);
}

// ============================================================
// MAIN FLOW: RESPONSE HANDLING
// ============================================================

function handleResponse() {
    if (!running) return;
    var text = getLastTurnText();
    var newCode = extractCode(text);

    // Fallback: grab from DOM if extraction returned nothing
    if (!newCode || newCode.trim().length === 0) {
        var domCode = getLastCodeFromDOM();
        if (domCode && domCode.trim().length > 20) {
            newCode = domCode;
        }
    }

    if (newCode && newCode.trim().length > 0) {
        accumulated = mergeOverlap(accumulated, newCode);
    }

    lastRawTail = getRawTail();

    if (accumulated.trim()) {
        injectCodeBlock(accumulated.trim());
    }

    decideNextAction(text);
}

function decideNextAction(text) {
    if (isDone(text)) {
        finish();
    } else if (continues >= MAX) {
        finish();
    } else if (isCodeIncomplete(accumulated)) {
        status('\u26A0 Code incomplete, auto-continuing...');
        scheduleNext();
    } else if (!accumulated || accumulated.trim().length === 0) {
        status('\u26A0 No code detected, stopping.');
        finish();
    } else {
        finish();
    }
}

// ============================================================
// CONTINUE SCHEDULING
// ============================================================

function scheduleNext() {
    continues++;
    incrementProcessing();
    status('\u23F3 Waiting... (' + continues + '/' + MAX + ')');
    showWait(DELAY_MS);
}

function doSkip() {
    clearWait();
    doSubmitContinue();
}

function doSubmitContinue() {
    if (!running) return;
    status('\u23F3 Continuing (' + continues + '/' + MAX + ')...');
    submit(buildContinuePrompt());
    setTimeout(poll, 4000);
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
    if (bar) {
        var pct = ((DELAY_MS / 1000 - waitRemaining) / (DELAY_MS / 1000)) * 100;
        bar.style.width = pct + '%';
    }
}

// ============================================================
// CONTINUE PROMPT BUILDING
// ============================================================

function buildContinuePrompt() {
    var tail = lastRawTail;
    if (!tail || tail.trim().length === 0) {
        var accLines = accumulated.split('\n');
        tail = accLines.slice(-5).join('\n');
    }
    var lines = [];
    lines.push('Continue EXACTLY where you left off. Your last lines were:');
    lines.push('');
    lines.push(FENCE);
    lines.push(tail);
    lines.push(FENCE);
    lines.push('');
    lines.push('Continue from there. Do NOT repeat those lines. Just write the next code.');
    lines.push('When you are 100% completely done with the ENTIRE file, write this AFTER your code block:');
    lines.push(FINISH);
    lines.push('');
    lines.push('If you are NOT done yet, just stop. I will ask again.');
    return lines.join('\n');
}

function buildInitialPrompt(userText) {
    var lines = [];
    lines.push(userText);
    lines.push('');
    lines.push('=== RULES ===');
    lines.push('Write the complete code in a single code block.');
    lines.push('If you run out of space, just stop mid-code. I will ask you to continue.');
    lines.push('When you are 100% completely finished with the ENTIRE file, write this AFTER your code block on its own line:');
    lines.push(FINISH);
    lines.push('');
    lines.push('Do NOT write ' + FINISH + ' unless the code is truly 100% complete.');
    lines.push('=============');
    return lines.join('\n');
}

// ============================================================
// FINISH / START / STOP
// ============================================================

function finish() {
    running = false;
    clearWait();
    markDone();
    updateBtn();
    var code = accumulated.trim();

    if (!code || code.length === 0) {
        code = harvestAllCode();
        accumulated = code;
    }

    injectCodeBlock(code);

    navigator.clipboard.writeText(code).then(function() {
        status('\u2705 Done! ' + code.split('\n').length + ' lines \u2014 copied!');
    }).catch(function() {
        status('\u2705 Done! ' + code.split('\n').length + ' lines.');
    });
}

function start(prompt) {
    running = true;
    continues = 0;
    accumulated = '';
    lastRawTail = '';
    prevHadUnclosedBlock = false;
    lastTurns = getTurns();
    incrementProcessing();
    updateBtn();
    status('\u23F3 Submitting...');
    submit(buildInitialPrompt(prompt));
    setTimeout(poll, 5000);
}

function stop() {
    running = false;
    clearWait();
    updateBtn();
    status('\u23F9 Stopped. Use \uD83C\uDF3E Harvest to collect.');
}

// ============================================================
// STATUS & BUTTON UPDATE
// ============================================================

function status(msg) {
    var el = qs('#acl-status');
    if (el) el.textContent = msg;
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

function buildStyles() {
    return [
        '#acl-bar{position:fixed;bottom:0;left:0;right:0;z-index:9999999;display:flex;align-items:center;background:linear-gradient(180deg,#0d0820,#0a0814);border-top:1px solid rgba(139,92,246,.4);padding:8px 12px;gap:10px;font:13px "SF Mono",monospace;box-shadow:0 -4px 30px rgba(124,58,237,.15);}',
        '#acl-input{flex:1;background:linear-gradient(135deg,#1a1528,#150f25);color:#e2e8f0;border:1px solid rgba(139,92,246,.3);border-radius:10px;padding:12px 16px;font:inherit;resize:none;min-height:38px;max-height:150px;transition:border-color .2s,box-shadow .2s;}',
        '#acl-input:focus{outline:none;border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,.2);}',
        '#acl-btn{width:44px;height:40px;border:none;border-radius:10px;cursor:pointer;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font-size:18px;transition:all .15s;box-shadow:0 4px 15px rgba(124,58,237,.4);}',
        '#acl-btn:hover{transform:scale(1.05);box-shadow:0 6px 20px rgba(124,58,237,.5);}',
        '#acl-btn.acl-on{background:linear-gradient(135deg,#dc2626,#b91c1c);box-shadow:0 4px 15px rgba(220,38,38,.4);animation:acl-p 1.5s infinite}',
        '@keyframes acl-p{0%,100%{opacity:1}50%{opacity:.5}}',
        '#acl-harvest{height:40px;padding:0 16px;border:none;border-radius:10px;cursor:pointer;background:linear-gradient(135deg,#059669,#047857);color:#fff;font:700 13px sans-serif;transition:all .15s;box-shadow:0 4px 15px rgba(5,150,105,.3);white-space:nowrap;}',
        '#acl-harvest:hover{transform:scale(1.05);box-shadow:0 6px 20px rgba(5,150,105,.4);}',
        '#acl-harvest:active{transform:scale(.95);}',
        '#acl-status{color:#a5b4fc;font-size:11px;min-width:180px;text-shadow:0 0 10px rgba(165,180,252,.3);}',
        '#acl-counter{display:flex;align-items:center;gap:14px;padding:4px 14px;background:rgba(124,58,237,.08);border:1px solid rgba(139,92,246,.2);border-radius:10px;margin-left:auto;}',
        '#acl-counter-title{font:600 11px sans-serif;color:#c4b5fd;white-space:nowrap;letter-spacing:.3px;}',
        '.acl-counter-badge{display:flex;align-items:center;gap:4px;font:700 14px "SF Mono",monospace;}',
        '.acl-counter-badge.processing{color:#fbbf24;text-shadow:0 0 8px rgba(251,191,36,.4);}',
        '.acl-counter-badge.done{color:#34d399;text-shadow:0 0 8px rgba(52,211,153,.4);}',
        '.acl-counter-badge.total{color:#a5b4fc;text-shadow:0 0 8px rgba(165,180,252,.4);}',
        '.acl-counter-sep{width:1px;height:18px;background:rgba(139,92,246,.3);}',
        '#acl-wait{display:none;position:fixed;bottom:75px;left:50%;transform:translateX(-50%);z-index:9999999;align-items:center;gap:14px;background:linear-gradient(135deg,#0f0b1e,#1a1035);border:1px solid rgba(139,92,246,.4);border-radius:16px;padding:16px 28px;box-shadow:0 15px 50px rgba(0,0,0,.7),0 0 30px rgba(124,58,237,.15);}',
        '#acl-wait-time{font:700 34px "SF Mono",monospace;color:#c4b5fd;min-width:55px;text-align:center;text-shadow:0 0 15px rgba(196,181,253,.3);}',
        '#acl-wait-track{width:150px;height:7px;background:rgba(139,92,246,.12);border-radius:4px;overflow:hidden;}',
        '#acl-wait-bar{height:100%;width:0%;background:linear-gradient(90deg,#7c3aed,#a855f7,#c084fc);border-radius:4px;transition:width 1s linear;box-shadow:0 0 8px rgba(168,85,247,.5);}',
        '#acl-skip{padding:13px 30px;border:none;border-radius:12px;cursor:pointer;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font:700 15px sans-serif;transition:all .15s;letter-spacing:.5px;box-shadow:0 4px 20px rgba(124,58,237,.4);}',
        '#acl-skip:hover{background:linear-gradient(135deg,#6d28d9,#5b21b6);transform:scale(1.05);box-shadow:0 6px 25px rgba(124,58,237,.5);}',
        '#acl-skip:active{transform:scale(.97);}',
        '#acl-panel{display:none;flex-direction:column;position:fixed;inset:5%;z-index:99999999;background:linear-gradient(180deg,#0a0a0f,#0d0820);border:1px solid rgba(124,58,237,.5);border-radius:16px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.8),0 0 40px rgba(124,58,237,.1);}',
        '#acl-panel pre{flex:1;overflow:auto;padding:20px;margin:0;color:#e2e8f0;font:12px/1.6 "SF Mono",monospace;white-space:pre-wrap;}',
        '#acl-panel-bar{display:flex;gap:10px;padding:14px;border-top:1px solid rgba(139,92,246,.2);background:rgba(0,0,0,.3);}',
        '#acl-panel-bar button{padding:10px 20px;border:none;border-radius:10px;cursor:pointer;font:600 12px sans-serif;transition:all .15s;}',
        '#acl-panel-bar button:hover{transform:scale(1.03);}'
    ].join('\n');
}

function buildBarHTML() {
    return [
        '<textarea id="acl-input" placeholder="\u2728 Prompt eingeben... (Enter zum Starten)" rows="1"></textarea>',
        '<button id="acl-btn">\u25B6</button>',
        '<button id="acl-harvest">\uD83C\uDF3E Harvest</button>',
        '<span id="acl-status">\u2728 Ready</span>',
        '<div id="acl-counter">',
        '  <span id="acl-counter-title">\u2728 KI Auto-Coder \u2014 Bereit</span>',
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
    qs('#acl-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); toggle(); }
    });
    qs('#acl-btn').addEventListener('click', toggle);
    qs('#acl-harvest').addEventListener('click', doHarvest);
    qs('#acl-skip').addEventListener('click', doSkip);
    qs('#acl-close').addEventListener('click', function() {
        qs('#acl-panel').style.display = 'none';
    });
    qs('#acl-copy').addEventListener('click', function() {
        navigator.clipboard.writeText(accumulated.trim()).then(function() {
            status('\u2705 Copied!');
        });
    });
    qs('#acl-dl').addEventListener('click', function() {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([accumulated.trim()], {type: 'text/html'}));
        a.download = 'output.html';
        a.click();
    });
}

function initUI() {
    var s = document.createElement('style');
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
}

// ============================================================
// STARTUP
// ============================================================

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
} else {
    initUI();
}

})();
