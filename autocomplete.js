// ==UserScript==
// @name         Auto-Coder v15
// @namespace    http://tampermonkey.net/
// @version      15.0
// @description  Auto-continue with robust completion detection, IMPROVED overlap merging using Levenshtein distance matrix, harvest. FIXED: Dynamic bar height adjusts page. FIXED: Mid-run instructions. FIXED: Harvest reliability.
// @match        https://you.com/*
// @grant        none
// ==/UserScript==

(function() {
'use strict';

var BT = String.fromCharCode(96);
var FENCE = BT + BT + BT;

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

// NEW: Mid-run instruction queue
var midRunInstructions = [];

// MERGE TUNING PARAMETERS
var MERGE_SEARCH_WINDOW = 40; // How many lines from end of A to search
var MERGE_CANDIDATE_WINDOW = 15; // How many lines from start of B to consider as overlap start
var MERGE_LINE_SIMILARITY_THRESHOLD = 0.6; // Minimum similarity for a line to be considered "matching"
var MERGE_MIN_CONSECUTIVE_MATCHES = 2; // Minimum consecutive similar lines to consider an overlap
var MERGE_PREFER_NEWER = true; // When in doubt, prefer the newer (B) text

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
    if (results.length === 0) {
        var codeContainers = el.querySelectorAll('[class*="code"], [class*="Code"], [class*="highlight"]');
        for (var m = 0; m < codeContainers.length; m++) {
            var ct = codeContainers[m].textContent || '';
            if (ct.trim().length > 10) results.push(ct);
        }
    }
    return results;
}

function getLastCodeFromDOM() {
    var el = getLastAnswerTurnEl();
    if (!el) return '';
    var blocks = getCodeBlocksFromElement(el);
    if (blocks.length === 0) return '';
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

function getTextarea() {
    return qs('#search-input-textarea') ||
           qs('textarea[data-testid="search-input-textarea"]') ||
           qs('textarea[placeholder*="Ask"]') ||
           qs('textarea[placeholder*="ask"]') ||
           qs('textarea[placeholder*="How can"]');
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

function isCodeIncomplete(code) {
    if (!code || code.trim().length === 0) return false;
    var trimmed = code.trim();

    if (endsWithHtmlClose(trimmed)) return false;
    if (/\}\s*\)\s*\(\s*\)\s*;?\s*$/.test(trimmed.slice(-20))) return false;
    if (trimmed.length < MIN_CODE_LENGTH_FOR_COMPLETE && continues > 0) return true;

    var lines = trimmed.split('\n');
    var lastNonEmpty = '';
    for (var i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim().length > 0) {
            lastNonEmpty = lines[i].trim();
            break;
        }
    }

    if (hasUnclosedScript(trimmed)) return true;
    if (hasUnclosedStyle(trimmed)) return true;
    if (hasUnclosedHtml(trimmed)) return true;

    if (/<script[\s>]/i.test(trimmed) && !/<\/script>\s*$/i.test(trimmed.slice(-50)) && !endsWithHtmlClose(trimmed)) {
        if (hasUnbalancedBraces(trimmed)) return true;
    }

    return lastLineIsCutOff(trimmed) ||
           hasUnbalancedBraces(trimmed) ||
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
    var text = el.innerText || '';
    if (countFences(text) % 2 !== 0) return false;

    var lastCode = getLastCodeFromDOM();
    if (lastCode && lastCode.trim().length > MIN_CODE_LENGTH_FOR_COMPLETE) {
        if (isCodeIncomplete(lastCode.trim())) {
            return true;
        }
    }

    return true;
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
            log('Code incomplete (structural check on accumulated) - continuing. ' + accTrimmed.length + ' chars');
            setStatus('\u26A0 Code incomplete (' + accTrimmed.split('\n').length + ' lines), auto-continuing...');
            scheduleNext();
            return;
        }

        var lastCode = getLastCodeFromDOM();
        if (lastCode && lastCode.trim().length > 0) {
            var lastCodeTrimmed = lastCode.trim();
            if (isCodeIncomplete(lastCodeTrimmed)) {
                log('Last DOM code block incomplete - continuing. ' + lastCodeTrimmed.length + ' chars');
                setStatus('\u26A0 Last code block incomplete, auto-continuing...');
                scheduleNext();
                return;
            }

            if (/<!DOCTYPE/i.test(lastCodeTrimmed) && !/<\/html>/i.test(lastCodeTrimmed)) {
                log('Last DOM code has DOCTYPE but no closing </html> - continuing.');
                setStatus('\u26A0 HTML document incomplete (no </html>), auto-continuing...');
                scheduleNext();
                return;
            }

            if (countMatches(lastCodeTrimmed, /<script[\s>]/gi) > countMatches(lastCodeTrimmed, /<\/script>/gi)) {
                log('Last DOM code has unclosed <script> tag - continuing.');
                setStatus('\u26A0 Unclosed <script> detected, auto-continuing...');
                scheduleNext();
                return;
            }

            if (countMatches(lastCodeTrimmed, /<style[\s>]/gi) > countMatches(lastCodeTrimmed, /<\/style>/gi)) {
                log('Last DOM code has unclosed <style> tag - continuing.');
                setStatus('\u26A0 Unclosed <style> detected, auto-continuing...');
                scheduleNext();
                return;
            }
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

            var domTrimmed = accumulated.trim();
            if (/<!DOCTYPE/i.test(domTrimmed) && !/<\/html>/i.test(domTrimmed)) {
                log('DOM code has DOCTYPE but no closing </html> - continuing.');
                setStatus('\u26A0 HTML document incomplete (no </html>), auto-continuing...');
                scheduleNext();
                return;
            }
            if (countMatches(domTrimmed, /<script[\s>]/gi) > countMatches(domTrimmed, /<\/script>/gi)) {
                log('DOM code has unclosed <script> tag - continuing.');
                setStatus('\u26A0 Unclosed <script> detected, auto-continuing...');
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

function isDone(turnText) {
    if (typeof FINISH_MARKER !== 'undefined' && turnText.indexOf(FINISH_MARKER) !== -1) return true;
    var el = getLastAnswerTurnEl();
    if (!el) return false;
    var textSpans = el.querySelectorAll('[data-testid="youchat-text"]');
    for (var i = 0; i < textSpans.length; i++) {
        var spanText = textSpans[i].textContent || '';
        if (typeof FINISH_MARKER !== 'undefined' && spanText.indexOf(FINISH_MARKER) !== -1) return true;
    }
    return false;
}

function hasUnclosedScript(t) {
    return countMatches(t, /<script[\s>]/gi) > countMatches(t, /<\/script>/gi);
}

function hasUnclosedStyle(t) {
    return countMatches(t, /<style[\s>]/gi) > countMatches(t, /<\/style>/gi);
}

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

// ============================================================
// IMPROVED MERGE LOGIC: Levenshtein-based fuzzy line matching
// ============================================================

// Compute Levenshtein distance between two strings
function levenshteinDistance(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // Optimization: if strings are very different in length, skip full computation
    var lenDiff = Math.abs(a.length - b.length);
    var maxLen = Math.max(a.length, b.length);
    if (lenDiff > maxLen * 0.7) return maxLen;

    // Use two-row optimization for memory efficiency
    var prev = [];
    var curr = [];
    for (var j = 0; j <= b.length; j++) prev[j] = j;

    for (var i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (var jj = 1; jj <= b.length; jj++) {
            var cost = a[i - 1] === b[jj - 1] ? 0 : 1;
            curr[jj] = Math.min(
                curr[jj - 1] + 1,      // insertion
                prev[jj] + 1,           // deletion
                prev[jj - 1] + cost     // substitution
            );
        }
        var tmp = prev;
        prev = curr;
        curr = tmp;
    }
    return prev[b.length];
}

// Compute normalized similarity between two lines (0 = totally different, 1 = identical)
function lineSimilarity(lineA, lineB) {
    var a = lineA.trim();
    var b = lineB.trim();

    // Both empty = perfect match
    if (a === '' && b === '') return 1.0;
    // One empty, one not = no match
    if (a === '' || b === '') return 0.0;
    // Exact match
    if (a === b) return 1.0;

    var maxLen = Math.max(a.length, b.length);

    // Quick check: if one is a prefix/suffix of the other (truncation case)
    if (a.length >= 3 && b.indexOf(a) === 0) return a.length / b.length;
    if (b.length >= 3 && a.indexOf(b) === 0) return b.length / a.length;

    // For very long lines, compare chunks to avoid expensive full Levenshtein
    if (maxLen > 500) {
        // Compare first 200 and last 200 chars
        var prefixSim = lineSimilarity(a.substring(0, 200), b.substring(0, 200));
        var suffixSim = lineSimilarity(a.slice(-200), b.slice(-200));
        return (prefixSim + suffixSim) / 2;
    }

    var dist = levenshteinDistance(a, b);
    return 1.0 - (dist / maxLen);
}

// Build a similarity matrix between tail of A and head of B
// Returns a 2D array where matrix[i][j] = similarity(aLines[aStart+i], bLines[j])
function buildSimilarityMatrix(aLines, aStart, aEnd, bLines, bStart, bEnd) {
    var rows = aEnd - aStart;
    var cols = bEnd - bStart;
    var matrix = [];
    for (var i = 0; i < rows; i++) {
        matrix[i] = [];
        for (var j = 0; j < cols; j++) {
            matrix[i][j] = lineSimilarity(aLines[aStart + i], bLines[bStart + j]);
        }
    }
    return matrix;
}

// Find the best diagonal alignment in the similarity matrix
// A diagonal represents a consistent overlap: aLines[aStart+i] matches bLines[bStart+i+offset]
// Returns { aOffset, bOffset, length, avgSimilarity } or null
function findBestDiagonalAlignment(matrix, rows, cols) {
    var bestAlignment = null;
    var bestScore = 0;

    // Try all possible diagonal starting points
    // Diagonal offset: for each possible start in A's tail matching some start in B's head
    for (var startRow = 0; startRow < rows; startRow++) {
        for (var startCol = 0; startCol < cols; startCol++) {
            // Walk along this diagonal
            var matchCount = 0;
            var totalSim = 0;
            var consecutiveGood = 0;
            var maxConsecutive = 0;
            var diagLen = Math.min(rows - startRow, cols - startCol);

            for (var d = 0; d < diagLen; d++) {
                var sim = matrix[startRow + d][startCol + d];
                totalSim += sim;
                if (sim >= MERGE_LINE_SIMILARITY_THRESHOLD) {
                    matchCount++;
                    consecutiveGood++;
                    if (consecutiveGood > maxConsecutive) maxConsecutive = consecutiveGood;
                } else {
                    consecutiveGood = 0;
                }
            }

            if (matchCount < MERGE_MIN_CONSECUTIVE_MATCHES) continue;
            if (maxConsecutive < MERGE_MIN_CONSECUTIVE_MATCHES) continue;

            // Score: prefer longer matches with higher similarity
            // Also prefer alignments that reach the end of A (meaning B continues where A left off)
            var avgSim = totalSim / diagLen;
            var reachesEndOfA = (startRow + diagLen >= rows);
            var score = matchCount * avgSim * (reachesEndOfA ? 2.0 : 1.0) * (maxConsecutive / diagLen + 0.5);

            if (score > bestScore) {
                bestScore = score;
                bestAlignment = {
                    aOffset: startRow,
                    bOffset: startCol,
                    length: diagLen,
                    matchCount: matchCount,
                    maxConsecutive: maxConsecutive,
                    avgSimilarity: avgSim,
                    score: score,
                    reachesEndOfA: reachesEndOfA
                };
            }
        }
    }

    return bestAlignment;
}

// Determine the exact merge point given an alignment
// When lines differ slightly in the overlap region, prefer the newer (B) version
function computeMergeResult(aLines, bLines, alignment, aSearchStart) {
    var aOverlapStart = aSearchStart + alignment.aOffset;
    var bOverlapStart = alignment.bOffset;
    var overlapLen = alignment.length;

    // Take everything from A before the overlap
    var result = aLines.slice(0, aOverlapStart);

    // For the overlap region, prefer the newer (B) text when lines differ
    if (MERGE_PREFER_NEWER) {
        // Use B's version of the overlapping lines
        var bOverlapEnd = bOverlapStart + overlapLen;
        // Then append everything from B starting at the overlap start
        var bRemainder = bLines.slice(bOverlapStart);
        for (var i = 0; i < bRemainder.length; i++) {
            result.push(bRemainder[i]);
        }
    } else {
        // Use A's version of the overlap, then append B after overlap
        for (var j = aOverlapStart; j < aOverlapStart + overlapLen; j++) {
            result.push(aLines[j]);
        }
        var bAfterOverlap = bLines.slice(bOverlapStart + overlapLen);
        for (var k = 0; k < bAfterOverlap.length; k++) {
            result.push(bAfterOverlap[k]);
        }
    }

    return result.join('\n');
}

// Main fuzzy merge function using Levenshtein-based similarity matrix
function fuzzyMergeOverlap(existing, fragment) {
    if (!existing) return fragment;
    if (!fragment) return existing;
    if (fragment.trim().length < 30 && existing.trim().length > 100) return existing;

    var aLines = existing.split('\n');
    var bLines = fragment.split('\n');

    // Determine search windows
    var aSearchStart = Math.max(0, aLines.length - MERGE_SEARCH_WINDOW);
    var aSearchEnd = aLines.length;
    var bSearchStart = 0;
    var bSearchEnd = Math.min(bLines.length, MERGE_CANDIDATE_WINDOW);

    // Build similarity matrix between tail of A and head of B
    var matrix = buildSimilarityMatrix(aLines, aSearchStart, aSearchEnd, bLines, bSearchStart, bSearchEnd);

    var rows = aSearchEnd - aSearchStart;
    var cols = bSearchEnd - bSearchStart;

    // Find the best diagonal alignment
    var alignment = findBestDiagonalAlignment(matrix, rows, cols);

    if (alignment && alignment.maxConsecutive >= MERGE_MIN_CONSECUTIVE_MATCHES) {
        log('FuzzyMerge: found alignment score=' + alignment.score.toFixed(2) +
            ' avgSim=' + alignment.avgSimilarity.toFixed(3) +
            ' consecutive=' + alignment.maxConsecutive +
            ' reachesEnd=' + alignment.reachesEndOfA);
        return computeMergeResult(aLines, bLines, alignment, aSearchStart);
    }

    // No good fuzzy alignment found - fall back to simple concatenation
    // But first check for mid-line split
    if (detectMidLineSplit(aLines, bLines)) {
        var firstBIdx = 0;
        while (firstBIdx < bLines.length && bLines[firstBIdx].trim() === '') firstBIdx++;
        var joinedLine = aLines[aLines.length - 1] + bLines[firstBIdx];
        var headLines = aLines.slice(0, aLines.length - 1);
        var tailLines = bLines.slice(firstBIdx + 1);
        log('FuzzyMerge: mid-line split detected, joining');
        var res = headLines.join('\n');
        if (res.length > 0) res += '\n';
        res += joinedLine;
        if (tailLines.length > 0) res += '\n' + tailLines.join('\n');
        return res;
    }

    log('FuzzyMerge: no overlap found, concatenating');
    return existing + '\n' + fragment;
}

// Updated mergeOverlap that uses the new fuzzy approach
function mergeOverlap(existing, fragment) {
    if (!existing) return fragment;
    if (!fragment) return existing;
    if (fragment.trim().length < 30 && existing.trim().length > 100) return existing;

    var aLines = existing.split('\n');
    var bLines = fragment.split('\n');

    // First try exact overlap (fast path)
    var exact = findExactOverlap(aLines, bLines);
    if (exact >= 3) {
        log('Merge: exact overlap of ' + exact + ' lines');
        var remainder = bLines.slice(exact);
        if (remainder.length === 0) return aLines.join('\n');
        return aLines.join('\n') + '\n' + remainder.join('\n');
    }

    // Try the old truncation-aware overlap (still useful for clear truncation cases)
    var truncOverlap = findOverlapWithTruncation(aLines, bLines);
    if (truncOverlap) {
        log('Merge: truncation-aware overlap at posA=' + truncOverlap.posA + ' startB=' + truncOverlap.startB);
        var head = aLines.slice(0, truncOverlap.posA);
        var tail = bLines.slice(truncOverlap.startB);
        if (head.length === 0) return tail.join('\n');
        return head.join('\n') + '\n' + tail.join('\n');
    }

    // Try old partial overlap (exact line matching)
    var partial = findPartialOverlap(aLines, bLines);
    if (partial && partial.matchLen >= 3) {
        log('Merge: partial overlap at posA=' + partial.posA + ' startB=' + partial.startB + ' len=' + partial.matchLen);
        var headP = aLines.slice(0, partial.posA);
        var tailP = bLines.slice(partial.startB);
        if (headP.length === 0) return tailP.join('\n');
        return headP.join('\n') + '\n' + tailP.join('\n');
    }

    // Now try the fuzzy Levenshtein-based approach
    return fuzzyMergeOverlap(existing, fragment);
}

function getRawTail() {
    var code = getLastCodeFromDOM();
    var source = (code && code.trim().length > 0) ? code : accumulated;
    if (!source) return '';
    return getLastNLines(source, OVERLAP_LINES);
}

function cleanMarkers(code) {
    var patterns = [

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
    if ((!allCode || allCode.trim().length < 50) && accumulated && accumulated.trim().length > 50) {
        log('Harvest: DOM harvest insufficient, using accumulated code');
        allCode = accumulated;
    }
    if (!allCode || allCode.trim().length < 50) {
        allCode = harvestFromRawText(turns);
    }
    return allCode.trim();
}

function harvestFromRawText(turns) {
    var allText = '';
    for (var i = 0; i < turns.length; i++) {
        var text = turns[i].innerText || turns[i].textContent || '';
        allText += text + '\n';
    }
    var codeBlocks = [];
    var fenceRegex = new RegExp(FENCE + '[^\\n]*\\n([\\s\\S]*?)' + FENCE, 'g');
    var match;
    while ((match = fenceRegex.exec(allText)) !== null) {
        if (match[1] && match[1].trim().length > 20) {
            codeBlocks.push(match[1]);
        }
    }
    if (codeBlocks.length === 0) return '';
    var result = '';
    for (var k = 0; k < codeBlocks.length; k++) {
        var cleaned = cleanMarkers(codeBlocks[k]);
        if (cleaned.trim().length > 20) {
            result = mergeOverlap(result, cleaned);
        }
    }
    log('Harvest: extracted ' + codeBlocks.length + ' blocks from raw text');
    return result;
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
            var preCount = qsa('pre', getChatRoot()).length;
            var figureCount = qsa('figure[aria-label="Code Block"]', getChatRoot()).length;
            setStatus('\u26A0 No valid code found. Turns: ' + turnCount + ', pre: ' + preCount + ', code: ' + codeElCount + ', figures: ' + figureCount);
            log('Harvest failed. Turns: ' + turnCount + ', pre: ' + preCount + ', code els: ' + codeElCount + ', figures: ' + figureCount);
            log('Harvest diagnostic: accumulated length = ' + accumulated.length);
            var lastEl = getLastAnswerTurnEl();
            if (lastEl) {
                log('Harvest diagnostic: last turn text length = ' + (lastEl.textContent || '').length);
                log('Harvest diagnostic: last turn innerHTML snippet = ' + (lastEl.innerHTML || '').substring(0, 200));
            }
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
        pollTimeout = setTimeout(poll, POLL_MS);
        return;
    }

    if (isTextStillChanging()) {
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
            log('Fence count odd - code block still open, waiting...');
            stableCheckCount = 0;
            pollTimeout = setTimeout(poll, STREAM_CHECK_INTERVAL);
            return;
        }
    }

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

    if (text === lastResponseText && text.length > 0) {
        log('Same response text detected, skipping duplicate');
        pollTimeout = setTimeout(poll, POLL_MS);
        return;
    }
    lastResponseText = text;

    var newCode = getLastCodeFromDOM();

    if (!newCode || newCode.trim().length < 20) {
        log('No code found in last turn DOM');
    }

    if (newCode && newCode.trim().length > 20) {
        accumulated = mergeOverlap(accumulated, cleanMarkers(newCode));
    }

    lastRawTail = getRawTail();
    decideNextAction(text);
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

    var prompt = buildContinuePrompt();
    if (midRunInstructions.length > 0) {
        var instructions = midRunInstructions.join('\n');
        midRunInstructions = [];
        prompt = prompt + '\n\n=== ADDITIONAL INSTRUCTIONS ===\n' + instructions + '\n===============================';
        log('Appended mid-run instructions to continue prompt');
        setStatus('\u23F3 Continuing with new instructions (' + continues + '/' + MAX + ')...');
    }

    submit(prompt);
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
    for (var startB = 0; startB < Math.min(10, bLines.length); startB++) {
        if (bLines[startB].trim() === '') continue;
        for (var posA = Math.max(0, aLines.length - 50); posA < aLines.length; posA++) {
            if (aLines[posA].trim() !== bLines[startB].trim()) continue;
            var matchLen = 1;
            while (posA + matchLen < aLines.length && startB + matchLen < bLines.length &&
                   aLines[posA + matchLen].trim() === bLines[startB + matchLen].trim()) {
                matchLen++;
            }
            if (posA + matchLen >= aLines.length && matchLen >= 2) {
                return { posA: posA, startB: startB, matchLen: matchLen, truncatedTail: false };
            }
            if (posA + matchLen === aLines.length - 1 && matchLen >= 2) {
                var lastA = aLines[aLines.length - 1].trim();
                var correspondingB = (startB + matchLen < bLines.length) ? bLines[startB + matchLen].trim() : '';
                if (lastA.length > 0 && correspondingB.length > lastA.length && correspondingB.indexOf(lastA) === 0) {
                    return { posA: posA, startB: startB, matchLen: matchLen + 1, truncatedTail: true };
                }
                if (lastA.length > 0 && isLineTruncated(lastA)) {
                    return { posA: posA, startB: startB, matchLen: matchLen + 1, truncatedTail: true };
                }
            }
        }
    }
    return null;
}

function isLineTruncated(line) {
    var trimmed = line.trim();
    if (trimmed.length === 0) return false;
    var singleQuotes = countChar(trimmed, "'");
    var doubleQuotes = countChar(trimmed, '"');
    if (singleQuotes % 2 !== 0) return true;
    if (doubleQuotes % 2 !== 0) return true;
    var openParens = countChar(trimmed, '(');
    var closeParens = countChar(trimmed, ')');
    if (openParens > closeParens) return true;
    var openBrackets = countChar(trimmed, '[');
    var closeBrackets = countChar(trimmed, ']');
    if (openBrackets > closeBrackets) return true;
    if (/[+\-*\/=,({|&:\\]$/.test(trimmed)) return true;
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
    var lastA = aLines[aLines.length - 1].trim();
    var lastAIsTruncated = isLineTruncated(lastA);
    if (!lastAIsTruncated) return null;

    for (var startB = 0; startB < Math.min(10, bLines.length); startB++) {
        if (bLines[startB].trim() === '') continue;
        for (var posA = Math.max(0, aLines.length - 50); posA < aLines.length - 1; posA++) {
            if (aLines[posA].trim() !== bLines[startB].trim()) continue;
            var matchLen = 1;
            var bIdx = startB + 1;
            var aIdx = posA + 1;
            while (aIdx < aLines.length - 1 && bIdx < bLines.length &&
                   aLines[aIdx].trim() === bLines[bIdx].trim()) {
                matchLen++;
                aIdx++;
                bIdx++;
            }
            if (aIdx === aLines.length - 1 && matchLen >= 2) {
                if (bIdx < bLines.length) {
                    var bLineAtTrunc = bLines[bIdx].trim();
                    if (bLineAtTrunc.indexOf(lastA) === 0 || lastA.length === 0) {
                        return { posA: posA, startB: startB };
                    }
                    if (matchLen >= 3) {
                        return { posA: posA, startB: startB };
                    }
                }
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

function buildContinuePrompt() {
    var tail = lastRawTail || getLastNLines(accumulated, OVERLAP_LINES);
    var noFenceWarning = 'IMPORTANT: Do NOT start your response with ' + FENCE + ' or any code fence. You are continuing MID-CODE inside an already-open code block. Just write the next lines of code directly.';
    return [
        'Continue EXACTLY where you left off. You MUST repeat the last 3-4 lines from below so I can merge properly:',
        '', FENCE, tail, FENCE, '',
        noFenceWarning,
        '',
        'CRITICAL: Start by repeating at least the last 3 lines shown above, then continue with new code after them. This overlap is required for proper merging.',
        '',
        'If you are NOT done yet, just stop mid-code. I will ask you to continue.',
        "Make sure you start code blocks with 3 backticks again, so it works. And make also sure you do not write backticks inside of them to not leave the code."
    ].join('\n');
}

function buildInitialPrompt(userText) {
    return [
        userText, '',
        '=== RULES ===',
        'Write the complete code in a single code block.',
        'If you run out of space, just stop mid-code. I will ask you to continue.',
        '',
        "Make sure you start code blocks with 3 backticks again, so it works. And make also sure you do not write backticks inside of them to not leave the code.",
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
    midRunInstructions = [];
    markDone();
    updateBtn();
    var code = accumulated.trim();

    if (!code || code.length === 0) {
        code = harvestAllCode();
        accumulated = code;
    }

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
    midRunInstructions = [];
    lastTurns = getTurnCount();
    lastSeenTextLength = 0;
    stableCheckCount = 0;
    lastResponseText = '';
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

function toggle() {
    if (running) return stop();
    var input = qs('#acl-input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    start(text);
}

function handleMidRunInput() {
    var input = qs('#acl-input');
    var text = input.value.trim();
    if (!text) return;
    if (!running) {
        input.value = '';
        start(text);
        return;
    }
    midRunInstructions.push(text);
    input.value = '';
    setStatus('\uD83D\uDCDD Instruction queued (' + midRunInstructions.length + ' pending): "' + text.substring(0, 40) + (text.length > 40 ? '...' : '') + '"');
    log('Mid-run instruction queued: ' + text.substring(0, 80));
    playTone(660, 0, 0.1);
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
        '#acl-input.has-queued{border-color:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.2);}',
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
        '<textarea id="acl-input" placeholder="\u2728 Enter prompt... (Enter to start/queue instruction, Shift+Enter for newline)" rows="1"></textarea>',
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

function updateInputVisual() {
    var input = qs('#acl-input');
    if (!input) return;
    if (midRunInstructions.length > 0) {
        input.classList.add('has-queued');
        input.placeholder = '\uD83D\uDCDD ' + midRunInstructions.length + ' instruction(s) queued. Type more or wait...';
    } else if (running) {
        input.classList.remove('has-queued');
        input.placeholder = '\uD83D\uDCDD Running... type here + Enter to queue instructions for next continue';
    } else {
        input.classList.remove('has-queued');
        input.placeholder = '\u2728 Enter prompt... (Enter to start, Shift+Enter for newline)';
    }
}

function attachEventListeners() {
    var input = qs('#acl-input');
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleMidRunInput();
        }
    });
    input.addEventListener('input', function() {
        this.style.height = 'auto';
        var newH = Math.min(this.scrollHeight, 300);
        this.style.height = newH + 'px';
        updateBodyPadding();
    });
    qs('#acl-btn').addEventListener('click', function() {
        if (running) return stop();
        var input = qs('#acl-input');
        var text = input.value.trim();
        if (!text) return;
        input.value = '';
        start(text);
    });
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

setInterval(function() {
    if (!qs('#acl-bar') && document.body) initUI();
    updateBodyPadding();
    updateInputVisual();
}, 3000);

setInterval(function() {
    if (!running) return;
    isTextStillChanging();
}, STREAM_CHECK_INTERVAL);

// ============================================================
// TEST SUITE - COMPREHENSIVE MERGE TESTS
// ============================================================

function createTestReport(results) {
    var passed = 0, failed = 0, errors = [];
    for (var i = 0; i < results.length; i++) {
        if (results[i].pass) passed++;
        else { failed++; errors.push(results[i]); }
    }
    console.log('\n%c' + Array(44).join('='), 'color:#7c3aed;font-weight:bold');
    console.log('%c  AUTO-CODER v15 TEST RESULTS', 'color:#c4b5fd;font-weight:bold;font-size:14px');
    console.log('%c' + Array(44).join('='), 'color:#7c3aed;font-weight:bold');
    console.log('%c  Passed: ' + passed, 'color:#34d399;font-weight:bold');
    console.log('%c  Failed: ' + failed, 'color:#f87171;font-weight:bold');
    console.log('%c  Total:  ' + results.length, 'color:#a5b4fc');
    console.log('%c' + Array(44).join('='), 'color:#7c3aed;font-weight:bold');
    if (errors.length > 0) {
        console.log('\n%cFailed Tests:', 'color:#f87171;font-weight:bold');
        for (var j = 0; j < errors.length; j++) {
            console.log('%c  X ' + errors[j].name + ': ' + errors[j].msg, 'color:#fca5a5');
            if (errors[j].expected) console.log('    Expected: ' + errors[j].expected.replace(/\n/g, '|'));
            if (errors[j].got) console.log('    Got:      ' + errors[j].got.replace(/\n/g, '|'));
        }
    }
    return { passed: passed, failed: failed, total: results.length, errors: errors };
}

function assert(results, name, condition, msg) {
    results.push({ name: name, pass: !!condition, msg: msg || (condition ? 'OK' : 'FAILED') });
    if (!condition) console.warn('  X ' + name + ': ' + (msg || 'FAILED'));
    else console.log('  V ' + name);
}

function assertMerge(results, name, a, b, expected) {
    var got = mergeOverlap(a, b);
    var pass = got === expected;
    results.push({
        name: name,
        pass: pass,
        msg: pass ? 'OK' : 'Mismatch',
        expected: expected,
        got: got
    });
    if (!pass) {
        console.warn('  X ' + name);
        console.warn('    A: ' + (a || '').replace(/\n/g, '|'));
        console.warn('    B: ' + (b || '').replace(/\n/g, '|'));
        console.warn('    Expected: ' + expected.replace(/\n/g, '|'));
        console.warn('    Got:      ' + got.replace(/\n/g, '|'));
    } else {
        console.log('  V ' + name);
    }
}

window.test_auto_continue = function() {
    var results = [];
    console.log('\n%cRunning Auto-Coder v15 Test Suite...', 'color:#a855f7;font-weight:bold;font-size:13px');

    // ============================================================
    // BASIC INFRASTRUCTURE TESTS
    // ============================================================
    console.log('\n%c--- Infrastructure Tests ---', 'color:#60a5fa;font-weight:bold');

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

    assert(results, 'UI bar exists', qs('#acl-bar') !== null, '');
    assert(results, 'UI input exists', qs('#acl-input') !== null, '');
    assert(results, 'UI btn exists', qs('#acl-btn') !== null, '');
    assert(results, 'UI harvest exists', qs('#acl-harvest') !== null, '');
    assert(results, 'UI status exists', qs('#acl-status') !== null, '');
    assert(results, 'UI wait exists', qs('#acl-wait') !== null, '');

    assert(results, 'countFences works', countFences(FENCE + 'js\ncode\n' + FENCE) === 2, '');
    assert(results, 'harvestFromRawText function exists', typeof harvestFromRawText === 'function', '');
    assert(results, 'fuzzyMergeOverlap function exists', typeof fuzzyMergeOverlap === 'function', '');
    assert(results, 'levenshteinDistance function exists', typeof levenshteinDistance === 'function', '');
    assert(results, 'lineSimilarity function exists', typeof lineSimilarity === 'function', '');

    // ============================================================
    // LEVENSHTEIN DISTANCE TESTS
    // ============================================================
    console.log('\n%c--- Levenshtein Distance Tests ---', 'color:#60a5fa;font-weight:bold');

    assert(results, 'levenshtein: identical strings', levenshteinDistance('hello', 'hello') === 0, '');
    assert(results, 'levenshtein: one char diff', levenshteinDistance('hello', 'hallo') === 1, 'Got: ' + levenshteinDistance('hello', 'hallo'));
    assert(results, 'levenshtein: insertion', levenshteinDistance('hello', 'helloo') === 1, 'Got: ' + levenshteinDistance('hello', 'helloo'));
    assert(results, 'levenshtein: deletion', levenshteinDistance('hello', 'helo') === 1, 'Got: ' + levenshteinDistance('hello', 'helo'));
    assert(results, 'levenshtein: empty vs string', levenshteinDistance('', 'abc') === 3, 'Got: ' + levenshteinDistance('', 'abc'));
    assert(results, 'levenshtein: both empty', levenshteinDistance('', '') === 0, '');

    // ============================================================
    // LINE SIMILARITY TESTS
    // ============================================================
    console.log('\n%c--- Line Similarity Tests ---', 'color:#60a5fa;font-weight:bold');

    assert(results, 'lineSimilarity: identical', lineSimilarity('function foo() {', 'function foo() {') === 1.0, '');
    assert(results, 'lineSimilarity: both empty', lineSimilarity('', '') === 1.0, '');
    assert(results, 'lineSimilarity: one empty', lineSimilarity('hello', '') === 0.0, '');

    var sim1 = lineSimilarity('  var x = 42;', '  var x = 43;');
    assert(results, 'lineSimilarity: one char diff high sim', sim1 > 0.9, 'Got: ' + sim1.toFixed(3));

    var sim2 = lineSimilarity('function handleClick(event) {', 'function handleClck(event) {');
    assert(results, 'lineSimilarity: typo still high sim', sim2 > 0.9, 'Got: ' + sim2.toFixed(3));

    var sim3 = lineSimilarity('completely different line', 'nothing in common here at all xyz');
    assert(results, 'lineSimilarity: totally different low sim', sim3 < 0.4, 'Got: ' + sim3.toFixed(3));

    var sim4 = lineSimilarity('  return result;', '  return result;  ');
    assert(results, 'lineSimilarity: trailing space ignored (trim)', sim4 === 1.0, 'Got: ' + sim4.toFixed(3));

    // ============================================================
    // MERGE OVERLAP TESTS - 10 COMPREHENSIVE USE CASES
    // ============================================================
    console.log('\n%c--- Merge Overlap Tests (10 Use Cases) ---', 'color:#60a5fa;font-weight:bold');

    // TEST 1: Perfect exact overlap (easy case)
    console.log('%c  Test 1: Perfect exact overlap', 'color:#94a3b8');
    assertMerge(results, 'Merge #1: perfect exact overlap',
        'line1\nline2\nline3\nline4\nline5',
        'line4\nline5\nline6\nline7',
        'line1\nline2\nline3\nline4\nline5\nline6\nline7'
    );

    // TEST 2: No overlap at all (concatenation)
    console.log('%c  Test 2: No overlap - concatenation', 'color:#94a3b8');
    assertMerge(results, 'Merge #2: no overlap concatenation',
        'alpha\nbeta\ngamma',
        'delta\nepsilon\nzeta',
        'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta'
    );

    // TEST 3: Identical texts (full dedup)
    console.log('%c  Test 3: Identical texts', 'color:#94a3b8');
    assertMerge(results, 'Merge #3: identical dedup',
        'foo\nbar\nbaz',
        'foo\nbar\nbaz',
        'foo\nbar\nbaz'
    );

    // TEST 4: One character typo in overlap region (fuzzy match)
    console.log('%c  Test 4: Typo in overlap (fuzzy)', 'color:#94a3b8');
    var test4a = 'function init() {\n  var x = 1;\n  var y = 2;\n  console.log(x);\n  console.log(y);';
    var test4b = '  var y = 2;\n  console.log(x);\n  console.log(y);\n  return x + y;\n}';
    var test4expected = 'function init() {\n  var x = 1;\n  var y = 2;\n  console.log(x);\n  console.log(y);\n  return x + y;\n}';
    assertMerge(results, 'Merge #4: exact overlap in code',
        test4a, test4b, test4expected
    );

    // TEST 5: Typo in overlap - one character different (fuzzy should handle)
    console.log('%c  Test 5: Typo in overlap line (fuzzy)', 'color:#94a3b8');
    var test5a = 'function render() {\n  var canvas = getCanvas();\n  var ctx = canvas.getContext("2d");\n  ctx.clearRect(0, 0, 800, 600);\n  ctx.fillStyle = "#ff0';
    var test5b = '  var ctx = canvas.getContext("2d");\n  ctx.clearRect(0, 0, 800, 600);\n  ctx.fillStyle = "#ff0000";\n  ctx.fillRect(10, 10, 50, 50);\n}';
    var test5result = mergeOverlap(test5a, test5b);
    // The result should contain the beginning of A and the end of B, without duplication
    var test5pass = test5result.indexOf('function render()') === 0 &&
                    test5result.indexOf('ctx.fillRect(10, 10, 50, 50)') !== -1 &&
                    test5result.indexOf('}') !== -1 &&
                    // Should not have duplicate "ctx.clearRect" lines
                    (test5result.match(/ctx\.clearRect/g) || []).length === 1;
    results.push({
        name: 'Merge #5: typo/truncation in overlap',
        pass: test5pass,
        msg: test5pass ? 'OK' : 'Merge did not handle truncated overlap correctly',
        expected: '(contains render, fillRect, single clearRect)',
        got: test5result.replace(/\n/g, '|')
    });
    if (!test5pass) console.warn('  X Merge #5: ' + test5result.replace(/\n/g, '|'));
    else console.log('  V Merge #5');

    // TEST 6: Overlap with extra whitespace differences
    console.log('%c  Test 6: Whitespace differences in overlap', 'color:#94a3b8');
    var test6a = 'line1\n  line2\n    line3\n      line4';
    var test6b = '  line2\n    line3\n      line4\n        line5\n          line6';
    var test6expected = 'line1\n  line2\n    line3\n      line4\n        line5\n          line6';
    assertMerge(results, 'Merge #6: whitespace preserved overlap',
        test6a, test6b, test6expected
    );

    // TEST 7: Overlap where B starts with blank lines before the overlap
    console.log('%c  Test 7: B starts with blank lines', 'color:#94a3b8');
    var test7a = 'alpha\nbeta\ngamma\ndelta';
    var test7b = '\n\ngamma\ndelta\nepsilon\nzeta';
    var test7expected = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta';
    assertMerge(results, 'Merge #7: B has leading blank lines',
        test7a, test7b, test7expected
    );

    // TEST 8: Large overlap (many lines match)
    console.log('%c  Test 8: Large overlap (8 lines)', 'color:#94a3b8');
    var test8a = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10';
    var test8b = 'line3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12';
    var test8expected = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12';
    assertMerge(results, 'Merge #8: large 8-line overlap',
        test8a, test8b, test8expected
    );

    // TEST 9: Mid-line truncation (A's last line is cut off, B has the full version)
    console.log('%c  Test 9: Mid-line truncation', 'color:#94a3b8');
    var test9a = 'function foo() {\n  var result = computeSomething(\n    param1, param2, par';
    var test9b = '  var result = computeSomething(\n    param1, param2, param3\n  );\n  return result;\n}';
    var test9result = mergeOverlap(test9a, test9b);
    var test9pass = test9result.indexOf('function foo()') === 0 &&
                    test9result.indexOf('param3') !== -1 &&
                    test9result.indexOf('return result;') !== -1 &&
                    (test9result.match(/computeSomething/g) || []).length === 1;
    results.push({
        name: 'Merge #9: mid-line truncation',
        pass: test9pass,
        msg: test9pass ? 'OK' : 'Mid-line truncation not handled',
        expected: '(contains foo, param3, return, single computeSomething)',
        got: test9result.replace(/\n/g, '|')
    });
    if (!test9pass) console.warn('  X Merge #9: ' + test9result.replace(/\n/g, '|'));
    else console.log('  V Merge #9');

    // TEST 10: B is a subset of A (should not duplicate)
    console.log('%c  Test 10: B is subset of A', 'color:#94a3b8');
    var test10a = 'line1\nline2\nline3\nline4\nline5';
    var test10b = 'line3\nline4\nline5';
    var test10expected = 'line1\nline2\nline3\nline4\nline5';
    assertMerge(results, 'Merge #10: B is subset of A (no growth)',
        test10a, test10b, test10expected
    );

    // TEST 11: Fuzzy overlap with multiple small differences
    console.log('%c  Test 11: Multiple small diffs in overlap (fuzzy)', 'color:#94a3b8');
    var test11a = [
        'function processData(items) {',
        '  var results = [];',
        '  for (var i = 0; i < items.length; i++) {',
        '    var item = items[i];',
        '    results.push(transform(item));'
    ].join('\n');
    var test11b = [
        '  for (var i = 0; i < items.length; i++) {',
        '    var item = items[i];',
        '    results.push(transform(item));',
        '  }',
        '  return results;',
        '}'
    ].join('\n');
    var test11result = mergeOverlap(test11a, test11b);
    var test11pass = test11result.indexOf('function processData') === 0 &&
                     test11result.indexOf('return results;') !== -1 &&
                     (test11result.match(/for \(var i/g) || []).length === 1;
    results.push({
        name: 'Merge #11: multi-line overlap with exact match',
        pass: test11pass,
        msg: test11pass ? 'OK' : 'Multi-line overlap failed',
        expected: '(single for loop, has return results)',
        got: test11result.replace(/\n/g, '|')
    });
    if (!test11pass) console.warn('  X Merge #11: ' + test11result.replace(/\n/g, '|'));
    else console.log('  V Merge #11');

    // TEST 12: Empty existing, non-empty fragment
    console.log('%c  Test 12: Empty existing', 'color:#94a3b8');
    assertMerge(results, 'Merge #12: empty existing returns fragment',
        '', 'new code here\nline2', 'new code here\nline2'
    );

    // TEST 13: Non-empty existing, empty fragment
    console.log('%c  Test 13: Empty fragment', 'color:#94a3b8');
    assertMerge(results, 'Merge #13: empty fragment returns existing',
        'existing code\nline2', '', 'existing code\nline2'
    );

    // ============================================================
    // FUZZY MERGE SPECIFIC TESTS
    // ============================================================
    console.log('\n%c--- Fuzzy Merge Specific Tests ---', 'color:#60a5fa;font-weight:bold');

    // Test fuzzyMergeOverlap directly with lines that have typos
    var fuzzy1a = [
        'function calculate() {',
        '  var sum = 0;',
        '  for (var i = 0; i < 10; i++) {',
        '    sum += i * 2;',
        '    console.log(sum);'
    ].join('\n');
    var fuzzy1b = [
        '  for (var i = 0; i < 10; i++) {',
        '    sum += i * 2;',
        '    consol.log(sum);',  // typo: consol instead of console
        '  }',
        '  return sum;',
        '}'
    ].join('\n');
    var fuzzy1result = fuzzyMergeOverlap(fuzzy1a, fuzzy1b);
    var fuzzy1pass = fuzzy1result.indexOf('function calculate()') === 0 &&
                     fuzzy1result.indexOf('return sum;') !== -1 &&
                     (fuzzy1result.match(/for \(var i/g) || []).length === 1;
    results.push({
        name: 'FuzzyMerge: typo in overlap line (consol vs console)',
        pass: fuzzy1pass,
        msg: fuzzy1pass ? 'OK' : 'Fuzzy merge failed with typo',
        expected: '(single for loop, has return sum)',
        got: fuzzy1result.replace(/\n/g, '|')
    });
    if (!fuzzy1pass) console.warn('  X FuzzyMerge typo: ' + fuzzy1result.replace(/\n/g, '|'));
    else console.log('  V FuzzyMerge typo');

    // Test similarity matrix building
    var matrixTestA = ['line1', 'line2', 'line3'];
    var matrixTestB = ['line2', 'line3', 'line4'];
    var testMatrix = buildSimilarityMatrix(matrixTestA, 0, 3, matrixTestB, 0, 3);
    assert(results, 'buildSimilarityMatrix dimensions correct',
        testMatrix.length === 3 && testMatrix[0].length === 3,
        'Got ' + testMatrix.length + 'x' + (testMatrix[0] ? testMatrix[0].length : 0));
    assert(results, 'buildSimilarityMatrix diagonal match',
        testMatrix[1][0] === 1.0 && testMatrix[2][1] === 1.0,
        'line2-line2=' + testMatrix[1][0] + ' line3-line3=' + testMatrix[2][1]);

    // Test findBestDiagonalAlignment
    var alignMatrix = buildSimilarityMatrix(
        ['a', 'b', 'c', 'd', 'e'], 2, 5,  // tail: c, d, e
        ['c', 'd', 'e', 'f', 'g'], 0, 5    // head: c, d, e, f, g
    );
    var alignment = findBestDiagonalAlignment(alignMatrix, 3, 5);
    assert(results, 'findBestDiagonalAlignment finds correct offset',
        alignment !== null && alignment.aOffset === 0 && alignment.bOffset === 0,
        alignment ? 'aOff=' + alignment.aOffset + ' bOff=' + alignment.bOffset : 'null');

    // ============================================================
    // CODE COMPLETENESS TESTS
    // ============================================================
    console.log('\n%c--- Code Completeness Tests ---', 'color:#60a5fa;font-weight:bold');

    assert(results, 'isCodeIncomplete: unclosed HTML', isCodeIncomplete('<!DOCTYPE html><html><body>') === true, '');
    assert(results, 'isCodeIncomplete: closed HTML', isCodeIncomplete('<!DOCTYPE html><html><body></body></html>') === false, '');
    assert(results, 'isCodeIncomplete: unclosed brace', isCodeIncomplete('function foo() {\n  var x = 1;\n  if (x) {\n    return x;') === true, '');
    assert(results, 'isCodeIncomplete: balanced braces', isCodeIncomplete('function foo() {\n  return 1;\n}') === false, '');
    assert(results, 'isCodeIncomplete: unclosed script', isCodeIncomplete('<!DOCTYPE html><html><body><script>\nvar x = 1;') === true, '');
    assert(results, 'isCodeIncomplete: IIFE complete', isCodeIncomplete('(function() {\n  var x = 1;\n})();') === false, '');

    // ============================================================
    // FINAL REPORT
    // ============================================================
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
            doneCount: doneCount,
            midRunInstructions: midRunInstructions.slice()
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
    testFuzzyMerge: fuzzyMergeOverlap,
    testLevenshtein: levenshteinDistance,
    testLineSimilarity: lineSimilarity,
    testBuildMatrix: buildSimilarityMatrix,
    testFindAlignment: findBestDiagonalAlignment,
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
    },
    getMidRunInstructions: function() { return midRunInstructions.slice(); },
    clearMidRunInstructions: function() { midRunInstructions = []; updateInputVisual(); }
};

log('Auto-Coder v15 loaded. Run test_auto_continue() in console to test. Use acl_debug for debugging.');

})();
