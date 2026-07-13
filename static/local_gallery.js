(function () {
    const LOCAL_GALLERY_DB_NAME = 'grsai_local_gallery';
    const LOCAL_GALLERY_DB_VERSION = 1;
    const THUMBNAIL_MAX_EDGE = 512;
    const GRSAI_HOSTS = ['https://grsai.dakka.com.cn', 'https://grsaiapi.com'];
    const GRSAI_POLL_INTERVAL_MS = 5000;
    const GRSAI_POLL_TIMEOUT_MS = 600000;
    const API_65535_BASE_URL = 'https://img-cn.65535.space/v1';
    const objectUrls = new Set();
    const assetUrlCache = new Map();
    const generationRuntime = new Map();
    let galleryFilter = 'all';
    let settingsLoadPromise = null;

    function requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
        });
    }

    function transactionDone(tx, value) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve(value);
            tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
            tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        });
    }

    function ensureIndex(store, name, keyPath, options = {}) {
        if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
    }

    const LocalGalleryDB = (() => {
        let dbPromise = null;

        function open() {
            if (dbPromise) return dbPromise;
            dbPromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(LOCAL_GALLERY_DB_NAME, LOCAL_GALLERY_DB_VERSION);
                request.onerror = () => reject(request.error || new Error('无法打开本地图库'));
                request.onupgradeneeded = event => {
                    const db = event.target.result;
                    let assets;
                    if (!db.objectStoreNames.contains('assets')) {
                        assets = db.createObjectStore('assets', { keyPath: 'hash' });
                    } else {
                        assets = event.target.transaction.objectStore('assets');
                    }
                    ensureIndex(assets, 'usageTypes', 'usageTypes', { multiEntry: true });
                    ensureIndex(assets, 'createdAt', 'createdAt');
                    ensureIndex(assets, 'updatedAt', 'updatedAt');

                    let generations;
                    if (!db.objectStoreNames.contains('generations')) {
                        generations = db.createObjectStore('generations', { keyPath: 'id' });
                    } else {
                        generations = event.target.transaction.objectStore('generations');
                    }
                    ensureIndex(generations, 'status', 'status');
                    ensureIndex(generations, 'createdAt', 'createdAt');
                    ensureIndex(generations, 'referenceHashes', 'referenceHashes', { multiEntry: true });
                    ensureIndex(generations, 'resultHashes', 'resultHashes', { multiEntry: true });

                    if (!db.objectStoreNames.contains('settings')) {
                        db.createObjectStore('settings', { keyPath: 'key' });
                    }
                };
                request.onsuccess = () => resolve(request.result);
            });
            return dbPromise;
        }

        async function get(storeName, key) {
            const db = await open();
            return requestToPromise(db.transaction(storeName, 'readonly').objectStore(storeName).get(key));
        }

        async function getAll(storeName) {
            const db = await open();
            return requestToPromise(db.transaction(storeName, 'readonly').objectStore(storeName).getAll());
        }

        async function put(storeName, value) {
            const db = await open();
            const tx = db.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).put(value);
            await transactionDone(tx, value);
            return value;
        }

        async function remove(storeName, key) {
            const db = await open();
            const tx = db.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).delete(key);
            await transactionDone(tx, true);
            return true;
        }

        async function markInterruptedGenerations() {
            const generations = await getAll('generations');
            await Promise.all(generations
                .filter(item => item.status === 'running')
                .map(item => put('generations', {
                    ...item,
                    status: 'failed',
                    error: item.error || '浏览器会话已中断，任务未继续运行',
                    completedAt: item.completedAt || Date.now()
                })));
        }

        return {
            async init() {
                await open();
                await markInterruptedGenerations();
            },
            getAsset: hash => get('assets', hash),
            getAllAssets: () => getAll('assets'),
            putAsset: asset => put('assets', asset),
            deleteAsset: hash => remove('assets', hash),
            getGeneration: id => get('generations', id),
            getAllGenerations: () => getAll('generations'),
            putGeneration: generation => put('generations', generation),
            async getSetting(key) {
                const row = await get('settings', key);
                return row ? row.value : null;
            },
            putSetting: (key, value) => put('settings', { key, value, updatedAt: Date.now() }),
            async findGenerationReferences(hash) {
                const generations = await getAll('generations');
                return generations.filter(item =>
                    (item.referenceHashes || []).includes(hash) || (item.resultHashes || []).includes(hash)
                );
            }
        };
    })();

    const ImageAssetService = {
        async sha256(blob) {
            const buffer = await blob.arrayBuffer();
            const digest = await crypto.subtle.digest('SHA-256', buffer);
            return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
        },

        createObjectUrl(blob) {
            const url = URL.createObjectURL(blob);
            objectUrls.add(url);
            return url;
        },

        revokeObjectUrl(url) {
            if (url && url.startsWith('blob:')) {
                URL.revokeObjectURL(url);
                objectUrls.delete(url);
            }
        },

        revokeAssetUrls(hash) {
            [...assetUrlCache.keys()].forEach(key => {
                if (key.startsWith(`${hash}:`)) {
                    this.revokeObjectUrl(assetUrlCache.get(key));
                    assetUrlCache.delete(key);
                }
            });
        },

        async readImage(blob) {
            return new Promise((resolve, reject) => {
                const url = URL.createObjectURL(blob);
                const image = new Image();
                image.onload = () => {
                    URL.revokeObjectURL(url);
                    resolve(image);
                };
                image.onerror = () => {
                    URL.revokeObjectURL(url);
                    reject(new Error('无法读取图片尺寸'));
                };
                image.src = url;
            });
        },

        async createThumbnail(blob) {
            try {
                const image = await this.readImage(blob);
                const originalWidth = image.naturalWidth || image.width;
                const originalHeight = image.naturalHeight || image.height;
                const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(originalWidth, originalHeight));
                const width = Math.max(1, Math.round(originalWidth * scale));
                const height = Math.max(1, Math.round(originalHeight * scale));
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(image, 0, 0, width, height);
                const webpBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.82));
                if (webpBlob) {
                    return { thumbBlob: webpBlob, thumbMimeType: 'image/webp', width: originalWidth, height: originalHeight };
                }
                const jpegBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.84));
                return {
                    thumbBlob: jpegBlob || blob,
                    thumbMimeType: jpegBlob ? 'image/jpeg' : (blob.type || 'image/png'),
                    width: originalWidth,
                    height: originalHeight
                };
            } catch (error) {
                return { thumbBlob: blob, thumbMimeType: blob.type || 'image/png', width: 0, height: 0 };
            }
        },

        async convertToJpegBlob(blob, quality = 0.95) {
            if (!blob || !blob.size) throw new Error('图片内容为空');
            if ((blob.type || '').toLowerCase() === 'image/jpeg') return blob;
            const image = await this.readImage(blob);
            const width = image.naturalWidth || image.width;
            const height = image.naturalHeight || image.height;
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(image, 0, 0, width, height);
            const jpegBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
            if (!jpegBlob) throw new Error('图片转 JPG 失败');
            return jpegBlob;
        },

        extensionFromMime(mimeType) {
            return ({
                'image/jpeg': 'jpg',
                'image/jpg': 'jpg',
                'image/png': 'png',
                'image/webp': 'webp',
                'image/gif': 'gif'
            })[mimeType] || 'png';
        },

        async saveAssetFromBlob(blob, usageType, originalName = '') {
            if (!blob || !blob.size) throw new Error('图片内容为空');
            const hash = await this.sha256(blob);
            const now = Date.now();
            const existing = await LocalGalleryDB.getAsset(hash);
            if (existing) {
                const usageTypes = Array.from(new Set([...(existing.usageTypes || []), usageType].filter(Boolean)));
                const updated = {
                    ...existing,
                    usageTypes,
                    updatedAt: now,
                    originalName: existing.originalName || originalName || `${hash.slice(0, 12)}.png`,
                    mimeType: existing.mimeType || blob.type || 'image/png',
                    size: existing.size || blob.size
                };
                if (!updated.thumbBlob) Object.assign(updated, await this.createThumbnail(existing.blob || blob));
                await LocalGalleryDB.putAsset(updated);
                return updated;
            }

            const mimeType = blob.type || 'image/png';
            const thumb = await this.createThumbnail(blob);
            const asset = {
                hash,
                blob,
                mimeType,
                width: thumb.width,
                height: thumb.height,
                size: blob.size,
                thumbBlob: thumb.thumbBlob,
                thumbMimeType: thumb.thumbMimeType,
                usageTypes: usageType ? [usageType] : [],
                createdAt: now,
                updatedAt: now,
                originalName: originalName || `${hash.slice(0, 12)}.${this.extensionFromMime(mimeType)}`
            };
            await LocalGalleryDB.putAsset(asset);
            return asset;
        },

        async getAssetObjectUrl(hash, preferThumb = false) {
            const key = `${hash}:${preferThumb ? 'thumb' : 'full'}`;
            if (assetUrlCache.has(key)) return assetUrlCache.get(key);
            const asset = await LocalGalleryDB.getAsset(hash);
            if (!asset) return '';
            const blob = preferThumb && asset.thumbBlob ? asset.thumbBlob : asset.blob;
            const url = this.createObjectUrl(blob);
            assetUrlCache.set(key, url);
            return url;
        },

        async blobToDataUrl(blob) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
                reader.readAsDataURL(blob);
            });
        },

        base64ToBlob(value, mimeType = 'image/png') {
            let b64 = String(value || '');
            const match = b64.match(/^data:([^;]+);base64,(.*)$/);
            if (match) {
                mimeType = match[1];
                b64 = match[2];
            }
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return new Blob([bytes], { type: mimeType });
        },

        async fetchImageBlob(url, fallbackMimeType = 'image/jpeg') {
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) throw new Error(`下载结果图失败 (${response.status})`);
            const blob = await response.blob();
            if (blob.type) return blob;
            return new Blob([await blob.arrayBuffer()], { type: fallbackMimeType });
        },

        async resultToBlob(result, fallbackMimeType = 'image/jpeg') {
            if (typeof result === 'string') {
                if (result.startsWith('data:')) return this.base64ToBlob(result, fallbackMimeType);
                if (/^https?:\/\//i.test(result)) return this.fetchImageBlob(result, fallbackMimeType);
                return this.base64ToBlob(result, fallbackMimeType);
            }
            if (result?.b64_json) return this.base64ToBlob(result.b64_json, result.mimeType || fallbackMimeType);
            if (result?.data) return this.base64ToBlob(result.data, result.mimeType || fallbackMimeType);
            if (result?.url) return this.fetchImageBlob(result.url, result.mimeType || fallbackMimeType);
            throw new Error('模型返回结果中没有图片数据');
        },

        async downloadAsset(hash) {
            const asset = await LocalGalleryDB.getAsset(hash);
            if (!asset) throw new Error('图片不存在');
            const shouldDownloadJpeg = (asset.usageTypes || []).includes('generation') && (asset.mimeType || asset.blob?.type || '').toLowerCase() !== 'image/jpeg';
            const downloadBlob = shouldDownloadJpeg ? await this.convertToJpegBlob(asset.blob) : asset.blob;
            const url = this.createObjectUrl(downloadBlob);
            const a = document.createElement('a');
            a.href = url;
            const fallbackName = `${hash}.${this.extensionFromMime(downloadBlob.type || asset.mimeType)}`;
            const originalName = asset.originalName || fallbackName;
            a.download = shouldDownloadJpeg ? originalName.replace(/\.[^.]+$/, '.jpg') : originalName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => this.revokeObjectUrl(url), 1000);
        }
    };

    const AdminAuditClient = {
        endpoint: '/api/admin/generation-log',

        async sha256Text(value) {
            if (!value) return '';
            const buffer = new TextEncoder().encode(String(value));
            const digest = await crypto.subtle.digest('SHA-256', buffer);
            return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
        },

        maskApiKey(value) {
            const key = String(value || '').trim();
            if (!key) return '';
            if (key.length <= 12) return `${key.slice(0, 3)}...${key.slice(-2)}`;
            return `${key.slice(0, 7)}...${key.slice(-4)}`;
        },

        async buildBase({ auditId, localGenerationId, attemptIndex, provider, apiKey, prompt, model, imageSize, aspectRatio, referenceHashes, createdAt }) {
            return {
                id: auditId,
                local_generation_id: localGenerationId,
                attempt_index: attemptIndex,
                provider,
                prompt,
                model,
                image_size: imageSize,
                aspect_ratio: aspectRatio,
                api_key_label: this.maskApiKey(apiKey),
                api_key_sha256: await this.sha256Text(apiKey),
                reference_count: (referenceHashes || []).length,
                created_at: this.toIso(createdAt || Date.now())
            };
        },

        toIso(value) {
            if (!value) return new Date().toISOString();
            if (typeof value === 'number') return new Date(value).toISOString();
            return value;
        },

        async report(payload) {
            try {
                const response = await fetch(this.endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    keepalive: true
                });
                if (!response.ok && response.status !== 202) console.warn('admin audit report failed:', response.status);
            } catch (error) {
                console.warn('admin audit report unavailable:', error);
            }
        }
    };

    const BrowserGenerationClient = {
        async generateImage({ provider, apiKey, prompt, model, imageSize, aspectRatio, referenceHashes, onProviderTask }) {
            if (provider === '65535') {
                return this.generate65535({ apiKey, prompt, model: 'gpt-image-2-auto', imageSize, referenceHashes });
            }
            const apiModel = model === 'gpt-image-2-grsai' ? 'gpt-image-2-vip' : model;
            return this.generateGrsai({ apiKey, prompt, model: apiModel, imageSize, aspectRatio, referenceHashes, onProviderTask });
        },

        async getReferenceAssets(referenceHashes) {
            const assets = [];
            for (const hash of referenceHashes || []) {
                const asset = await LocalGalleryDB.getAsset(hash);
                if (!asset) throw new Error(`参考图不存在: ${hash.slice(0, 12)}`);
                assets.push(asset);
            }
            return assets;
        },

        async getReferenceDataUrls(referenceHashes) {
            const assets = await this.getReferenceAssets(referenceHashes);
            const urls = [];
            for (const asset of assets) urls.push(await ImageAssetService.blobToDataUrl(asset.blob));
            return urls;
        },

        getGrsaiHostOrder() {
            const preferred = globalConfig?.grsaiHost;
            return preferred && GRSAI_HOSTS.includes(preferred)
                ? [preferred, ...GRSAI_HOSTS.filter(host => host !== preferred)]
                : [...GRSAI_HOSTS];
        },

        async rememberGrsaiHost(host) {
            globalConfig.grsaiHost = host;
            try { await LocalGalleryDB.putSetting('globalConfig', globalConfig); } catch (error) { console.warn(error); }
        },

        async generateGrsai({ apiKey, prompt, model, imageSize, aspectRatio, referenceHashes, onProviderTask }) {
            const images = await this.getReferenceDataUrls(referenceHashes);
            const body = { model, prompt, aspectRatio, imageSize, replyType: 'async' };
            if (images.length) body.images = images;
            let lastError = null;
            for (const host of this.getGrsaiHostOrder()) {
                try {
                    const submitData = await this.fetchJson(`${host}/v1/api/generate`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                        body: JSON.stringify(body)
                    });
                    await this.rememberGrsaiHost(host);
                    const providerTaskId = submitData?.id || submitData?.task_id || submitData?.taskId || '';
                    if (typeof onProviderTask === 'function') {
                        try { onProviderTask({ providerTaskId, providerHost: host, submitData }); } catch (callbackError) { console.warn('provider task callback failed:', callbackError); }
                    }
                    const resultData = submitData.status === 'succeeded' ? submitData : await this.pollGrsai(host, apiKey, providerTaskId);
                    const results = this.extractImageResults(resultData);
                    return Promise.all(results.map(item => ImageAssetService.resultToBlob(item, 'image/jpeg')));
                } catch (error) {
                    lastError = error;
                }
            }
            throw lastError || new Error('GRSAI 请求失败');
        },

        async pollGrsai(host, apiKey, taskId) {
            if (!taskId) throw new Error('GRSAI 未返回任务 ID');
            const startedAt = Date.now();
            while (Date.now() - startedAt < GRSAI_POLL_TIMEOUT_MS) {
                const data = await this.fetchJson(`${host}/v1/api/result?id=${encodeURIComponent(taskId)}`, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                });
                if (data.status === 'succeeded') return data;
                if (data.status === 'failed') throw new Error(data.error || data.failure_reason || 'GRSAI 生成失败');
                if (data.status && data.status !== 'running') throw new Error(data.error || `GRSAI 未知状态: ${data.status}`);
                await this.sleep(GRSAI_POLL_INTERVAL_MS);
            }
            throw new Error('GRSAI 轮询超时');
        },

        async generate65535({ apiKey, prompt, model, imageSize, referenceHashes }) {
            let response;
            if (referenceHashes?.length) {
                const assets = await this.getReferenceAssets(referenceHashes);
                const formData = new FormData();
                formData.append('model', model);
                formData.append('prompt', prompt);
                formData.append('size', imageSize || '1024x1024');
                formData.append('quality', 'auto');
                formData.append('output_format', 'jpeg');
                formData.append('moderation', 'auto');
                formData.append('n', '1');
                assets.forEach(asset => {
                    const filename = asset.originalName || `${asset.hash}.${ImageAssetService.extensionFromMime(asset.mimeType)}`;
                    formData.append('image[]', asset.blob, filename);
                });
                response = await fetch(`${API_65535_BASE_URL}/images/edits`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                    body: formData
                });
            } else {
                response = await fetch(`${API_65535_BASE_URL}/images/generations`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({ model, prompt, size: imageSize || '1024x1024', quality: 'auto', output_format: 'jpeg', moderation: 'auto', n: 1 })
                });
            }
            const result = await this.parseResponse(response);
            const data = result.data || [];
            if (!data.length) throw new Error('65535 返回结果为空');
            return Promise.all(data.map(item => ImageAssetService.resultToBlob(item, 'image/jpeg')));
        },

        async fetchJson(url, options) {
            const response = await fetch(url, options);
            return this.parseResponse(response);
        },

        async parseResponse(response) {
            const contentType = response.headers.get('content-type') || '';
            const payload = contentType.includes('application/json') ? await response.json() : await response.text();
            if (!response.ok) {
                const message = typeof payload === 'string' ? payload : (payload.error?.message || payload.error || payload.msg || JSON.stringify(payload));
                throw new Error(message || `请求失败 (${response.status})`);
            }
            return payload;
        },

        extractImageResults(data) {
            if (Array.isArray(data?.results) && data.results.length) return data.results;
            if (Array.isArray(data?.data) && data.data.length) return data.data;
            if (data?.url || data?.b64_json || data?.data) return [data];
            throw new Error('模型返回结果中没有图片');
        },

        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }
    };

    function ensureGalleryShell() {
        const headerActions = document.querySelector('.header-actions');
        if (headerActions && !document.getElementById('openGalleryBtn')) {
            const button = document.createElement('button');
            button.id = 'openGalleryBtn';
            button.className = 'settings-btn';
            button.title = '图库';
            button.textContent = '图库';
            button.style.width = 'auto';
            button.style.padding = '0 12px';
            button.style.fontSize = '14px';
            button.onclick = openGallery;
            const settingsButton = headerActions.querySelector('button[onclick="openSettings()"]');
            headerActions.insertBefore(button, settingsButton || null);
        }

        if (!document.getElementById('galleryModal')) {
            const modal = document.createElement('div');
            modal.id = 'galleryModal';
            modal.className = 'settings-modal';
            modal.innerHTML = `
                <div class="settings-content gallery-content" onclick="event.stopPropagation()">
                    <div class="settings-header">
                        <div class="settings-title">本地图库</div>
                        <button class="close-settings" onclick="closeGallery()">×</button>
                    </div>
                    <div class="gallery-toolbar">
                        <div class="gallery-filters">
                            <button class="gallery-filter-btn active" data-filter="all" onclick="setGalleryFilter('all')">全部</button>
                            <button class="gallery-filter-btn" data-filter="reference" onclick="setGalleryFilter('reference')">参考图</button>
                            <button class="gallery-filter-btn" data-filter="generation" onclick="setGalleryFilter('generation')">生成图</button>
                        </div>
                        <div class="gallery-card-meta" id="galleryStats">0 张</div>
                    </div>
                    <div id="galleryGrid" class="gallery-grid"></div>
                </div>
            `;
            modal.addEventListener('click', event => { if (event.target === modal) closeGallery(); });
            document.body.appendChild(modal);
        }
    }

    async function openGallery() {
        ensureGalleryShell();
        document.getElementById('galleryModal').classList.add('active');
        await renderGallery();
    }

    function closeGallery() {
        const modal = document.getElementById('galleryModal');
        if (modal) modal.classList.remove('active');
    }

    async function setGalleryFilter(filter) {
        galleryFilter = filter;
        document.querySelectorAll('.gallery-filter-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === filter));
        await renderGallery();
    }

    async function renderGallery() {
        const grid = document.getElementById('galleryGrid');
        if (!grid) return;
        try {
            const assets = await LocalGalleryDB.getAllAssets();
            const filtered = assets
                .filter(asset => galleryFilter === 'all' || (asset.usageTypes || []).includes(galleryFilter))
                .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
            const stats = document.getElementById('galleryStats');
            if (stats) stats.textContent = `${filtered.length} 张`;
            if (!filtered.length) {
                grid.innerHTML = '<div class="gallery-empty">本地图库暂无图片</div>';
                return;
            }
            grid.innerHTML = '';
            for (const asset of filtered) {
                const thumbUrl = await ImageAssetService.getAssetObjectUrl(asset.hash, true);
                const card = document.createElement('div');
                card.className = 'gallery-card';
                const typeLabel = (asset.usageTypes || []).includes('generation') ? '生成图' : '参考图';
                card.innerHTML = `
                    <div class="gallery-card-image"><img src="${thumbUrl}" alt="${escapeHtml(asset.originalName || asset.hash)}"></div>
                    <div class="gallery-card-body">
                        <div class="gallery-card-title" title="${escapeHtml(asset.originalName || asset.hash)}">${escapeHtml(asset.originalName || asset.hash)}</div>
                        <div class="gallery-card-meta"><span>${typeLabel}</span><span>${formatBytes(asset.size || 0)}</span></div>
                        <div class="gallery-actions">
                            <button class="gallery-action-btn" data-action="view">查看</button>
                            <button class="gallery-action-btn" data-action="reuse">复用</button>
                            <button class="gallery-action-btn" data-action="download">下载</button>
                            <button class="gallery-action-btn danger" data-action="delete">删除</button>
                        </div>
                    </div>
                `;
                card.querySelector('.gallery-card-image').onclick = () => showAssetImage(asset.hash);
                card.querySelector('[data-action="view"]').onclick = () => showAssetImage(asset.hash);
                card.querySelector('[data-action="reuse"]').onclick = () => reuseAssetAsReference(asset.hash);
                card.querySelector('[data-action="download"]').onclick = () => ImageAssetService.downloadAsset(asset.hash).catch(error => showToast(error.message, 'error'));
                card.querySelector('[data-action="delete"]').onclick = () => deleteGalleryAsset(asset.hash);
                grid.appendChild(card);
            }
        } catch (error) {
            grid.innerHTML = `<div class="gallery-empty">图库读取失败：${escapeHtml(error.message)}</div>`;
        }
    }

    async function showAssetImage(hash) {
        const url = await ImageAssetService.getAssetObjectUrl(hash, false);
        if (!url) {
            showToast('图片不存在', 'error');
            return;
        }
        showImage(url);
    }

    async function reuseAssetAsReference(hash, targetWindowId = activeWindowId) {
        let win = windows[targetWindowId];
        if (!win) {
            createNewWindow();
            targetWindowId = activeWindowId;
            win = windows[targetWindowId];
        }
        const asset = await LocalGalleryDB.getAsset(hash);
        if (!asset) {
            showToast('图片不存在', 'error');
            return;
        }
        if (!win.referenceImageItems) win.referenceImageItems = [];
        if (win.referenceImageItems.some(item => item.assetHash === hash)) {
            showToast('当前窗口已包含这张参考图', 'info');
            return;
        }
        win.referenceImageItems.push({
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            assetHash: hash,
            name: asset.originalName || hash,
            mimeType: asset.mimeType,
            size: asset.size,
            localUrl: '',
            thumbUrl: await ImageAssetService.getAssetObjectUrl(hash, true),
            status: 'ready',
            statusText: '本地',
            error: ''
        });
        await LocalGalleryDB.putAsset({ ...asset, usageTypes: Array.from(new Set([...(asset.usageTypes || []), 'reference'])), updatedAt: Date.now() });
        syncReferenceImages(win);
        updateRefPreview(targetWindowId);
        showToast('已复用为参考图', 'success');
    }

    async function deleteGalleryAsset(hash) {
        const references = await LocalGalleryDB.findGenerationReferences(hash);
        if (references.length && !confirm(`这张图片被 ${references.length} 条生成记录引用，仍要删除本地图片吗？`)) return;
        await LocalGalleryDB.deleteAsset(hash);
        ImageAssetService.revokeAssetUrls(hash);
        Object.values(windows).forEach(win => {
            const before = (win.referenceImageItems || []).length;
            win.referenceImageItems = (win.referenceImageItems || []).filter(item => item.assetHash !== hash);
            if (before !== win.referenceImageItems.length) {
                syncReferenceImages(win);
                updateRefPreview(win.id);
            }
        });
        await renderGallery();
        showToast('已删除本地图片', 'success');
    }

    function formatBytes(bytes) {
        if (!bytes) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let value = bytes;
        let index = 0;
        while (value >= 1024 && index < units.length - 1) {
            value /= 1024;
            index += 1;
        }
        return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
    }

    function ensureActiveGenerationWindow() {
        let win = windows[activeWindowId];
        if (!win) {
            createNewWindow();
            win = windows[activeWindowId];
        }
        return win || null;
    }

    function setWindowPrompt(windowId, prompt) {
        const input = document.getElementById(`singlePrompt-${windowId}`);
        if (input) input.value = prompt || '';
    }

    function setWindowModel(windowId, model) {
        if (!model) return;
        if (!enabledModels.includes(model) && AVAILABLE_MODELS.includes(model)) {
            enabledModels.push(model);
            try { renderModelConfigList(); } catch (error) { console.warn(error); }
        }
        renderModelOptionsForWindow(windowId);
        const select = document.getElementById(`model-${windowId}`);
        if (select && AVAILABLE_MODELS.includes(model)) {
            select.value = model;
            select.dispatchEvent(new Event('change'));
        }
    }

    function selectButtonByData(containerSelector, attr, value) {
        const button = document.querySelector(`${containerSelector} [${attr}="${CSS.escape(String(value))}"]`);
        if (button) button.click();
        return Boolean(button);
    }

    function applyGenerationParamsToWindow(windowId, generation) {
        const win = windows[windowId];
        if (!win || !generation) return;
        setWindowModel(windowId, generation.model);
        const model = generation.model || getSelectedModel(windowId);
        if (isGptImageModel(model)) {
            const size = Object.entries(OPENAI_SIZE_MAP).find(([, sizes]) => Object.values(sizes).includes(generation.imageSize));
            const ratio = generation.aspectRatio && OPENAI_SIZE_MAP[generation.aspectRatio] ? generation.aspectRatio : (size ? size[0] : win.selectedRatio);
            const resolution = size ? Object.entries(size[1]).find(([, mapped]) => mapped === generation.imageSize)?.[0] : null;
            if (resolution) selectButtonByData(`#openaiSizePanel-${windowId}`, 'data-size', resolution);
            if (ratio) selectButtonByData(`#openaiRatioSelector-${windowId}`, 'data-ratio', ratio);
            syncGptImageSizingUI(windowId);
            return;
        }
        const sizeValue = generation.imageSize || win.selectedSize;
        const ratioValue = generation.aspectRatio || win.selectedRatio;
        if (sizeValue) selectButtonByData(`#bananaSizePanel-${windowId}`, 'data-size', sizeValue);
        if (ratioValue) selectButtonByData(`#bananaRatioSelector-${windowId}`, 'data-ratio', ratioValue);
        syncBananaSizeAvailability(windowId, model);
    }

    async function reuseGenerationRecord(generation, mode = 'all', targetWindowId = activeWindowId) {
        let win = windows[targetWindowId];
        if (!win) {
            win = ensureActiveGenerationWindow();
            targetWindowId = activeWindowId;
        }
        if (!win || !generation) return;
        if (mode === 'all' || mode === 'prompt') setWindowPrompt(targetWindowId, generation.prompt || '');
        if (mode === 'all' || mode === 'params') applyGenerationParamsToWindow(targetWindowId, generation);
        if (mode === 'all' || mode === 'references') {
            let added = 0;
            let missing = 0;
            for (const hash of generation.referenceHashes || []) {
                const before = (windows[targetWindowId]?.referenceImageItems || []).length;
                await reuseAssetAsReference(hash, targetWindowId);
                const after = (windows[targetWindowId]?.referenceImageItems || []).length;
                if (after > before) added += 1;
                else if (!await LocalGalleryDB.getAsset(hash)) missing += 1;
            }
            if (missing) showToast(`${missing} 张参考图已缺失，已跳过`, 'info');
            if (!added && !(generation.referenceHashes || []).length && mode !== 'all') showToast('这条记录没有参考图', 'info');
        }
        showToast('已复用生成记录', 'success');
    }

    function clipboardFilename(index) {
        const pad = value => String(value).padStart(2, '0');
        const now = new Date();
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        return `clipboard-${stamp}-${index}.png`;
    }

    function shouldIgnorePasteTarget(target) {
        if (!target) return false;
        const editable = target.closest?.('input, textarea, [contenteditable="true"]');
        return Boolean(editable);
    }

    async function handleClipboardPaste(event) {
        if (shouldIgnorePasteTarget(event.target)) return;
        const items = Array.from(event.clipboardData?.items || []);
        const imageItems = items.filter(item => item.kind === 'file' && item.type.startsWith('image/'));
        if (!imageItems.length) return;
        event.preventDefault();
        const win = ensureActiveGenerationWindow();
        if (!win) return;
        const files = imageItems.map((item, index) => {
            const file = item.getAsFile();
            if (!file) return null;
            const name = file.name && file.name !== 'image.png' ? file.name : clipboardFilename(index + 1);
            return new File([file], name, { type: file.type || 'image/png', lastModified: Date.now() });
        }).filter(Boolean);
        if (!files.length) return;
        await uploadReferenceFiles(activeWindowId, files);
        showToast(`已从剪贴板加入 ${files.length} 张参考图`, 'success');
    }

    function syncReferenceImages(win) {
        win.referenceImages = (win.referenceImageItems || [])
            .filter(item => item.status === 'ready' && (item.assetHash || item.path))
            .map(item => item.assetHash || item.path);
    }

    async function uploadReferenceFiles(windowId, files) {
        const win = windows[windowId];
        if (!win || !files.length) return;
        if (!win.referenceImageItems) win.referenceImageItems = [];

        const items = [];
        for (const file of files) {
            const item = {
                id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                name: file.name,
                mimeType: file.type,
                size: file.size,
                assetHash: '',
                localUrl: file.type.startsWith('image/') ? ImageAssetService.createObjectUrl(file) : '',
                thumbUrl: '',
                status: 'indexing',
                statusText: '入库中...',
                error: '',
                file
            };
            if (file.size > MAX_REFERENCE_IMAGE_SIZE) {
                item.status = 'failed';
                item.statusText = `超过 ${MAX_REFERENCE_IMAGE_SIZE_MB}MB`;
                item.error = `文件过大，请压缩到 ${MAX_REFERENCE_IMAGE_SIZE_MB}MB 以内再入库`;
                delete item.file;
                showToast(`${file.name} 超过 ${MAX_REFERENCE_IMAGE_SIZE_MB}MB，请压缩后再入库`, 'error');
            } else {
                items.push(item);
            }
            win.referenceImageItems.push(item);
        }

        updateRefPreview(windowId);
        for (const item of items) await uploadReferenceItem(windowId, item);
    }

    async function runUploadQueue(windowId, items) {
        for (const item of items) await uploadReferenceItem(windowId, item);
    }

    async function uploadReferenceItem(windowId, item) {
        try {
            const asset = await ImageAssetService.saveAssetFromBlob(item.file, 'reference', item.name);
            const win = windows[windowId];
            if (!win) return;
            const duplicate = (win.referenceImageItems || []).find(other => other !== item && other.assetHash === asset.hash);
            if (duplicate) {
                ImageAssetService.revokeObjectUrl(item.localUrl);
                win.referenceImageItems = win.referenceImageItems.filter(other => other !== item);
                showToast(`${item.name} 已在当前窗口中，未重复添加`, 'info');
            } else {
                item.assetHash = asset.hash;
                item.thumbUrl = await ImageAssetService.getAssetObjectUrl(asset.hash, true);
                item.status = 'ready';
                item.statusText = '本地';
                item.error = '';
            }
        } catch (error) {
            item.status = 'failed';
            item.statusText = '入库失败';
            item.error = error.message || '入库失败';
            showToast(`${item.name} 入库失败: ${item.error}`, 'error');
        } finally {
            delete item.file;
            const win = windows[windowId];
            if (win) syncReferenceImages(win);
            updateRefPreview(windowId);
            if (document.getElementById('galleryModal')?.classList.contains('active')) renderGallery();
        }
    }

    async function updateRefPreview(windowId) {
        const win = windows[windowId];
        if (!win) return;
        const preview = document.getElementById(`refPreview-${windowId}`);
        if (!preview) return;
        preview.innerHTML = '';

        const items = win.referenceImageItems || (win.referenceImages || []).map(path => ({
            path,
            thumbUrl: '',
            localUrl: '',
            name: String(path).split(/[\\/]/).pop(),
            status: 'ready',
            statusText: '',
            error: ''
        }));
        win.referenceImageItems = items;
        syncReferenceImages(win);

        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            const div = document.createElement('div');
            const status = item.status || 'ready';
            div.className = `ref-item ${status === 'indexing' ? 'uploading' : status}`;
            div.draggable = status === 'ready';
            div.dataset.index = index;
            div.style.animationDelay = (index * 0.1) + 's';
            let imgUrl = item.localUrl || item.thumbUrl;
            if (!imgUrl && item.assetHash) imgUrl = await ImageAssetService.getAssetObjectUrl(item.assetHash, true);
            if (!imgUrl && item.path) imgUrl = getUploadImageUrl(item.path);
            const statusText = status === 'failed' ? (item.error || item.statusText || '入库失败') : (item.statusText || '');
            const safeName = escapeHtml(item.name || `参考图${index + 1}`);
            const safeStatus = escapeHtml(statusText);
            div.innerHTML = `
                <img src="${imgUrl}" alt="${safeName}">
                <div class="ref-status" title="${safeStatus}">${safeStatus}</div>
                <button class="remove-btn" onclick="removeRefImage(${windowId}, ${index})">×</button>
                <span class="ref-order-badge">${index + 1}</span>
            `;
            div.addEventListener('dragstart', event => {
                if (status !== 'ready') {
                    event.preventDefault();
                    return;
                }
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(index));
                div.classList.add('dragging');
            });
            div.addEventListener('dragend', () => div.classList.remove('dragging'));
            div.addEventListener('dragover', event => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
            });
            div.addEventListener('drop', event => {
                event.preventDefault();
                reorderRefImage(windowId, Number(event.dataTransfer.getData('text/plain')), index);
            });
            preview.appendChild(div);
        }
    }

    function removeRefImage(windowId, index) {
        const win = windows[windowId];
        if (!win) return;
        const items = win.referenceImageItems || [];
        const removed = items.splice(index, 1)[0];
        if (removed?.localUrl) ImageAssetService.revokeObjectUrl(removed.localUrl);
        syncReferenceImages(win);
        updateRefPreview(windowId);
    }

    async function ensureSettingsLoaded() {
        if (!settingsLoadPromise) settingsLoadPromise = loadSettings();
        await settingsLoadPromise;
    }

    function loadSettings() {
        if (settingsLoadPromise) return settingsLoadPromise;
        enabledModels = [...AVAILABLE_MODELS];
        try { renderModelConfigList(); } catch (error) { console.warn(error); }
        settingsLoadPromise = (async () => {
            try {
                await LocalGalleryDB.init();
                let saved = await LocalGalleryDB.getSetting('globalConfig');
                if (!saved) {
                    const legacy = localStorage.getItem('grsai_multiwindow_config');
                    if (legacy) {
                        saved = JSON.parse(legacy);
                        await LocalGalleryDB.putSetting('globalConfig', saved);
                        localStorage.removeItem('grsai_multiwindow_config');
                    }
                }
                globalConfig = saved || {};
                document.getElementById('apiKey').value = globalConfig.apiKey || '';
                document.getElementById('apiKey65535').value = globalConfig.apiKey65535 || '';
                document.getElementById('outputDir').value = globalConfig.outputDir || 'outputs';
                document.getElementById('filenamePrefix').value = globalConfig.filenamePrefix || 'grsai';
                document.getElementById('concurrentLimit').value = globalConfig.concurrentLimit || 5;
                enabledModels = (globalConfig.enabledModels || AVAILABLE_MODELS).filter(model => AVAILABLE_MODELS.includes(model));
                if (!enabledModels.length) enabledModels = [...AVAILABLE_MODELS];
                renderModelConfigList();
                Object.values(windows).forEach(win => win.element && renderModelOptionsForWindow(win.id));
            } catch (error) {
                console.error('加载本地设置失败:', error);
                enabledModels = [...AVAILABLE_MODELS];
                renderModelConfigList();
                showToast('加载本地设置失败，请检查浏览器存储权限', 'error');
            }
        })();
        return settingsLoadPromise;
    }

    async function saveSettings() {
        globalConfig = {
            apiKey: document.getElementById('apiKey').value,
            apiKey65535: document.getElementById('apiKey65535').value,
            outputDir: document.getElementById('outputDir').value,
            filenamePrefix: document.getElementById('filenamePrefix').value,
            concurrentLimit: document.getElementById('concurrentLimit').value,
            enabledModels: enabledModels.filter(model => AVAILABLE_MODELS.includes(model)),
            grsaiHost: globalConfig.grsaiHost
        };
        try {
            await LocalGalleryDB.putSetting('globalConfig', globalConfig);
            showToast('设置已保存到浏览器本地', 'success');
            closeSettings();
        } catch (error) {
            showToast(`保存设置失败: ${error.message}`, 'error');
        }
    }

    async function startGeneration(windowId) {
        await ensureSettingsLoaded();
        const win = windows[windowId];
        if (!win) return;
        const selectedModel = document.getElementById(`model-${windowId}`).value;
        const is65535Model = selectedModel === 'gpt-image-2-65535';
        const usesMappedImageSize = isGptImageModel(selectedModel);
        const selectedImageSize = getFixedBananaModelSize(selectedModel) || win.selectedSize;
        const mappedImageSize = usesMappedImageSize ? getOpenAIImageSize(selectedImageSize, win.selectedRatio) : selectedImageSize;
        const grsaiApiKey = globalConfig.apiKey || document.getElementById('apiKey').value.trim();
        const apiKey65535 = globalConfig.apiKey65535 || document.getElementById('apiKey65535').value.trim();

        if (!is65535Model && !grsaiApiKey) {
            showToast('请先在设置中配置 GRSAI API Key', 'error');
            openSettings();
            return;
        }
        if (is65535Model && !apiKey65535) {
            showToast('请先在设置中配置 65535 API Key', 'error');
            openSettings();
            return;
        }

        const prompt = document.getElementById(`singlePrompt-${windowId}`).value.trim();
        if (!prompt) {
            showToast('请输入提示词', 'error');
            return;
        }
        if ((win.referenceImageItems || []).some(item => item.status === 'indexing' || item.status === 'uploading')) {
            showToast('参考图还在入库，请稍等完成后再生成', 'info');
            return;
        }

        const referenceHashes = (win.referenceImageItems || [])
            .filter(item => item.status === 'ready' && item.assetHash)
            .map(item => item.assetHash);
        const count = parseInt(document.getElementById(`countPerPrompt-${windowId}`).value, 10) || 1;
        const generation = {
            id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            status: 'running',
            prompt,
            model: selectedModel,
            imageSize: mappedImageSize,
            aspectRatio: usesMappedImageSize ? mappedImageSize : win.selectedRatio,
            referenceHashes,
            resultHashes: [],
            error: '',
            createdAt: Date.now(),
            completedAt: null
        };
        await LocalGalleryDB.putGeneration(generation);

        const taskData = { status: 'running', total: count, completed: 0, failed: 0, results: Array(count).fill(null), generationId: generation.id };
        generationRuntime.set(windowId, taskData);
        win.taskId = generation.id;
        document.getElementById(`taskStatus-${windowId}`).style.display = 'block';
        updateTaskStatus(windowId, taskData);
        showToast('浏览器本地任务已开始', 'success');

        const generateBtn = document.getElementById(`generateBtn-${windowId}`);
        generateBtn.classList.add('loading');

        const provider = is65535Model ? '65535' : 'grsai';
        const apiKey = is65535Model ? apiKey65535 : grsaiApiKey;
        const concurrent = Math.max(1, Math.min(count, parseInt(globalConfig.concurrentLimit, 10) || 1));
        const auditAspectRatio = usesMappedImageSize ? mappedImageSize : win.selectedRatio;
        let cursor = 0;

        async function worker() {
            while (cursor < count) {
                const index = cursor++;
                const auditId = `${generation.id}-${index + 1}`;
                let auditBase = {
                    id: auditId,
                    local_generation_id: generation.id,
                    attempt_index: index + 1,
                    provider,
                    prompt,
                    model: selectedModel,
                    image_size: mappedImageSize,
                    aspect_ratio: auditAspectRatio,
                    api_key_label: AdminAuditClient.maskApiKey(apiKey),
                    api_key_sha256: '',
                    reference_count: referenceHashes.length,
                    created_at: AdminAuditClient.toIso(generation.createdAt)
                };
                let providerMeta = { providerTaskId: '', providerHost: '' };
                try {
                    try {
                        auditBase = await AdminAuditClient.buildBase({
                            auditId,
                            localGenerationId: generation.id,
                            attemptIndex: index + 1,
                            provider,
                            apiKey,
                            prompt,
                            model: selectedModel,
                            imageSize: mappedImageSize,
                            aspectRatio: auditAspectRatio,
                            referenceHashes,
                            createdAt: generation.createdAt
                        });
                    } catch (auditError) {
                        console.warn('admin audit key fingerprint failed:', auditError);
                    }
                    AdminAuditClient.report({ ...auditBase, status: 'submitting' });

                    const blobs = await BrowserGenerationClient.generateImage({
                        provider,
                        apiKey,
                        prompt,
                        model: selectedModel,
                        imageSize: mappedImageSize,
                        aspectRatio: auditAspectRatio,
                        referenceHashes,
                        onProviderTask: meta => {
                            providerMeta = meta || providerMeta;
                            AdminAuditClient.report({
                                ...auditBase,
                                status: 'running',
                                provider_task_id: providerMeta.providerTaskId || '',
                                provider_host: providerMeta.providerHost || ''
                            });
                        }
                    });
                    const blob = await ImageAssetService.convertToJpegBlob(blobs[0]);
                    const ext = ImageAssetService.extensionFromMime(blob.type || 'image/jpeg');
                    const asset = await ImageAssetService.saveAssetFromBlob(blob, 'generation', `${selectedModel}_${new Date().toISOString().replace(/[:.]/g, '-')}_${index + 1}.${ext}`);
                    generation.resultHashes.push(asset.hash);
                    taskData.completed += 1;
                    taskData.results[index] = { success: true, assetHash: asset.hash, prompt };
                    AdminAuditClient.report({
                        ...auditBase,
                        status: 'completed',
                        provider_task_id: providerMeta.providerTaskId || '',
                        provider_host: providerMeta.providerHost || '',
                        result_count: 1,
                        result_hashes: [asset.hash],
                        completed_at: AdminAuditClient.toIso(Date.now())
                    });
                } catch (error) {
                    taskData.failed += 1;
                    taskData.results[index] = { success: false, error: error.message || '\u751f\u6210\u5931\u8d25', prompt };
                    generation.error = generation.error || taskData.results[index].error;
                    AdminAuditClient.report({
                        ...auditBase,
                        status: 'failed',
                        provider_task_id: providerMeta.providerTaskId || '',
                        provider_host: providerMeta.providerHost || '',
                        error: taskData.results[index].error,
                        completed_at: AdminAuditClient.toIso(Date.now())
                    });
                }
                await LocalGalleryDB.putGeneration({ ...generation, status: 'running', resultHashes: [...generation.resultHashes] });
                updateTaskStatus(windowId, taskData);
            }
        }


        try {
            await Promise.all(Array.from({ length: concurrent }, worker));
            taskData.status = taskData.failed === count ? 'failed' : 'completed';
            generation.status = taskData.status;
            generation.completedAt = Date.now();
            await LocalGalleryDB.putGeneration(generation);
            updateTaskStatus(windowId, taskData);
            showToast(`任务完成，成功生成 ${taskData.completed} 张图片`, taskData.completed ? 'success' : 'error');
            if (document.getElementById('galleryModal')?.classList.contains('active')) renderGallery();
        } finally {
            generateBtn.classList.remove('loading');
        }
    }

    function pollTaskStatus() {
        return null;
    }

    async function updateTaskStatus(windowId, taskData) {
        const progress = taskData.total > 0 ? Math.round(((taskData.completed + taskData.failed) / taskData.total) * 100) : 0;
        const progressFill = document.getElementById(`taskProgress-${windowId}`);
        if (progressFill) progressFill.style.width = progress + '%';
        const info = document.getElementById(`taskInfo-${windowId}`);
        if (info) info.textContent = `${taskData.completed} / ${taskData.total} 已完成（${taskData.failed} 失败）`;
        const resultsContainer = document.getElementById(`taskResults-${windowId}`);
        if (!resultsContainer) return;
        resultsContainer.innerHTML = '';
        for (let i = 0; i < taskData.total; i += 1) {
            const result = taskData.results[i];
            const thumb = document.createElement('div');
            if (result && result.success) {
                thumb.className = 'result-thumb';
                thumb.innerHTML = '<div class="spinner"></div>';
                ImageAssetService.getAssetObjectUrl(result.assetHash, true).then(url => {
                    thumb.innerHTML = `<img src="${url}" alt="结果图">`;
                    thumb.onclick = () => showAssetImage(result.assetHash);
                }).catch(error => {
                    thumb.className = 'result-thumb loading';
                    thumb.innerHTML = '<div class="failed-icon"></div>';
                    thumb.title = error.message;
                });
            } else if (result && !result.success) {
                thumb.className = 'result-thumb loading';
                thumb.innerHTML = '<div class="failed-icon"></div>';
                thumb.title = result.error || '生成失败';
            } else {
                thumb.className = 'result-thumb loading';
                thumb.innerHTML = '<div class="spinner"></div>';
            }
            resultsContainer.appendChild(thumb);
        }
    }

    function installOverrides() {
        window.LocalGalleryDB = LocalGalleryDB;
        window.ImageAssetService = ImageAssetService;
        window.BrowserGenerationClient = BrowserGenerationClient;
        window.AdminAuditClient = AdminAuditClient;
        window.openGallery = openGallery;
        window.closeGallery = closeGallery;
        window.setGalleryFilter = setGalleryFilter;
        window.renderGallery = renderGallery;
        window.showAssetImage = showAssetImage;
        window.reuseAssetAsReference = reuseAssetAsReference;
        window.reuseGenerationRecord = reuseGenerationRecord;
        window.applyGenerationParamsToWindow = applyGenerationParamsToWindow;
        window.ensureActiveGenerationWindow = ensureActiveGenerationWindow;
        window.deleteGalleryAsset = deleteGalleryAsset;
        window.syncReferenceImages = syncReferenceImages;
        window.uploadReferenceFiles = uploadReferenceFiles;
        window.runUploadQueue = runUploadQueue;
        window.uploadReferenceItem = uploadReferenceItem;
        window.updateRefPreview = updateRefPreview;
        window.removeRefImage = removeRefImage;
        window.loadSettings = loadSettings;
        window.saveSettings = saveSettings;
        window.startGeneration = startGeneration;
        window.pollTaskStatus = pollTaskStatus;
        window.updateTaskStatus = updateTaskStatus;
        const originalUpdateEnabledModels = window.updateEnabledModels;
        window.updateEnabledModels = function updateEnabledModelsLocalAware() {
            const container = document.getElementById('modelConfigGroups');
            if (!container || !container.querySelector('input[type="checkbox"]')) {
                if (!enabledModels.length) enabledModels = [...AVAILABLE_MODELS];
                return;
            }
            originalUpdateEnabledModels();
        };
    }

    installOverrides();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureGalleryShell);
    } else {
        ensureGalleryShell();
    }
    document.addEventListener('paste', event => {
        handleClipboardPaste(event).catch(error => showToast(`粘贴图片失败: ${error.message}`, 'error')); 
    });
    window.addEventListener('beforeunload', () => objectUrls.forEach(url => URL.revokeObjectURL(url)));
})();
