const INTERVAL = 3000;
const MIN_RATIO = 0.55;
const MAX_RATIO = 2.2;
const DUAL_MIN_RATIO = 1.3;
const DUAL_CHANCE = 0.35;
const IDLE_DELAY = 2500;

// Damped harmonic spring curve (1 - exp(-7t) * cos(8.5t)) sampled for native CSS linear() easing.
const SPRING_EASING = `linear(${Array.from({ length: 25 }, (_, i) => {
    const t = i / 24;
    return i === 24 ? '1' : (1 - Math.exp(-7 * t) * Math.cos(8.5 * t)).toFixed(4);
}).join(', ')})`;

const main = document.getElementById('main');
const wrapper = document.getElementById('wrapper');
const toggles = Array.from(document.querySelectorAll('a[href="#display"]'));

if (main && toggles.length) {
    const sources = [...new Set(Array.from(main.querySelectorAll('.thumb > a.image'), a => a.href))];

    if (!sources.length) {
        for (const toggle of toggles) {
            (toggle.closest('li') || toggle).remove();
        }
    } else {
        initDisplayMode(sources);
    }
}

function initDisplayMode(sources) {
    const lookahead = Math.min(10, Math.max(6, Math.ceil(sources.length / 3)));
    let display;
    let stage;
    let pauseButton;
    let pauseIcon;
    let rows = [];
    const loads = new Map();
    const failed = new Set();
    const inUse = new Map();
    let deck = [];
    const ready = [];
    let pending = 0;
    let isOpen = false;
    let paused = false;
    let busy = false;
    let inFullscreen = false;
    let generation = 0;
    let turn = 0;
    let timer = null;
    let idleTimer = null;
    let layoutFrame = null;
    let wakeLock = null;
    let returnFocus = null;

    build();

    for (const toggle of toggles) {
        toggle.addEventListener('click', event => {
            event.preventDefault();
            open(toggle);
        });
    }

    window.addEventListener('hashchange', () => {
        if (location.hash === '#display') open();
    });
    if (location.hash === '#display') open();

    function build() {
        display = document.createElement('div');
        display.id = 'display';
        display.hidden = true;
        display.tabIndex = -1;
        display.setAttribute('role', 'dialog');
        display.setAttribute('aria-modal', 'true');
        display.setAttribute('aria-label', 'Display mode');

        stage = document.createElement('div');
        stage.className = 'display-stage';
        stage.setAttribute('aria-hidden', 'true');

        const controls = document.createElement('div');
        controls.className = 'display-controls';

        const hint = document.createElement('span');
        hint.className = 'display-hint';
        hint.textContent = 'Space to pause \u00B7 Esc to exit';

        pauseButton = document.createElement('button');
        pauseButton.type = 'button';
        pauseButton.className = 'display-pause';
        pauseIcon = document.createElement('span');
        pauseIcon.setAttribute('aria-hidden', 'true');
        pauseButton.append(pauseIcon);

        const exitButton = document.createElement('button');
        exitButton.type = 'button';
        exitButton.className = 'display-exit';
        exitButton.setAttribute('aria-label', 'Exit display mode');
        const exitIcon = document.createElement('span');
        exitIcon.className = 'icon icon-close';
        exitIcon.setAttribute('aria-hidden', 'true');
        exitButton.append(exitIcon);

        controls.append(hint, pauseButton, exitButton);
        display.append(stage, controls);
        document.body.append(display);

        pauseButton.addEventListener('click', togglePause);
        exitButton.addEventListener('click', close);

        display.addEventListener('pointermove', showControls);
        display.addEventListener('pointerdown', showControls);
        document.addEventListener('keydown', onKeydown, true);
        document.addEventListener('fullscreenchange', onFullscreenChange);
        document.addEventListener('visibilitychange', () => {
            if (isOpen && !document.hidden) requestWakeLock();
        });

        new ResizeObserver(scheduleLayout).observe(stage);
    }

    function open(trigger) {
        if (isOpen) return;
        isOpen = true;
        paused = false;
        returnFocus = trigger || document.activeElement;
        display.hidden = false;
        document.body.classList.add('display-active');
        setInert(true);
        requestFullscreen();
        requestWakeLock();
        updatePauseButton();
        display.focus({ preventScroll: true });
        showControls();
        layout();
        prefetch();
        schedule();
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        clearTimeout(timer);
        clearTimeout(idleTimer);
        clearRows();
        display.hidden = true;
        document.body.classList.remove('display-active');
        setInert(false);
        if (wakeLock) {
            wakeLock.release().catch(() => {});
            wakeLock = null;
        }
        if (location.hash === '#display') {
            history.replaceState(null, '', location.pathname + location.search);
        }

        if (document.fullscreenElement === display) {
            inFullscreen = false;
            document.exitFullscreen().then(restoreFocus, restoreFocus);
        } else {
            restoreFocus();
        }
    }

    function setInert(inert) {
        for (const element of [wrapper, document.getElementById('map-view')]) {
            if (element) element.inert = inert;
        }
    }

    function restoreFocus() {
        if (isOpen || !returnFocus) return;
        returnFocus.focus?.({ preventScroll: true });
        returnFocus = null;
    }

    function onKeydown(event) {
        if (!isOpen) return;
        showControls();
        if (event.key === 'Escape') {
            close();
        } else if (event.key === ' ' && !event.target.closest('button')) {
            togglePause();
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            shift().then(schedule);
        } else {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
    }

    function togglePause() {
        paused = !paused;
        updatePauseButton();
        showControls();
        schedule();
    }

    function updatePauseButton() {
        pauseButton.setAttribute('aria-label', paused ? 'Play' : 'Pause');
        pauseIcon.className = `icon ${paused ? 'icon-play' : 'icon-pause'}`;
        display.classList.toggle('paused', paused);
    }

    function showControls() {
        display.classList.remove('idle');
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (!paused) display.classList.add('idle');
        }, IDLE_DELAY);
    }

    function schedule() {
        clearTimeout(timer);
        if (isOpen && !paused) timer = setTimeout(tick, INTERVAL);
    }

    function tick() {
        const stageFilled = rows.length > 0 && rows.every(row => rowWidth(tilesOf(row), gapOf(row)) >= stage.clientWidth);
        if (document.hidden || !stageFilled) schedule();
        else shift().then(schedule);
    }

    function requestFullscreen() {
        if (!display.requestFullscreen) return;
        display.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    }

    function onFullscreenChange() {
        if (document.fullscreenElement === display) {
            inFullscreen = true;
            return;
        }
        if (inFullscreen) {
            inFullscreen = false;
            close();
        }
        restoreFocus();
    }

    async function requestWakeLock() {
        if (wakeLock || !navigator.wakeLock) return;
        try {
            const lock = await navigator.wakeLock.request('screen');
            if (!isOpen) {
                await lock.release();
                return;
            }
            wakeLock = lock;
            lock.addEventListener('release', () => {
                if (wakeLock === lock) wakeLock = null;
            });
        } catch {
            // Wake Lock may be declined in background tabs or restricted contexts.
        }
    }

    function reducedMotion() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function prefetch() {
        while (ready.length + pending < lookahead) {
            const src = draw();
            if (!src) return;
            fetchPhoto(src);
        }
    }

    function fetchPhoto(src) {
        pending++;
        use(src, 1);
        if (!loads.has(src)) loads.set(src, load(src));
        loads.get(src).then(photo => {
            pending--;
            if (photo) {
                ready.push(photo);
            } else {
                failed.add(src);
                use(src, -1);
            }
            if (isOpen) {
                fillRows(true);
                prefetch();
            }
        });
    }

    async function load(src) {
        const image = new Image();
        image.decoding = 'async';
        const loaded = await new Promise(resolve => {
            image.onload = () => resolve(true);
            image.onerror = () => resolve(false);
            image.src = src;
        });
        if (!loaded) return null;
        await image.decode().catch(() => {});
        return image.naturalWidth && image.naturalHeight
            ? { src, ratio: image.naturalWidth / image.naturalHeight, image }
            : null;
    }

    function draw() {
        const candidates = sources.filter(src => !failed.has(src));
        if (!candidates.length) return null;
        deck = deck.filter(src => !failed.has(src));
        let index = deck.findIndex(src => !inUse.get(src));
        if (index < 0) {
            deck = shuffle(candidates);
            index = Math.max(0, deck.findIndex(src => !inUse.get(src)));
        }
        return deck.splice(index, 1)[0];
    }

    function use(src, delta) {
        inUse.set(src, (inUse.get(src) || 0) + delta);
    }

    function take(index = 0) {
        const [photo] = ready.splice(index, 1);
        if (photo) use(photo.src, -1);
        return photo;
    }

    function imageFor(photo) {
        const image = photo.image.parentNode ? photo.image.cloneNode(false) : photo.image;
        image.alt = '';
        image.draggable = false;
        image.className = '';
        image.removeAttribute('style');
        use(photo.src, 1);
        return image;
    }

    function release(element) {
        for (const image of element.querySelectorAll('img')) {
            use(image.src, -1);
        }
    }

    function scheduleLayout() {
        if (!isOpen || layoutFrame) return;
        layoutFrame = window.requestAnimationFrame(() => {
            layoutFrame = null;
            if (isOpen) layout();
        });
    }

    function rowCount() {
        const width = stage.clientWidth;
        const height = stage.clientHeight;
        return Math.max(2, Math.min(5, Math.ceil(height / Math.min(width * 0.6, 640))));
    }

    function layout() {
        const count = rowCount();
        if (count !== rows.length) {
            clearRows();
            for (let i = 0; i < count; i++) {
                const row = document.createElement('div');
                row.className = `display-row${i % 2 ? ' reverse' : ''}`;
                stage.append(row);
                rows.push(row);
            }
            schedule();
        }
        fillRows(true);
    }

    function clearRows() {
        generation++;
        busy = false;
        for (const row of rows) {
            release(row);
            for (const anim of row.getAnimations({ subtree: true })) anim.cancel();
        }
        stage.replaceChildren();
        rows = [];
    }

    function tilesOf(row) {
        return Array.from(row.children).filter(tile => !tile.classList.contains('leaving'));
    }

    function gapOf(row) {
        return parseFloat(window.getComputedStyle(row).columnGap) || 0;
    }

    function rowNeeds(row) {
        const width = stage.clientWidth;
        return width + Math.min(row.clientHeight * MAX_RATIO, width * 0.9);
    }

    function rowWidth(tiles, gap) {
        return tiles.reduce((sum, tile) => sum + tile.offsetWidth + gap, -gap);
    }

    function fillRows(animate) {
        let added;
        do {
            added = false;
            const ordered = rows.slice().sort(
                (a, b) => rowWidth(tilesOf(a), gapOf(a)) / rowNeeds(a) - rowWidth(tilesOf(b), gapOf(b)) / rowNeeds(b)
            );
            for (const row of ordered) {
                if (rowWidth(tilesOf(row), gapOf(row)) >= rowNeeds(row)) continue;
                const tile = createTile();
                if (!tile) break;
                row.append(tile);
                if (animate) enter(tile, tilesOf(row).length);
                added = true;
                break;
            }
        } while (added);
        for (const row of rows) trim(row);
        prefetch();
    }

    function trim(row) {
        const tiles = tilesOf(row);
        const gap = gapOf(row);
        let width = rowWidth(tiles, gap);
        const needed = rowNeeds(row);
        while (tiles.length > 1 && width - tiles.at(-1).offsetWidth - gap >= needed) {
            const last = tiles.pop();
            width -= last.offsetWidth + gap;
            release(last);
            last.remove();
        }
    }

    function createTile() {
        const first = take();
        if (!first) return null;
        const photos = [first];
        if (first.ratio >= DUAL_MIN_RATIO && Math.random() < DUAL_CHANCE) {
            const partner = ready.findIndex(item => item.ratio >= DUAL_MIN_RATIO);
            if (partner >= 0) photos.push(take(partner));
        }
        const tile = document.createElement('div');
        tile.className = `display-tile${photos.length > 1 ? ' dual' : ''}`;
        tile.style.aspectRatio = String(
            photos.length > 1
                ? (photos[0].ratio + photos[1].ratio) / 4
                : Math.max(MIN_RATIO, Math.min(MAX_RATIO, first.ratio))
        );
        for (const photo of photos) tile.append(imageFor(photo));
        return tile;
    }

    function enter(tile, index) {
        const keyframes = reducedMotion()
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [{ opacity: 0, scale: '0.94' }, { opacity: 1, scale: '1' }];
        tile.animate(keyframes, {
            duration: 700,
            delay: Math.min(index, 8) * 70,
            easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
            fill: 'backwards'
        });
    }

    function shift() {
        if (!isOpen || busy || !rows.length || !ready.length) return Promise.resolve();
        if (reducedMotion()) return crossfade();

        const row = rows[turn++ % rows.length];
        const tiles = tilesOf(row);
        const candidates = visibleTiles(tiles);
        if (!candidates.length) return Promise.resolve();

        const leaving = candidates[Math.floor(Math.random() * candidates.length)];
        const reverse = row.classList.contains('reverse');
        const gap = gapOf(row);
        const before = tiles.map(tile => tile.offsetLeft);
        const from = tiles.indexOf(leaving);
        const distance = (leaving.offsetWidth + gap) * (reverse ? -1 : 1);
        const gen = generation;
        const animations = [];

        busy = true;
        leaving.style.left = `${leaving.offsetLeft}px`;
        leaving.style.width = `${leaving.offsetWidth}px`;
        leaving.classList.add('leaving');
        animations.push(leaving.animate([
            { opacity: 1, scale: '1' },
            { opacity: 0.6, scale: '0.5', offset: 0.6 },
            { opacity: 0, scale: '0' }
        ], { duration: 600, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' }));

        fillRows(false);

        tilesOf(row).forEach((tile, i) => {
            const index = tiles.indexOf(tile);
            const dx = index < 0 ? distance : before[index] - tile.offsetLeft;
            if (Math.abs(dx) < 0.5) return;
            animations.push(tile.animate(
                [{ translate: `${dx}px 0` }, { translate: '0 0' }],
                {
                    duration: 1200,
                    easing: SPRING_EASING,
                    delay: 350 + Math.min(Math.abs(i - from), 6) * 20,
                    fill: 'backwards'
                }
            ));
        });

        return settle(animations, () => {
            release(leaving);
            leaving.remove();
            fillRows(false);
        }, gen);
    }

    function crossfade() {
        const images = rows.flatMap(row =>
            visibleTiles(tilesOf(row)).flatMap(tile => Array.from(tile.querySelectorAll('img')))
        );
        if (!images.length) return Promise.resolve();

        const old = images[Math.floor(Math.random() * images.length)];
        const ratio = old.clientWidth / old.clientHeight;
        let best = 0;
        ready.forEach((photo, i) => {
            if (Math.abs(Math.log(photo.ratio / ratio)) < Math.abs(Math.log(ready[best].ratio / ratio))) best = i;
        });

        const image = imageFor(take(best));
        const gen = generation;
        busy = true;
        image.className = 'display-swap';
        Object.assign(image.style, {
            left: `${old.offsetLeft}px`,
            top: `${old.offsetTop}px`,
            width: `${old.offsetWidth}px`,
            height: `${old.offsetHeight}px`
        });
        old.parentNode.append(image);
        const animations = [image.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1200, easing: 'ease-in-out' })];

        return settle(animations, () => {
            use(old.src, -1);
            image.className = '';
            image.removeAttribute('style');
            old.replaceWith(image);
            prefetch();
        }, gen);
    }

    async function settle(animations, finish, gen) {
        await Promise.allSettled(animations.map(animation => animation.finished));
        if (gen === generation) {
            busy = false;
            finish();
        }
    }

    function visibleTiles(tiles) {
        const bounds = stage.getBoundingClientRect();
        const visible = tiles.filter(tile => {
            const rect = tile.getBoundingClientRect();
            return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
        });
        return visible.length ? visible : tiles.filter(tile => {
            const rect = tile.getBoundingClientRect();
            return rect.right > bounds.left && rect.left < bounds.right;
        });
    }

    function shuffle(list) {
        const copy = list.slice();
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    }
}
