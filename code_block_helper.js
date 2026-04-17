// ==UserScript==
// @name         You.com Code Block Helper v3
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Gorgeous sticky toolbar for code blocks on You.com
// @match        https://you.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const ATTR = 'data-ch-processed';
    const toolbars = [];

    /* ── Styles ────────────────────────────────────────── */
    const css = document.createElement('style');
    css.textContent = `
        /* ===== Figure wrapper ===== */
        figure[${ATTR}] {
            position: relative;
            transition: box-shadow .35s ease, border-color .35s ease;
            border-radius: 10px;
        }
        figure[${ATTR}]:hover {
            box-shadow:
                0 0 0 1.5px rgba(167,139,250,.30),
                0 0 30px rgba(139,92,246,.07),
                0 0 60px rgba(99,102,241,.04);
        }

        /* ===== Toolbar ===== */
        .ch-tb {
            display: flex;
            align-items: center;
            gap: 5px;
            padding: 6px 10px;
            border-radius: 0 8px 0 12px;
            z-index: 999999;
            pointer-events: auto;

            /* Glassmorphism */
            background: linear-gradient(
                135deg,
                rgba(15,15,25,.88) 0%,
                rgba(25,20,50,.92) 50%,
                rgba(15,15,25,.88) 100%
            );
            border-bottom: 1px solid rgba(167,139,250,.18);
            border-left: 1px solid rgba(167,139,250,.10);
            backdrop-filter: blur(20px) saturate(1.8);
            -webkit-backdrop-filter: blur(20px) saturate(1.8);
            box-shadow:
                0 8px 32px rgba(0,0,0,.50),
                inset 0 1px 0 rgba(255,255,255,.06),
                inset 0 0 20px rgba(139,92,246,.03);

            /* Reveal animation */
            opacity: 0;
            transform: translateY(-4px) scale(.98);
            transition: opacity .25s ease, transform .25s ease;
        }

        figure:hover > .ch-tb,
        .ch-tb--sticky,
        .ch-tb--always {
            opacity: 1 !important;
            transform: translateY(0) scale(1) !important;
        }

        .ch-tb--abs {
            position: absolute;
            top: 0;
            right: 0;
        }
        .ch-tb--sticky {
            position: sticky;
            top: 0;
            right: 0;
            float: right;
        }
        .ch-tb--hide { display: none !important; }

        /* ===== Animated shimmer border ===== */
        .ch-tb::before {
            content: '';
            position: absolute;
            inset: -1px;
            border-radius: inherit;
            padding: 1px;
            background: linear-gradient(
                135deg,
                transparent 30%,
                rgba(139,92,246,.25) 50%,
                rgba(236,72,153,.20) 60%,
                transparent 80%
            );
            background-size: 300% 300%;
            -webkit-mask:
                linear-gradient(#fff 0 0) content-box,
                linear-gradient(#fff 0 0);
            -webkit-mask-composite: xor;
            mask-composite: exclude;
            animation: ch-shimmer 6s ease infinite;
            pointer-events: none;
            opacity: 0;
            transition: opacity .3s;
        }
        figure:hover > .ch-tb::before,
        .ch-tb--sticky::before {
            opacity: 1;
        }
        @keyframes ch-shimmer {
            0%   { background-position: 0% 50%; }
            50%  { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
        }

        /* ===== Language badge ===== */
        .ch-lang {
            font: bold 9.5px/1 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
            text-transform: uppercase;
            letter-spacing: .8px;
            padding: 4px 8px;
            border-radius: 5px;
            background: linear-gradient(135deg, #7c3aed, #a855f7);
            color: #f3e8ff;
            margin-right: 2px;
            user-select: none;
            box-shadow: 0 2px 8px rgba(124,58,237,.30);
            text-shadow: 0 1px 2px rgba(0,0,0,.3);
        }

        /* ===== Line count ===== */
        .ch-lines {
            font: 600 9.5px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            padding: 4px 8px;
            border-radius: 5px;
            background: rgba(255,255,255,.06);
            color: rgba(255,255,255,.40);
            user-select: none;
        }

        /* ===== Divider ===== */
        .ch-div {
            width: 1px;
            height: 20px;
            background: linear-gradient(
                180deg,
                transparent,
                rgba(167,139,250,.25),
                transparent
            );
            margin: 0 3px;
            flex-shrink: 0;
        }

        /* ===== Buttons (base) ===== */
        .ch-btn {
            position: relative;
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 5px 13px;
            border: none;
            border-radius: 7px;
            cursor: pointer;
            font: 600 11px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            white-space: nowrap;
            transition:
                background .18s ease,
                color .18s ease,
                box-shadow .18s ease,
                transform .12s ease;
            overflow: hidden;
        }
        .ch-btn:hover {
            transform: translateY(-1px);
        }
        .ch-btn:active {
            transform: scale(.95);
        }

        /* Glow on hover */
        .ch-btn::after {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: inherit;
            opacity: 0;
            transition: opacity .2s;
            pointer-events: none;
        }
        .ch-btn:hover::after {
            opacity: 1;
        }

        /* — Copy — */
        .ch-btn--copy {
            background: linear-gradient(135deg, rgba(56,189,248,.12), rgba(99,102,241,.12));
            color: #93c5fd;
        }
        .ch-btn--copy:hover {
            background: linear-gradient(135deg, rgba(56,189,248,.28), rgba(99,102,241,.28));
            color: #fff;
            box-shadow: 0 4px 16px rgba(56,189,248,.20);
        }

        /* — Save — */
        .ch-btn--dl {
            background: linear-gradient(135deg, rgba(251,146,60,.12), rgba(245,158,11,.12));
            color: #fdba74;
        }
        .ch-btn--dl:hover {
            background: linear-gradient(135deg, rgba(251,146,60,.28), rgba(245,158,11,.28));
            color: #fff;
            box-shadow: 0 4px 16px rgba(251,146,60,.20);
        }

        /* — Top — */
        .ch-btn--top {
            background: linear-gradient(135deg, rgba(168,85,247,.12), rgba(139,92,246,.12));
            color: #c4b5fd;
        }
        .ch-btn--top:hover {
            background: linear-gradient(135deg, rgba(168,85,247,.28), rgba(139,92,246,.28));
            color: #fff;
            box-shadow: 0 4px 16px rgba(168,85,247,.20);
        }

        /* — Bottom — */
        .ch-btn--bot {
            background: linear-gradient(135deg, rgba(244,114,182,.12), rgba(236,72,153,.12));
            color: #f9a8d4;
        }
        .ch-btn--bot:hover {
            background: linear-gradient(135deg, rgba(244,114,182,.28), rgba(236,72,153,.28));
            color: #fff;
            box-shadow: 0 4px 16px rgba(244,114,182,.20);
        }

        /* — Continue — */
        .ch-btn--cont {
            background: linear-gradient(135deg, rgba(52,211,153,.12), rgba(16,185,129,.12));
            color: #6ee7b7;
        }
        .ch-btn--cont:hover {
            background: linear-gradient(135deg, rgba(52,211,153,.28), rgba(16,185,129,.28));
            color: #fff;
            box-shadow: 0 4px 16px rgba(52,211,153,.20);
        }

        /* ===== Success flash ===== */
        @keyframes ch-flash {
            0%   { background-position: 0% 50%; }
            100% { background-position: 200% 50%; }
        }
        .ch-btn--ok {
            background: linear-gradient(
                90deg,
                rgba(52,211,153,.30),
                rgba(16,185,129,.45),
                rgba(52,211,153,.30)
            ) !important;
            background-size: 200% 100% !important;
            animation: ch-flash .6s ease !important;
            color: #a7f3d0 !important;
        }

        /* ===== Particle burst on copy ===== */
        @keyframes ch-particle {
            0%   { transform: translate(0,0) scale(1); opacity: 1; }
            100% { transform: translate(var(--dx), var(--dy)) scale(0); opacity: 0; }
        }
        .ch-particle {
            position: absolute;
            width: 4px;
            height: 4px;
            border-radius: 50%;
            pointer-events: none;
            animation: ch-particle .55s ease-out forwards;
        }
    `;
    document.head.appendChild(css);

    /* ── Helpers ───────────────────────────────────────── */
    function codeOf(fig) {
        const c = fig.querySelector('code');
        return c ? c.textContent : '';
    }

    function langOf(fig) {
        const code = fig.querySelector('code');
        if (!code) return '';
        for (const cls of code.classList) {
            const m = cls.match(/^(?:language-|lang-)(.+)/i);
            if (m) return m[1];
        }
        const cap = fig.querySelector('figcaption, [data-language]');
        if (cap) return cap.textContent.trim().split(/\s/)[0];
        return '';
    }

    function lineCount(fig) {
        const txt = codeOf(fig);
        return txt ? txt.split('\n').length : 0;
    }

    function extFor(lang) {
        const map = {
            javascript:'js', js:'js', typescript:'ts', ts:'ts',
            python:'py', py:'py', java:'java', cpp:'cpp', c:'c',
            csharp:'cs', cs:'cs', go:'go', rust:'rs', ruby:'rb',
            php:'php', html:'html', css:'css', scss:'scss',
            json:'json', yaml:'yaml', yml:'yml', xml:'xml',
            bash:'sh', sh:'sh', shell:'sh', sql:'sql',
            swift:'swift', kotlin:'kt', lua:'lua', r:'r',
            markdown:'md', md:'md', toml:'toml',
        };
        return map[(lang || '').toLowerCase()] || lang || 'txt';
    }

    function makeBtn(label, cls, fn) {
        const b = document.createElement('button');
        b.className = `ch-btn ${cls}`;
        b.innerHTML = label;
        b.addEventListener('click', fn);
        return b;
    }

    function flash(btn, html, duration = 1400) {
        const orig = btn.innerHTML;
        btn.innerHTML = html;
        btn.classList.add('ch-btn--ok');
        setTimeout(() => {
            btn.innerHTML = orig;
            btn.classList.remove('ch-btn--ok');
        }, duration);
    }

    /* Particle burst effect */
    function burst(btn) {
        const colors = ['#a78bfa','#f472b6','#38bdf8','#34d399','#fbbf24','#fb923c'];
        const rect = btn.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        for (let i = 0; i < 10; i++) {
            const p = document.createElement('div');
            p.className = 'ch-particle';
            const angle = (Math.PI * 2 * i) / 10 + (Math.random() - .5) * .5;
            const dist = 20 + Math.random() * 30;
            p.style.cssText = `
                left:${cx}px; top:${cy}px;
                position:fixed;
                background:${colors[i % colors.length]};
                --dx:${Math.cos(angle) * dist}px;
                --dy:${Math.sin(angle) * dist}px;
                z-index:9999999;
            `;
            document.body.appendChild(p);
            setTimeout(() => p.remove(), 600);
        }
    }

    function setInputAndSubmit(text) {
        const ta = document.getElementById('search-input-textarea');
        if (!ta) return;
        const set = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype, 'value'
        ).set;
        set.call(ta, text);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => {
            const form = ta.closest('form');
            if (!form) return;
            const sub = form.querySelector('[type="submit"]');
            if (sub) sub.click();
        }, 300);
    }

    function copyText(text, feedbackBtn) {
        const ok = () => {
            burst(feedbackBtn);
            flash(feedbackBtn, '✅ Copied!');
        };
        if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(ok).catch(() => fallbackCopy(text, ok));
        } else {
            fallbackCopy(text, ok);
        }
    }

    function fallbackCopy(text, cb) {
        const t = document.createElement('textarea');
        t.value = text;
        document.body.appendChild(t);
        t.select();
        document.execCommand('copy');
        t.remove();
        cb();
    }

    function downloadCode(fig) {
        const lang = langOf(fig);
        const ext = extFor(lang);
        const code = codeOf(fig);
        const blob = new Blob([code], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `code.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    /* ── Toolbar factory ──────────────────────────────── */
    function makeTB(fig) {
        const tb = document.createElement('div');
        tb.className = 'ch-tb ch-tb--abs';

        // Language badge
        const lang = langOf(fig);
        if (lang) {
            const badge = document.createElement('span');
            badge.className = 'ch-lang';
            badge.textContent = lang;
            tb.appendChild(badge);
        }

        // Line count
        const lines = lineCount(fig);
        if (lines > 0) {
            const lc = document.createElement('span');
            lc.className = 'ch-lines';
            lc.textContent = `${lines} ln`;
            tb.appendChild(lc);
        }

        const div = () => {
            const d = document.createElement('span');
            d.className = 'ch-div';
            return d;
        };
        tb.appendChild(div());

        // Copy
        const copyB = makeBtn('📋 Copy', 'ch-btn--copy', () => copyText(codeOf(fig), copyB));
        tb.appendChild(copyB);

        // Download
        const dlB = makeBtn('💾 Save', 'ch-btn--dl', () => {
            downloadCode(fig);
            burst(dlB);
            flash(dlB, '✅ Saved!');
        });
        tb.appendChild(dlB);

        tb.appendChild(div());

        // Scroll Top
        tb.appendChild(makeBtn('⬆ Top', 'ch-btn--top', () =>
            fig.scrollIntoView({ behavior: 'smooth', block: 'start' })
        ));

        // Scroll Bottom
        tb.appendChild(makeBtn('⬇ End', 'ch-btn--bot', () =>
            fig.scrollIntoView({ behavior: 'smooth', block: 'end' })
        ));

        tb.appendChild(div());

        // Continue
        tb.appendChild(makeBtn('▶ Continue', 'ch-btn--cont', () => {
            const allLines = codeOf(fig).split('\n').filter(l => l.trim());
            const tail = allLines.slice(-6).join('\n');
            setInputAndSubmit(
                'Continue the code from where you left off. ' +
                'Here are the last lines for context:\n```\n' +
                tail + '\n```\nPlease continue from there.'
            );
        }));

        tb._fig = fig;
        return tb;
    }

    /* ── Scan & attach ────────────────────────────────── */
    function scan() {
        document.querySelectorAll(`figure:not([${ATTR}])`).forEach(fig => {
            if (!fig.querySelector('code')) return;
            fig.setAttribute(ATTR, '1');

            // Ensure figure is a positioning context
            const cs = getComputedStyle(fig);
            if (cs.position === 'static') {
                fig.style.position = 'relative';
            }

            const tb = makeTB(fig);
            fig.prepend(tb);
            toolbars.push(tb);
        });
    }

    /* ── Scroll: pin toolbar to top of code block ───── */
    function reposition() {
        for (const tb of toolbars) {
            const fig = tb._fig;
            if (!fig || !document.contains(fig)) continue;

            const r = fig.getBoundingClientRect();

            if (r.bottom <= 60 || r.top >= window.innerHeight) {
                // Figure completely out of view
                tb.classList.add('ch-tb--hide');
                tb.classList.remove('ch-tb--sticky');
                resetPos(tb);
            } else if (r.top >= 0) {
                // Figure top is visible → sit at top-right of figure
                tb.classList.remove('ch-tb--hide', 'ch-tb--sticky');
                resetPos(tb);
                tb.style.position = 'absolute';
                tb.style.top = '0';
                tb.style.right = '0';
            } else {
                // Figure top scrolled out but bottom still visible → stick
                tb.classList.remove('ch-tb--hide');
                tb.classList.add('ch-tb--sticky');

                // Use fixed positioning pinned to the figure's right edge
                const tbW = tb.offsetWidth || 400;
                const rightEdge = r.right;
                const leftPos = Math.max(8, rightEdge - tbW);

                tb.style.position = 'fixed';
                tb.style.top = '10px';
                tb.style.left = leftPos + 'px';
                tb.style.right = 'auto';
            }
        }
    }

    function resetPos(tb) {
        tb.style.position = '';
        tb.style.top = '';
        tb.style.left = '';
        tb.style.right = '';
    }

    /* ── Cleanup stale ────────────────────────────────── */
    function cleanup() {
        for (let i = toolbars.length - 1; i >= 0; i--) {
            if (!document.contains(toolbars[i]._fig)) {
                toolbars[i].remove();
                toolbars.splice(i, 1);
            }
        }
    }

    /* ── Bootstrap ────────────────────────────────────── */
    new MutationObserver(() => { scan(); cleanup(); })
        .observe(document.body, { childList: true, subtree: true });

    window.addEventListener('scroll', reposition, { passive: true });
    document.addEventListener('scroll', reposition, { passive: true, capture: true });
    window.addEventListener('resize', reposition, { passive: true });

    scan();
    reposition();
})();
