// js/gmTopbar.js
//
// Cross-tool top nav injected into each editor. Small chrome bar with:
//   - gmc64 logo (goes to index.html)
//   - "editors ▾" dropdown listing all 5 editors, in the same order
//     as gmTools.js's quit-menu popup (kept in loose sync)
//   - community link
//   - github link
//
// The current page is marked with aria-current="page" on its dropdown
// item (or on the flat link for community).
//
// CSS lives in css/gm-ui.css under .gm-topbar. Editors that want the
// bar just include this script; no per-page markup required.
//
// NOT loaded by play.html — the game-runner has minimal chrome by
// design (embedded in iframes, fullscreen mode, etc.). NOT loaded by
// index.html / community.html either — those have their own richer
// static navs.

(function () {

    // Order intentionally mirrors gmTools.js quitMenu.show() so the
    // dropdown and the popup show the same list in the same order.
    // Update both together when links change.
    const EDITORS = [
        { label: 'program editor', href: 'program-editor.html' },
        { label: 'sprite maker',   href: 'sprite-maker.html' },
        { label: 'sound maker',    href: 'sound-maker.html' },
        { label: 'scene maker',    href: 'scene-maker.html' },
        { label: 'music maker',    href: 'music-maker.html' },
    ];

    const currentPage = location.pathname.split('/').pop() || 'index.html';

    // Build markup. Everything is static text or hrefs from the fixed
    // EDITORS list — nothing user-supplied — so template strings are
    // safe here. If that ever changes, escape aggressively.
    const nav = document.createElement('nav');
    nav.className = 'gm-topbar';
    nav.setAttribute('aria-label', 'Site navigation');
    nav.innerHTML = `
        <a class="gm-topbar-logo" href="index.html">gmc64</a>
        <div class="gm-topbar-links">
            <div class="gm-topbar-dropdown" data-open="false">
                <button class="gm-topbar-dropdown-trigger" type="button"
                        aria-haspopup="true" aria-expanded="false">
                    editors<span class="gm-topbar-chevron">▾</span>
                </button>
                <div class="gm-topbar-dropdown-menu" role="menu">
                    ${EDITORS.map(e => `
                        <a role="menuitem" href="${e.href}"${
                            e.href === currentPage ? ' aria-current="page"' : ''
                        }>${e.label}</a>
                    `).join('')}
                </div>
            </div>
            <a href="community.html"${
                currentPage === 'community.html' ? ' aria-current="page"' : ''
            }>community</a>
            <a href="https://github.com/needlestack/gmc64">github</a>
        </div>
    `;

    // Insert as first child of <body> so the bar sits above the editor
    // stage. Wait for DOMContentLoaded if this script loaded before
    // <body> was parsed (unusual, but safe).
    function inject() {
        document.body.insertBefore(nav, document.body.firstChild);
        wireDropdown();
    }
    if (document.body) inject();
    else document.addEventListener('DOMContentLoaded', inject);

    function wireDropdown() {
        const dropdown = nav.querySelector('.gm-topbar-dropdown');
        const trigger  = dropdown.querySelector('.gm-topbar-dropdown-trigger');

        function setOpen(open) {
            dropdown.dataset.open = String(open);
            trigger.setAttribute('aria-expanded', String(open));
        }

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            setOpen(dropdown.dataset.open !== 'true');
        });
        // Click anywhere outside the dropdown closes it. Attach to
        // document (not window) so it fires reliably in all browsers.
        document.addEventListener('click', (e) => {
            if (dropdown.dataset.open === 'true' && !dropdown.contains(e.target)) {
                setOpen(false);
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && dropdown.dataset.open === 'true') {
                setOpen(false);
                e.preventDefault();
            }
        });
    }
})();
