// ==UserScript==
// @name         Auto-Coder v7
// @namespace    http://tampermonkey.net/
// @version      7.0
// @description  Auto-continue with overlap. Uses >>>CODE STARTS<<< / >>>CODE ENDS<<<.
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
var codeParts = [], lastTail = '';

var $ = function(s) { return document.querySelector(s); };
var getTurns = function() { return document.querySelectorAll('[data-testid^="youchat-answer-turn-"]').length; };
var isGen = function() { return document.querySelectorAll('[data-testid^="step-"][data-finished="false"]').length > 0; };

function lastText() {
    var all = document.querySelectorAll('[data-testid^="youchat-answer-turn-"]');
    return all.length ? all[all.length - 1].innerText : '';
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
    return code.replace(/>>>BACKTICK<<</g, BT);
}

function extractBlocks(text) {
    var blocks = [];
    var idx = 0;
    while (true) {
        var si = text.indexOf(CODE_START, idx);
        if (si === -1) break;
        var ei = text.indexOf(CODE_END, si);
        var raw = ei === -1 ? text.substring(si + CODE_START.length) : text.substring(si + CODE_START.length, ei);
        var code = extractFromFence(raw);
        if (code) blocks.push(unesc(code));
        if (ei === -1) break;
        idx = ei + CODE_END.length;
    }
    return blocks;
}

function extractFromFence(block) {
    var lines = block.split('\n');
    var inFence = false, out = [];
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (!inFence && l.trim().indexOf(FENCE) === 0) { inFence = true; continue; }
        if (inFence && l.trim() === FENCE) { inFence = false; continue; }
        if (inFence) out.push(l);
    }
    if (out.length === 0) {
        var filtered = lines.slice(1).filter(function(l) { return l.trim().length > 0; });
        return filtered.join('\n');
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

function isDone(text) {
    if (text.indexOf(FINISH) !== -1) return true;
    return false;
}

function getAccumulated() {
    return codeParts.join('\n');
}

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
    var blocks = extractBlocks(text);

    for (var i = 0; i < blocks.length; i++) {
        if (codeParts.length === 0) {
            codeParts.push(blocks[i]);
        } else {
            var lastIdx = codeParts.length - 1;
            codeParts[lastIdx] = mergeOverlap(codeParts[lastIdx], blocks[i]);
        }
    }

    // Save tail for continue prompt
    var accumulated = getAccumulated();
    var accLines = accumulated.split('\n');
    lastTail = accLines.slice(-10).join('\n');

    if (isDone(text) || continues >= MAX) {
        finish();
    } else {
        continues++;
        status('Continuing (' + continues + '/' + MAX + ')...');
        setTimeout(function() {
            if (!running) return;
            submit(buildContinue());
            setTimeout(poll, 4000);
        }, DELAY_MS);
    }
}

function buildContinue() {
    var lines = [];
    lines.push('Continue EXACTLY where you left off. Here are the last lines you wrote:');
    lines.push('');
    lines.push(FENCE);
    lines.push(lastTail);
    lines.push(FENCE);
    lines.push('');
    lines.push('Resume from the VERY NEXT LINE. Do NOT repeat those lines.');
    lines.push('');
    lines.push('RULES (same as before):');
    lines.push('- Wrap code in ' + CODE_START + ' and ' + CODE_END);
    lines.push('- Replace all backticks with ' + BACKTICK_ESC);
    lines.push('- When 100% done: ' + FINISH);
    return lines.join('\n');
}

function buildInitial(userText) {
    var lines = [];
    lines.push(userText);
    lines.push('');
    lines.push('=== OUTPUT RULES ===');
    lines.push('1. Wrap ALL code between these markers (on their own lines):');
    lines.push('   ' + CODE_START);
    lines.push('   ' + FENCE + 'html');
    lines.push('   ...your code...');
    lines.push('   ' + FENCE);
    lines.push('   ' + CODE_END);
    lines.push('2. Replace EVERY backtick inside your code with: ' + BACKTICK_ESC);
    lines.push('3. When completely finished, write: ' + FINISH);
    lines.push('4. If response gets long, just stop. I will say continue.');
    lines.push('5. Keep functions short (~10 lines max).');
    lines.push('==================');
    return lines.join('\n');
}

function finish() {
    running = false;
    updateBtn();
    var code = getAccumulated().trim();
    var panel = $('#acl-panel');
    panel.querySelector('pre').textContent = code;
    panel.style.display = 'flex';
    navigator.clipboard.writeText(code).then(function() { status('Done & copied! (' + code.split('\n').length + ' lines)'); });
}

function start(prompt) {
    running = true; continues = 0; codeParts = []; lastTail = ''; lastTurns = getTurns();
    updateBtn(); status('Submitting...');
    submit(buildInitial(prompt));
    setTimeout(poll, 5000);
}

function stop() { running = false; updateBtn(); status('Stopped.'); }
function status(msg) { var el = $('#acl-status'); if (el) el.textContent = msg; }
function updateBtn() {
    var btn = $('#acl-btn');
    if (!btn) return;
    btn.textContent = running ? '\u23F9' : '\u25B6';
    btn.className = running ? 'acl-on' : '';
}

function initUI() {
    var s = document.createElement('style');
    s.textContent = '#acl-bar{position:fixed;bottom:0;left:0;right:0;z-index:9999999;display:flex;align-items:center;background:#111;border-top:1px solid #333;padding:6px 10px;gap:8px;font:13px monospace;}' +
        '#acl-input{flex:1;background:#222;color:#eee;border:1px solid #444;border-radius:6px;padding:8px 12px;font:inherit;resize:none;min-height:36px;max-height:150px;}' +
        '#acl-btn{width:40px;height:36px;border:none;border-radius:6px;cursor:pointer;background:#7c3aed;color:#fff;font-size:16px;}' +
        '#acl-btn.acl-on{background:#dc2626;animation:acl-p 1s infinite}' +
        '@keyframes acl-p{50%{opacity:.5}}' +
        '#acl-status{color:#888;font-size:11px;min-width:180px;}' +
        '#acl-panel{display:none;flex-direction:column;position:fixed;inset:5%;z-index:99999999;background:#0a0a0f;border:1px solid #7c3aed;border-radius:10px;overflow:hidden;}' +
        '#acl-panel pre{flex:1;overflow:auto;padding:16px;margin:0;color:#e2e8f0;font:12px/1.5 monospace;white-space:pre-wrap;}' +
        '#acl-panel-bar{display:flex;gap:8px;padding:10px;border-top:1px solid #333;}' +
        '#acl-panel-bar button{padding:6px 14px;border:none;border-radius:6px;cursor:pointer;font:600 12px sans-serif;}';
    document.head.appendChild(s);

    var bar = document.createElement('div'); bar.id = 'acl-bar';
    bar.innerHTML = '<textarea id="acl-input" placeholder="Prompt... (Enter to go)" rows="1"></textarea><button id="acl-btn">\u25B6</button><span id="acl-status">Ready</span>';
    document.body.appendChild(bar);

    var panel = document.createElement('div'); panel.id = 'acl-panel';
    panel.innerHTML = '<pre></pre><div id="acl-panel-bar"><button id="acl-copy" style="background:#2563eb;color:#fff">Copy</button><button id="acl-dl" style="background:#d97706;color:#fff">Download</button><button id="acl-close" style="background:#444;color:#fff">Close</button></div>';
    document.body.appendChild(panel);

    $('#acl-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); toggle(); }
    });
    $('#acl-btn').addEventListener('click', toggle);
    $('#acl-close').addEventListener('click', function() { panel.style.display = 'none'; });
    $('#acl-copy').addEventListener('click', function() {
        navigator.clipboard.writeText(getAccumulated().trim()).then(function() { status('Copied!'); });
    });
    $('#acl-dl').addEventListener('click', function() {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([getAccumulated().trim()]));
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
