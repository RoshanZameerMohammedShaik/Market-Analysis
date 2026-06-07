// Keyboard shortcuts. Bound globally; ignored while typing in inputs.
//
//   /  focus search
//   1  stock tab
//   2  crypto tab
//   t  today
//   m  tomorrow
//   r  refresh hot picks
//   p  toggle P&L panel
//   ?  toggle help dialog

import { openPLPanel, closePLPanel, isPLPanelOpen } from './pl-panel.js';

function togglePLPanel() {
    if (isPLPanelOpen()) closePLPanel();
    else openPLPanel({ shimmerTitle: true });
}

let helpOpen = false;

export function initKeyboard({ onRefresh }) {
    document.addEventListener('keydown', e => {
        const target = e.target;
        const inField = target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

        if (e.key === '?' && !inField) {
            e.preventDefault();
            toggleHelp();
            return;
        }
        if (e.key === 'Escape' && helpOpen) {
            toggleHelp();
            return;
        }

        if (inField) return;

        switch (e.key) {
            case '/':
                e.preventDefault();
                document.getElementById('search-input')?.focus();
                break;
            case '1': clickTab('stock'); break;
            case '2': clickTab('crypto'); break;
            case 't': clickTimeframe('today'); break;
            case 'm': clickTimeframe('tomorrow'); break;
            case 'r':
                e.preventDefault();
                onRefresh && onRefresh();
                break;
            case 'p':
            case 'P':
                e.preventDefault();
                togglePLPanel();
                break;
        }
    });
}

function clickTab(tab) {
    document.querySelector(`[data-tab="${tab}"]`)?.click();
}
function clickTimeframe(tf) {
    document.querySelector(`[data-timeframe="${tf}"]`)?.click();
}

function toggleHelp() {
    let dialog = document.getElementById('keyboard-help');
    if (helpOpen && dialog) {
        dialog.remove();
        helpOpen = false;
        return;
    }
    dialog = document.createElement('div');
    dialog.id = 'keyboard-help';
    dialog.className = 'kbd-help-overlay';
    dialog.innerHTML = `
        <div class="kbd-help-card">
            <div class="kbd-help-title">Keyboard Shortcuts</div>
            <div class="kbd-help-row"><kbd>/</kbd> <span>focus search</span></div>
            <div class="kbd-help-row"><kbd>1</kbd> <span>stock tab</span></div>
            <div class="kbd-help-row"><kbd>2</kbd> <span>crypto tab</span></div>
            <div class="kbd-help-row"><kbd>t</kbd> <span>today</span></div>
            <div class="kbd-help-row"><kbd>m</kbd> <span>tomorrow</span></div>
            <div class="kbd-help-row"><kbd>r</kbd> <span>refresh hot picks</span></div>
            <div class="kbd-help-row"><kbd>p</kbd> <span>toggle P&amp;L panel</span></div>
            <div class="kbd-help-row"><kbd>?</kbd> <span>toggle this help</span></div>
            <div class="kbd-help-row"><kbd>Esc</kbd> <span>close</span></div>
            <div class="kbd-help-foot">Click anywhere to close</div>
        </div>`;
    dialog.addEventListener('click', () => toggleHelp());
    document.body.appendChild(dialog);
    helpOpen = true;
}
