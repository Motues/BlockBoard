// 设置弹窗（底部齿轮按钮）：界面语言 + 开发者密码 + 数据备份的导出 / 导入。
//
//   · 语言改动是即时预览的（下拉里一选界面就跟着变），点「关闭」会退回打开弹窗时的语言
//   · 点「保存」写入本地并收起弹窗
//   · 开发者密码只存在这台设备的浏览器里（blockboard-dev-password），
//     点「开发者工具」时会拿它去服务端换 token，校验始终在服务端
//   · 数据导出 / 导入会把 game-config.json 与二进制存档打包 / 还原，属于危险操作。
//     服务端要的是**同一个**管理员密码（就是开发者密码），所以这里不再单独要一遍：
//     直接用上面那栏已保存的密码（没保存过就先用当前显示的密码换一次 token）。
//     导入会覆盖服务端数据，所以按钮点第一下只是变成「确认覆盖？」。

import { getLang, onLangChange, setLang, t, LANGUAGES } from './i18n.mjs';
import { closeOptionsPanel } from './ring.mjs';
import { serverInfo } from './shared.mjs';
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
const exportButton = document.getElementById('settings-export');
const importButton = document.getElementById('settings-import');
const importInput = document.getElementById('settings-import-file');
const transferStatusEl = document.getElementById('settings-transfer-status');
const versionEl = document.getElementById('settings-version');
const versionSeparatorEl = document.getElementById('settings-version-sep');

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

// 版本号对应的 release 页：https://github.com/Motues/BlockBoard/releases/tag/v1.7.1
const RELEASES_URL = 'https://github.com/Motues/BlockBoard/releases';

// 左下角那行：产品名写在 index.html 里（固定链到仓库），这里把版本号补成 “BlockBoard | v1.7.1”
// 并链到对应的 release 页。版本号来自服务端 package.json（init-game 的 version）；
// 老服务端不发这个字段，就把分隔符和版本号一起藏起来，只留产品名。
function renderVersion() {
    const version = serverInfo.version;
    const known = Boolean(version);

    versionEl.hidden = !known;
    versionSeparatorEl.hidden = !known;

    if (!known) return;

    versionEl.textContent = `v${version}`;
    versionEl.href = `${RELEASES_URL}/tag/v${version}`;
}

// --- 弹窗 ---
export function isSettingsOpen() {
    return open;
}

export function openSettingsPanel() {
    openedLang = getLang();
    renderLanguage();
    renderVersion();
    closeLanguageMenu();
    passwordEl.value = getSavedDevPassword();

    // 数据备份：状态行清空，密码直接用上面那栏的开发者密码
    setTransferStatus('');
    resetImportConfirm();
    renderImportButton();

    modalEl.classList.remove('hidden');
    open = true;
}

function hide() {
    open = false;
    closeLanguageMenu();
    passwordEl.value = '';
    setTransferStatus('');
    resetImportConfirm();
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

// --- 数据备份：导出 / 导入 ---
// 用的就是开发者密码（服务端校验的也是它），所以不在这里再要一遍：
// 取本地已保存的那份，没保存过就先用输入框里的密码换一次 token 验一下

let busy = false;
let importArmed = false;
let importTimer = 0;

function setTransferStatus(text, kind) {
    transferStatusEl.textContent = text || '';
    transferStatusEl.classList.toggle('error', kind === 'error');
    transferStatusEl.classList.toggle('ok', kind === 'ok');
}

/**
 * 拿一份可以发给服务端的管理员密码。
 *
 * 本来就没有单独的「管理员密码」——服务端校验的就是开发者密码，所以直接用上面那栏
 * 已保存的那份（`blockboard-dev-password`）。没保存过就提示先在上面填好并保存，
 * 绝不在数据备份这边偷偷替用户存一份密码：校验始终在服务端，失败照样按 IP 计入锁定。
 */
function resolveAdminPassword() {
    const password = getSavedDevPassword();
    if (password) return password;

    toast(t('transfer.needPassword'), 'error');
    passwordEl.focus();
    return null;
}

function resetImportConfirm() {
    importArmed = false;
    importButton.classList.remove('armed');
    renderImportButton();

    if (importTimer) {
        clearTimeout(importTimer);
        importTimer = 0;
    }
}

// 导入按钮的文字随语言与「待确认」状态变，所以别用 data-i18n，自己渲染
function renderImportButton() {
    importButton.textContent = importArmed ? t('transfer.importConfirm') : t('transfer.import');
}

function formatSize(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

// 服务端返回的是 JSON 错误 → 映射成 i18n 文案；503 时说明服务端没设密码（管理功能整个关闭）
const TRANSFER_ERROR_KEYS = {
    'bad-password': 'transfer.badPassword',
    locked: 'transfer.locked',
    disabled: 'transfer.disabled',
    'bad-package': 'transfer.badPackage',
    'bad-config': 'transfer.badPackage',
    'bad-save': 'transfer.badPackage',
    'too-large': 'transfer.tooLarge'
};

async function readError(response) {
    let payload = null;

    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    const code = payload && typeof payload.error === 'string' ? payload.error : '';
    if (TRANSFER_ERROR_KEYS[code]) return t(TRANSFER_ERROR_KEYS[code]);

    return (payload && typeof payload.message === 'string' && payload.message) || t('transfer.failed');
}

async function exportData() {
    if (busy) return;

    const password = resolveAdminPassword();
    if (!password) return;

    busy = true;
    exportButton.disabled = true;
    setTransferStatus(t('transfer.exporting'));

    try {
        const response = await fetch('/api/dev/export', {
            method: 'POST',
            headers: { 'x-dev-password': password }
        });

        if (!response.ok) {
            setTransferStatus(await readError(response), 'error');
            return;
        }

        const blob = await response.blob();
        const disposition = response.headers.get('content-disposition') || '';
        const match = /filename="?([^";]+)"?/.exec(disposition);
        const filename = match ? match[1] : 'BlockBoard-backup.bbx';

        const link = document.createElement('a');
        link.download = filename;
        link.href = URL.createObjectURL(blob);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);

        setTransferStatus(t('transfer.exported', { size: formatSize(blob.size) }), 'ok');
    } catch (error) {
        console.error('Failed to export the data package:', error);
        setTransferStatus(t('transfer.failed'), 'error');
    } finally {
        busy = false;
        exportButton.disabled = false;
    }
}

async function importData() {
    if (busy) return;

    const file = importInput.files && importInput.files[0];
    if (!file) {
        toast(t('transfer.noFile'), 'error');
        return;
    }

    // 覆盖服务端的棋盘与配置文件，点第一下只是确认（3 秒内再点一次才真的上传）
    if (!importArmed) {
        importArmed = true;
        importButton.classList.add('armed');
        renderImportButton();
        importTimer = setTimeout(resetImportConfirm, 3000);
        return;
    }

    const password = resolveAdminPassword();
    if (!password) {
        resetImportConfirm();
        return;
    }

    busy = true;
    resetImportConfirm();
    importButton.disabled = true;
    setTransferStatus(t('transfer.importing'));

    try {
        const body = new FormData();
        body.append('package', file, file.name);

        const response = await fetch('/api/dev/import', {
            method: 'POST',
            headers: { 'x-dev-password': password },
            body
        });

        if (!response.ok) {
            setTransferStatus(await readError(response), 'error');
            return;
        }

        const payload = await response.json();

        setTransferStatus(t('transfer.imported', {
            cols: payload.cols,
            rows: payload.rows,
            size: payload.sizeChanged ? t('transfer.sizeChanged') : ''
        }), 'ok');

        // 导入成功后棋盘会重同步，没必要再留着旧文件名
        importInput.value = '';
    } catch (error) {
        console.error('Failed to import the data package:', error);
        setTransferStatus(t('transfer.failed'), 'error');
    } finally {
        busy = false;
        importButton.disabled = false;
    }
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

    // --- 数据备份 ---
    exportButton.addEventListener('click', exportData);

    importButton.addEventListener('click', importData);

    // 文件选择框是隐藏的，由「导入存档」旁边的按钮去点它
    document.getElementById('settings-import-pick').addEventListener('click', () => {
        importInput.click();
    });

    importInput.addEventListener('change', () => {
        resetImportConfirm();
        const file = importInput.files && importInput.files[0];
        setTransferStatus(file ? file.name : '');
    });

    // 换语言时把「确认覆盖？」收回去并重画按钮文字，免得英文按钮上挂着中文
    onLangChange(() => resetImportConfirm());

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
