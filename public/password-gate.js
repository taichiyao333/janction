/**
 * Janction - Beta Access Password Gate
 * Injected into all pages by deploy_ftp.ps1
 * Password is injected at deploy time from .env (SITE_BETA_PASSWORD)
 */
(function () {
    'use strict';

    // ── Config (injected by deploy script) ──────────────────────────────────
    var BETA_PASSWORD = '__BETA_PASSWORD__';
    var STORAGE_KEY = 'janction_beta_auth';
    var SKIP_PATHS = ['/maintenance.html', '/admin', '/epsilon_mock', '/epsilon_mock/'];

    // ── Skip on admin / maintenance pages ───────────────────────────────────
    var path = location.pathname;
    for (var i = 0; i < SKIP_PATHS.length; i++) {
        if (path.indexOf(SKIP_PATHS[i]) !== -1) return;
    }

    // ── Already authenticated? ───────────────────────────────────────────────
    if (sessionStorage.getItem(STORAGE_KEY) === 'ok') return;

    // ── Build overlay ────────────────────────────────────────────────────────
    var style = document.createElement('style');
    style.textContent = [
        '#_pg_overlay{',
        'position:fixed;inset:0;z-index:99999;',
        'background:linear-gradient(135deg,#0a0e1a 0%,#0d1428 50%,#0a1020 100%);',
        'display:flex;align-items:center;justify-content:center;',
        'font-family:"Inter","Noto Sans JP",sans-serif;',
        '}',
        '#_pg_box{',
        'background:rgba(255,255,255,0.04);',
        'border:1px solid rgba(255,255,255,0.10);',
        'border-radius:20px;',
        'padding:48px 40px;',
        'width:100%;max-width:420px;',
        'box-shadow:0 24px 64px rgba(0,0,0,0.6),0 0 0 1px rgba(99,102,241,0.15);',
        'text-align:center;',
        'backdrop-filter:blur(12px);',
        '}',
        '#_pg_logo{',
        'display:flex;align-items:center;justify-content:center;gap:10px;',
        'margin-bottom:8px;',
        '}',
        '#_pg_logo svg{width:32px;height:32px;}',
        '#_pg_logo span{',
        'font-size:1.5rem;font-weight:700;',
        'background:linear-gradient(90deg,#818cf8,#60a5fa);',
        '-webkit-background-clip:text;-webkit-text-fill-color:transparent;',
        '}',
        '#_pg_badge{',
        'display:inline-block;',
        'padding:3px 12px;',
        'background:rgba(99,102,241,0.15);',
        'border:1px solid rgba(99,102,241,0.3);',
        'border-radius:20px;',
        'font-size:0.72rem;letter-spacing:0.08em;',
        'color:#a5b4fc;margin-bottom:28px;',
        '}',
        '#_pg_title{',
        'font-size:1.15rem;font-weight:600;color:#e2e8f0;',
        'margin-bottom:6px;',
        '}',
        '#_pg_sub{',
        'font-size:0.82rem;color:#64748b;margin-bottom:28px;',
        '}',
        '#_pg_input{',
        'width:100%;box-sizing:border-box;',
        'background:rgba(255,255,255,0.06);',
        'border:1px solid rgba(255,255,255,0.12);',
        'border-radius:10px;',
        'padding:13px 16px;',
        'font-size:1rem;color:#e2e8f0;',
        'outline:none;',
        'transition:border-color 0.2s;',
        'margin-bottom:12px;',
        'letter-spacing:0.12em;',
        '-webkit-text-security:disc;',
        '}',
        '#_pg_input:focus{border-color:#6366f1;}',
        '#_pg_btn{',
        'width:100%;padding:13px;',
        'background:linear-gradient(135deg,#6366f1,#4f46e5);',
        'border:none;border-radius:10px;',
        'color:#fff;font-size:0.95rem;font-weight:600;',
        'cursor:pointer;',
        'transition:opacity 0.2s,transform 0.1s;',
        'margin-bottom:16px;',
        '}',
        '#_pg_btn:hover{opacity:0.9;transform:translateY(-1px);}',
        '#_pg_btn:active{transform:translateY(0);}',
        '#_pg_err{',
        'font-size:0.82rem;color:#f87171;',
        'min-height:20px;transition:opacity 0.2s;',
        '}',
        '#_pg_footer{',
        'margin-top:32px;font-size:0.72rem;color:#334155;',
        '}',
        '@keyframes _pg_shake{',
        '0%,100%{transform:translateX(0);}',
        '20%,60%{transform:translateX(-6px);}',
        '40%,80%{transform:translateX(6px);}',
        '}',
        '._pg_shake{animation:_pg_shake 0.4s ease;}',
    ].join('');
    document.head.appendChild(style);

    var overlay = document.createElement('div');
    overlay.id = '_pg_overlay';
    overlay.innerHTML = [
        '<div id="_pg_box">',
        '<div id="_pg_logo">',
        '<svg viewBox="0 0 32 32" fill="none">',
        '<rect width="32" height="32" rx="8" fill="url(#pg_g)"/>',
        '<defs><linearGradient id="pg_g" x1="0" y1="0" x2="32" y2="32">',
        '<stop offset="0%" stop-color="#6366f1"/>',
        '<stop offset="100%" stop-color="#60a5fa"/>',
        '</linearGradient></defs>',
        '<path d="M8 20l5-8 4 6 3-4 4 6" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
        '</svg>',
        '<span>Janction</span>',
        '</div>',
        '<div id="_pg_badge">BETA ACCESS</div>',
        '<div id="_pg_title">ベータアクセス</div>',
        '<div id="_pg_sub">アクセスにはパスワードが必要です</div>',
        '<input id="_pg_input" type="password" placeholder="パスワードを入力" autocomplete="off"/>',
        '<button id="_pg_btn">アクセスする →</button>',
        '<div id="_pg_err"></div>',
        '<div id="_pg_footer">© 2025 METADATALAB.INC — Janction Beta</div>',
        '</div>',
    ].join('');

    // Wait for DOM
    function mount() {
        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';

        var input = document.getElementById('_pg_input');
        var btn = document.getElementById('_pg_btn');
        var err = document.getElementById('_pg_err');
        var box = document.getElementById('_pg_box');

        function attempt() {
            var val = input.value.trim();
            if (val === BETA_PASSWORD) {
                sessionStorage.setItem(STORAGE_KEY, 'ok');
                overlay.style.transition = 'opacity 0.4s';
                overlay.style.opacity = '0';
                setTimeout(function () {
                    overlay.remove();
                    document.body.style.overflow = '';
                }, 400);
            } else {
                err.textContent = '❌ パスワードが違います';
                box.classList.remove('_pg_shake');
                void box.offsetWidth; // reflow
                box.classList.add('_pg_shake');
                input.value = '';
                input.focus();
                setTimeout(function () { err.textContent = ''; }, 2500);
            }
        }

        btn.addEventListener('click', attempt);
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') attempt();
        });
        input.focus();
    }

    if (document.body) {
        mount();
    } else {
        document.addEventListener('DOMContentLoaded', mount);
    }
})();
