// ==UserScript==
// @name         Auto-Coder v7
// @namespace    http://tampermonkey.net/
// @version      7.1
// @description  Auto-continue with overlap, skip button, proper fence handling.
// @match        https://you.com/*
// @grant        none
// ==/UserScript==

(function() {
'use strict';

var BT = String.fromCharCode(96);
var FENCE = BT + BT + BT;
var FINISH = '>>>FINISHED<<<';
var CODE_START = '>>>CODE STARTS<<<';
var CODE_END = '>>>CODE ENDS<<<';
var BACKTICK_ESC = '>>>BACKTICK<<<';
var DELAY_MS = 25000;
var MAX = 15;
var POLL_MS = 2500;

var running = false, continues = 0, lastTurns = 0;
var accumulated = '', lastRawTail = '', prevHadUnclosedBlock = false;
var waitTimer = null, waitRemaining = 0;

var $ = function(s) { return document.querySelector(s); };
var getTurns = function() { return document.querySelectorAll('[data-testid^="youchat-answer-turn-"]').length; };
var isGen = function() { return document.querySelectorAll('[data-testid^="step-"][data-finished="false"]').length > 0; };

function lastTurnEl() {
    var all = document.querySelectorAll('[data-testid^="youchat-answer-turn-"]');
    return all.length ? all[all.length - 1] : null;
}

function lastText() {
    var el = lastTurnEl();
    return el ? el.innerText : '';
}

function lastCodeFromDOM() {
    var el = lastTurnEl();
    if (!el) return '';
    var codeEls = el.querySelectorAll('pre code');
    if (codeEls.length === 0) return '';
    var allCode = '';
    for (var i = 0; i < codeEls.length; i++) {
        allCode += (allCode ? '\n' : '') + (codeEls[i].textContent || '');
    }
    return allCode;
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

function unesc(code) { return code.replace(/>>>BACKTICK<<</g, BT); }

function extractCode(text) {
    var result = '';
    var idx = 0;
    while (true) {
        var si = text.indexOf(CODE_START, idx);
        if (si === -1) break;
        var ei = text.indexOf(CODE_END, si);
        var raw;
        if (ei === -1) {
            raw = text.substring(si + CODE_START.length);
            prevHadUnclosedBlock = true;
        } else {
            raw = text.substring(si + CODE_START.length, ei);
            prevHadUnclosedBlock = false;
        }
        var code = stripFence(raw);
        if (code) result += (result ? '\n' : '') + code;
        if (ei === -1) break;
        idx = ei + CODE_END.length;
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
        return lines.slice(1).join('\n');
    }
    return out.join('\n');
}

function mergeOverlap(existing, fragment) {
    if (!existing) return fragment;
    if (!fragment) return existing;
    var aL = existing.split('\n');
    var bL = fragment.split('\n');
    var maxCheck = Math.min(aL.length, bL.length, 25);
    var best = 0;
    for (var n = 1; n <= maxCheck; n++) {
        var tail = aL.slice(-n).map(function(l) { return l.trim(); }).join('\n');
        var head = bL.slice(0, n).map(function(l) { return l.trim(); }).join('\n');
        if (tail === head) best = n;
    }
    if (best > 0) return existing + '\n' + bL.slice(best).join('\n');
    return existing + '\n' + fragment;
}

function getRawTail() {
    var code = lastCodeFromDOM();
    if (!code || code.trim().length === 0) {
        if (accumulated) {
            var accLines = accumulated.split('\n');
            return accLines.slice(-3).join('\n');
        }
        return '';
    }
    var lines = code.split('\n');
    var meaningful = [];
    for (var i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim().length > 0 || meaningful.length > 0) {
            meaningful.unshift(lines[i]);
        }
        if (meaningful.length >= 3) break;
    }
    return meaningful.join('\n');
}

function isDone(text) { return text.indexOf(FINISH) !== -1; }

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

    if (newCode) {
        accumulated = mergeOverlap(accumulated, newCode);
    }

    lastRawTail = getRawTail();

    if (isDone(text) || continues >= MAX) { finish(); }
    else { scheduleNext(); }
}

function scheduleNext() {
    continues++;
    status('Waiting... (' + continues + '/' + MAX + ')');
    showWait(DELAY_MS);
}

function doSkip() { clearWait(); doSubmitContinue(); }

function doSubmitContinue() {
    if (!running) return;
    status('Continuing (' + continues + '/' + MAX + ')...');
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
        tail = accLines.slice(-3).join('\n');
    }
    var lines = [];
    lines.push('Continue EXACTLY where you left off. Here are the last lines you wrote:');
    lines.push('');
    lines.push(FENCE);
    lines.push(tail);
    lines.push(FENCE);
    lines.push('');
    lines.push('Your response MUST start with exactly these two lines:');
    lines.push(CODE_START);
    lines.push(FENCE + 'html');
    lines.push('');
    lines.push('Then repeat those last 2 lines for overlap, then continue the code.');
    lines.push('');
    lines.push('RULES:');
    lines.push('- First line of response: ' + CODE_START);
    lines.push('- Second line of response: ' + FENCE + 'html');
    lines.push('- Then the code continues');
    lines.push('- Replace all backticks in code with ' + BACKTICK_ESC);
    lines.push('- When 100% done, close with ' + FENCE + ' then ' + CODE_END + ' then ' + FINISH);
    return lines.join('\n');
}

function buildInitial(userText) {
    var lines = [];
    lines.push(userText);
    lines.push('');
    lines.push('=== OUTPUT RULES ===');
    lines.push('1. Wrap ALL code between these exact markers on their own lines:');
    lines.push('   ' + CODE_START);
    lines.push('   ' + FENCE + 'html');
    lines.push('   ...your code...');
    lines.push('   ' + FENCE);
    lines.push('   ' + CODE_END);
    lines.push('2. Replace EVERY backtick inside your code with: ' + BACKTICK_ESC);
    lines.push('3. When completely finished, write on its own line: ' + FINISH);
    lines.push('4. If response gets long, just stop mid-code. I will say continue.');
    lines.push('==================');
    return lines.join('\n');
}

function finish() {
    running = false;
    clearWait();
    updateBtn();
    var code = accumulated.trim();
    var panel = $('#acl-panel');
    panel.querySelector('pre').textContent = code;
    panel.style.display = 'flex';
    navigator.clipboard.writeText(code).then(function() {
        status('Done! ' + code.split('\n').length + ' lines copied.');
    });
}

function start(prompt) {
    running = true; continues = 0; accumulated = ''; lastRawTail = '';
    prevHadUnclosedBlock = false; lastTurns = getTurns();
    updateBtn(); status('Submitting...');
    submit(buildInitial(prompt));
    setTimeout(poll, 5000);
}

function stop() { running = false; clearWait(); updateBtn(); status('Stopped.'); }
function status(msg) { var el = $('#acl-status'); if (el) el.textContent = msg; }
function updateBtn() {
    var btn = $('#acl-btn');
    if (!btn) return;
    btn.textContent = running ? '\u23F9' : '\u25B6';
    btn.className = running ? 'acl-on' : '';
}

function initUI() {
    var s = document.createElement('style');
    s.textContent = [
        '#acl-bar{position:fixed;bottom:0;left:0;right:0;z-index:9999999;display:flex;align-items:center;background:#0a0814;border-top:1px solid rgba(139,92,246,.3);padding:6px 10px;gap:8px;font:13px "SF Mono",monospace;}',
        '#acl-input{flex:1;background:#1a1528;color:#e2e8f0;border:1px solid #333;border-radius:6px;padding:10px 14px;font:inherit;resize:none;min-height:38px;max-height:150px;}',
        '#acl-btn{width:44px;height:38px;border:none;border-radius:8px;cursor:pointer;background:#7c3aed;color:#fff;font-size:18px;}',
        '#acl-btn.acl-on{background:#dc2626;animation:acl-p 1s infinite}',
        '@keyframes acl-p{50%{opacity:.5}}',
        '#acl-status{color:#a5b4fc;font-size:11px;min-width:200px;}',
        '#acl-wait{display:none;position:fixed;bottom:70px;left:50%;transform:translateX(-50%);z-index:9999999;align-items:center;gap:14px;background:#0f0b1e;border:1px solid rgba(139,92,246,.4);border-radius:14px;padding:14px 24px;box-shadow:0 10px 40px rgba(0,0,0,.6);}',
        '#acl-wait-time{font:700 32px "SF Mono",monospace;color:#c4b5fd;min-width:55px;text-align:center;}',
        '#acl-wait-track{width:140px;height:6px;background:rgba(139,92,246,.15);border-radius:3px;overflow:hidden;}',
        '#acl-wait-bar{height:100%;width:0%;background:linear-gradient(90deg,#7c3aed,#a855f7);border-radius:3px;transition:width 1s linear;}',
        '#acl-skip{padding:12px 28px;border:none;border-radius:10px;cursor:pointer;background:#7c3aed;color:#fff;font:700 15px sans-serif;transition:all .15s;letter-spacing:.5px;}',
        '#acl-skip:hover{background:#6d28d9;transform:scale(1.05);}',
        '#acl-skip:active{transform:scale(.97);}',
        '#acl-panel{display:none;flex-direction:column;position:fixed;inset:5%;z-index:99999999;background:#0a0a0f;border:1px solid #7c3aed;border-radius:12px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.7);}',
        '#acl-panel pre{flex:1;overflow:auto;padding:16px;margin:0;color:#e2e8f0;font:12px/1.6 "SF Mono",monospace;white-space:pre-wrap;}',
        '#acl-panel-bar{display:flex;gap:8px;padding:12px;border-top:1px solid #333;}',
        '#acl-panel-bar button{padding:8px 16px;border:none;border-radius:8px;cursor:pointer;font:600 12px sans-serif;}'
    ].join('\n');
    document.head.appendChild(s);

    var bar = document.createElement('div'); bar.id = 'acl-bar';
    bar.innerHTML = '<textarea id="acl-input" placeholder="Prompt... (Enter to go)" rows="1"></textarea><button id="acl-btn">\u25B6</button><span id="acl-status">Ready</span>';
    document.body.appendChild(bar);

    var wait = document.createElement('div'); wait.id = 'acl-wait';
    wait.innerHTML = '<span id="acl-wait-time">25s</span><div id="acl-wait-track"><div id="acl-wait-bar"></div></div><button id="acl-skip">SKIP \u25B6\u25B6</button>';
    document.body.appendChild(wait);

    var panel = document.createElement('div'); panel.id = 'acl-panel';
    panel.innerHTML = '<pre></pre><div id="acl-panel-bar"><button id="acl-copy" style="background:#2563eb;color:#fff">Copy</button><button id="acl-dl" style="background:#d97706;color:#fff">Download</button><button id="acl-close" style="background:#333;color:#fff">Close</button></div>';
    document.body.appendChild(panel);

    $('#acl-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); toggle(); }
    });
    $('#acl-btn').addEventListener('click', toggle);
    $('#acl-skip').addEventListener('click', doSkip);
    $('#acl-close').addEventListener('click', function() { panel.style.display = 'none'; });
    $('#acl-copy').addEventListener('click', function() {
        navigator.clipboard.writeText(accumulated.trim()).then(function() { status('Copied!'); });
    });
    $('#acl-dl').addEventListener('click', function() {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([accumulated.trim()]));
        a.download = 'output.html'; a.click();
    });
}

function toggle() {
    if (running) return stop();
    var input = $('#acl-input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    start(text);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI);
else initUI();
})();
