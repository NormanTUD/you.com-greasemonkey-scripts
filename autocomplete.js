// ==UserScript==
// @name         You.com Auto-Coder v5
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Single-button auto-continue, smart merge with placeholders, model-driven JS testing
// @match        https://you.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* ══════════════════════════════════════════════════════
       CONSTANTS
    ══════════════════════════════════════════════════════ */
    const ATTR = 'data-acv5';
    const FINISH_SIGNAL = 'I REALLY NOW FINISHED';
    const TEST_START = '>>>TESTCODE STARTS<<<';
    const TEST_END = '>>>TESTCODE ENDS<<<';
    const SUBMIT_DELAY = 30000;
    const MAX_RETRIES = 15;
    const POLL_INTERVAL = 3000;
    const DOM_SETTLE_MS = 2500;

    /* ══════════════════════════════════════════════════════
       STATE
    ══════════════════════════════════════════════════════ */
    let running = false;
    let mergedParts = [];
    let retryCount = 0;
    let lastTurnCount = 0;
    let pollTimer = null;

    /* ══════════════════════════════════════════════════════
       STYLES
    ══════════════════════════════════════════════════════ */
    function injectStyles() {
        const s = document.createElement('style');
        s.textContent = getStyleText();
        document.head.appendChild(s);
    }

    function getStyleText() {
        return `
            /* Hide original input area visually */
            .ch-hidden-original {
                position: absolute !important;
                width: 1px !important; height: 1px !important;
                overflow: hidden !important;
                clip: rect(0,0,0,0) !important;
                white-space: nowrap !important;
                border: 0 !important;
                padding: 0 !important;
                margin: -1px !important;
            }

            /* Our input bar */
            #acv5-bar {
                position: fixed; bottom: 0; left: 0; right: 0;
                z-index: 9999999;
                display: flex; align-items: stretch; gap: 0;
                background: rgba(12,10,24,.97);
                border-top: 1px solid rgba(139,92,246,.25);
                backdrop-filter: blur(16px);
                padding: 0;
            }
            #acv5-input {
                flex: 1;
                min-height: 52px; max-height: 220px;
                resize: none;
                padding: 14px 18px;
                border: none; outline: none;
                background: transparent;
                color: #e2e8f0;
                font: 14px/1.5 'SF Mono','Fira Code','Consolas',monospace;
            }
            #acv5-input::placeholder { color: rgba(255,255,255,.25); }
            #acv5-go {
                width: 64px; min-height: 52px;
                border: none; cursor: pointer;
                background: linear-gradient(135deg,#7c3aed,#6366f1);
                color: #fff; font: 700 18px/1 sans-serif;
                transition: opacity .2s;
            }
            #acv5-go:hover { opacity: .85; }
            #acv5-go.running {
                background: linear-gradient(135deg,#dc2626,#ef4444);
                animation: acv5-pulse 1.2s infinite;
            }
            @keyframes acv5-pulse {
                0%,100% { opacity:1; } 50% { opacity:.6; }
            }
            #acv5-status {
                position: fixed; bottom: 56px; left: 0; right: 0;
                padding: 4px 16px;
                font: 11px/1.4 'SF Mono',monospace;
                color: rgba(255,255,255,.5);
                background: rgba(12,10,24,.85);
                border-top: 1px solid rgba(139,92,246,.12);
                z-index: 9999998;
                pointer-events: none;
                transition: color .2s;
            }
            #acv5-status.ok { color: #6ee7b7; }
            #acv5-status.err { color: #fca5a5; }
            #acv5-status.warn { color: #fbbf24; }

            /* Merged panel */
            #acv5-panel {
                position: fixed; top: 50%; left: 50%;
                transform: translate(-50%,-50%);
                width: 70vw; max-width: 900px; max-height: 80vh;
                z-index: 99999999;
                background: rgba(15,12,30,.98);
                border: 1px solid rgba(139,92,246,.35);
                border-radius: 14px;
                display: none; flex-direction: column;
                box-shadow: 0 30px 80px rgba(0,0,0,.7);
                overflow: hidden;
            }
            #acv5-panel.visible { display: flex; }
            #acv5-panel-head {
                padding: 12px 16px;
                background: rgba(139,92,246,.08);
                border-bottom: 1px solid rgba(139,92,246,.2);
                display: flex; justify-content: space-between; align-items: center;
                font: 600 13px/1 -apple-system,sans-serif; color: #c4b5fd;
            }
            #acv5-panel-body {
                flex: 1; overflow: auto; padding: 14px;
                font: 12px/1.6 'SF Mono','Fira Code',monospace;
                color: #e2e8f0; white-space: pre-wrap; tab-size: 2;
            }
            #acv5-panel-foot {
                padding: 10px 14px;
                border-top: 1px solid rgba(139,92,246,.2);
                display: flex; gap: 8px;
            }
            .acv5-pbtn {
                padding: 6px 14px; border: none; border-radius: 7px;
                cursor: pointer; font: 600 11px/1.3 -apple-system,sans-serif;
                transition: all .15s;
            }
            .acv5-pbtn:hover { transform: translateY(-1px); }
            .acv5-pbtn--copy { background: rgba(56,189,248,.15); color: #93c5fd; }
            .acv5-pbtn--dl { background: rgba(251,146,60,.15); color: #fdba74; }
            .acv5-pbtn--close { background: rgba(239,68,68,.15); color: #fca5a5; }

            /* Code block mini-toolbar (minimal) */
            .acv5-minitb {
                position: absolute; top: 4px; right: 4px;
                display: flex; gap: 3px; opacity: 0;
                transition: opacity .2s;
                z-index: 999;
            }
            figure:hover .acv5-minitb { opacity: 1; }
            .acv5-mbtn {
                padding: 3px 8px; border: none; border-radius: 5px;
                cursor: pointer; font: 600 10px/1 sans-serif;
                background: rgba(255,255,255,.08); color: rgba(255,255,255,.6);
                transition: all .15s;
            }
            .acv5-mbtn:hover { background: rgba(139,92,246,.3); color: #fff; }
        `;
    }

    /* ══════════════════════════════════════════════════════
       LOGGING
    ══════════════════════════════════════════════════════ */
    function log(msg, type = 'info') {
        const pre = '[ACv5]';
        const c = { info:'#6ee7b7', warn:'#fbbf24', error:'#fca5a5', success:'#34d399' };
        console.log(`%c${pre} ${msg}`, `color:${c[type]||c.info};font-weight:bold`);
        setStatus(msg, type);
    }

    function setStatus(msg, type = 'info') {
        const el = document.getElementById('acv5-status');
        if (!el) return;
        el.textContent = `[${timeStr()}] ${msg}`;
        el.className = type === 'error' ? 'err' : type === 'warn' ? 'warn' : 'ok';
    }

    function timeStr() {
        return new Date().toLocaleTimeString();
    }

    /* ══════════════════════════════════════════════════════
       DOM QUERIES
    ══════════════════════════════════════════════════════ */
    function getOriginalTextarea() {
        return document.querySelector('#search-input-textarea');
    }

    function getOriginalForm() {
        const ta = getOriginalTextarea();
        return ta ? ta.closest('form') : null;
    }

    function getTurnCount() {
        return document.querySelectorAll('[data-testid^="youchat-answer-turn-"]').length;
    }

    function getLatestTurnEl() {
        const all = document.querySelectorAll('[data-testid^="youchat-answer-turn-"]');
        return all.length ? all[all.length - 1] : null;
    }

    function getLatestText() {
        const el = getLatestTurnEl();
        return el ? el.textContent || '' : '';
    }

    function getAllCodeBlocksInTurn(turnEl) {
        if (!turnEl) return [];
        return [...turnEl.querySelectorAll('figure code')];
    }

    function getLatestCodeBlocks() {
        return getAllCodeBlocksInTurn(getLatestTurnEl());
    }

    function isStillGenerating() {
        const unfinished = document.querySelectorAll('[data-testid^="step-"][data-finished="false"]');
        if (unfinished.length > 0) return true;
        const sub = document.querySelector('[data-testid="search-input-send-button"]');
        if (sub && sub.disabled) return true;
        return false;
    }

    function hasFinishSignal() {
        const spans = document.querySelectorAll('[data-testid="youchat-text"]');
        for (const s of spans) {
            if (s.textContent.includes(FINISH_SIGNAL)) return true;
        }
        return false;
    }

    /* ══════════════════════════════════════════════════════
       INPUT / SUBMIT
    ══════════════════════════════════════════════════════ */
    function submitText(text) {
        const ta = getOriginalTextarea();
        if (!ta) { log('Textarea not found!', 'error'); return false; }
        setNativeValue(ta, text);
        fireInputEvents(ta);
        setTimeout(() => clickSubmit(ta), 350);
        return true;
    }

    function setNativeValue(el, val) {
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        set.call(el, val);
    }

    function fireInputEvents(el) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function clickSubmit(ta) {
        const form = ta.closest('form');
        if (!form) return;
        const btn = form.querySelector('button[type="submit"], [data-testid="search-input-send-button"]');
        if (btn) { btn.disabled = false; btn.click(); }
        else form.dispatchEvent(new Event('submit', { bubbles: true }));
    }

    /* ══════════════════════════════════════════════════════
       HIDE ORIGINAL TEXTAREA
    ══════════════════════════════════════════════════════ */
    function hideOriginalInput() {
        const form = getOriginalForm();
        if (!form) return;
        const wrapper = form.closest('[class*="input"]') || form.parentElement;
        if (wrapper && !wrapper.classList.contains('ch-hidden-original')) {
            wrapper.classList.add('ch-hidden-original');
            log('Original input hidden', 'info');
        }
    }

    function showOriginalInput() {
        const hidden = document.querySelector('.ch-hidden-original');
        if (hidden) hidden.classList.remove('ch-hidden-original');
    }

    /* ══════════════════════════════════════════════════════
       PART LABELING & PLACEHOLDER SYSTEM
    ══════════════════════════════════════════════════════ */
    function detectPartLabel(codeEl) {
        const lang = detectLang(codeEl);
        const labels = { html:'HTML Part', css:'CSS Part', javascript:'JS Part', js:'JS Part',
            typescript:'TS Part', python:'Python Part', json:'JSON Part', bash:'Shell Part' };
        return labels[lang] || `${lang.toUpperCase()} Part`;
    }

    function detectLang(codeEl) {
        for (const cls of codeEl.classList) {
            const m = cls.match(/^(?:language-|lang-)(.+)/i);
            if (m) return m[1].toLowerCase();
        }
        return 'text';
    }

    function addPart(code, label, lang) {
        mergedParts.push({ code: code.trim(), label, lang, id: mergedParts.length });
        log(`Added part #${mergedParts.length}: "${label}" (${code.split('\n').length} lines)`, 'success');
    }

    function buildFinalOutput() {
        if (mergedParts.length === 0) return '';
        if (mergedParts.length === 1) return mergedParts[0].code;
        return assemblePlaceholders();
    }

    function assemblePlaceholders() {
        const htmlParts = mergedParts.filter(p => p.lang === 'html');
        const jsParts = mergedParts.filter(p => isJSLang(p.lang));
        const cssParts = mergedParts.filter(p => p.lang === 'css');
        const otherParts = mergedParts.filter(p => !['html','css'].includes(p.lang) && !isJSLang(p.lang));

        // If there's an HTML part with placeholders, fill them
        if (htmlParts.length > 0) {
            return mergeHTMLWithParts(htmlParts, jsParts, cssParts, otherParts);
        }
        // Otherwise just concatenate labeled
        return concatLabeled();
    }

    function mergeHTMLWithParts(htmlParts, jsParts, cssParts, otherParts) {
        let html = htmlParts.map(p => p.code).join('\n');

        // Replace %%JS_PLACEHOLDER%% or similar
        if (jsParts.length > 0) {
            const jsCode = jsParts.map(p => p.code).join('\n\n');
            html = html.replace(/%%JS[_ ]?PLACEHOLDER%%/gi, jsCode);
            html = html.replace(/<script><\/script>/gi, `<script>\n${jsCode}\n</script>`);
        }
        if (cssParts.length > 0) {
            const cssCode = cssParts.map(p => p.code).join('\n\n');
            html = html.replace(/%%CSS[_ ]?PLACEHOLDER%%/gi, cssCode);
            html = html.replace(/<style><\/style>/gi, `<style>\n${cssCode}\n</style>`);
        }
        // Append others as comments
        if (otherParts.length > 0) {
            html += '\n\n' + otherParts.map(p => `<!-- ${p.label} -->\n${p.code}`).join('\n\n');
        }
        return html;
    }

    function concatLabeled() {
        return mergedParts.map(p => {
            return `// ═══ ${p.label} (Part ${p.id + 1}) ═══\n${p.code}`;
        }).join('\n\n');
    }

    /* ══════════════════════════════════════════════════════
       SMART OVERLAP MERGE (for continuation fragments)
    ══════════════════════════════════════════════════════ */
    function mergeOverlapping(existing, fragment) {
        if (!existing) return fragment;
        if (!fragment) return existing;
        const overlap = findOverlapLines(existing, fragment);
        if (overlap > 0) {
            log(`Overlap: ${overlap} lines removed`, 'info');
            const fragLines = fragment.split('\n');
            return existing + '\n' + fragLines.slice(overlap).join('\n');
        }
        return existing + '\n' + fragment;
    }

    function findOverlapLines(a, b) {
        const aLines = a.split('\n');
        const bLines = b.split('\n');
        const maxCheck = Math.min(aLines.length, bLines.length, 25);
        let best = 0;
        for (let n = 1; n <= maxCheck; n++) {
            if (tailMatchesHead(aLines, bLines, n)) best = n;
        }
        return best;
    }

    function tailMatchesHead(aLines, bLines, n) {
        const tail = aLines.slice(-n).map(l => l.trim()).join('\n');
        const head = bLines.slice(0, n).map(l => l.trim()).join('\n');
        return tail === head;
    }

    /* ══════════════════════════════════════════════════════
       JS TESTING (model-driven via markers)
    ══════════════════════════════════════════════════════ */
    function extractTestCode(text) {
        const startIdx = text.indexOf(TEST_START);
        const endIdx = text.indexOf(TEST_END);
        if (startIdx === -1 || endIdx === -1) return null;
        return text.substring(startIdx + TEST_START.length, endIdx).trim();
    }

    function runTestCode(testCode, mainCode) {
        log('Running model-provided test code...', 'info');
        try {
            const wrapped = buildTestWrapper(testCode, mainCode);
            const result = eval(wrapped);
            return processTestResult(result);
        } catch (e) {
            return { passed: false, errors: [{ type: e.name, message: e.message }] };
        }
    }

    function buildTestWrapper(testCode, mainCode) {
        return `(function(){
            const __errs=[], __logs=[];
            const _log = console.log;
            console.log=(...a)=>{__logs.push(a.join(' '));};
            try { ${mainCode} } catch(e){ __errs.push({type:e.name,message:e.message}); }
            try { ${testCode} } catch(e){ __errs.push({type:'TestError',message:e.message}); }
            console.log=_log;
            return {errors:__errs,logs:__logs};
        })()`;
    }

    function processTestResult(result) {
        if (result.errors.length > 0) {
            log(`Tests FAILED: ${result.errors[0].message}`, 'error');
            return { passed: false, errors: result.errors, logs: result.logs };
        }
        log(`Tests PASSED ✓ (${result.logs.length} outputs)`, 'success');
        return { passed: true, errors: [], logs: result.logs };
    }

    function syntaxCheck(code) {
        try { new Function(code); return null; }
        catch (e) { return { type: 'SyntaxError', message: e.message }; }
    }

    function buildFixPrompt(errors, code) {
        let p = 'The code has bugs. Fix them and give the COMPLETE corrected code.\n\n';
        p += '```javascript\n' + code + '\n```\n\nErrors:\n';
        errors.forEach((e, i) => { p += `${i+1}. [${e.type}] ${e.message}\n`; });
        p += `\nWhen done, end with: ${FINISH_SIGNAL}`;
        return p;
    }

    function isJSLang(lang) {
        return ['javascript','js','jsx','typescript','ts','tsx'].includes(lang);
    }

    /* ══════════════════════════════════════════════════════
       PROMPT WRAPPING
    ══════════════════════════════════════════════════════ */
    function wrapPrompt(userText) {
        return `${userText}

IMPORTANT INSTRUCTIONS FOR YOUR RESPONSE:
1. Modularize everything. All functions must be ~10 lines max. Break large functions into smaller helpers.
2. Label each code block clearly: "JS Part", "HTML Part", "CSS Part", etc.
3. If the code is JavaScript/TypeScript, include test code between these exact markers:
   ${TEST_START}
   // your test assertions here, e.g.:
   // if (typeof myFunc !== 'function') throw new Error('myFunc not defined');
   ${TEST_END}
4. If the code is NOT JS (e.g. Python, HTML-only, etc.), do NOT include test markers.
5. Use %%JS_PLACEHOLDER%% inside HTML where JS should be inserted, and %%CSS_PLACEHOLDER%% for CSS.
6. When you are COMPLETELY finished with ALL code, end your response with exactly:
   ${FINISH_SIGNAL}
7. If your response gets cut off, I will ask you to continue. Pick up exactly where you left off.`;
    }

    function buildContinuePrompt(lastCode) {
        const tail = lastCode.split('\n').filter(l => l.trim()).slice(-8).join('\n');
        return `Continue from where you left off. Last lines:
\`\`\`
${tail}
\`\`\`
Continue immediately from there. Same rules apply. End with: ${FINISH_SIGNAL}`;
    }

    /* ══════════════════════════════════════════════════════
       AUTO-CONTINUE ENGINE
    ══════════════════════════════════════════════════════ */
    function startEngine(userPrompt) {
        running = true;
        retryCount = 0;
        mergedParts = [];
        lastTurnCount = getTurnCount();
        updateButton();
        log('Engine started — submitting prompt...', 'success');
        submitText(wrapPrompt(userPrompt));
        setTimeout(() => beginPolling(), 4000);
    }

    function stopEngine() {
        running = false;
        clearPoll();
        updateButton();
        log('Engine stopped.', 'warn');
    }

    function beginPolling() {
        if (!running) return;
        clearPoll();
        pollTimer = setInterval(() => pollCheck(), POLL_INTERVAL);
    }

    function clearPoll() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function pollCheck() {
        if (!running) { clearPoll(); return; }
        if (isStillGenerating()) { log('Generating...', 'info'); return; }
        const turns = getTurnCount();
        if (turns > lastTurnCount) {
            lastTurnCount = turns;
            clearPoll();
            log(`Response #${turns} complete. Processing...`, 'info');
            setTimeout(() => handleResponse(), DOM_SETTLE_MS);
        }
    }

    function handleResponse() {
        if (!running) return;
        const text = getLatestText();
        const codeEls = getLatestCodeBlocks();
        collectParts(codeEls);
        const testCode = extractTestCode(text);
        const finished = text.includes(FINISH_SIGNAL);

        if (finished) {
            handleFinished(testCode);
        } else {
            handleCutOff();
        }
    }

    function collectParts(codeEls) {
        codeEls.forEach(el => {
            const lang = detectLang(el);
            const label = detectPartLabel(el);
            const code = el.textContent.trim();
            if (code.length > 10) addPart(code, label, lang);
        });
    }

    function handleFinished(testCode) {
        log('🎉 FINISH SIGNAL received!', 'success');
        const jsParts = mergedParts.filter(p => isJSLang(p.lang));

        if (testCode && jsParts.length > 0) {
            const jsCode = jsParts.map(p => p.code).join('\n\n');
            const synErr = syntaxCheck(jsCode);
            if (synErr) {
                retryWithFix([synErr], jsCode);
                return;
            }
            const result = runTestCode(testCode, jsCode);
            if (!result.passed && retryCount < MAX_RETRIES) {
                retryWithFix(result.errors, jsCode);
                return;
            }
        }
        finalize();
    }

    function handleCutOff() {
        retryCount++;
        if (retryCount > MAX_RETRIES) {
            log(`Max retries (${MAX_RETRIES}) hit. Finalizing what we have.`, 'error');
            finalize();
            return;
        }
        log(`Cut off. Continuing (${retryCount}/${MAX_RETRIES})...`, 'warn');
        const lastPart = mergedParts.length > 0 ? mergedParts[mergedParts.length - 1].code : '';
        scheduleSubmit(buildContinuePrompt(lastPart));
    }

    function retryWithFix(errors, code) {
        retryCount++;
        if (retryCount > MAX_RETRIES) {
            log('Max fix retries reached. Finalizing.', 'error');
            finalize();
            return;
        }
        log(`Fixing bugs (attempt ${retryCount})...`, 'warn');
        scheduleSubmit(buildFixPrompt(errors, code));
    }

    function scheduleSubmit(text) {
        log(`Waiting ${SUBMIT_DELAY/1000}s before submit...`, 'info');
        setTimeout(() => {
            if (!running) return;
            log('Submitting...', 'info');
            submitText(text);
            lastTurnCount = getTurnCount();
            setTimeout(() => beginPolling(), 5000);
        }, SUBMIT_DELAY);
    }

    function finalize() {
        const output = buildFinalOutput();
        showPanel(output);
        stopEngine();
        log(`✅ Done! ${mergedParts.length} parts merged.`, 'success');
    }

    /* ══════════════════════════════════════════════════════
       UI: SINGLE INPUT BAR
    ══════════════════════════════════════════════════════ */
    function createUI() {
        if (document.getElementById('acv5-bar')) return;
        createInputBar();
        createStatusBar();
        createPanel();
        hideOriginalInput();
    }

    function createInputBar() {
        const bar = document.createElement('div');
        bar.id = 'acv5-bar';
        bar.innerHTML = `
            <textarea id="acv5-input" placeholder="Type your prompt… (Enter = Go, Shift+Enter = newline)" rows="1"></textarea>
            <button id="acv5-go">▶</button>
        `;
        document.body.appendChild(bar);
        bindInputEvents();
    }

    function bindInputEvents() {
        const input = document.getElementById('acv5-input');
        const btn = document.getElementById('acv5-go');
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); toggleAction(); }
        });
        btn.addEventListener('click', toggleAction);
    }

    function toggleAction() {
        if (running) { stopEngine(); return; }
        const input = document.getElementById('acv5-input');
        const text = input.value.trim();
        if (!text) { log('Enter a prompt first.', 'warn'); return; }
        input.value = '';
        startEngine(text);
    }

    function updateButton() {
        const btn = document.getElementById('acv5-go');
        if (!btn) return;
        btn.textContent = running ? '⏹' : '▶';
        btn.classList.toggle('running', running);
    }

    function createStatusBar() {
        const s = document.createElement('div');
        s.id = 'acv5-status';
        s.textContent = 'Ready';
        document.body.appendChild(s);
    }

    /* ══════════════════════════════════════════════════════
       UI: RESULT PANEL
    ══════════════════════════════════════════════════════ */
    function createPanel() {
        if (document.getElementById('acv5-panel')) return;
        const p = document.createElement('div');
        p.id = 'acv5-panel';
        p.innerHTML = `
            <div id="acv5-panel-head">
                <span>📦 Final Merged Code</span>
                <span id="acv5-panel-info"></span>
            </div>
            <div id="acv5-panel-body"></div>
            <div id="acv5-panel-foot">
                <button class="acv5-pbtn acv5-pbtn--copy" id="acv5-p-copy">📋 Copy</button>
                <button class="acv5-pbtn acv5-pbtn--dl" id="acv5-p-dl">💾 Download</button>
                <button class="acv5-pbtn acv5-pbtn--close" id="acv5-p-close">✕ Close</button>
            </div>
        `;
        document.body.appendChild(p);
        bindPanelEvents();
    }

    function bindPanelEvents() {
        document.getElementById('acv5-p-close').addEventListener('click', hidePanel);
        document.getElementById('acv5-p-copy').addEventListener('click', copyMerged);
        document.getElementById('acv5-p-dl').addEventListener('click', downloadMerged);
    }

    function showPanel(code) {
        const panel = document.getElementById('acv5-panel');
        const body = document.getElementById('acv5-panel-body');
        const info = document.getElementById('acv5-panel-info');
        body.textContent = code;
        info.textContent = `${mergedParts.length} parts · ${code.split('\n').length} lines`;
        panel.classList.add('visible');
    }

    function hidePanel() {
        document.getElementById('acv5-panel').classList.remove('visible');
    }

    function copyMerged() {
        const code = buildFinalOutput();
        navigator.clipboard.writeText(code).then(() => log('Copied!', 'success'));
    }

    function downloadMerged() {
        const code = buildFinalOutput();
        const mainLang = detectMainLang();
        const ext = getExtension(mainLang);
        const blob = new Blob([code], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        triggerDownload(url, `merged.${ext}`);
        URL.revokeObjectURL(url);
        log(`Downloaded merged.${ext}`, 'success');
    }

    function triggerDownload(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    function detectMainLang() {
        if (mergedParts.length === 0) return 'txt';
        const counts = {};
        mergedParts.forEach(p => { counts[p.lang] = (counts[p.lang] || 0) + 1; });
        return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    }

    function getExtension(lang) {
        const map = { javascript:'js', js:'js', typescript:'ts', ts:'ts',
            python:'py', html:'html', css:'css', json:'json',
            bash:'sh', go:'go', rust:'rs', ruby:'rb', php:'php',
            java:'java', cpp:'cpp', c:'c', swift:'swift', kotlin:'kt' };
        return map[lang] || lang || 'txt';
    }

    /* ══════════════════════════════════════════════════════
       CODE BLOCK MINI-TOOLBAR (minimal: just copy)
    ══════════════════════════════════════════════════════ */
    function attachMiniToolbar(fig) {
        if (fig.hasAttribute(ATTR)) return;
        fig.setAttribute(ATTR, '1');
        if (getComputedStyle(fig).position === 'static') {
            fig.style.position = 'relative';
        }
        const tb = buildMiniTB(fig);
        fig.prepend(tb);
    }

    function buildMiniTB(fig) {
        const tb = document.createElement('div');
        tb.className = 'acv5-minitb';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'acv5-mbtn';
        copyBtn.textContent = '📋';
        copyBtn.title = 'Copy code';
        copyBtn.addEventListener('click', () => copyFigCode(fig, copyBtn));
        tb.appendChild(copyBtn);
        return tb;
    }

    function copyFigCode(fig, btn) {
        const code = fig.querySelector('code');
        if (!code) return;
        navigator.clipboard.writeText(code.textContent).then(() => {
            btn.textContent = '✓';
            setTimeout(() => { btn.textContent = '📋'; }, 1200);
        });
    }

    /* ══════════════════════════════════════════════════════
       SCAN FOR NEW CODE BLOCKS
    ══════════════════════════════════════════════════════ */
    function scanCodeBlocks() {
        const figures = document.querySelectorAll(`figure:not([${ATTR}])`);
        figures.forEach(fig => {
            if (fig.querySelector('code')) attachMiniToolbar(fig);
        });
    }

    /* ══════════════════════════════════════════════════════
       MUTATION OBSERVER & INIT
    ══════════════════════════════════════════════════════ */
    function setupObserver() {
        const obs = new MutationObserver(() => scanCodeBlocks());
        obs.observe(document.body, { childList: true, subtree: true });
    }

    function hideOriginalInputRetry() {
        hideOriginalInput();
        // Retry a few times since You.com loads dynamically
        let attempts = 0;
        const iv = setInterval(() => {
            hideOriginalInput();
            attempts++;
            if (attempts > 10) clearInterval(iv);
        }, 2000);
    }

    function init() {
        injectStyles();
        createUI();
        setupObserver();
        scanCodeBlocks();
        hideOriginalInputRetry();
        log('Auto-Coder v5 ready. One button to rule them all.', 'success');
    }

    /* ══════════════════════════════════════════════════════
       BOOT
    ══════════════════════════════════════════════════════ */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
