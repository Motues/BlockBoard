const socket = io();
const grid = document.getElementById('grid');
const gridContainer = document.getElementById('grid-container');

// --- UI 元素获取 ---
const settingsButton = document.getElementById('settings-button');
const optionsPanel = document.getElementById('options-panel');
const menuIcon = document.getElementById('menu-icon');
const closeIcon = document.getElementById('close-icon');

let isPanelOpen = false;

let cells = []; 
let pendingRequests = new Set(); 

let gridMetrics = {
    width: 0,
    height: 0,
    cols: 0,
    rows: 0,
    cellSize: 0
};

let viewState = {
    panning: false,
    startX: 0,
    startY: 0,
    translateX: 0,
    translateY: 0,
    hasMoved: false
};

// 显示提示弹窗并在一段时间后自动隐藏
function showHintPopup() {
    const hintPopup = document.getElementById('hint-popup');
    
    // 显示提示弹窗
    hintPopup.classList.remove('hidden');
    
    // 5秒后自动隐藏提示弹窗
    setTimeout(() => {
        hintPopup.classList.add('hidden');
    }, 10000);
}

// 关闭提示弹窗
function closeHintPopup() {
    const hintPopup = document.getElementById('hint-popup');
    hintPopup.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', function() {
    const hintPopup = document.getElementById('hint-popup');
    
    // 页面加载后延迟1秒显示提示弹窗
    setTimeout(() => {
        hintPopup.classList.remove('hidden');
    }, 1000);
    
    // 5秒后自动隐藏提示弹窗
    setTimeout(() => {
        hintPopup.classList.add('hidden');
    }, 11000);
});

// --- 设置按钮点击处理 (已优化渐变效果) ---
function toggleOptionsPanel() {
    isPanelOpen = !isPanelOpen;
    const transitionDuration = 300; // 0.3s

    if (isPanelOpen) {
        // 1. 确保元素立即可见，并取消 pointer-events: none;
        optionsPanel.style.visibility = 'visible'; 
        
        // 2. 移除 hidden 类触发 opacity 和 transform 渐变
        optionsPanel.classList.remove('hidden'); 
        
        // 3. 切换按钮图标
        menuIcon.style.display = 'none';
        closeIcon.style.display = 'block';
    } else {
        // 1. 添加 hidden 类触发 opacity 和 transform 渐变
        optionsPanel.classList.add('hidden');
        
        // 2. 渐变持续时间后，再彻底移除元素的可见性 (完成渐变)
        setTimeout(() => {
            if (!isPanelOpen) {
                optionsPanel.style.visibility = 'hidden'; 
            }
        }, transitionDuration); 

        // 3. 立即切换按钮图标
        menuIcon.style.display = 'block';
        closeIcon.style.display = 'none';
    }
}

// 绑定设置按钮事件
settingsButton.addEventListener('click', toggleOptionsPanel);


// --- Socket ---
socket.on('init-game', (data) => {
    const { config, state } = data;
    initGrid(config, state);
});

socket.on('update-square', ({ index, isBlack }) => {
    pendingRequests.delete(index);
    if (cells[index]) {
        updateCellView(cells[index], isBlack);
        cells[index].classList.remove('pending');
    }
});

socket.on('online-users', (count) => {
    document.getElementById('onlineCount').textContent = count;
});

// --- 初始化 ---
function initGrid(config, state) {
    grid.innerHTML = '';
    cells = [];

    gridMetrics.cols = config.cols;
    gridMetrics.rows = config.rows;
    gridMetrics.cellSize = config.cellSize;

    gridMetrics.width = config.cols * config.cellSize;
    gridMetrics.height = config.rows * config.cellSize;

    grid.style.gridTemplateColumns = `repeat(${config.cols}, ${config.cellSize}px)`;
    grid.style.gridTemplateRows = `repeat(${config.rows}, ${config.cellSize}px)`;

    const totalSquares = config.rows * config.cols;
    for (let i = 0; i < totalSquares; i++) {
        const div = document.createElement('div');
        div.className = 'cell';
        div.style.width = `${config.cellSize}px`;
        div.style.height = `${config.cellSize}px`;

        updateCellView(div, state[i]);
        div.addEventListener('click', (e) => handleCellClick(e, i));
        grid.appendChild(div);
        cells.push(div);
    }
    centerGrid();
}

function updateCellView(el, isBlack) {
    if (isBlack) {
        el.classList.remove('white');
    } else {
        el.classList.add('white');
    }
}

function handleCellClick(e, index) {
    if (e.target.closest('.glass-panel')) return;

    if (viewState.hasMoved) return; 
    if (!pendingRequests.has(index)) {
        pendingRequests.add(index);
        cells[index].classList.add('pending');
        socket.emit('toggle-square', index);
    }
}

function centerGrid() {
    viewState.translateX = 0;
    viewState.translateY = 0;
    updateTransform();
}

function updateTransform() {
    gridContainer.style.transform = `translate(${viewState.translateX}px, ${viewState.translateY}px)`;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

// --- 核心修改：严格的边界计算 ---
function calculateBoundaries() {
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    
    const limitX = Math.max(0, (gridMetrics.width - viewportW) / 2);
    const limitY = Math.max(0, (gridMetrics.height - viewportH) / 2);

    return {
        minX: -limitX,
        maxX: limitX,
        minY: -limitY,
        maxY: limitY
    };
}

function onPointerDown(e) {
    if (e.target.closest('#settings-button') || e.target.closest('#options-panel')) {
         viewState.panning = false;
         return;
    }

    if (e.type === 'mousedown' && e.button !== 0) return;
    
    viewState.panning = true;
    viewState.hasMoved = false;
    
    const point = getPoint(e);
    viewState.startX = point.x - viewState.translateX;
    viewState.startY = point.y - viewState.translateY;
    
    viewState.clickStartX = point.x;
    viewState.clickStartY = point.y;
    
    document.body.classList.add('grabbing');
}

function onPointerMove(e) {
    if (!viewState.panning) return;
    e.preventDefault();

    const point = getPoint(e);
    let nextX = point.x - viewState.startX;
    let nextY = point.y - viewState.startY;

    // 实时获取边界并应用
    if (gridMetrics.width > 0) {
        const bounds = calculateBoundaries();
        nextX = clamp(nextX, bounds.minX, bounds.maxX);
        nextY = clamp(nextY, bounds.minY, bounds.maxY);
    }

    viewState.translateX = nextX;
    viewState.translateY = nextY;

    // 移动阈值判断
    if (Math.abs(point.x - viewState.clickStartX) > 5 || 
        Math.abs(point.y - viewState.clickStartY) > 5) {
        viewState.hasMoved = true;
    }

    requestAnimationFrame(updateTransform);
}

function onPointerUp() {
    viewState.panning = false;
    document.body.classList.remove('grabbing');
}

function getPoint(e) {
    if (e.touches) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
}

const container = document.body;
container.addEventListener('mousedown', onPointerDown);
container.addEventListener('touchstart', onPointerDown, { passive: false });
container.addEventListener('mousemove', onPointerMove);
container.addEventListener('touchmove', onPointerMove, { passive: false });
container.addEventListener('mouseup', onPointerUp);
container.addEventListener('touchend', onPointerUp);
container.addEventListener('mouseleave', onPointerUp);

// 窗口大小变化时，重新校验位置，防止留在无效区域
window.addEventListener('resize', () => {
    const bounds = calculateBoundaries();
    viewState.translateX = clamp(viewState.translateX, bounds.minX, bounds.maxX);
    viewState.translateY = clamp(viewState.translateY, bounds.minY, bounds.maxY);
    updateTransform();
});

// --- 图片保存功能 ---
function saveAsImage() {
    // 隐藏 UI 元素以确保截图干净
    const uiElements = document.querySelectorAll('.glass-panel');
    uiElements.forEach(el => el.style.visibility = 'hidden');

    // 获取要截图的元素（包含网格的容器）
    const elementToCapture = document.getElementById('grid-container'); 
    
    // 使用 html2canvas 进行截图
    html2canvas(elementToCapture, {
        allowTaint: true,
        useCORS: true,
        backgroundColor: '#222222', // 使用 CSS 变量中的背景色
        scale: 2 // 提高分辨率
    }).then(canvas => {
        // 创建一个临时链接用于下载
        const imageURL = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.download = 'BlockBoard_Snapshot.png';
        link.href = imageURL;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        // 截图完成后，恢复 UI 元素的可见性
        uiElements.forEach(el => el.style.visibility = ''); 
        
        // 特别处理选项面板，因为它可能需要恢复 'hidden' 类的逻辑
        if (!isPanelOpen) {
            optionsPanel.style.visibility = 'hidden';
        }
    }).catch(error => {
        console.error('Error capturing image:', error);
        // 确保即使出错也恢复 UI
        uiElements.forEach(el => el.style.visibility = '');
        if (!isPanelOpen) {
            optionsPanel.style.visibility = 'hidden';
        }
    });
    
    // 截图后自动关闭选项面板
    toggleOptionsPanel(); 
}