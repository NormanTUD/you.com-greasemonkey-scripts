// ==UserScript==
// @name         Auto-Coder v7
// @namespace    http://tampermonkey.net/
// @version      7.0
// @description  Minimal auto-continue with proper overlap detection & reliable finish.
// @match        https://you.com/*
// @grant        none
// ==/UserScript==

(function() {
'use strict';

var BT = String.fromCharCode(96);
var FENCE = BT + BT + BT;
var DONE = '///DONE';
var POLL_MS = 2500;
var DELAY_MS = 25000;
var MAX = 15;

var running = false, continues = 0, lastTurns = 0, codeBlocks = [];

var $ = function(s) { return document.querySelector(s); };
var getTurns = function() { return document.querySelectorAll('[data-testid^="youchat-answer-turn-"]').length; };
var lastText = function() {
    var all = document.querySelectorAll('[data-testid^="youchat-answer-turn-"]');
    return all.length ? all[all.length - 1].innerText : '';
};
var isGen = function() { return document.querySelectorAll('[data-testid^="step-"][data-finished="false"]').length > 0; };

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

function extractFences(text) {
    var blocks = [];
    var re = new RegExp(FENCE + '[\\w]*\\n([\\s\\S]*?)' + FENCE, 'g');
    var m;
    while ((m = re.exec(text)) !== null) blocks.push(m[1]);
    return blocks;
}

function getLastCodeTail(text) {
    var blocks = extractFences(text);
    if (blocks.length === 0) return '';
    var last = blocks[blocks.length - 1];
    var lines = last.split('\n');
    return lines.slice(-8).join('\n');
}

function mergeOverlap(existing, fragment) {
    if (!existing) return fragment;
    if (!fragment) return existing;
    var aL = existing.split('\n');
    var bL = fragment.split('\n');
    var maxCheck = Math.min(aL.length, bL.length, 20);
    var best = 0;
    for (var n = 1; n <= maxCheck; n++) {
        var tail = aL.slice(-n).map(function(l) { return l.trim(); }).join('\n');
        var head = bL.slice(0, n).map(function(l) { return l.trim(); }).join('\n');
        if (tail === head) best = n;
    }
    if (best > 0) {
        return existing + '\n' + bL.slice(best).join('\n');
    }
    return existing + '\n' + fragment;
}

function isDone(text) {
    if (text.indexOf(DONE) !== -1) return true;
    var fenceCount = text.split(FENCE).length - 1;
    if (fenceCount % 2 !== 0) return false;
    var tail = text.slice(-300);
    if (/\b(continue|next part|I'll continue|let me continue)\b/i.test(tail)) return false;
    var trimmed = text.trimEnd();
    var lastLine = trimmed.split('\n').pop().trim();
    if (/[.;}\])\x60"']$/.test(lastLine) && fenceCount > 0) return true;
    return false;
}

function poll() {
    if (!running) return;
    if (isGen()) { setTimeout(poll, POLL_MS); return; }
    var t = getTurns();
    if (t <= lastTurns) { setTimeout(poll, POLL_MS); return; }
    lastTurns = t;
    setTimeout(handleResponse, 1500);
}

function handleResponse() {
    if (!running) return;
    var text = lastText();
    var blocks = extractFences(text);

    // Merge each block with overlap detection against accumulated code
    for (var i = 0; i < blocks.length; i++) {
        if (codeBlocks.length === 0) {
            codeBlocks.push(blocks[i]);
        } else {
            var lastIdx = codeBlocks.length - 1;
            var merged = mergeOverlap(codeBlocks[lastIdx], blocks[i]);
            // If overlap found, merge into last block; otherwise push new
            if (merged.length < codeBlocks[lastIdx].length + blocks[i].length + 5) {
                codeBlocks[lastIdx] = merged;
            } else {
                codeBlocks.push(blocks[i]);
            }
        }
    }

    if (isDone(text) || continues >= MAX) {
        finish();
    } else {
        continues++;
        status('Continuing (' + continues + '/' + MAX + ')...');
        var tail = getLastCodeTail(text);
        setTimeout(function() {
            if (!running) return;
            var prompt = 'Continue EXACTLY where you left off.';
            if (tail) {
                prompt += ' The last lines you wrote were:\n' + FENCE + '\n' + tail + '\n' + FENCE + '\n';
                prompt += 'Resume from the very next line after those.';
            }
            prompt += '\nWhen completely finished, write ' + DONE + ' on its own line.';
            submit(prompt);
            setTimeout(poll, 4000);
        }, DELAY_MS);
    }
}

function finish() {
    running = false;
    updateBtn();
    var code = codeBlocks.join('\n\n').trim();
    var panel = $('#acl-panel');
    panel.querySelector('pre').textContent = code;
    panel.style.display = 'flex';
    navigator.clipboard.writeText(code).then(function() { status('Done & copied!'); });
}

function start(prompt) {
    running = true; continues = 0; codeBlocks = []; lastTurns = getTurns();
    updateBtn(); status('Submitting...');
    submit(prompt + '\n\nWhen completely finished, write "' + DONE + '" on its own line.');
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
        var code = codeBlocks.join('\n\n').trim();
        navigator.clipboard.writeText(code).then(function() { status('Copied!'); });
    });
    $('#acl-dl').addEventListener('click', function() {
        var code = codeBlocks.join('\n\n').trim();
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([code]));
        a.download = 'output.txt'; a.click();
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
