// 设置弹窗（底部齿轮按钮）：界面语言 + 开发者密码。
//
//   · 语言改动是即时预览的（下拉里一选界面就跟着变），点「关闭」会退回打开弹窗时的语言
//   · 点「保存」写入本地并收起弹窗
//   · 开发者密码只存在这台设备的浏览器里（blockboard-dev-password），
//     点「开发者工具」时会拿它去服务端换 token，校验始终在服务端

import { getLang, setLang, t, LANGUAGES } from './i18n.mjs';
import { closeOptionsPanel } from './ring.mjs';
import { toast } from './toast.mjs';

const DEV_PASSWORD_KEY = 'blockboard-dev-password';

const modalEl = document.getElementById('settings-modal');
const langEl = document.getElementById('settings-language');            // 下拉容器
const langValueEl = document.getElementById('settings-language-value');  // 下拉的触发按钮
const langLabelEl = document.getElementById('settings-language-label');
const langMenuEl = document.getElementById('settings-language-menu');
const langOptionEls = Array.from(langMenuEl.querySelectorAll('.settings-select-option'));
const passwordEl = document.getElementById('settings-dev-password');
const settingsButton = document.getElementById('settings-button');

let open = false;
// 打开弹窗时的语言：取消时退回去
let openedLang = 'en';

// --- 本地保存的开发者密码 ---
export function getSavedDevPassword() {
    try {
        return localStorage.getItem(DEV_PASSWORD_KEY) || '';
    } catch {
        return '';
    }
}

export function setSavedDevPassword(value) {
    const password = typeof value === 'string' ? value : '';

    try {
        if (password) localStorage.setItem(DEV_PASSWORD_KEY, password);
        else localStorage.removeItem(DEV_PASSWORD_KEY);
    } catch {
        // 隐私模式下写不了，忽略
    }
}

export function clearSavedDevPassword() {
    setSavedDevPassword('');
}

// --- 语言下拉（自绘，不用系统原生 select）---
// 语言名用它自己的语言写，不随界面语言变
function renderLanguage() {
    const lang = getLang();
    const current = LANGUAGES.find(item => item.code === lang);
    langLabelEl.textContent = current ? current.label : lang;

    for (const option of langOptionEls) {
        const active = option.dataset.lang === lang;
        option.classList.toggle('active', active);
        option.setAttribute('aria-selected', active ? 'true' : 'false');
    }
}

function isLanguageMenuOpen() {
    return !langMenuEl.classList.contains('hidden');
}

function openLanguageMenu() {
    langEl.classList.add('open');
    langMenuEl.classList.remove('hidden');
    langValueEl.setAttribute('aria-expanded', 'true');
}

function closeLanguageMenu() {
    langEl.classList.remove('open');
    langMenuEl.classList.add('hidden');
    langValueEl.setAttribute('aria-expanded', 'false');
}

// --- 弹窗 ---
export function isSettingsOpen() {
    return open;
}

export function openSettingsPanel() {
    openedLang = getLang();
    renderLanguage();
    closeLanguageMenu();
    passwordEl.value = getSavedDevPassword();

    modalEl.classList.remove('hidden');
    open = true;
}

function hide() {
    open = false;
    closeLanguageMenu();
    passwordEl.value = '';
    modalEl.classList.add('hidden');
}

// 关闭 / Esc / 点外面：丢掉没保存的改动（语言也退回原样）
export function closeSettingsPanel() {
    if (!open) return;

    if (getLang() !== openedLang) setLang(openedLang);
    hide();
}

function saveSettings() {
    if (!open) return;

    // 语言在选的时候就已经生效并存好了，这里只需要落盘密码
    setSavedDevPassword(passwordEl.value.trim());
    hide();

    toast(t('settings.saved'));
}

export function bindSettingsEvents() {
    settingsButton.addEventListener('click', () => {
        if (isSettingsOpen()) closeSettingsPanel();
        else openSettingsPanel();
    });

    // 移动端：设置入口收在选项面板里（桌面端底部按钮条里有齿轮按钮），
    // 面板要顺手收起来，别让它压在弹窗下面
    document.getElementById('settings-option').addEventListener('click', () => {
        closeOptionsPanel();
        openSettingsPanel();
    });

    document.getElementById('settings-save').addEventListener('click', saveSettings);
    document.getElementById('settings-close').addEventListener('click', closeSettingsPanel);

    langValueEl.addEventListener('click', () => {
        if (isLanguageMenuOpen()) closeLanguageMenu();
        else openLanguageMenu();
    });

    // 选语言：立刻生效（预览），保存 / 取消时再定下来
    for (const option of langOptionEls) {
        option.addEventListener('click', () => {
            setLang(option.dataset.lang);
            renderLanguage();
            closeLanguageMenu();
        });
    }

    passwordEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveSettings();
    });

    // 点别处：先收下拉，再考虑收起整个弹窗
    document.addEventListener('click', (e) => {
        if (isLanguageMenuOpen() &&
            !(e.target.closest && e.target.closest('#settings-language'))) {
            closeLanguageMenu();
        }

        if (!open) return;
        if (e.target.closest && e.target.closest('#settings-modal, #settings-button')) return;
        closeSettingsPanel();
    }, true);

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !open) return;

        // 下拉开着就先收下拉，再按一次才关弹窗
        if (isLanguageMenuOpen()) {
            closeLanguageMenu();
            return;
        }

        closeSettingsPanel();
    });
}
