// ==UserScript==
// @name         You.com Auto-Coder v6
// @namespace    http://tampermonkey.net/
// @version      6.0
// @description  Fully automatic code generation with visual feedback, placeholder system
// @match        https://you.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    var BT = String.fromCharCode(96);
    var FENCE = BT + BT + BT;

    var FINISH = '>>>FINISHED<<<';
    var CODE_START = '>>>CODE STARTS<<<';
    var CODE_END = '>>>CODE ENDS<<<';
    var TEST_START = '>>>TESTCODE STARTS<<<';
    var TEST_END = '>>>TESTCODE ENDS<<<';
    var BACKTICK_ESC = '>>>BACKTICK<<<';
    var DELAY_MS = 30000;
    var MAX_RETRIES = 20;
    var POLL_MS = 2500;
    var SETTLE_MS = 2000;
    var ATTR = 'data-acv6';

    var running = false;
    var parts = {};
    var outline = '';
    var currentPlaceholder = null;
    var retries = 0;
    var lastTurns = 0;
    var pollId = null;
    var timerId = null;
    var logEntries = [];

    function injectStyles() {
        var el = document.createElement('style');
        el.textContent = [
            '.acv6-hidden{position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;border:0!important;padding:0!important;margin:-1px!important;}',
            '#acv6-bar{position:fixed;bottom:0;left:0;right:0;z-index:9999999;display:flex;align-items:stretch;background:rgba(10,8,20,.98);border-top:1px solid rgba(139,92,246,.3);backdrop-filter:blur(16px);}',
            '#acv6-input{flex:1;min-height:50px;max-height:200px;resize:none;padding:14px 16px;border:none;outline:none;background:transparent;color:#e2e8f0;font:13px/1.5 "SF Mono","Fira Code","Consolas",monospace;}',
            '#acv6-input::placeholder{color:rgba(255,255,255,.2);}',
            '#acv6-go{width:60px;border:none;cursor:pointer;background:linear-gradient(135deg,#7c3aed,#6366f1);color:#fff;font:700 20px/1 sans-serif;transition:all .2s;}',
            '#acv6-go:hover{opacity:.85;}',
            '#acv6-go.on{background:linear-gradient(135deg,#dc2626,#ef4444);animation:acv6-p 1s infinite;}',
            '@keyframes acv6-p{0%,100%{opacity:1}50%{opacity:.5}}',
            '#acv6-log{position:fixed;top:10px;right:10px;width:340px;max-height:50vh;z-index:9999998;overflow-y:auto;background:rgba(10,8,20,.94);border:1px solid rgba(139,92,246,.25);border-radius:12px;padding:10px;font:11px/1.5 "SF Mono",monospace;color:#a5b4fc;display:none;flex-direction:column;gap:2px;box-shadow:0 12px 40px rgba(0,0,0,.6);backdrop-filter:blur(12px);}',
            '#acv6-log.visible{display:flex;}',
            '.acv6-log-entry{padding:3px 6px;border-radius:4px;word-break:break-word;}',
            '.acv6-log-entry.info{color:#6ee7b7;}',
            '.acv6-log-entry.warn{color:#fbbf24;background:rgba(251,191,36,.05);}',
            '.acv6-log-entry.error{color:#fca5a5;background:rgba(239,68,68,.05);}',
            '.acv6-log-entry.success{color:#34d399;background:rgba(52,211,153,.05);}',
            '#acv6-log-toggle{position:fixed;top:10px;right:360px;z-index:9999998;width:32px;height:32px;border-radius:8px;border:none;cursor:pointer;background:rgba(139,92,246,.2);color:#a5b4fc;font:14px/1 sans-serif;transition:all .2s;}',
            '#acv6-log-toggle:hover{background:rgba(139,92,246,.4);}',
            '#acv6-timer{position:fixed;bottom:58px;right:16px;z-index:9999998;display:none;align-items:center;gap:10px;padding:10px 16px;background:rgba(10,8,20,.96);border:1px solid rgba(139,92,246,.3);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.5);}',
            '#acv6-timer.visible{display:flex;}',
            '.acv6-ring{width:40px;height:40px;transform:rotate(-90deg);}',
            '.acv6-ring-bg{fill:none;stroke:rgba(139,92,246,.12);stroke-width:4;}',
            '.acv6-ring-fg{fill:none;stroke:#7c3aed;stroke-width:4;stroke-linecap:round;stroke-dasharray:100.53;stroke-dashoffset:0;transition:stroke-dashoffset 1s linear;}',
            '#acv6-timer-sec{font:700 18px/1 "SF Mono",monospace;color:#c4b5fd;min-width:28px;text-align:center;}',
            '#acv6-timer-lbl{font:11px/1.3 sans-serif;color:rgba(255,255,255,.4);}',
            '#acv6-progress{position:fixed;bottom:54px;left:0;right:0;height:3px;z-index:9999997;background:rgba(139,92,246,.1);}',
            '#acv6-progress-fill{height:100%;width:0%;background:linear-gradient(90deg,#7c3aed,#a855f7,#ec4899);transition:width .5s ease;}',
            '#acv6-panel{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:75vw;max-width:960px;max-height:82vh;z-index:99999999;background:rgba(12,10,24,.99);border:1px solid rgba(139,92,246,.35);border-radius:14px;display:none;flex-direction:column;box-shadow:0 30px 80px rgba(0,0,0,.7);overflow:hidden;}',
            '#acv6-panel.visible{display:flex;}',
            '#acv6-panel-head{padding:12px 16px;background:rgba(139,92,246,.06);border-bottom:1px solid rgba(139,92,246,.2);display:flex;justify-content:space-between;align-items:center;font:600 13px/1 sans-serif;color:#c4b5fd;}',
            '#acv6-panel-body{flex:1;overflow:auto;padding:14px;font:12px/1.6 "SF Mono",monospace;color:#e2e8f0;white-space:pre-wrap;tab-size:2;}',
            '#acv6-panel-foot{padding:10px 14px;border-top:1px solid rgba(139,92,246,.2);display:flex;gap:8px;}',
            '.acv6-btn{padding:6px 14px;border:none;border-radius:7px;cursor:pointer;font:600 11px/1.3 sans-serif;transition:all .15s;}',
            '.acv6-btn:hover{transform:translateY(-1px);}',
            '.acv6-btn--cp{background:rgba(56,189,248,.12);color:#93c5fd;}',
            '.acv6-btn--dl{background:rgba(251,146,60,.12);color:#fdba74;}',
            '.acv6-btn--cl{background:rgba(239,68,68,.12);color:#fca5a5;}',
            '#acv6-parts{position:fixed;top:10px;left:10px;z-index:9999998;background:rgba(10,8,20,.94);border:1px solid rgba(139,92,246,.2);border-radius:10px;padding:8px 12px;font:11px/1.5 "SF Mono",monospace;color:#a5b4fc;max-width:280px;display:none;}',
            '#acv6-parts.visible{display:block;}',
            '.acv6-part-item{padding:2px 0;display:flex;align-items:center;gap:6px;}',
            '.acv6-part-dot{width:8px;height:8px;border-radius:50%;}',
            '.acv6-part-dot.done{background:#34d399;}',
            '.acv6-part-dot.pending{background:rgba(255,255,255,.15);}',
            '.acv6-part-dot.active{background:#fbbf24;animation:acv6-p 1s infinite;}'
        ].join('\n');
        document.head.appendChild(el);
    }

    function log(msg, type) {
        type = type || 'info';
        var ts = new Date().toLocaleTimeString();
        var full = '[' + ts + '] ' + msg;
        var colors = { info: '#6ee7b7', warn: '#fbbf24', error: '#fca5a5', success: '#34d399' };
        console.log('%c[ACv6] ' + msg, 'color:' + (colors[type] || colors.info) + ';font-weight:bold');
        logEntries.push({ msg: full, type: type });
        renderLog();
    }

    function renderLog() {
        var el = document.getElementById('acv6-log');
        if (!el) return;
        var last30 = logEntries.slice(-30);
        el.innerHTML = last30.map(function (e) {
            return '<div class="acv6-log-entry ' + e.type + '">' + escHtml(e.msg) + '</div>';
        }).join('');
        el.scrollTop = el.scrollHeight;
    }

    function escHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function showLog() {
        var el = document.getElementById('acv6-log');
        if (el) el.classList.add('visible');
    }

    function showTimer(ms, label) {
        var el = document.getElementById('acv6-timer');
        var sec = document.getElementById('acv6-timer-sec');
        var lbl = document.getElementById('acv6-timer-lbl');
        var ring = document.getElementById('acv6-ring-fg');
        if (!el) return;
        var circ = 2 * Math.PI * 16;
        ring.style.strokeDasharray = circ;
        ring.style.strokeDashoffset = '0';
        lbl.textContent = label || 'waiting...';
        el.classList.add('visible');
        var total = Math.ceil(ms / 1000);
        var rem = total;
        sec.textContent = rem;
        clearTimerInterval();
        timerId = setInterval(function () {
            rem--;
            if (rem <= 0) { hideTimer(); return; }
            sec.textContent = rem;
            var pct = 1 - (rem / total);
            ring.style.strokeDashoffset = circ * pct;
        }, 1000);
    }

    function hideTimer() {
        clearTimerInterval();
        var el = document.getElementById('acv6-timer');
        if (el) el.classList.remove('visible');
    }

    function clearTimerInterval() {
        if (timerId) { clearInterval(timerId); timerId = null; }
    }

    function setProgress(pct) {
        var el = document.getElementById('acv6-progress-fill');
        if (el) el.style.width = Math.min(100, Math.max(0, pct)) + '%';
    }

    function calcProgress() {
        var keys = Object.keys(parts).filter(function (k) { return k !== '__TEST__'; });
        if (keys.length === 0) return 0;
        var filled = keys.filter(function (k) { return parts[k] !== null; }).length;
        return (filled / keys.length) * 100;
    }

    function renderParts() {
        var el = document.getElementById('acv6-parts');
        if (!el) return;
        var keys = Object.keys(parts).filter(function (k) { return k !== '__TEST__'; });
        if (keys.length === 0) { el.classList.remove('visible'); return; }
        el.classList.add('visible');
        var html = '<div style="margin-bottom:4px;font-weight:700;color:#c4b5fd;">Parts:</div>';
        html += keys.map(function (k) {
            var status = parts[k] !== null ? 'done' : (k === currentPlaceholder ? 'active' : 'pending');
            var lines = parts[k] ? ' (' + parts[k].split('\n').length + 'ln)' : '';
            return '<div class="acv6-part-item"><span class="acv6-part-dot ' + status + '"></span>' + escHtml(k) + lines + '</div>';
        }).join('');
        el.innerHTML = html;
    }

    function getTA() {
        return document.querySelector('#search-input-textarea');
    }

    function getTurns() {
        return document.querySelectorAll('[data-testid^="youchat-answer-turn-"]').length;
    }

    function getLastTurnText() {
        var all = document.querySelectorAll('[data-testid^="youchat-answer-turn-"]');
        return all.length ? (all[all.length - 1].textContent || '') : '';
    }

    function stillGenerating() {
        var uf = document.querySelectorAll('[data-testid^="step-"][data-finished="false"]');
        return uf.length > 0;
    }

    function submitPrompt(text) {
        var ta = getTA();
        if (!ta) { log('Textarea not found!', 'error'); return false; }
        var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, text);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(function () {
            var form = ta.closest('form');
            if (!form) return;
            var btn = form.querySelector('button[type="submit"],[data-testid="search-input-send-button"]');
            if (btn) { btn.disabled = false; btn.click(); }
        }, 400);
        return true;
    }

    function hideOriginalInput() {
        var ta = getTA();
        if (!ta) return;
        var wrapper = ta.closest('form');
        if (wrapper) wrapper = wrapper.parentElement;
        if (wrapper && !wrapper.classList.contains('acv6-hidden')) {
            wrapper.classList.add('acv6-hidden');
        }
    }

    function buildInitialPrompt(userText) {
        var lines = [];
        lines.push(userText);
        lines.push('');
        lines.push('================================================================');
        lines.push('CRITICAL INSTRUCTIONS - THE ENTIRE PROJECT DEPENDS ON THESE');
        lines.push('================================================================');
        lines.push('');
        lines.push('STEP 1: OUTLINE FIRST');
        lines.push('- Output a structured outline with labeled placeholders.');
        lines.push('- Placeholder format: >>>$PLACEHOLDER_NAME<<<');
        lines.push('- Examples: >>>$JS_MAIN<<<, >>>$HTML_TEMPLATE<<<, >>>$CSS_STYLES<<<');
        lines.push('- The outline shows the full file structure with placeholders.');
        lines.push('');
        lines.push('STEP 2: FILL EACH PLACEHOLDER');
        lines.push('- Fill them ONE BY ONE.');
        lines.push('- Before each code block write on its own line: ' + CODE_START + ' PLACEHOLDER_NAME');
        lines.push('- After each code block write on its own line: ' + CODE_END);
        lines.push('- ALL functions must be ~10 lines max.');
        lines.push('');
        lines.push('STEP 3: BACKTICK ESCAPING');
        lines.push('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
        lines.push('THIS IS EXTREMELY CRITICAL. DO NOT SKIP THIS.');
        lines.push('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
        lines.push('- If your code contains backtick characters (template literals etc),');
        lines.push('  replace EVERY backtick inside code with: ' + BACKTICK_ESC);
        lines.push('- I will automatically convert them back.');
        lines.push('- DO NOT use real backtick characters inside code. NEVER. EVER.');
        lines.push('- This prevents breaking out of code fences.');
        lines.push('');
        lines.push('STEP 4: TESTING (JS/TS ONLY)');
        lines.push('- If the code is JavaScript or TypeScript, include tests:');
        lines.push('  ' + TEST_START);
        lines.push('  // your test assertions');
        lines.push('  ' + TEST_END);
        lines.push('- If NOT JS/TS, do NOT include test markers.');
        lines.push('');
        lines.push('STEP 5: FINISH SIGNAL');
        lines.push('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
        lines.push('THIS IS THE SINGLE MOST IMPORTANT RULE OF ALL.');
        lines.push('WITHOUT THIS, NOTHING WORKS. THE AUTOMATION BREAKS.');
        lines.push('I CANNOT STRESS THIS ENOUGH.');
        lines.push('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
        lines.push('- When you are COMPLETELY done with ALL placeholders:');
        lines.push('- Write this EXACT text on its own line: ' + FINISH);
        lines.push('- If you do NOT write ' + FINISH + ', I will ask you to continue.');
        lines.push('- NEVER write ' + FINISH + ' until EVERY placeholder is filled.');
        lines.push('- If your response is getting long, STOP EARLY. I will continue.');
        lines.push('- But when truly 100% done: ' + FINISH);
        lines.push('- ' + FINISH + ' ' + FINISH + ' ' + FINISH);
        lines.push('- I repeat: ' + FINISH + ' is REQUIRED at the end.');
        lines.push('');
        lines.push('EXAMPLE OUTPUT:');
        lines.push('');
        lines.push('OUTLINE:');
        lines.push(FENCE + 'html');
        lines.push('<!DOCTYPE html>');
        lines.push('<html><head><style>>>>$CSS_STYLES<<<</style></head>');
        lines.push('<body><script>>>>$JS_MAIN<<<</script></body></html>');
        lines.push(FENCE);
        lines.push('');
        lines.push(CODE_START + ' CSS_STYLES');
        lines.push(FENCE + 'css');
        lines.push('body { margin: 0; }');
        lines.push(FENCE);
        lines.push(CODE_END);
        lines.push('');
        lines.push(CODE_START + ' JS_MAIN');
        lines.push(FENCE + 'javascript');
        lines.push('function main() { console.log("hi"); }');
        lines.push(FENCE);
        lines.push(CODE_END);
        lines.push('');
        lines.push(FINISH);
        lines.push('');
        lines.push('================================================================');
        lines.push('NOW BEGIN. Outline first, then fill, then ' + FINISH + '.');
        lines.push('================================================================');
        return lines.join('\n');
    }

    function buildContinuePrompt() {
        var unfilled = Object.keys(parts).filter(function (k) {
            return k !== '__TEST__' && parts[k] === null;
        });
        var lines = [];
        lines.push('Continue where you left off.');
        if (currentPlaceholder && parts[currentPlaceholder]) {
            var tail = parts[currentPlaceholder].split('\n').slice(-8).join('\n');
            lines.push('');
            lines.push('Last lines of ' + currentPlaceholder + ':');
            lines.push(FENCE);
            lines.push(tail);
            lines.push(FENCE);
        }
        lines.push('');
        lines.push('Remaining placeholders: ' + unfilled.join(', '));
        lines.push('');
        lines.push('REMEMBER:');
        lines.push('- ' + CODE_START + ' NAME before each block');
        lines.push('- ' + CODE_END + ' after each block');
        lines.push('- Replace backticks with ' + BACKTICK_ESC);
        lines.push('- When ALL done: ' + FINISH);
        lines.push('');
        lines.push('!!! ' + FINISH + ' IS ABSOLUTELY REQUIRED WHEN DONE !!!');
        lines.push('!!! DO NOT FORGET ' + FINISH + ' !!!');
        lines.push('!!! THE ENTIRE SYSTEM BREAKS WITHOUT ' + FINISH + ' !!!');
        return lines.join('\n');
    }

    function buildFixPrompt(errors, code) {
        var lines = [];
        lines.push('The code has bugs. Provide the COMPLETE fixed code.');
        lines.push('');
        lines.push(FENCE + 'javascript');
        lines.push(code);
        lines.push(FENCE);
        lines.push('');
        lines.push('Errors:');
        errors.forEach(function (e, i) {
            lines.push((i + 1) + '. [' + e.type + '] ' + e.message);
        });
        lines.push('');
        lines.push('Use ' + CODE_START + ' and ' + CODE_END + ' markers.');
        lines.push('Replace backticks with ' + BACKTICK_ESC);
        lines.push('When done: ' + FINISH);
        lines.push('!!! ' + FINISH + ' IS REQUIRED !!!');
        return lines.join('\n');
    }

    function parseResponse(text) {
        parseOutline(text);
        parseCodeBlocks(text);
        parseTestCode(text);
    }

    function parseOutline(text) {
        if (outline) return;
        var match = text.match(/OUTLINE:?[\s\S]*?(<!DOCTYPE|<html|<\w|\/\/|#|\{)/i);
        if (!match) {
            var phMatches = text.match(/>>>\$([A-Z0-9_]+)<<</g);
            if (phMatches && phMatches.length >= 2) {
                extractPlaceholders(text);
            }
            return;
        }
        extractPlaceholders(text);
    }

    function extractPlaceholders(text) {
        var phs = [];
        var re = />>>\$([A-Z0-9_]+)<<</g;
        var m;
        while ((m = re.exec(text)) !== null) {
            if (phs.indexOf(m[1]) === -1) phs.push(m[1]);
        }
        if (phs.length === 0) return;
        phs.forEach(function (name) {
            if (!parts.hasOwnProperty(name)) parts[name] = null;
        });
        outline = text.substring(0, text.indexOf(CODE_START) > 0 ? text.indexOf(CODE_START) : text.length);
        log('Outline: ' + phs.length + ' placeholders found: ' + phs.join(', '), 'success');
        renderParts();
    }

    function parseCodeBlocks(text) {
        var startTag = CODE_START;
        var endTag = CODE_END;
        var idx = 0;
        while (true) {
            var si = text.indexOf(startTag, idx);
            if (si === -1) break;
            var ei = text.indexOf(endTag, si);
            if (ei === -1) {
                handlePartialBlock(text, si);
                break;
            }
            var block = text.substring(si + startTag.length, ei);
            processBlock(block);
            idx = ei + endTag.length;
        }
        setProgress(calcProgress());
        renderParts();
    }

    function handlePartialBlock(text, startIdx) {
        var block = text.substring(startIdx + CODE_START.length);
        var nameMatch = block.match(/^\s*([A-Z0-9_]+)/);
        if (nameMatch) {
            currentPlaceholder = nameMatch[1];
            var code = extractCodeFromBlock(block);
            if (code && parts.hasOwnProperty(currentPlaceholder)) {
                parts[currentPlaceholder] = mergeOverlap(parts[currentPlaceholder], code);
                log('Partial: ' + currentPlaceholder + ' (will continue)', 'warn');
            }
        }
    }

    function processBlock(block) {
        var nameMatch = block.match(/^\s*([A-Z0-9_]+)/);
        if (!nameMatch) return;
        var name = nameMatch[1];
        var code = extractCodeFromBlock(block);
        if (!code) return;
        code = unescBackticks(code);
        if (!parts.hasOwnProperty(name)) parts[name] = null;
        parts[name] = mergeOverlap(parts[name], code);
        currentPlaceholder = name;
        log('Filled: ' + name + ' (' + code.split('\n').length + ' lines)', 'success');
    }

    function extractCodeFromBlock(block) {
        var lines = block.split('\n');
        var inCode = false;
        var codeLines = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (!inCode && line.trim().indexOf(BT + BT + BT) === 0) {
                inCode = true;
                continue;
            }
            if (inCode && line.trim() === BT + BT + BT) {
                inCode = false;
                continue;
            }
            if (inCode) codeLines.push(line);
        }
        if (codeLines.length === 0) {
            var filtered = lines.slice(1).filter(function (l) { return l.trim().length > 0; });
            return filtered.join('\n');
        }
        return codeLines.join('\n');
    }

    function parseTestCode(text) {
        var si = text.indexOf(TEST_START);
        var ei = text.indexOf(TEST_END);
        if (si === -1 || ei === -1) return;
        var tc = text.substring(si + TEST_START.length, ei).trim();
        parts['__TEST__'] = tc;
        log('Test code extracted.', 'info');
    }

    function unescBackticks(code) {
        return code.replace(/>>>BACKTICK<<</g, BT);
    }

    function mergeOverlap(existing, fragment) {
        if (!existing) return fragment;
        if (!fragment) return existing;
        var overlap = findOverlap(existing, fragment);
        if (overlap > 0) {
            log('Overlap: ' + overlap + ' lines merged', 'info');
            return existing + '\n' + fragment.split('\n').slice(overlap).join('\n');
        }
        return existing + '\n' + fragment;
    }

    function findOverlap(a, b) {
        var aL = a.split('\n');
        var bL = b.split('\n');
        var max = Math.min(aL.length, bL.length, 20);
        var best = 0;
        for (var n = 1; n <= max; n++) {
            var tail = aL.slice(-n).map(function (l) { return l.trim(); }).join('\n');
            var head = bL.slice(0, n).map(function (l) { return l.trim(); }).join('\n');
            if (tail === head) best = n;
        }
        return best;
    }

    function assemble() {
        var keys = Object.keys(parts).filter(function (k) { return k !== '__TEST__'; });
        if (keys.length === 0) return '';
        if (!outline) return concatAll();
        var result = outline;
        keys.forEach(function (k) {
            var ph = '>>>$' + k + '<<<';
            if (parts[k]) {
                result = result.split(ph).join(parts[k]);
            }
        });
        result = cleanAssembly(result);
        return result;
    }

    function cleanAssembly(text) {
        text = text.replace(/>>>CODE STARTS<<<[\s\S]*?>>>CODE ENDS<<</g, '');
        text = text.replace(/OUTLINE:?\s*/gi, '');
        var fenceRe = new RegExp(FENCE + '[a-z]*\\n?', 'g');
        text = text.replace(fenceRe, '');
        text = text.replace(/\n{3,}/g, '\n\n');
        return text.trim();
    }

    function concatAll() {
        return Object.keys(parts).filter(function (k) {
            return k !== '__TEST__' && parts[k];
        }).map(function (k) {
            return '// === ' + k + ' ===\n' + parts[k];
        }).join('\n\n');
    }

    function runTests(mainCode, testCode) {
        log('Running tests...', 'info');
        var synErr = checkSyntax(mainCode);
        if (synErr) return { passed: false, errors: [synErr] };
        return execTest(mainCode, testCode);
    }

    function checkSyntax(code) {
        try { new Function(code); return null; }
        catch (e) { return { type: 'SyntaxError', message: e.message }; }
    }

    function execTest(main, test) {
        try {
            var fn = new Function(
                'var __e=[];' +
                'var _l=console.log;console.log=function(){};' +
                'try{' + main + '}catch(e){__e.push({type:e.name,message:e.message});}' +
                'try{' + test + '}catch(e){__e.push({type:"TestFail",message:e.message});}' +
                'console.log=_l;return{errors:__e};'
            );
            var r = fn();
            if (r.errors.length) {
                log('FAIL: ' + r.errors[0].message, 'error');
                return { passed: false, errors: r.errors };
            }
            log('All tests passed!', 'success');
            return { passed: true, errors: [] };
        } catch (e) {
            return { passed: false, errors: [{ type: e.name, message: e.message }] };
        }
    }

    function isJSLang() {
        var jsKeys = Object.keys(parts).filter(function (k) {
            return k.indexOf('JS') !== -1 || k.indexOf('TS') !== -1;
        });
        return jsKeys.length > 0;
    }

    function getJSCode() {
        return Object.keys(parts).filter(function (k) {
            return k !== '__TEST__' && (k.indexOf('JS') !== -1 || k.indexOf('TS') !== -1);
        }).map(function (k) {
            return parts[k] || '';
        }).join('\n\n');
    }

    function start(userText) {
        running = true;
        parts = {};
        outline = '';
        currentPlaceholder = null;
        retries = 0;
        lastTurns = getTurns();
        logEntries = [];
        updateBtn();
        showLog();
        renderParts();
        setProgress(0);
        log('Starting...', 'success');
        submitPrompt(buildInitialPrompt(userText));
        setTimeout(function () { beginPoll(); }, 4000);
    }

    function stop() {
        running = false;
        clearPollInterval();
        hideTimer();
        updateBtn();
        log('Stopped.', 'warn');
    }

    function beginPoll() {
        if (!running) return;
        clearPollInterval();
        pollId = setInterval(function () {
            if (!running) { clearPollInterval(); return; }
            if (stillGenerating()) return;
            var t = getTurns();
            if (t > lastTurns) {
                lastTurns = t;
                clearPollInterval();
                log('Response #' + t + ' received.', 'info');
                setTimeout(function () { onResponse(); }, SETTLE_MS);
            }
        }, POLL_MS);
    }

    function clearPollInterval() {
        if (pollId) { clearInterval(pollId); pollId = null; }
    }

    function onResponse() {
        if (!running) return;
        var text = getLastTurnText();
        parseResponse(text);
        var finished = text.indexOf(FINISH) !== -1;
        if (finished) {
            onFinished();
        } else {
            onCutOff();
        }
    }

    function onFinished() {
        log('FINISH signal received!', 'success');
        setProgress(100);
        if (parts['__TEST__'] && isJSLang()) {
            var jsCode = getJSCode();
            var result = runTests(jsCode, parts['__TEST__']);
            if (!result.passed && retries < MAX_RETRIES) {
                retries++;
                log('Tests failed. Fixing (attempt ' + retries + ')...', 'warn');
                scheduleSubmit(buildFixPrompt(result.errors, jsCode));
                return;
            }
        }
        finalize();
    }

    function onCutOff() {
        retries++;
        if (retries > MAX_RETRIES) {
            log('Max retries (' + MAX_RETRIES + '). Finalizing.', 'error');
            finalize();
            return;
        }
        log('Cut off. Continuing (' + retries + '/' + MAX_RETRIES + ')...', 'warn');
        scheduleSubmit(buildContinuePrompt());
    }

    function scheduleSubmit(text) {
        log('Waiting ' + (DELAY_MS / 1000) + 's...', 'info');
        showTimer(DELAY_MS, 'next submit');
        setTimeout(function () {
            if (!running) { hideTimer(); return; }
            hideTimer();
            log('Submitting...', 'info');
            submitPrompt(text);
            lastTurns = getTurns();
            setTimeout(function () { beginPoll(); }, 5000);
        }, DELAY_MS);
    }

    function finalize() {
        var output = assemble();
        showPanel(output);
        stop();
        log('Done! ' + Object.keys(parts).filter(function (k) {
            return k !== '__TEST__' && parts[k];
        }).length + ' parts assembled.', 'success');
    }

    function createUI() {
        if (document.getElementById('acv6-bar')) return;
        createBar();
        createLogPanel();
        createTimerEl();
        createProgressBar();
        createPartsPanel();
        createResultPanel();
        //retryHideOriginal();
    }

    function createBar() {
        var bar = document.createElement('div');
        bar.id = 'acv6-bar';
        var input = document.createElement('textarea');
        input.id = 'acv6-input';
        input.placeholder = 'Type prompt... (Enter = Go, Shift+Enter = newline)';
        input.rows = 1;
        var btn = document.createElement('button');
        btn.id = 'acv6-go';
        btn.textContent = '\u25B6';
        bar.appendChild(input);
        bar.appendChild(btn);
        document.body.appendChild(bar);
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                toggleAction();
            }
        });
        btn.addEventListener('click', toggleAction);
    }

    function toggleAction() {
        if (running) { stop(); return; }
        var input = document.getElementById('acv6-input');
        var text = input.value.trim();
        if (!text) { log('Enter a prompt.', 'warn'); return; }
        input.value = '';
        start(text);
    }

    function updateBtn() {
        var btn = document.getElementById('acv6-go');
        if (!btn) return;
        btn.textContent = running ? '\u23F9' : '\u25B6';
        btn.className = running ? 'on' : '';
    }

    function createLogPanel() {
        var el = document.createElement('div');
        el.id = 'acv6-log';
        document.body.appendChild(el);
        var toggle = document.createElement('button');
        toggle.id = 'acv6-log-toggle';
        toggle.textContent = '\uD83D\uDCCB';
        toggle.addEventListener('click', function () {
            el.classList.toggle('visible');
        });
        document.body.appendChild(toggle);
    }

    function createTimerEl() {
        var el = document.createElement('div');
        el.id = 'acv6-timer';
        el.innerHTML = [
            '<svg class="acv6-ring" viewBox="0 0 36 36">',
            '<circle class="acv6-ring-bg" cx="18" cy="18" r="16"/>',
            '<circle class="acv6-ring-fg" id="acv6-ring-fg" cx="18" cy="18" r="16"/>',
            '</svg>',
            '<span id="acv6-timer-sec">30</span>',
            '<span id="acv6-timer-lbl">waiting</span>'
        ].join('');
        document.body.appendChild(el);
    }

    function createProgressBar() {
        var el = document.createElement('div');
        el.id = 'acv6-progress';
        el.innerHTML = '<div id="acv6-progress-fill"></div>';
        document.body.appendChild(el);
    }

    function createPartsPanel() {
        var el = document.createElement('div');
        el.id = 'acv6-parts';
        document.body.appendChild(el);
    }

    function createResultPanel() {
        var el = document.createElement('div');
        el.id = 'acv6-panel';
        el.innerHTML = [
            '<div id="acv6-panel-head">',
            '<span>Final Merged Code</span>',
            '<span id="acv6-panel-info"></span>',
            '</div>',
            '<div id="acv6-panel-body"></div>',
            '<div id="acv6-panel-foot">',
            '<button class="acv6-btn acv6-btn--cp" id="acv6-p-copy">Copy</button>',
            '<button class="acv6-btn acv6-btn--dl" id="acv6-p-dl">Download</button>',
            '<button class="acv6-btn acv6-btn--cl" id="acv6-p-close">Close</button>',
            '</div>'
        ].join('');
        document.body.appendChild(el);
        document.getElementById('acv6-p-close').addEventListener('click', hidePanel);
        document.getElementById('acv6-p-copy').addEventListener('click', copyResult);
        document.getElementById('acv6-p-dl').addEventListener('click', downloadResult);
    }

    function showPanel(code) {
        var panel = document.getElementById('acv6-panel');
        var body = document.getElementById('acv6-panel-body');
        var info = document.getElementById('acv6-panel-info');
        body.textContent = code;
        info.textContent = code.split('\n').length + ' lines';
        panel.classList.add('visible');
    }

    function hidePanel() {
        document.getElementById('acv6-panel').classList.remove('visible');
    }

    function copyResult() {
        var code = assemble();
        navigator.clipboard.writeText(code).then(function () {
            log('Copied!', 'success');
        });
    }

    function downloadResult() {
        var code = assemble();
        var ext = isJSLang() ? 'html' : 'txt';
        var blob = new Blob([code], { type: 'text/plain' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'output.' + ext;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        log('Downloaded output.' + ext, 'success');
    }

    function retryHideOriginal() {
        return;
        var attempts = 0;
        var iv = setInterval(function () {
            hideOriginalInput();
            attempts++;
            if (attempts > 15) clearInterval(iv);
        }, 2000);
    }

    function init() {
        injectStyles();
        createUI();
        log('Auto-Coder v6 ready. One button.', 'success');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
