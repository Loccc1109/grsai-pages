(function () {
    const IDS = {
        sidebar: 'generationGallerySidebar',
        toggle: 'generationGalleryToggle',
        detail: 'generationGalleryDetail',
        preview: 'generationAssetPreview',
        style: 'generation-gallery-sidebar-style'
    };

    const OPEN_SETTING_KEY = 'generationSidebarOpen';
    const SIDEBAR_WIDTH = 320;
    const DEBOUNCE_MS = 200;

    let sidebarOpen = true;
    let searchTerm = '';
    let debounceTimer = 0;
    let currentEntries = [];
    let previousStartGeneration = null;

    function dbReady() {
        return Boolean(window.LocalGalleryDB && window.ImageAssetService);
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[char]));
    }

    function formatTime(value) {
        if (!value) return '未知时间';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '未知时间';
        return date.toLocaleString('zh-CN', { hour12: false });
    }

    function formatSize(asset) {
        if (!asset) return '本地图片已删除';
        if (asset.width && asset.height) return `${asset.width} x ${asset.height}`;
        return '未知尺寸';
    }

    function formatParams(generation) {
        const imageSize = generation.imageSize || '未知分辨率';
        const ratio = generation.aspectRatio || '未知比例';
        return `${imageSize} / ${ratio}`;
    }

    function shortHash(hash) {
        return hash ? `${hash.slice(0, 8)}...${hash.slice(-6)}` : '';
    }

    function desktop() {
        return document.getElementById('desktop') || document.body;
    }

    function installStyles() {
        if (document.getElementById(IDS.style)) return;
        const style = document.createElement('style');
        style.id = IDS.style;
        style.textContent = `
            .desktop.generation-gallery-workspace {
                position: relative;
            }

            .generation-gallery-sidebar {
                position: absolute;
                top: 12px;
                right: 12px;
                bottom: 12px;
                z-index: 82;
                width: ${SIDEBAR_WIDTH}px;
                display: flex;
                flex-direction: column;
                background: rgba(29, 30, 34, 0.88);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 8px;
                box-shadow: -14px 0 38px rgba(0, 0, 0, 0.28);
                backdrop-filter: blur(20px) saturate(145%);
                -webkit-backdrop-filter: blur(20px) saturate(145%);
                transform: translateX(0);
                transition: transform 180ms ease, opacity 180ms ease;
            }

            .desktop:not(.gallery-sidebar-open) .generation-gallery-sidebar {
                transform: translateX(calc(100% + 18px));
                opacity: 0;
                pointer-events: none;
            }

            .generation-gallery-toggle {
                position: absolute;
                top: 50%;
                right: 12px;
                z-index: 83;
                width: 36px;
                height: 96px;
                transform: translateY(-50%);
                border: 1px solid rgba(255, 255, 255, 0.20);
                border-radius: 8px;
                background: rgba(42, 43, 47, 0.92);
                color: #f2f3f5;
                cursor: pointer;
                writing-mode: vertical-rl;
                letter-spacing: 0;
                font-size: 13px;
                transition: right 180ms ease, background 160ms ease;
            }

            .desktop.gallery-sidebar-open .generation-gallery-toggle {
                right: ${SIDEBAR_WIDTH + 18}px;
            }

            .generation-gallery-toggle:hover {
                background: rgba(255, 255, 255, 0.12);
            }

            .generation-gallery-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                padding: 14px 14px 10px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.10);
            }

            .generation-gallery-title {
                font-size: 15px;
                font-weight: 700;
                color: #fff;
            }

            .generation-gallery-count {
                margin-top: 3px;
                color: #a8abb2;
                font-size: 12px;
                font-weight: 400;
            }

            .generation-gallery-icon-btn {
                width: 32px;
                height: 32px;
                border-radius: 7px;
                border: 1px solid rgba(255, 255, 255, 0.14);
                background: rgba(255, 255, 255, 0.055);
                color: #f2f3f5;
                cursor: pointer;
                font-size: 16px;
            }

            .generation-gallery-icon-btn:hover {
                background: rgba(255, 255, 255, 0.11);
            }

            .generation-gallery-search-wrap {
                padding: 12px 14px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            }

            .generation-gallery-search {
                width: 100%;
                height: 36px;
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.14);
                background: rgba(255, 255, 255, 0.06);
                color: #f2f3f5;
                padding: 0 10px;
                outline: none;
            }

            .generation-gallery-search:focus {
                border-color: rgba(255, 255, 255, 0.42);
                box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.10);
            }

            .generation-gallery-list {
                flex: 1;
                overflow-y: auto;
                padding: 12px;
                display: grid;
                grid-template-columns: 1fr;
                gap: 10px;
                align-content: start;
            }

            .generation-gallery-card {
                display: grid;
                grid-template-columns: 76px minmax(0, 1fr);
                gap: 10px;
                padding: 8px;
                border-radius: 8px;
                border: 1px solid rgba(255, 255, 255, 0.11);
                background: rgba(255, 255, 255, 0.052);
                cursor: pointer;
                text-align: left;
                transition: background 160ms ease, border-color 160ms ease, transform 160ms ease;
            }

            .generation-gallery-card:hover {
                background: rgba(255, 255, 255, 0.092);
                border-color: rgba(255, 255, 255, 0.25);
                transform: translateY(-1px);
            }

            .generation-gallery-thumb {
                width: 76px;
                height: 76px;
                border-radius: 7px;
                background: rgba(0, 0, 0, 0.22);
                overflow: hidden;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #a8abb2;
                font-size: 12px;
                text-align: center;
            }

            .generation-gallery-thumb img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
            }

            .generation-gallery-card-title {
                color: #fff;
                font-size: 13px;
                line-height: 1.35;
                max-height: 36px;
                overflow: hidden;
            }

            .generation-gallery-card-meta {
                margin-top: 6px;
                color: #a8abb2;
                font-size: 11px;
                line-height: 1.45;
            }

            .generation-gallery-card-hash {
                margin-top: 4px;
                color: rgba(255, 255, 255, 0.46);
                font-size: 10px;
                font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
            }

            .generation-gallery-empty {
                padding: 36px 12px;
                border: 1px dashed rgba(255, 255, 255, 0.16);
                border-radius: 8px;
                color: #a8abb2;
                text-align: center;
                line-height: 1.6;
                background: rgba(255, 255, 255, 0.035);
            }

            .generation-detail-modal,
            .generation-asset-preview {
                position: fixed;
                inset: 0;
                z-index: 4200;
                display: none;
                align-items: center;
                justify-content: center;
                background: rgba(0, 0, 0, 0.78);
                backdrop-filter: blur(8px);
                -webkit-backdrop-filter: blur(8px);
            }

            .generation-asset-preview {
                z-index: 5600;
            }

            .generation-detail-modal.active,
            .generation-asset-preview.active {
                display: flex;
            }

            .generation-detail-panel {
                width: min(1180px, 94vw);
                height: min(760px, 90vh);
                display: grid;
                grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.8fr);
                border-radius: 10px;
                overflow: hidden;
                border: 1px solid rgba(255, 255, 255, 0.16);
                background: rgba(29, 30, 34, 0.96);
                box-shadow: 0 30px 90px rgba(0, 0, 0, 0.55);
            }

            .generation-detail-image,
            .generation-preview-stage {
                min-width: 0;
                min-height: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(0, 0, 0, 0.34);
                padding: 18px;
                overflow: hidden;
                position: relative;
            }

            .generation-detail-image {
                cursor: grab;
            }

            .generation-detail-image.dragging,
            .generation-preview-stage.dragging {
                cursor: grabbing;
            }

            .generation-detail-image img,
            .generation-preview-stage img {
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
                border-radius: 8px;
                user-select: none;
                -webkit-user-drag: none;
                transform-origin: center center;
                will-change: transform;
            }

            .generation-zoom-help {
                position: absolute;
                left: 18px;
                bottom: 14px;
                padding: 5px 8px;
                border-radius: 7px;
                color: rgba(255,255,255,0.76);
                background: rgba(0,0,0,0.34);
                font-size: 12px;
                pointer-events: none;
            }

            .generation-preview-panel {
                width: min(1080px, 94vw);
                height: min(820px, 92vh);
                position: relative;
                border-radius: 10px;
                overflow: hidden;
                border: 1px solid rgba(255, 255, 255, 0.16);
                background: rgba(17, 18, 21, 0.96);
                box-shadow: 0 30px 90px rgba(0,0,0,0.58);
            }

            .generation-preview-stage {
                width: 100%;
                height: 100%;
                cursor: grab;
            }

            .generation-preview-close {
                position: absolute;
                top: 14px;
                right: 14px;
                z-index: 2;
                width: 34px;
                height: 34px;
                border-radius: 7px;
                border: 1px solid rgba(255,255,255,0.16);
                background: rgba(255,255,255,0.08);
                color: #fff;
                cursor: pointer;
                font-size: 18px;
            }

            .generation-detail-missing {
                color: #a8abb2;
                text-align: center;
                border: 1px dashed rgba(255, 255, 255, 0.18);
                border-radius: 8px;
                padding: 28px;
            }

            .generation-detail-info {
                min-width: 0;
                overflow-y: auto;
                padding: 18px;
                border-left: 1px solid rgba(255, 255, 255, 0.10);
            }

            .generation-detail-top {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                margin-bottom: 14px;
            }

            .generation-detail-title {
                color: #fff;
                font-size: 16px;
                font-weight: 700;
            }

            .generation-detail-close {
                width: 32px;
                height: 32px;
                border-radius: 7px;
                border: 1px solid rgba(255, 255, 255, 0.14);
                background: rgba(255, 255, 255, 0.06);
                color: #fff;
                cursor: pointer;
                font-size: 18px;
            }

            .generation-detail-section {
                margin-top: 14px;
            }

            .generation-detail-label {
                color: #a8abb2;
                font-size: 12px;
                margin-bottom: 6px;
            }

            .generation-detail-value {
                color: #f2f3f5;
                font-size: 13px;
                line-height: 1.55;
                word-break: break-word;
            }

            .generation-detail-grid {
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 10px;
            }

            .generation-detail-box {
                padding: 10px;
                border: 1px solid rgba(255, 255, 255, 0.10);
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.045);
            }

            .generation-reference-grid {
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                gap: 8px;
            }

            .generation-reference-thumb {
                aspect-ratio: 1;
                border-radius: 7px;
                overflow: hidden;
                border: 1px solid rgba(255, 255, 255, 0.12);
                background: rgba(0, 0, 0, 0.25);
                display: flex;
                align-items: center;
                justify-content: center;
                color: #a8abb2;
                font-size: 11px;
                text-align: center;
                cursor: pointer;
            }

            .generation-reference-thumb img {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }

            .generation-detail-actions {
                display: flex;
                gap: 8px;
                margin-top: 16px;
            }

            .generation-detail-action {
                height: 34px;
                padding: 0 12px;
                border-radius: 7px;
                border: 1px solid rgba(255, 255, 255, 0.14);
                background: rgba(255, 255, 255, 0.07);
                color: #fff;
                cursor: pointer;
            }

            .generation-detail-action:hover {
                background: rgba(255, 255, 255, 0.13);
            }

            @media (max-width: 900px) {
                .generation-gallery-sidebar {
                    width: min(360px, calc(100% - 24px));
                }

                .desktop.gallery-sidebar-open .generation-gallery-toggle {
                    right: min(374px, calc(100% - 12px));
                }

                .generation-detail-panel {
                    grid-template-columns: 1fr;
                    height: 92vh;
                }

                .generation-detail-info {
                    border-left: 0;
                    border-top: 1px solid rgba(255, 255, 255, 0.10);
                }
            }
        `;
        document.head.appendChild(style);
    }

    function removeLegacyGalleryDom() {
        document.getElementById('galleryModal')?.remove();
    }

    function ensureShell() {
        installStyles();
        removeLegacyGalleryDom();
        const host = desktop();
        host.classList.add('generation-gallery-workspace');

        if (!document.getElementById(IDS.sidebar)) {
            const sidebar = document.createElement('aside');
            sidebar.id = IDS.sidebar;
            sidebar.className = 'generation-gallery-sidebar';
            sidebar.innerHTML = `
                <div class="generation-gallery-header">
                    <div>
                        <div class="generation-gallery-title">生成图库</div>
                        <div class="generation-gallery-count" id="generationGalleryCount">0 条记录</div>
                    </div>
                    <button class="generation-gallery-icon-btn" id="generationGalleryHide" title="隐藏图库">×</button>
                </div>
                <div class="generation-gallery-search-wrap">
                    <input class="generation-gallery-search" id="generationGallerySearch" type="search" placeholder="搜索提示词、模型、尺寸、时间...">
                </div>
                <div class="generation-gallery-list" id="generationGalleryList"></div>
            `;
            host.appendChild(sidebar);
            sidebar.querySelector('#generationGalleryHide').addEventListener('click', () => setSidebarOpen(false));
            sidebar.querySelector('#generationGallerySearch').addEventListener('input', event => {
                window.clearTimeout(debounceTimer);
                debounceTimer = window.setTimeout(() => {
                    searchTerm = event.target.value.trim().toLowerCase();
                    renderSidebar();
                }, DEBOUNCE_MS);
            });
        }

        if (!document.getElementById(IDS.toggle)) {
            const toggle = document.createElement('button');
            toggle.id = IDS.toggle;
            toggle.className = 'generation-gallery-toggle';
            toggle.type = 'button';
            toggle.textContent = '图库';
            toggle.addEventListener('click', () => setSidebarOpen(!sidebarOpen));
            host.appendChild(toggle);
        }

        if (!document.getElementById(IDS.detail)) {
            const detail = document.createElement('div');
            detail.id = IDS.detail;
            detail.className = 'generation-detail-modal';
            detail.addEventListener('click', event => {
                if (event.target === detail) closeDetail();
            });
            document.body.appendChild(detail);
        }

        if (!document.getElementById(IDS.preview)) {
            const preview = document.createElement('div');
            preview.id = IDS.preview;
            preview.className = 'generation-asset-preview';
            preview.addEventListener('click', event => {
                if (event.target === preview) closeAssetPreview();
            });
            document.body.appendChild(preview);
        }

        patchHeaderButton();
    }

    function patchHeaderButton() {
        const button = document.getElementById('openGalleryBtn');
        if (!button) return;
        button.onclick = () => setSidebarOpen(!sidebarOpen);
        button.title = sidebarOpen ? '隐藏图库' : '打开图库';
        button.textContent = '图库';
    }

    async function initOpenState() {
        if (!window.LocalGalleryDB) return;
        const saved = await window.LocalGalleryDB.getSetting(OPEN_SETTING_KEY);
        sidebarOpen = saved === null || saved === undefined ? true : Boolean(saved);
        applyOpenState();
    }

    function applyOpenState() {
        desktop().classList.toggle('gallery-sidebar-open', sidebarOpen);
        patchHeaderButton();
    }

    async function setSidebarOpen(open) {
        sidebarOpen = Boolean(open);
        applyOpenState();
        try {
            if (window.LocalGalleryDB) await window.LocalGalleryDB.putSetting(OPEN_SETTING_KEY, sidebarOpen);
        } catch (error) {
            console.warn('保存图库侧边栏状态失败:', error);
        }
        if (sidebarOpen) await renderSidebar();
    }

    async function buildEntries() {
        if (!dbReady()) return [];
        const generations = await window.LocalGalleryDB.getAllGenerations();
        const entries = [];
        for (const generation of generations) {
            const resultHashes = generation.resultHashes || [];
            if (!resultHashes.length) continue;
            for (let index = 0; index < resultHashes.length; index += 1) {
                const resultHash = resultHashes[index];
                const asset = await window.LocalGalleryDB.getAsset(resultHash);
                const time = generation.completedAt || generation.createdAt || 0;
                entries.push({
                    generation,
                    generationId: generation.id,
                    resultHash,
                    resultIndex: index,
                    asset,
                    time
                });
            }
        }
        return entries.sort((a, b) => (b.time || 0) - (a.time || 0));
    }

    function matchesSearch(entry) {
        if (!searchTerm) return true;
        const generation = entry.generation;
        const haystack = [
            generation.prompt,
            generation.model,
            generation.imageSize,
            generation.aspectRatio,
            generation.id,
            entry.resultHash,
            formatTime(entry.time),
            entry.asset?.originalName,
            formatSize(entry.asset)
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(searchTerm);
    }

    async function renderSidebar() {
        ensureShell();
        const list = document.getElementById('generationGalleryList');
        const count = document.getElementById('generationGalleryCount');
        if (!list || !count) return;

        if (!dbReady()) {
            list.innerHTML = '<div class="generation-gallery-empty">本地图库正在初始化</div>';
            count.textContent = '0 条记录';
            return;
        }

        try {
            currentEntries = await buildEntries();
            const filtered = currentEntries.filter(matchesSearch);
            count.textContent = `${filtered.length} 条记录`; 
            if (!filtered.length) {
                list.innerHTML = `<div class="generation-gallery-empty">${searchTerm ? '没有匹配的生图记录' : '还没有生成图记录'}</div>`;
                return;
            }

            list.innerHTML = '';
            for (const entry of filtered) {
                list.appendChild(await createCard(entry));
            }
        } catch (error) {
            console.error('渲染生成图库失败:', error);
            list.innerHTML = `<div class="generation-gallery-empty">读取生成记录失败：${escapeHtml(error.message)}</div>`;
        }
    }

    async function createCard(entry) {
        const card = document.createElement('div');
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.className = 'generation-gallery-card';
        card.dataset.generationId = entry.generationId;
        card.dataset.resultHash = entry.resultHash;
        const generation = entry.generation;
        const thumb = await renderThumb(entry.resultHash, entry.asset, true);
        card.innerHTML = `
            <div class="generation-gallery-thumb">${thumb}</div>
            <div>
                <div class="generation-gallery-card-title">${escapeHtml(generation.prompt || '无提示词')}</div>
                <div class="generation-gallery-card-meta">
                    ${escapeHtml(generation.model || '未知模型')}<br>
                    ${escapeHtml(formatParams(generation))}<br>
                    ${escapeHtml(formatTime(entry.time))}
                </div>
                <div class="generation-gallery-card-hash">${escapeHtml(shortHash(entry.resultHash))}</div>
            </div>
        `;
        card.addEventListener('click', () => openDetail(entry.generationId, entry.resultHash));
        card.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openDetail(entry.generationId, entry.resultHash);
            }
        });
        return card;
    }

    async function renderThumb(hash, asset, preferThumb) {
        if (!asset) return '<span>图片已删除</span>';
        try {
            const url = await window.ImageAssetService.getAssetObjectUrl(hash, preferThumb);
            return `<img src="${url}" alt="${escapeHtml(asset.originalName || hash)}">`;
        } catch (error) {
            return '<span>读取失败</span>';
        }
    }

    function findEntry(generationId, resultHash) {
        return currentEntries.find(entry => entry.generationId === generationId && entry.resultHash === resultHash);
    }

    async function openDetail(generationId, resultHash) {
        if (!currentEntries.length) currentEntries = await buildEntries();
        const entry = findEntry(generationId, resultHash);
        if (!entry) return;
        const modal = document.getElementById(IDS.detail);
        const generation = entry.generation;
        const asset = entry.asset || await window.LocalGalleryDB.getAsset(resultHash);
        const imageHtml = asset
            ? `<img class="generation-zoom-img" src="${await window.ImageAssetService.getAssetObjectUrl(resultHash, false)}" alt="生成图">`
            : '<div class="generation-detail-missing">本地图片已删除</div>';
        const referenceHtml = await renderReferences(generation.referenceHashes || []);
        const statusHtml = generation.status && generation.status !== 'completed'
            ? `<div class="generation-detail-section"><div class="generation-detail-label">状态/错误</div><div class="generation-detail-value">${escapeHtml(generation.status)}${generation.error ? `：${escapeHtml(generation.error)}` : ''}</div></div>`
            : generation.error
                ? `<div class="generation-detail-section"><div class="generation-detail-label">状态/错误</div><div class="generation-detail-value">${escapeHtml(generation.error)}</div></div>`
                : '';

        modal.innerHTML = `
            <div class="generation-detail-panel" onclick="event.stopPropagation()">
                <div class="generation-detail-image" id="generationDetailImageStage">
                    ${imageHtml}
                    ${asset ? '<div class="generation-zoom-help">滚轮缩放，按住拖拽，双击重置</div>' : ''}
                </div>
                <div class="generation-detail-info">
                    <div class="generation-detail-top">
                        <div class="generation-detail-title">生成详情</div>
                        <button class="generation-detail-close" type="button" id="generationDetailClose">×</button>
                    </div>
                    <div class="generation-detail-section">
                        <div class="generation-detail-label">提示词</div>
                        <div class="generation-detail-value">${escapeHtml(generation.prompt || '无提示词')}</div>
                    </div>
                    <div class="generation-detail-section generation-detail-grid">
                        <div class="generation-detail-box">
                            <div class="generation-detail-label">模型选择</div>
                            <div class="generation-detail-value">${escapeHtml(generation.model || '未知模型')}</div>
                        </div>
                        <div class="generation-detail-box">
                            <div class="generation-detail-label">生成时间</div>
                            <div class="generation-detail-value">${escapeHtml(formatTime(entry.time))}</div>
                        </div>
                        <div class="generation-detail-box">
                            <div class="generation-detail-label">图像尺寸</div>
                            <div class="generation-detail-value">${escapeHtml(formatSize(asset))}</div>
                        </div>
                        <div class="generation-detail-box">
                            <div class="generation-detail-label">分辨率参数</div>
                            <div class="generation-detail-value">${escapeHtml(formatParams(generation))}</div>
                        </div>
                    </div>
                    ${statusHtml}
                    <div class="generation-detail-section">
                        <div class="generation-detail-label">参考图</div>
                        <div class="generation-reference-grid">${referenceHtml}</div>
                    </div>
                    <div class="generation-detail-section">
                        <div class="generation-detail-label">结果 Hash</div>
                        <div class="generation-detail-value">${escapeHtml(resultHash)}</div>
                    </div>
                    <div class="generation-detail-actions">
                        <button class="generation-detail-action" type="button" id="generationDownloadCurrent" ${asset ? '' : 'disabled'}>下载当前图片</button>
                        <button class="generation-detail-action" type="button" id="generationReuseAll">复用全部</button>
                    </div>
                </div>
            </div>
        `;
        modal.classList.add('active');
        document.getElementById('generationDetailClose').addEventListener('click', closeDetail);
        document.getElementById('generationDownloadCurrent').addEventListener('click', () => {
            window.ImageAssetService.downloadAsset(resultHash).catch(error => showToast(error.message, 'error'));
        });
        document.getElementById('generationReuseAll').addEventListener('click', () => {
            window.reuseGenerationRecord?.(generation, 'all').catch(error => showToast(error.message, 'error')); 
        });
        modal.querySelectorAll('[data-reference-hash]').forEach(node => {
            node.addEventListener('click', () => openAssetPreview(node.getAttribute('data-reference-hash')));
        });
        const stage = document.getElementById('generationDetailImageStage');
        const img = stage?.querySelector('img');
        if (stage && img) installZoomPan(stage, img);
    }

    async function renderReferences(referenceHashes) {
        if (!referenceHashes.length) return '<div class="generation-detail-value">无参考图</div>';
        const parts = [];
        for (const hash of referenceHashes) {
            const asset = await window.LocalGalleryDB.getAsset(hash);
            if (!asset) {
                parts.push('<div class="generation-reference-thumb">已删除</div>');
                continue;
            }
            try {
                const url = await window.ImageAssetService.getAssetObjectUrl(hash, true);
                parts.push(`<div class="generation-reference-thumb" data-reference-hash="${escapeHtml(hash)}"><img src="${url}" alt="参考图"></div>`);
            } catch (error) {
                parts.push('<div class="generation-reference-thumb">读取失败</div>');
            }
        }
        return parts.join('');
    }

    function installZoomPan(stage, img) {
        const state = {
            scale: 1,
            x: 0,
            y: 0,
            dragging: false,
            startX: 0,
            startY: 0,
            originX: 0,
            originY: 0
        };

        function apply() {
            img.style.transform = `translate3d(${state.x}px, ${state.y}px, 0) scale(${state.scale})`;
        }

        function reset() {
            state.scale = 1;
            state.x = 0;
            state.y = 0;
            apply();
        }

        stage.addEventListener('wheel', event => {
            event.preventDefault();
            const oldScale = state.scale;
            const nextScale = Math.max(1, Math.min(6, oldScale * (event.deltaY < 0 ? 1.12 : 0.88)));
            if (nextScale === oldScale) return;
            const rect = stage.getBoundingClientRect();
            const cursorX = event.clientX - rect.left - rect.width / 2;
            const cursorY = event.clientY - rect.top - rect.height / 2;
            const ratio = nextScale / oldScale;
            state.x = cursorX - (cursorX - state.x) * ratio;
            state.y = cursorY - (cursorY - state.y) * ratio;
            state.scale = nextScale;
            if (state.scale === 1) {
                state.x = 0;
                state.y = 0;
            }
            apply();
        }, { passive: false });

        stage.addEventListener('mousedown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            state.dragging = true;
            state.startX = event.clientX;
            state.startY = event.clientY;
            state.originX = state.x;
            state.originY = state.y;
            stage.classList.add('dragging');
        });

        window.addEventListener('mousemove', event => {
            if (!state.dragging) return;
            state.x = state.originX + event.clientX - state.startX;
            state.y = state.originY + event.clientY - state.startY;
            apply();
        });

        window.addEventListener('mouseup', () => {
            if (!state.dragging) return;
            state.dragging = false;
            stage.classList.remove('dragging');
        });

        stage.addEventListener('dblclick', reset);
        reset();
    }

    async function openAssetPreview(hash) {
        if (!hash) return;
        const asset = await window.LocalGalleryDB.getAsset(hash);
        const modal = document.getElementById(IDS.preview);
        const imageHtml = asset
            ? `<img class="generation-zoom-img" src="${await window.ImageAssetService.getAssetObjectUrl(hash, false)}" alt="预览图">`
            : '<div class="generation-detail-missing">本地图片已删除</div>';
        modal.innerHTML = `
            <div class="generation-preview-panel" onclick="event.stopPropagation()">
                <button class="generation-preview-close" type="button" id="generationPreviewClose">×</button>
                <div class="generation-preview-stage" id="generationPreviewStage">
                    ${imageHtml}
                    ${asset ? '<div class="generation-zoom-help">滚轮缩放，按住拖拽，双击重置</div>' : ''}
                </div>
            </div>
        `;
        modal.classList.add('active');
        document.getElementById('generationPreviewClose').addEventListener('click', closeAssetPreview);
        const stage = document.getElementById('generationPreviewStage');
        const img = stage?.querySelector('img');
        if (stage && img) installZoomPan(stage, img);
    }

    function closeAssetPreview() {
        const modal = document.getElementById(IDS.preview);
        if (modal) modal.classList.remove('active');
    }

    function closeDetail() {
        const modal = document.getElementById(IDS.detail);
        if (modal) modal.classList.remove('active');
        closeAssetPreview();
    }

    function overrideGalleryEntrypoints() {
        window.openGallery = async function openGenerationSidebar() {
            ensureShell();
            await setSidebarOpen(true);
        };
        window.closeGallery = async function closeGenerationSidebar() {
            await setSidebarOpen(false);
        };
        window.renderGallery = renderSidebar;
        window.showAssetImage = openAssetPreview;
        window.toggleGenerationGallery = () => setSidebarOpen(!sidebarOpen);
    }

    function patchGenerationRefresh() {
        if (previousStartGeneration || typeof window.startGeneration !== 'function') return;
        previousStartGeneration = window.startGeneration;
        window.startGeneration = async function startGenerationWithSidebarRefresh(...args) {
            try {
                return await previousStartGeneration.apply(this, args);
            } finally {
                window.setTimeout(renderSidebar, 250);
            }
        };
    }

    async function boot() {
        ensureShell();
        overrideGalleryEntrypoints();
        patchGenerationRefresh();
        await initOpenState();
        await renderSidebar();
    }

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (document.getElementById(IDS.preview)?.classList.contains('active')) {
            closeAssetPreview();
        } else {
            closeDetail();
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
