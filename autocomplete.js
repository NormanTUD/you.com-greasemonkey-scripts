// ==UserScript==
// @name         Auto-Coder v13.6
// @namespace    http://tampermonkey.net/
// @version      13.6
// @description  Auto-continue with robust completion detection, overlap merging, harvest. FIXED: Continue prompt warns about backticks. FIXED: Merged output only shows at end.
// @match        https://you.com/*
// @grant        none
// ==/UserScript==

(function() {
'use strict';

var BT = String.fromCharCode(96);
var FENCE = BT + BT + BT;
var FINISH_MARKER = 'AUTOCODER_FINISHED';
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

var dockedRight = false;
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
var showMergedOutput = false;
var OVERLAP_LINES = 8;

var UNCLOSED_FENCE_MAX_WAITS = 8;
var unclosedFenceWaitCount = 0;

function log(msg) {
    var entry = '[AutoCoder ' + new Date().toISOString().slice(11,19) + '] ' + msg;
    console.log(entry);
    debugLog.push(entry);
    if (debugLog.length > 300) debugLog.shift();
}

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

function isGenerating() {
    var root = getChatRoot();
    var steps = qsa('[data-testid^="step-"]', root);
    for (var i = 0; i < steps.length; i++) {
        if (steps[i].getAttribute('data-finished') === 'false') return true;
    }
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

function getCodeBlocksFromElement(el) {
    if (!el) return [];
    var results = [];
    var figures = el.querySelectorAll('figure[aria-label="Code Block"]');
    for (var i = 0; i < figures.length; i++) {
        var codeEl = figures[i].querySelector('pre > code') || figures[i].querySelector('pre');
        if (codeEl) {
            var text = codeEl.textContent || '';
            if (text.trim().length > 10) results.push(text);
        }
    }
    if (results.length === 0) {
        var codeEls = el.querySelectorAll('pre code');
        for (var j = 0; j < codeEls.length; j++) {
            var t = codeEls[j].textContent || '';
            if (t.trim().length > 10) results.push(t);
        }
    }
    if (results.length === 0) {
        var pres = el.querySelectorAll('pre');
        for (var k = 0; k < pres.length; k++) {
            var pt = pres[k].textContent || '';
            if (pt.trim().length > 10) results.push(pt);
        }
    }
    return results;
}

function stripLeadingFenceArtifacts(code) {
    if (!code) return code;
    var lines = code.split('\n');
    // Check if first line is just a language identifier (no actual code)
    if (lines.length > 1) {
        var firstLine = lines[0].trim().toLowerCase();
        var langIds = ['javascript', 'js', 'html', 'css', 'python', 'py', 'typescript', 'ts',
                       'json', 'xml', 'sql', 'bash', 'sh', 'text', 'plaintext', 'plain',
                       'jsx', 'tsx', 'php', 'ruby', 'java', 'c', 'cpp', 'csharp', 'go',
                       'rust', 'swift', 'kotlin', 'dart', 'lua', 'perl', 'r', 'scala'];
        if (langIds.indexOf(firstLine) !== -1) {
            lines.shift();
        }
    }
    return lines.join('\n');
}

function getMergedCodeFromTurn(el) {
    if (!el) return '';
    var blocks = getCodeBlocksFromElement(el);
    if (blocks.length === 0) return '';
    if (blocks.length === 1) return blocks[0];

    // Multiple blocks in same turn = Claude used fences despite instructions
    // Merge them sequentially
    var merged = blocks[0];
    for (var i = 1; i < blocks.length; i++) {
        var cleaned = stripLeadingFenceArtifacts(blocks[i]);
        merged = mergeOverlap(merged, cleaned);
    }
    return merged;
}

function getLastCodeFromDOM() {
    var el = getLastAnswerTurnEl();
    if (!el) return '';
    // USE NEW MERGED FUNCTION instead of just getting longest block
    return getMergedCodeFromTurn(el);
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

function isDone(turnText) {
    if (turnText.indexOf(FINISH_MARKER) !== -1) return true;
    var el = getLastAnswerTurnEl();
    if (!el) return false;
    var textSpans = el.querySelectorAll('[data-testid="youchat-text"]');
    for (var i = 0; i < textSpans.length; i++) {
        if ((textSpans[i].textContent || '').indexOf(FINISH_MARKER) !== -1) return true;
    }
    return false;
}

function getTextarea() {
    return qs('#search-input-textarea') ||
           qs('textarea[data-testid="search-input-textarea"]') ||
           qs('textarea[placeholder*="Ask"]') ||
           qs('textarea[placeholder*="ask"]');
}

function setNativeValue(ta, text) {
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
        if (!btn) {
            var allBtns = form.querySelectorAll('button');
            if (allBtns.length > 0) btn = allBtns[allBtns.length - 1];
        }
        if (btn) {
            btn.disabled = false;
            btn.removeAttribute('disabled');
            btn.click();
            log('Clicked send button');
            return true;
        }
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
    setTimeout(function() { clickSend(ta); }, 400);
    return true;
}

function getLastNLines(text, n) {
    if (!text) return '';
    var lines = text.split('\n');
    var result = [];
    for (var i = lines.length - 1; i >= 0 && result.length < n; i--) {
        result.unshift(lines[i]);
    }
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

function endsWithHtmlClose(trimmed) {
    return /<\/html>\s*$/i.test(trimmed.slice(-30));
}

function lastLineIsCutOff(trimmed) {
    var lines = trimmed.split('\n');
    var lastLine = lines[lines.length - 1].trim();
    if (lastLine.length === 0) return false;
    if (/[+\-*\/=,({|&:\\]$/.test(lastLine)) return true;
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
    if (trimmed.indexOf(FINISH_MARKER) !== -1) return false;
    if (endsWithHtmlClose(trimmed)) return false;
    if (/\}\s*\)\s*\(\s*\)\s*;?\s*$/.test(trimmed.slice(-20))) return false;
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

function isResponseFullySettled() {
    if (isGenerating()) return false;
    var el = getLastAnswerTurnEl();
    if (!el) return false;
    if (isTextStillChanging()) return false;
    if (stableCheckCount < STREAM_STABLE_CHECKS) return false;
    // NOTE: We no longer block on odd fence count here.
    // An odd fence count with a fully stopped response means the AI
    // stopped mid-code-block (truncated). We handle this in poll().
    return true;
}


function getRawTail() {
    var el = getLastAnswerTurnEl();
    var code = el ? getMergedCodeFromTurn(el) : '';
    var source = (code && code.trim().length > 0) ? code : accumulated;
    if (!source) return '';
    return getLastNLines(source, OVERLAP_LINES);
}

function cleanMarkers(code) {
    var patterns = [
        /^.*AUTOCODER_FINISHED.*$/gm,
        /^.*>>>FINISHED<<<.*$/gm
    ];
    var cleaned = code;
    for (var i = 0; i < patterns.length; i++) {
        cleaned = cleaned.replace(patterns[i], '');
    }
    // Also strip any backtick fence lines that leaked through
    cleaned = stripBacktickFences(cleaned);
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
        // Use getMergedCodeFromTurn to handle split blocks within a turn
        var turnCode = getMergedCodeFromTurn(turns[i]);
        if (turnCode) {
            var cleaned = cleanMarkers(turnCode);
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
    showMergedOutput = true;
    injectCodeBlock(code);
    copyToClipboard(code, function() {
        setStatus('\uD83C\uDF3E ' + code.split('\n').length + ' lines harvested & copied!');
        playSuccessSound();
    }, function() {
        setStatus('\uD83C\uDF3E ' + code.split('\n').length + ' lines harvested (clipboard failed).');
    });
}

function copyToClipboard(text, onSuccess, onFail) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(onSuccess || function(){}).catch(onFail || function(){});
    } else if (onFail) { onFail(); }
}

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
            if (showMergedOutput) {
                injectCodeBlock(code);
            }
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
    if (!root) return;
    autoHarvestObserver = new MutationObserver(onAutoHarvestMutation);
    autoHarvestObserver.observe(root, { childList: true, subtree: true });
    log('Auto-harvest observer started on ' + (root.id ? '#' + root.id : root.tagName));
}

function injectCodeBlock(code) {
    if (!showMergedOutput) return;
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

    if (isGenerating()) {
        stableCheckCount = 0;
        lastSeenTextLength = 0;
        unclosedFenceWaitCount = 0;
        pollTimeout = setTimeout(poll, POLL_MS);
        return;
    }

    if (isTextStillChanging()) {
        unclosedFenceWaitCount = 0;
        pollTimeout = setTimeout(poll, STREAM_CHECK_INTERVAL);
        return;
    }

    if (stableCheckCount < STREAM_STABLE_CHECKS) {
        pollTimeout = setTimeout(poll, STREAM_CHECK_INTERVAL);
        return;
    }

    var t = getTurnCount();
    if (t <= lastTurns) {
        pollTimeout = setTimeout(poll, POLL_MS);
        return;
    }

    var el = getLastAnswerTurnEl();
    if (el) {
        var text = el.innerText || '';
        if (countFences(text) % 2 !== 0) {
            unclosedFenceWaitCount++;
            if (unclosedFenceWaitCount < UNCLOSED_FENCE_MAX_WAITS) {
                log('Fence count odd - code block appears open, wait ' + unclosedFenceWaitCount + '/' + UNCLOSED_FENCE_MAX_WAITS);
                stableCheckCount = 0;
                pollTimeout = setTimeout(poll, STREAM_CHECK_INTERVAL);
                return;
            }
            log('Fence count odd but response stopped after ' + unclosedFenceWaitCount + ' checks - treating as truncated');
            unclosedFenceWaitCount = 0;
        }
    }

    unclosedFenceWaitCount = 0;
    lastTurns = t;

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

    if (isGenerating()) {
        isProcessingResponse = false;
        pollTimeout = setTimeout(poll, POLL_MS);
        return;
    }

    if (isTextStillChanging()) {
        isProcessingResponse = false;
        stableCheckCount = 0;
        pollTimeout = setTimeout(poll, STREAM_CHECK_INTERVAL);
        return;
    }

    // NOTE: Removed the fence-count re-check here. If poll() already
    // determined the response is done (possibly truncated mid-block),
    // we should proceed to handle it, not loop back.

    handleResponse();
    isProcessingResponse = false;
}

function handleResponse() {
    if (!running) return;
    var text = getLastTurnText();

    if (text === lastResponseText && text.length > 0) {
        log('Same response text detected, skipping duplicate');
        pollTimeout = setTimeout(poll, POLL_MS);
        return;
    }
    lastResponseText = text;

    // USE getMergedCodeFromTurn instead of getLastCodeFromDOM for consistency
    var el = getLastAnswerTurnEl();
    var newCode = getMergedCodeFromTurn(el);

    if (!newCode || newCode.trim().length < 20) {
        log('No code found in last turn DOM (or too short)');
    }

    if (newCode && newCode.trim().length > 20) {
        var cleanedNew = cleanMarkers(newCode);
        // Also strip any backtick fences that might have leaked into the text content
        cleanedNew = stripBacktickFences(cleanedNew);
        accumulated = mergeOverlap(accumulated, cleanedNew);
    }

    lastRawTail = getRawTail();
    decideNextAction(text);
}

function stripBacktickFences(code) {
    if (!code) return code;
    var lines = code.split('\n');
    var filtered = [];
    for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].trim();
        // Skip lines that are ONLY a fence (``` optionally followed by a language)
        if (/^`{3,}\s*\w*\s*$/.test(trimmed)) { // `
            continue;
        }
        filtered.push(lines[i]);
    }
    return filtered.join('\n');
}

function decideNextAction(text) {
    if (isDone(text)) {
        log('FINISHED marker detected - completing.');
        finish();
        return;
    }

    if (continues >= MAX) {
        log('Max continues reached (' + MAX + ') - completing.');
        finish();
        return;
    }

    var accTrimmed = accumulated.trim();

    if (accTrimmed.length > 0) {
        if (isCodeIncomplete(accTrimmed)) {
            log('Code incomplete (structural check) - continuing. ' + accTrimmed.length + ' chars');
            setStatus('\u26A0 Code incomplete (' + accTrimmed.split('\n').length + ' lines), auto-continuing...');
            scheduleNext();
            return;
        }

        var lastCode = getLastCodeFromDOM();
        if (lastCode && isCodeIncomplete(lastCode)) {
            log('Last DOM code block incomplete - continuing.');
            setStatus('\u26A0 Last code block incomplete, auto-continuing...');
            scheduleNext();
            return;
        }

        log('Code appears complete. ' + accTrimmed.split('\n').length + ' lines.');
        finish();
    } else {
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
    stableCheckCount = 0;
    lastSeenTextLength = 0;
    lastResponseText = '';
    isProcessingResponse = false;

    setStatus('\u23F3 Continuing (' + continues + '/' + MAX + ')...');
    submit(buildContinuePrompt());
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
// FIX: Continue prompt warns AI not to start with triple backticks
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
    // Look for a sequence of lines in B that matches a sequence at the END of A
    // Key insight: the overlap might start BEFORE a truncated last line in A
    for (var startB = 0; startB < Math.min(10, bLines.length); startB++) {
        if (bLines[startB].trim() === '') continue;
        for (var posA = Math.max(0, aLines.length - 50); posA < aLines.length; posA++) {
            if (aLines[posA].trim() !== bLines[startB].trim()) continue;
            var matchLen = 1;
            while (posA + matchLen < aLines.length && startB + matchLen < bLines.length &&
                   aLines[posA + matchLen].trim() === bLines[startB + matchLen].trim()) {
                matchLen++;
            }
            // Case 1: match reaches the end of A exactly
            if (posA + matchLen >= aLines.length && matchLen >= 2) {
                return { posA: posA, startB: startB, matchLen: matchLen, truncatedTail: false };
            }
            // Case 2: match reaches aLines.length - 1 (all but last line matched)
            // AND the last line of A looks truncated (it's a partial line that doesn't match)
            // This handles the case where the last line of A is a cut-off version of a line in B
            if (posA + matchLen === aLines.length - 1 && matchLen >= 2) {
                var lastA = aLines[aLines.length - 1].trim();
                var correspondingB = (startB + matchLen < bLines.length) ? bLines[startB + matchLen].trim() : '';
                // Check if lastA is a prefix/truncation of the corresponding B line
                if (lastA.length > 0 && correspondingB.length > lastA.length && correspondingB.indexOf(lastA) === 0) {
                    return { posA: posA, startB: startB, matchLen: matchLen + 1, truncatedTail: true };
                }
                // Also check if lastA is just a truncated line (unmatched quotes, unclosed parens, etc.)
                if (lastA.length > 0 && isLineTruncated(lastA)) {
                    return { posA: posA, startB: startB, matchLen: matchLen + 1, truncatedTail: true };
                }
            }
        }
    }
    return null;
}

function isLineTruncated(line) {
    // Check if a line appears to be cut off mid-way
    var trimmed = line.trim();
    if (trimmed.length === 0) return false;
    // Unbalanced quotes
    var singleQuotes = countChar(trimmed, "'");
    var doubleQuotes = countChar(trimmed, '"');
    if (singleQuotes % 2 !== 0) return true;
    if (doubleQuotes % 2 !== 0) return true;
    // Unbalanced parentheses
    var openParens = countChar(trimmed, '(');
    var closeParens = countChar(trimmed, ')');
    if (openParens > closeParens) return true;
    // Unbalanced brackets
    var openBrackets = countChar(trimmed, '[');
    var closeBrackets = countChar(trimmed, ']');
    if (openBrackets > closeBrackets) return true;
    // Ends with operators or incomplete tokens
    if (/[+\-*\/=,({|&:\\]$/.test(trimmed)) return true;
    // Ends mid-word (no terminator)
    if (/[a-zA-Z]$/.test(trimmed) && !/;$/.test(trimmed) && !/\*\/$/.test(trimmed)) {
        // Could be truncated mid-word, but this is less certain
        // Only flag if it also has unbalanced quotes or parens above
        return false;
    }
    return false;
}

function fixTruncatedTail(aLines, bLines) {
    if (aLines.length === 0 || bLines.length === 0) return false;
    var lastA = aLines[aLines.length - 1].trim();
    if (lastA.length === 0) return false;
    var firstBIdx = 0;
    while (firstBIdx < bLines.length && bLines[firstBIdx].trim() === '') firstBIdx++;
    if (firstBIdx >= bLines.length) return false;
    var firstB = bLines[firstBIdx].trim();
    // Case: first line of B is the complete version of the truncated last line of A
    if (firstB.length > lastA.length && firstB.indexOf(lastA) === 0) {
        aLines.pop();
        return true;
    }
    if (lastA.length >= 3 && firstB.length > lastA.length) {
        var lastANoTrail = lastA.replace(/\s+$/, '');
        var firstBStart = firstB.substring(0, lastANoTrail.length);
        if (firstBStart === lastANoTrail) {
            aLines.pop();
            return true;
        }
    }
    return false;
}

function findOverlapWithTruncation(aLines, bLines) {
    // This is the KEY new function that handles the specific failure case:
    // A ends with a truncated line, and B starts with context that overlaps
    // lines BEFORE the truncated line in A.
    //
    // Example:
    // A: [..., "ctx.fillStyle = '#ce93d8';", "ctx.font = '14px Segoe UI';", ... , "ctx.fillText('In set theory, {true, false} != {0, 1} even though they are"]
    // B: ["ctx.fillStyle = '#ce93d8';", "ctx.font = '14px Segoe UI';", ..., "ctx.fillText('In set theory, {true, false} != {0, 1} even though they are isomorphic', width / 2, height - 35);", ...]
    //
    // We need to find where B's lines match a sequence in A (possibly ending before A's last line),
    // and if A's last line is a truncated prefix of the next line in B after the matched region.

    var lastA = aLines[aLines.length - 1].trim();
    var lastAIsTruncated = isLineTruncated(lastA);

    if (!lastAIsTruncated) return null;

    // Try to find where B's opening lines match a sequence in A that ends just before the truncated last line
    for (var startB = 0; startB < Math.min(10, bLines.length); startB++) {
        if (bLines[startB].trim() === '') continue;
        // Search backwards from the second-to-last line of A
        for (var posA = Math.max(0, aLines.length - 50); posA < aLines.length - 1; posA++) {
            if (aLines[posA].trim() !== bLines[startB].trim()) continue;
            // Count how many consecutive lines match
            var matchLen = 1;
            var bIdx = startB + 1;
            var aIdx = posA + 1;
            while (aIdx < aLines.length - 1 && bIdx < bLines.length &&
                   aLines[aIdx].trim() === bLines[bIdx].trim()) {
                matchLen++;
                aIdx++;
                bIdx++;
            }
            // Now aIdx should be at aLines.length - 1 (the truncated line)
            // Check if the truncated last line of A is a prefix of bLines[bIdx]
            if (aIdx === aLines.length - 1 && matchLen >= 2) {
                if (bIdx < bLines.length) {
                    var bLineAtTrunc = bLines[bIdx].trim();
                    if (bLineAtTrunc.indexOf(lastA) === 0 || lastA.length === 0) {
                        // Perfect: the truncated line is a prefix of the B line
                        // Return: keep A up to posA (exclusive), take B from startB onward
                        return { posA: posA, startB: startB };
                    }
                    // Even if it's not a perfect prefix match, if the last line is clearly truncated
                    // and we have a good match sequence, trust the overlap
                    if (matchLen >= 3) {
                        return { posA: posA, startB: startB };
                    }
                }
                // If bIdx >= bLines.length, the entire B is within A (minus truncated tail)
                // This shouldn't normally happen but handle it
                if (bIdx >= bLines.length && matchLen >= 2) {
                    return { posA: posA, startB: startB };
                }
            }
        }
    }
    return null;
}

function detectMidLineSplit(aLines, bLines) {
    if (aLines.length === 0 || bLines.length === 0) return false;
    var lastA = aLines[aLines.length - 1];
    var firstBIdx = 0;
    while (firstBIdx < bLines.length && bLines[firstBIdx].trim() === '') firstBIdx++;
    if (firstBIdx >= bLines.length) return false;
    var firstB = bLines[firstBIdx].trim();
    var lastATrimmed = lastA.trimEnd();
    if (lastATrimmed.length === 0) return false;
    var lastAEndsClean = /[;{})\]>\/\*]$/.test(lastATrimmed) ||
                         /^\s*\/\//.test(lastATrimmed) ||
                         /^\s*\*/.test(lastATrimmed) ||
                         /^\s*$/.test(lastATrimmed);
    if (lastAEndsClean) return false;
    var firstBStartsClean = /^\s*[{}()\[\]<\/]/.test(firstB) ||
                            /^\s*(var|let|const|function|if|else|for|while|return|case|break|default|switch|class|import|export)\b/.test(firstB) ||
                            /^\s*\/[\/\*]/.test(firstB) ||
                            /^\s*[.]\w/.test(firstB);
    if (firstBStartsClean) return false;
    return true;
}

function mergeOverlap(existing, fragment) {
    if (!existing) return fragment;
    if (!fragment) return existing;
    if (fragment.trim().length < 30 && existing.trim().length > 100) return existing;

    // NEW: Strip any fence artifacts from fragment before merging
    fragment = stripBacktickFences(fragment);
    fragment = stripLeadingFenceArtifacts(fragment);

    var aLines = existing.split('\n');
    var bLines = fragment.split('\n');

    // NEW Step -1: Check if fragment is entirely contained within existing (subset check)
    // This happens when Claude repeats a large chunk after a fence break
    if (bLines.length > 5 && bLines.length < aLines.length) {
        var isSubset = isFragmentSubsetOfExisting(aLines, bLines);
        if (isSubset) {
            log('Merge: fragment is a subset of existing, skipping');
            return existing;
        }
    }

    // Step 0: Try the truncation-aware overlap detection FIRST
    var truncOverlap = findOverlapWithTruncation(aLines, bLines);
    if (truncOverlap) {
        log('Merge: truncation-aware overlap at posA=' + truncOverlap.posA + ' startB=' + truncOverlap.startB);
        var head = aLines.slice(0, truncOverlap.posA);
        var tail = bLines.slice(truncOverlap.startB);
        if (head.length === 0) return tail.join('\n');
        return head.join('\n') + '\n' + tail.join('\n');
    }

    // Step 1: Try fixTruncatedTail
    fixTruncatedTail(aLines, bLines);

    // Step 2: Try exact overlap
    var exact = findExactOverlap(aLines, bLines);
    if (exact > 0) {
        log('Merge: exact overlap of ' + exact + ' lines');
        var remainder = bLines.slice(exact);
        if (remainder.length === 0) return aLines.join('\n');
        return aLines.join('\n') + '\n' + remainder.join('\n');
    }

    // Step 3: Try partial overlap
    var partial = findPartialOverlap(aLines, bLines);
    if (partial) {
        log('Merge: partial overlap at posA=' + partial.posA + ' startB=' + partial.startB + ' truncated=' + partial.truncatedTail);
        var headP = aLines.slice(0, partial.posA);
        var tailP = bLines.slice(partial.startB);
        if (headP.length === 0) return tailP.join('\n');
        return headP.join('\n') + '\n' + tailP.join('\n');
    }

    // NEW Step 3.5: Try large-window overlap for cases where Claude repeats many lines
    var largeOverlap = findLargeContextOverlap(aLines, bLines);
    if (largeOverlap) {
        log('Merge: large context overlap found, skipB=' + largeOverlap.skipB);
        var newContent = bLines.slice(largeOverlap.skipB);
        if (newContent.length === 0) return aLines.join('\n');
        return aLines.join('\n') + '\n' + newContent.join('\n');
    }

    // Step 4: Mid-line split
    if (detectMidLineSplit(aLines, bLines)) {
        var firstBIdx = 0;
        while (firstBIdx < bLines.length && bLines[firstBIdx].trim() === '') firstBIdx++;
        var joinedLine = aLines[aLines.length - 1] + bLines[firstBIdx];
        var headLines = aLines.slice(0, aLines.length - 1);
        var tailLines = bLines.slice(firstBIdx + 1);
        log('Merge: mid-line split detected');
        var result = headLines.join('\n');
        if (result.length > 0) result += '\n';
        result += joinedLine;
        if (tailLines.length > 0) result += '\n' + tailLines.join('\n');
        return result;
    }

    // Step 5: No overlap found, concatenate
    log('Merge: no overlap found, concatenating');
    return aLines.join('\n') + '\n' + bLines.join('\n');
}

function isFragmentSubsetOfExisting(aLines, bLines) {
    // Check if the first 5 non-empty lines of B all exist in A in sequence
    var bStart = 0;
    while (bStart < bLines.length && bLines[bStart].trim() === '') bStart++;

    var checkLines = [];
    for (var i = bStart; i < bLines.length && checkLines.length < 5; i++) {
        if (bLines[i].trim().length > 0) checkLines.push(bLines[i].trim());
    }

    if (checkLines.length < 3) return false;

    // Find first checkLine in A
    for (var posA = 0; posA < aLines.length; posA++) {
        if (aLines[posA].trim() !== checkLines[0]) continue;
        // Check if subsequent lines also match
        var allMatch = true;
        for (var k = 1; k < checkLines.length; k++) {
            var aIdx = posA + k;
            // Skip empty lines in A
            while (aIdx < aLines.length && aLines[aIdx].trim() === '') aIdx++;
            if (aIdx >= aLines.length || aLines[aIdx].trim() !== checkLines[k]) {
                allMatch = false;
                break;
            }
        }
        if (allMatch) {
            // Now check if ALL of B is within A (not just the first 5 lines)
            // Check last few lines of B
            var bEnd = bLines.length - 1;
            while (bEnd > 0 && bLines[bEnd].trim() === '') bEnd--;
            var lastBLine = bLines[bEnd].trim();
            if (lastBLine.length > 0) {
                for (var searchA = posA; searchA < aLines.length; searchA++) {
                    if (aLines[searchA].trim() === lastBLine) return true;
                }
            }
            // If we matched the start but not the end, it's not a full subset
            // but it IS an overlap - return false and let normal overlap handle it
            return false;
        }
    }
    return false;
}

function findLargeContextOverlap(aLines, bLines) {
    // Look for the first non-empty line of B somewhere in the last 60 lines of A
    var bStart = 0;
    while (bStart < bLines.length && bLines[bStart].trim() === '') bStart++;
    if (bStart >= bLines.length) return null;

    var searchStart = Math.max(0, aLines.length - 60);
    var firstBTrimmed = bLines[bStart].trim();
    if (firstBTrimmed.length < 5) return null; // Too short to be reliable

    for (var posA = searchStart; posA < aLines.length; posA++) {
        if (aLines[posA].trim() !== firstBTrimmed) continue;

        // Count consecutive matching lines
        var matchCount = 1;
        var aIdx = posA + 1;
        var bIdx = bStart + 1;
        while (aIdx < aLines.length && bIdx < bLines.length) {
            if (aLines[aIdx].trim() === bLines[bIdx].trim()) {
                matchCount++;
                aIdx++;
                bIdx++;
            } else if (bLines[bIdx].trim() === '') {
                bIdx++; // Skip empty lines in B
            } else if (aLines[aIdx].trim() === '') {
                aIdx++; // Skip empty lines in A
            } else {
                break;
            }
        }

        // If we matched at least 5 lines and reached the end of A's content
        // (or close to it), this is a large context overlap
        if (matchCount >= 5) {
            // bIdx now points to where new content starts in B
            // But only if we consumed most of the remaining A
            var aRemaining = aLines.length - aIdx;
            if (aRemaining <= 2 || aIdx >= aLines.length - 1) {
                return { skipB: bIdx };
            }
            // If we matched a lot but didn't reach end of A,
            // it might be a partial overlap in the middle - still useful
            if (matchCount >= 10) {
                return { skipB: bIdx };
            }
        }
    }
    return null;
}



// ============================================================
// PROMPT BUILDING - COMPLETELY REDESIGNED
// The key insight: remove ALL backtick characters from the prompt itself,
// use a different delimiter for the overlap context, and restructure
// instructions to be short, positive, and front-loaded.
// ============================================================

function buildContinuePrompt() {
	var tail = lastRawTail || getLastNLines(accumulated, OVERLAP_LINES);
	// Use a delimiter that won't prime Claude to output backticks
	var DELIM = '```';
	var DELIM_END = '```';
	return [
		'Here is where the code left off:',
		DELIM,
		tail,
		DELIM_END,
		'',
		'IMPORTANT RULES:',
		'- Start by repeating the last 4-6 lines shown above exactly as they are (for alignment), then continue with new code.',
		'- When the ENTIRE file is complete, write AUTOCODER_FINISHED on its own line at the very end.',
	].join('\n');
}

function buildInitialPrompt(userText) {
	return [
		userText, '',
		'- When 100% finished with the ENTIRE file, close the code blocks and write AUTOCODER_FINISHED on its own line.',
		'- Do NOT write AUTOCODER_FINISHED unless truly 100% complete.',
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

    // Final cleanup pass - strip any remaining fence artifacts
    code = stripBacktickFences(code);
    code = cleanMarkers(code);
    accumulated = code;

    showMergedOutput = true;
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
    showMergedOutput = false;
    lastTurns = getTurnCount();
    lastSeenTextLength = 0;
    stableCheckCount = 0;
    lastResponseText = '';
    unclosedFenceWaitCount = 0;
    isProcessingResponse = false;
    if (responseHandleTimeout) { clearTimeout(responseHandleTimeout); responseHandleTimeout = null; }
    if (pollTimeout) { clearTimeout(pollTimeout); pollTimeout = null; }

    var oldBlock = document.getElementById('acl-injected-block');
    if (oldBlock) oldBlock.remove();

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

function toggleDockRight() {
    var bar = qs('#acl-bar');
    if (!bar) return;
    dockedRight = !dockedRight;
    if (dockedRight) {
        bar.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:auto;z-index:9999999;display:flex;flex-direction:column;align-items:stretch;background:linear-gradient(90deg,#0d0820,#0a0814);border-left:1px solid rgba(139,92,246,.4);padding:8px 12px;gap:10px;font:13px "SF Mono",monospace;box-shadow:-4px 0 30px rgba(124,58,237,.15);width:320px;overflow-y:auto;';
        document.body.style.paddingBottom = '';
        document.body.style.paddingRight = '330px';
        qs('#acl-move').textContent = '\u2B07';
        qs('#acl-move').title = 'Move to bottom';
    } else {
        bar.style.cssText = '';
        document.body.style.paddingRight = '';
        updateBodyPadding();
        qs('#acl-move').textContent = '\u2B95';
        qs('#acl-move').title = 'Move to right side';
    }
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
        'body{padding-bottom:' + (barHeight + 10) + 'px !important;transition:padding-bottom .2s;}',
	'#acl-move{width:44px;height:40px;border:none;border-radius:10px;cursor:pointer;background:linear-gradient(135deg,#4f46e5,#4338ca);color:#fff;font-size:18px;transition:all .15s;box-shadow:0 4px 15px rgba(79,70,229,.4);flex-shrink:0;}',
	'#acl-move:hover{transform:scale(1.05);}',

    ].join('\n');
}

function buildBarHTML() {
    return [
        '<button id="acl-move" title="Move to right side">\u2B95</button>',
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

	qs('#acl-move').addEventListener('click', toggleDockRight);
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

setInterval(function() {
    if (!qs('#acl-bar') && document.body) initUI();
    updateBodyPadding();
}, 3000);

setInterval(function() {
    if (!running) return;
    isTextStillChanging();
}, STREAM_CHECK_INTERVAL);

// ============================================================
// TEST SUITE
// ============================================================

function createTestReport(results) {
    var passed = 0, failed = 0, errors = [];
    for (var i = 0; i < results.length; i++) {
        if (results[i].pass) passed++;
        else { failed++; errors.push(results[i]); }
    }
    console.log('\n%c' + Array(44).join('='), 'color:#7c3aed;font-weight:bold');
    console.log('%c  AUTO-CODER v13.1 TEST RESULTS', 'color:#c4b5fd;font-weight:bold;font-size:14px');
    console.log('%c' + Array(44).join('='), 'color:#7c3aed;font-weight:bold');
    console.log('%c  Passed: ' + passed, 'color:#34d399;font-weight:bold');
    console.log('%c  Failed: ' + failed, 'color:#f87171;font-weight:bold');
    console.log('%c  Total:  ' + results.length, 'color:#a5b4fc');
    console.log('%c' + Array(44).join('='), 'color:#7c3aed;font-weight:bold');
    if (errors.length > 0) {
        console.log('\n%cFailed Tests:', 'color:#f87171;font-weight:bold');
        for (var j = 0; j < errors.length; j++) {
            console.log('%c  X ' + errors[j].name + ': ' + errors[j].msg, 'color:#fca5a5');
        }
    }
    return { passed: passed, failed: failed, total: results.length, errors: errors };
}

function assert(results, name, condition, msg) {
    results.push({ name: name, pass: !!condition, msg: msg || (condition ? 'OK' : 'FAILED') });
    if (!condition) console.warn('  X ' + name + ': ' + (msg || 'FAILED'));
    else console.log('  V ' + name);
}

window.test_auto_continue = function() {
    var results = [];
    console.log('\n%cRunning Auto-Coder v13.1 Test Suite...', 'color:#a855f7;font-weight:bold;font-size:13px');

    var chatRoot = getChatRoot();
    assert(results, 'getChatRoot finds element', chatRoot !== null, chatRoot ? (chatRoot.id || chatRoot.tagName) : 'null');

    var answerTurns = getAnswerTurns();
    assert(results, 'getAnswerTurns returns NodeList', answerTurns.length >= 0, 'Found ' + answerTurns.length);

    var turnCount = getTurnCount();
    assert(results, 'getTurnCount returns number', typeof turnCount === 'number', 'Count: ' + turnCount);

    var gen = isGenerating();
    assert(results, 'isGenerating returns boolean', typeof gen === 'boolean', 'Value: ' + gen);

    var ta = getTextarea();
    assert(results, 'getTextarea finds textarea', ta !== null, ta ? ta.id : 'NOT FOUND');

    var m1 = mergeOverlap('a\nb\nc\nd\ne', 'd\ne\nf\ng');
    assert(results, 'mergeOverlap exact overlap', m1 === 'a\nb\nc\nd\ne\nf\ng', m1.replace(/\n/g, '|'));

    var m2 = mergeOverlap('x\ny\nz', 'a\nb\nc');
    assert(results, 'mergeOverlap no overlap concat', m2 === 'x\ny\nz\na\nb\nc', m2.replace(/\n/g, '|'));

    var m3 = mergeOverlap('a\nb\nc', 'a\nb\nc');
    assert(results, 'mergeOverlap identical dedup', m3 === 'a\nb\nc', m3.replace(/\n/g, '|'));

    assert(results, 'isCodeIncomplete unclosed HTML', isCodeIncomplete('<!DOCTYPE html><html><body>') === true, '');
    assert(results, 'isCodeIncomplete closed HTML', isCodeIncomplete('<!DOCTYPE html><html></html>') === false, '');
    assert(results, 'isCodeIncomplete with FINISH_MARKER', isCodeIncomplete('code\nAUTOCODER_FINISHED') === false, '');

    var initPrompt = buildInitialPrompt('test prompt');
    assert(results, 'buildInitialPrompt has user text', initPrompt.indexOf('test prompt') !== -1, '');
    assert(results, 'buildInitialPrompt has rules', initPrompt.indexOf('=== RULES ===') !== -1, '');

    var savedAcc = accumulated;
    var savedTail = lastRawTail;
    accumulated = 'line1\nline2\nline3\nline4\nline5';
    lastRawTail = 'line3\nline4\nline5';
    var contPrompt = buildContinuePrompt();
    assert(results, 'buildContinuePrompt has tail', contPrompt.indexOf('line5') !== -1, '');
    assert(results, 'buildContinuePrompt warns about fences', contPrompt.indexOf('Do NOT start') !== -1, '');
    assert(results, 'buildContinuePrompt has FENCE', contPrompt.indexOf(FENCE) !== -1, '');
    accumulated = savedAcc;
    lastRawTail = savedTail;

    assert(results, 'showMergedOutput flag exists', typeof showMergedOutput === 'boolean', 'Value: ' + showMergedOutput);

    assert(results, 'UI bar exists', qs('#acl-bar') !== null, '');
    assert(results, 'UI input exists', qs('#acl-input') !== null, '');
    assert(results, 'UI btn exists', qs('#acl-btn') !== null, '');
    assert(results, 'UI harvest exists', qs('#acl-harvest') !== null, '');
    assert(results, 'UI status exists', qs('#acl-status') !== null, '');
    assert(results, 'UI wait exists', qs('#acl-wait') !== null, '');

    assert(results, 'cleanMarkers removes markers',
        cleanMarkers('code\nAUTOCODER_FINISHED\nmore').indexOf('AUTOCODER_FINISHED') === -1, '');

    assert(results, 'countFences works', countFences(FENCE + 'js\ncode\n' + FENCE) === 2, '');

    return createTestReport(results);
};

window.acl_debug = {
    getState: function() {
        return {
            running: running, continues: continues,
            accumulated_length: accumulated.length,
            accumulated_lines: accumulated ? accumulated.split('\n').length : 0,
            lastTurns: lastTurns, turnCount: getTurnCount(),
            isGenerating: isGenerating(), stableCheckCount: stableCheckCount,
            showMergedOutput: showMergedOutput,
            lastSeenTextLength: lastSeenTextLength,
            isProcessingResponse: isProcessingResponse,
            totalGenerations: totalGenerations,
            processingCount: processingCount,
            doneCount: doneCount
        };
    },
    getLog: function() { return debugLog.slice(); },
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

log('Auto-Coder v13.1 loaded. Run test_auto_continue() in console to test. Use acl_debug for debugging.');

toggleDockRight();

})();
