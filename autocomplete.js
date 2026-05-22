// ==UserScript==
// @name         Auto-Coder v10
// @namespace    http://tampermonkey.net/
// @version      10.1
// @description  Auto-continue: detects incomplete code even without markers. Smart merge, harvest, skip timer.
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

var running = false, continues = 0, lastTurns = 0;
var accumulated = '', lastRawTail = '', prevHadUnclosedBlock = false;
var waitTimer = null, waitRemaining = 0;

var totalGenerations = 0;
var processingCount = 0;
var doneCount = 0;

var $ = function(s) { return document.querySelector(s); };
var $$ = function(s) { return document.querySelectorAll(s); };
var getTurns = function() { return $$('[data-testid^="youchat-answer-turn-"]').length; };
var isGen = function() { return $$('[data-testid^="step-"][data-finished="false"]').length > 0; };

// ============================================================
// COUNTER & TITLE
// ============================================================

function updateTitle() {
    var title = '';
    if (totalGenerations === 0) {
        title = '\u2728 KI Auto-Coder \u2014 Bereit';
    } else if (totalGenerations < 3) {
        title = '\u26A1 Auto-Coder \u2014 ' + totalGenerations + ' generiert';
    } else if (totalGenerations < 7) {
        title = '\uD83D\uDD25 Auto-Coder \u2014 ' + totalGenerations + ' generiert!';
    } else if (totalGenerations < 12) {
        title = '\uD83D\uDE80 Auto-Coder \u2014 ' + totalGenerations + ' generiert!!';
    } else {
        title = '\uD83C\uDF1F BEAST MODE \u2014 ' + totalGenerations + ' Generierungen!';
    }
    document.title = title;
    var titleEl = $('#acl-counter-title');
    if (titleEl) titleEl.textContent = title;
}

function updateCounter() {
    var procEl = $('#acl-count-processing');
    var doneEl = $('#acl-count-done');
    var totalEl = $('#acl-count-total');
    if (procEl) procEl.textContent = processingCount;
    if (doneEl) doneEl.textContent = doneCount;
    if (totalEl) totalEl.textContent = totalGenerations;
    updateTitle();
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
// WEB AUDIO API SOUNDS
// ============================================================

var audioCtx = null;
function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
}

function playTone(freq, startTime, duration) {
    var ctx = getAudioCtx();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);
    gain.gain.setValueAtTime(0.3, startTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration);
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
// DOM HELPERS
// ============================================================

function lastTurnEl() {
    var all = $$('[data-testid^="youchat-answer-turn-"]');
    if (!all.length) return null;
    return all[all.length - 1];
}

function allTurnEls() {
    return $$('[data-testid^="youchat-answer-turn-"]');
}

function lastText() {
    var el = lastTurnEl();
    return el ? el.innerText : '';
}

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

function lastCodeFromDOM() {
    return getCodeFromTurnEl(lastTurnEl());
}

function submit(text) {
    var ta = $('#search-input-textarea');
    if (!ta) return;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(function() {
        var form = ta.closest('form');
        var btn = form && form.querySelector('button[type="submit"],[data-testid="search-input-send-button"]');
        if (btn) { btn.disabled = false; btn.click(); }
    }, 300);
}

function unesc(code) {
    return code.replace(/!!!!!BACKTICK!!!!!/g, BT);
}

// ============================================================
// CODE COMPLETENESS DETECTION
// ============================================================

function isCodeIncomplete(code) {
    if (!code || code.trim().length === 0) return false;

    var trimmed = code.trim();
    var lines = trimmed.split('\n');
    var lastLine = lines[lines.length - 1].trim();

    // If it ends with </html>, it's done
    if (/^<\/html>$/i.test(lastLine)) return false;
    if (/<\/html>\s*$/i.test(trimmed.slice(-30))) return false;

    // If the last line is clearly cut off mid-expression
    if (/[+\-*\/=,({;|&:]$/.test(lastLine)) return true;
    if (/\($/.test(lastLine)) return true;

    // Check second-to-last non-empty line if last is empty
    if (/^\s*$/.test(lastLine) && lines.length > 5) {
        for (var i = lines.length - 2; i >= 0; i--) {
            var l = lines[i].trim();
            if (l.length > 0) {
                if (/[+\-*\/=,({;|&:]$/.test(l)) return true;
                break;
            }
        }
    }

    // Check structural completeness
    var hasDoctype = /<!DOCTYPE/i.test(trimmed);
    var hasHtmlClose = /<\/html>/i.test(trimmed);
    if (hasDoctype && !hasHtmlClose) return true;

    // Check for unbalanced braces
    var openBraces = (trimmed.match(/\{/g) || []).length;
    var closeBraces = (trimmed.match(/\}/g) || []).length;
    if (openBraces - closeBraces > 2) return true;

    // Check script tags
    var scriptOpens = (trimmed.match(/<script/gi) || []).length;
    var scriptCloses = (trimmed.match(/<\/script>/gi) || []).length;
    if (scriptOpens > scriptCloses) return true;

    // Check style tags
    var styleOpens = (trimmed.match(/<style/gi) || []).length;
    var styleCloses = (trimmed.match(/<\/style>/gi) || []).length;
    if (styleOpens > styleCloses) return true;

    return false;
}

// ============================================================
// IMPROVED MERGE
// ============================================================

function mergeOverlap(existing, fragment) {
    if (!existing) return fragment;
    if (!fragment) return existing;

    var aL = existing.split('\n');
    var bL = fragment.split('\n');

    // Step 1: Check if last line of A is truncated version of first line of B
    var lastLineA = aL[aL.length - 1];
    var lastLineTrimA = lastLineA.trim();

    if (lastLineTrimA.length > 0 && bL.length > 0) {
        var firstBIdx = 0;
        while (firstBIdx < bL.length && bL[firstBIdx].trim() === '') firstBIdx++;

        if (firstBIdx < bL.length) {
            var firstLineB = bL[firstBIdx].trim();
            if (firstLineB.length > lastLineTrimA.length && firstLineB.indexOf(lastLineTrimA) === 0) {
                aL.pop();
                existing = aL.join('\n');
            }
        }
    }

    // Step 2: Standard overlap detection
    aL = existing.split('\n');
    var maxCheck = Math.min(aL.length, bL.length, 30);
    var best = 0;

    for (var n = 1; n <= maxCheck; n++) {
        var match = true;
        for (var k = 0; k < n; k++) {
            if (aL[aL.length - n + k].trim() !== bL[k].trim()) {
                match = false;
                break;
            }
        }
        if (match) best = n;
    }

    if (best > 0) {
        return existing + '\n' + bL.slice(best).join('\n');
    }

    // Step 3: Partial overlap search
    for (var startB = 0; startB < Math.min(5, bL.length); startB++) {
        if (bL[startB].trim() === '') continue;
        for (var posA = Math.max(0, aL.length - 30); posA < aL.length; posA++) {
            if (aL[posA].trim() === bL[startB].trim()) {
                var matchLen = 1;
                while (posA + matchLen < aL.length && startB + matchLen < bL.length &&
                       aL[posA + matchLen].trim() === bL[startB + matchLen].trim()) {
                    matchLen++;
                }
                if (posA + matchLen >= aL.length && matchLen >= 2) {
                    return aL.slice(0, posA).join('\n') + '\n' + bL.slice(startB).join('\n');
                }
            }
        }
    }

    return existing + '\n' + fragment;
}

function getRawTail() {
    var code = lastCodeFromDOM();
    if (!code || code.trim().length === 0) {
        if (accumulated) {
            var accLines = accumulated.split('\n');
            return accLines.slice(-5).join('\n');
        }
        return '';
    }
    var lines = code.split('\n');
    var meaningful = [];
    for (var i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim().length > 0 || meaningful.length > 0) {
            meaningful.unshift(lines[i]);
        }
        if (meaningful.length >= 5) break;
    }
    return meaningful.join('\n');
}

// ============================================================
// MARKER DETECTION & CODE EXTRACTION
// ============================================================

function isDone(text) {
    if (text.indexOf(FINISH) !== -1) return true;
    if (text.indexOf('AUTOCODER_FINISHED') !== -1) return true;
    var lastEl = lastTurnEl();
    if (lastEl) {
        var spans = lastEl.querySelectorAll('[data-testid="youchat-text"]');
        for (var i = 0; i < spans.length; i++) {
            var t = spans[i].textContent || '';
            if (t.indexOf('AUTOCODER_FINISHED') !== -1) return true;
        }
    }
    return false;
}

function extractCode(text) {
    var result = '';
    var idx = 0;
    var foundAny = false;

    var startMarkers = [CODE_START, 'CODEBLOCK_STARTS!!!!!'];
    var endMarkers = [CODE_END, 'CODEBLOCK_ENDS!!!!!'];

    while (true) {
        var si = -1;
        var usedStartLen = 0;
        for (var s = 0; s < startMarkers.length; s++) {
            var found = text.indexOf(startMarkers[s], idx);
            if (found !== -1 && (si === -1 || found < si)) {
                si = found;
                usedStartLen = startMarkers[s].length;
            }
        }
        if (si === -1) break;
        foundAny = true;

        var ei = -1;
        var usedEndLen = 0;
        for (var e = 0; e < endMarkers.length; e++) {
            var foundEnd = text.indexOf(endMarkers[e], si + usedStartLen);
            if (foundEnd !== -1 && (ei === -1 || foundEnd < ei)) {
                ei = foundEnd;
                usedEndLen = endMarkers[e].length;
            }
        }

        var raw;
        if (ei === -1) {
            raw = text.substring(si + usedStartLen);
            prevHadUnclosedBlock = true;
        } else {
            raw = text.substring(si + usedStartLen, ei);
            prevHadUnclosedBlock = false;
        }
        var code = stripFence(raw);
        if (code) result += (result ? '\n' : '') + code;
        if (ei === -1) break;
        idx = ei + usedEndLen;
    }

    // Fallback: no markers found - grab code from DOM directly
    if (!foundAny) {
        var domCode = lastCodeFromDOM();
        if (domCode && domCode.trim().length > 20) {
            result = domCode;
            foundAny = true;
            if (isCodeIncomplete(domCode)) {
                prevHadUnclosedBlock = true;
            }
        }
    }

    return unesc(result);
}

function stripFence(block) {
    var lines = block.split('\n');
    var inFence = false, out = [];
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (!inFence && l.trim().indexOf(FENCE) === 0) { inFence = true; continue; }
        if (inFence && l.trim() === FENCE) { inFence = false; continue; }
        if (inFence) out.push(l);
    }
    if (out.length === 0) {
        var start = 0;
        if (lines.length > 0 && /^\s*$/.test(lines[0])) start = 1;
        var end = lines.length;
        if (end > 0 && /^\s*$/.test(lines[end - 1])) end--;
        return lines.slice(start, end).join('\n');
    }
    return out.join('\n');
}

// ============================================================
// INLINE CODE BLOCK INJECTION
// ============================================================

function injectCodeBlock(code) {
    var lastTurn = lastTurnEl();
    if (!lastTurn) return;

    var blockId = 'acl-injected-block';
    var old = document.getElementById(blockId);

    if (old) {
        var oldCode = old.querySelector('code');
        var oldHeader = old.querySelector('.acl-header-text');
        if (oldCode) oldCode.textContent = code;
        if (oldHeader) oldHeader.textContent = '\u2714 MERGED OUTPUT (' + code.split('\n').length + ' lines)';
        return;
    }

    var wrapper = document.createElement('div');
    wrapper.id = blockId;
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
        var currentCode = wrapper.querySelector('code').textContent;
        navigator.clipboard.writeText(currentCode).then(function() {
            copyBtn.textContent = 'Copied!';
            setTimeout(function() { copyBtn.textContent = 'Copy All'; }, 2000);
        });
    });

    var dlBtn = document.createElement('button');
    dlBtn.textContent = 'Download .html';
    dlBtn.style.cssText = 'padding:4px 12px;border:none;border-radius:6px;background:#059669;color:#fff;font:600 11px sans-serif;cursor:pointer;';
    dlBtn.addEventListener('click', function() {
        var currentCode = wrapper.querySelector('code').textContent;
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([currentCode], {type: 'text/html'}));
        a.download = 'output.html'; a.click();
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

    var container = lastTurn.parentElement;
    if (container) {
        container.insertBefore(wrapper, lastTurn.nextSibling);
    } else {
        lastTurn.after(wrapper);
    }
}

// ============================================================
// HARVEST
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

function harvestAllCode() {
    var turns = document.querySelectorAll('[data-testid^="youchat-answer-turn-"]');

    if (!turns || turns.length === 0) {
        turns = document.querySelectorAll('[class*="answer"], [class*="response"], [data-testid*="answer"]');
    }

    // Nuclear fallback: grab ALL code blocks on page
    if (!turns || turns.length === 0) {
        var allCodeEls = document.querySelectorAll('pre code');
        if (allCodeEls.length === 0) allCodeEls = document.querySelectorAll('pre');
        if (allCodeEls.length === 0) return '';

        var allCode = '';
        for (var i = 0; i < allCodeEls.length; i++) {
            var raw = allCodeEls[i].textContent || '';
            if (raw.trim().length < 10) continue;
            var cleaned = cleanMarkers(raw);
            if (cleaned.trim().length > 0) {
                allCode = mergeOverlap(allCode, cleaned);
            }
        }
        return unesc(allCode).trim();
    }

    var allCode = '';
    for (var i = 0; i < turns.length; i++) {
        var codeEls = turns[i].querySelectorAll('pre code');
        if (codeEls.length === 0) codeEls = turns[i].querySelectorAll('pre');
        for (var j = 0; j < codeEls.length; j++) {
            var raw = codeEls[j].textContent || '';
            if (raw.trim().length < 10) continue;
            var cleaned = cleanMarkers(raw);
            if (cleaned.trim().length > 0) {
                allCode = mergeOverlap(allCode, cleaned);
            }
        }
    }

    return unesc(allCode).trim();
}

function doHarvest() {
    status('\uD83C\uDF3E Harvesting...');

    var code = harvestAllCode();

    if (!code || code.length === 0) {
        status('\u26A0 No code found. ' + document.querySelectorAll('pre code').length + ' code elements on page.');
        console.log('[ACL] Harvest debug:', {
            turns: document.querySelectorAll('[data-testid^="youchat-answer-turn-"]').length,
            preCodes: document.querySelectorAll('pre code').length,
            pres: document.querySelectorAll('pre').length
        });
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
// AUTO-HARVEST OBSERVER
// ============================================================

var autoHarvestObserver = null;
var lastAutoHarvestTurns = 0;

function startAutoHarvest() {
    if (autoHarvestObserver) return;

    autoHarvestObserver = new MutationObserver(function() {
        if (isGen()) return;
        var currentTurns = getTurns();
        if (currentTurns > lastAutoHarvestTurns) {
            lastAutoHarvestTurns = currentTurns;
            setTimeout(function() {
                if (!isGen()) {
                    var code = harvestAllCode();
                    if (code && code.length > 0) {
                        accumulated = code;
                        injectCodeBlock(code);
                    }
                }
            }, 1500);
        }
    });

    autoHarvestObserver.observe(document.body, { childList: true, subtree: true });
}

// ============================================================
// MAIN FLOW
// ============================================================

function poll() {
    if (!running) return;
    if (isGen()) { setTimeout(poll, POLL_MS); return; }
    var t = getTurns();
    if (t <= lastTurns) { setTimeout(poll, POLL_MS); return; }
    lastTurns = t;
    setTimeout(handleResponse, 2000);
}

function handleResponse() {
    if (!running) return;
    var text = lastText();
    var newCode = extractCode(text);

    // FALLBACK: If extractCode returned nothing, grab from DOM directly
    if (!newCode || newCode.trim().length === 0) {
        var domCode = lastCodeFromDOM();
        if (domCode && domCode.trim().length > 20) {
            newCode = domCode;
        }
    }

    if (newCode && newCode.trim().length > 0) {
        accumulated = mergeOverlap(accumulated, newCode);
    }

    lastRawTail = getRawTail();

    // Always inject current state inline
    if (accumulated.trim()) {
        injectCodeBlock(accumulated.trim());
    }

    // Determine completion
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

function scheduleNext() {
    continues++;
    incrementProcessing();
    status('\u23F3 Waiting... (' + continues + '/' + MAX + ')');
    showWait(DELAY_MS);
}

function doSkip() { clearWait(); doSubmitContinue(); }

function doSubmitContinue() {
    if (!running) return;
    status('\u23F3 Continuing (' + continues + '/' + MAX + ')...');
    submit(buildContinue());
    setTimeout(poll, 4000);
}

function showWait(ms) {
    waitRemaining = Math.ceil(ms / 1000);
    updateWaitUI();
    var el = $('#acl-wait');
    if (el) el.style.display = 'flex';
    waitTimer = setInterval(function() {
        waitRemaining--;
        updateWaitUI();
        if (waitRemaining <= 0) { clearWait(); doSubmitContinue(); }
    }, 1000);
}

function clearWait() {
    if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
    var el = $('#acl-wait');
    if (el) el.style.display = 'none';
}

function updateWaitUI() {
    var el = $('#acl-wait-time');
    if (el) el.textContent = waitRemaining + 's';
    var bar = $('#acl-wait-bar');
    if (bar) {
        var pct = ((DELAY_MS / 1000 - waitRemaining) / (DELAY_MS / 1000)) * 100;
        bar.style.width = pct + '%';
    }
}

function buildContinue() {
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

function buildInitial(userText) {
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
    running = true; continues = 0; accumulated = ''; lastRawTail = '';
    prevHadUnclosedBlock = false; lastTurns = getTurns();
    incrementProcessing();
    updateBtn(); status('\u23F3 Submitting...');
    submit(buildInitial(prompt));
    setTimeout(poll, 5000);
}

function stop() {
    running = false;
    clearWait();
    updateBtn();
    status('\u23F9 Stopped. Use \uD83C\uDF3E Harvest to collect.');
}

function status(msg) { var el = $('#acl-status'); if (el) el.textContent = msg; }

function updateBtn() {
    var btn = $('#acl-btn');
    if (!btn) return;
    btn.textContent = running ? '\u23F9' : '\u25B6';
    btn.className = running ? 'acl-on' : '';
}

// ============================================================
// UI INITIALIZATION
// ============================================================

function initUI() {
    var s = document.createElement('style');
    s.textContent = [
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
    document.head.appendChild(s);

    var bar = document.createElement('div'); bar.id = 'acl-bar';
    bar.innerHTML = [
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
    document.body.appendChild(bar);

    var wait = document.createElement('div'); wait.id = 'acl-wait';
    wait.innerHTML = '<span id="acl-wait-time">25s</span><div id="acl-wait-track"><div id="acl-wait-bar"></div></div><button id="acl-skip">SKIP \u25B6\u25B6</button>';
    document.body.appendChild(wait);

    var panel = document.createElement('div'); panel.id = 'acl-panel';
    panel.innerHTML = '<pre></pre><div id="acl-panel-bar"><button id="acl-copy" style="background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff">Copy</button><button id="acl-dl" style="background:linear-gradient(135deg,#d97706,#b45309);color:#fff">Download</button><button id="acl-close" style="background:linear-gradient(135deg,#374151,#1f2937);color:#fff">Close</button></div>';
    document.body.appendChild(panel);

    // Event listeners
    $('#acl-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); toggle(); }
    });
    $('#acl-btn').addEventListener('click', toggle);
    $('#acl-harvest').addEventListener('click', doHarvest);
    $('#acl-skip').addEventListener('click', doSkip);
    $('#acl-close').addEventListener('click', function() { panel.style.display = 'none'; });
    $('#acl-copy').addEventListener('click', function() {
        navigator.clipboard.writeText(accumulated.trim()).then(function() {
            status('\u2705 Copied!');
        });
    });
    $('#acl-dl').addEventListener('click', function() {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([accumulated.trim()], {type: 'text/html'}));
        a.download = 'output.html'; a.click();
    });

    updateCounter();
    startAutoHarvest();
}

function toggle() {
    if (running) return stop();
    var input = $('#acl-input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    start(text);
}

// ============================================================
// STARTUP
// ============================================================

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
else initUI();

})();
