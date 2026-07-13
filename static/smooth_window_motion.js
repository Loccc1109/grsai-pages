(function () {
    const MIN_WIDTH = 400;
    const MIN_HEIGHT = 300;
    const BODY_CLASS = 'window-motion-active';
    let active = null;
    let rafId = 0;

    function installStyles() {
        if (document.getElementById('smooth-window-motion-style')) return;
        const style = document.createElement('style');
        style.id = 'smooth-window-motion-style';
        style.textContent = `
            .window.window-dragging,
            .window.window-resizing {
                will-change: transform, width, height;
                transition: box-shadow 120ms ease !important;
                box-shadow: 0 30px 90px rgba(0, 0, 0, 0.50), 0 0 0 1px rgba(255, 255, 255, 0.16) !important;
            }

            .window.window-dragging .window-content {
                pointer-events: none;
            }

            body.${BODY_CLASS} {
                user-select: none;
                -webkit-user-select: none;
            }

            body.${BODY_CLASS} * {
                cursor: inherit !important;
            }
        `;
        document.head.appendChild(style);
    }

    function getDesktopBounds() {
        const desktop = document.getElementById('desktop');
        return {
            width: desktop?.clientWidth || window.innerWidth,
            height: desktop?.clientHeight || Math.max(0, window.innerHeight - 65)
        };
    }

    function getDesktopRect() {
        const desktop = document.getElementById('desktop');
        return desktop?.getBoundingClientRect() || { left: 0, top: 65 };
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(value, max));
    }

    function scheduleFrame() {
        if (!rafId) rafId = requestAnimationFrame(applyFrame);
    }

    function applyFrame() {
        rafId = 0;
        if (!active?.element) return;

        if (active.type === 'drag') {
            active.element.style.transform = `translate3d(${active.dx}px, ${active.dy}px, 0)`;
            return;
        }

        active.element.style.width = `${active.width}px`;
        active.element.style.height = `${active.height}px`;
    }

    function isInteractiveTarget(target) {
        return Boolean(target.closest('.window-controls, button, input, select, textarea, a, [contenteditable="true"]'));
    }

    function startDrag(event, windowId) {
        if (event.button !== undefined && event.button !== 0) return;
        if (isInteractiveTarget(event.target)) return;

        const win = windows[windowId];
        if (!win?.element || win.isMaximized) return;

        event.preventDefault();
        activateWindow(windowId);

        const rect = win.element.getBoundingClientRect();
        const desktopRect = getDesktopRect();
        active = {
            type: 'drag',
            windowId,
            element: win.element,
            startX: event.clientX,
            startY: event.clientY,
            initialX: rect.left - desktopRect.left,
            initialY: rect.top - desktopRect.top,
            width: rect.width,
            height: rect.height,
            targetX: rect.left - desktopRect.left,
            targetY: rect.top - desktopRect.top,
            dx: 0,
            dy: 0
        };

        win.element.classList.add('window-dragging');
        document.body.classList.add(BODY_CLASS);
        document.body.style.cursor = 'move';
        document.addEventListener('mousemove', handleMove, { passive: false });
        document.addEventListener('mouseup', finishMotion, { once: true });
        document.addEventListener('keydown', handleKeyDown);
    }

    function startResize(event, windowId) {
        if (event.button !== undefined && event.button !== 0) return;

        const win = windows[windowId];
        if (!win?.element || win.isMaximized) return;

        event.preventDefault();
        event.stopPropagation();
        activateWindow(windowId);

        const rect = win.element.getBoundingClientRect();
        const desktopRect = getDesktopRect();
        active = {
            type: 'resize',
            windowId,
            element: win.element,
            startX: event.clientX,
            startY: event.clientY,
            left: rect.left - desktopRect.left,
            top: rect.top - desktopRect.top,
            initialWidth: rect.width,
            initialHeight: rect.height,
            width: rect.width,
            height: rect.height
        };

        win.element.classList.add('window-resizing');
        document.body.classList.add(BODY_CLASS);
        document.body.style.cursor = 'nwse-resize';
        document.addEventListener('mousemove', handleMove, { passive: false });
        document.addEventListener('mouseup', finishMotion, { once: true });
        document.addEventListener('keydown', handleKeyDown);
    }

    function handleMove(event) {
        if (!active) return;
        event.preventDefault();

        const bounds = getDesktopBounds();
        if (active.type === 'drag') {
            const rawX = active.initialX + event.clientX - active.startX;
            const rawY = active.initialY + event.clientY - active.startY;
            active.targetX = clamp(rawX, 0, Math.max(0, bounds.width - active.width));
            active.targetY = clamp(rawY, 0, Math.max(0, bounds.height - active.height));
            active.dx = Math.round(active.targetX - active.initialX);
            active.dy = Math.round(active.targetY - active.initialY);
        } else {
            const rawWidth = active.initialWidth + event.clientX - active.startX;
            const rawHeight = active.initialHeight + event.clientY - active.startY;
            active.width = Math.round(clamp(rawWidth, MIN_WIDTH, Math.max(MIN_WIDTH, bounds.width - active.left)));
            active.height = Math.round(clamp(rawHeight, MIN_HEIGHT, Math.max(MIN_HEIGHT, bounds.height - active.top)));
        }

        scheduleFrame();
    }

    function handleKeyDown(event) {
        if (event.key === 'Escape') cancelMotion();
    }

    function cleanup() {
        document.removeEventListener('mousemove', handleMove);
        document.removeEventListener('keydown', handleKeyDown);
        document.body.classList.remove(BODY_CLASS);
        document.body.style.cursor = '';
    }

    function cancelMotion() {
        if (!active) return;
        const { element, type } = active;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        if (type === 'drag') element.style.transform = '';
        if (type === 'resize') {
            element.style.width = `${Math.round(active.initialWidth)}px`;
            element.style.height = `${Math.round(active.initialHeight)}px`;
        }
        element.classList.remove('window-dragging', 'window-resizing');
        active = null;
        cleanup();
    }

    function finishMotion() {
        if (!active) return;
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
            applyFrame();
        }

        const { element, windowId } = active;
        if (active.type === 'drag') {
            const snapped = typeof snapWindowPosition === 'function'
                ? snapWindowPosition(windowId, active.targetX, active.targetY, active.width, active.height)
                : { x: active.targetX, y: active.targetY };
            element.style.transform = '';
            element.style.left = `${Math.round(snapped.x)}px`;
            element.style.top = `${Math.round(snapped.y)}px`;
        } else {
            const snappedSize = typeof snapWindowSize === 'function'
                ? snapWindowSize(windowId, active.left, active.top, active.width, active.height)
                : { width: active.width, height: active.height };
            element.style.width = `${Math.round(snappedSize.width)}px`;
            element.style.height = `${Math.round(snappedSize.height)}px`;
        }

        element.classList.remove('window-dragging', 'window-resizing');
        active = null;
        cleanup();
    }

    installStyles();
    window.startDrag = startDrag;
    window.startResize = startResize;
})();
