import { readPhotoMetadata } from './exif-reader.js';

function reducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function initPanels() {
    const triggers = document.querySelectorAll('[data-panel-open]');
    for (const trigger of triggers) {
        const panelId = trigger.dataset.panelOpen;
        const dialog = document.getElementById(panelId);
        if (!(dialog instanceof HTMLDialogElement)) continue;

        for (const closeBtn of dialog.querySelectorAll('[data-panel-close]')) {
            closeBtn.addEventListener('click', () => dialog.close());
        }

        trigger.addEventListener('click', () => {
            if (dialog.open) {
                dialog.close();
                return;
            }
            dialog.showModal();
            trigger.setAttribute('aria-expanded', 'true');
            document.body.classList.add('content-active');
        });

        dialog.addEventListener('close', () => {
            trigger.setAttribute('aria-expanded', 'false');
            document.body.classList.remove('content-active');
        });
    }
}

function initGalleryLayout(main) {
    const galleryLayout = main.dataset.layout || 'thumbnail';
    if (galleryLayout === 'thumbnail') return;

    const tiles = Array.from(main.querySelectorAll(':scope > .thumb'));
    main.classList.add('gallery-ready');

    if (galleryLayout === 'carousel') {
        initCarousel(main, tiles);
        return;
    }

    let pending = false;
    let previousWidth = 0;

    function scheduleLayout() {
        if (pending) return;
        pending = true;
        window.requestAnimationFrame(() => {
            pending = false;
            const width = main.clientWidth;
            if (!width) return;
            previousWidth = width;
            layoutTiles(main, tiles, width, galleryLayout);
        });
    }

    for (const tile of tiles) {
        const img = tile.querySelector('img');
        if (!img) continue;
        img.addEventListener('load', scheduleLayout);
        img.addEventListener('error', scheduleLayout);
    }

    const observer = new ResizeObserver(() => {
        if (main.clientWidth !== previousWidth) scheduleLayout();
    });
    observer.observe(main);
    scheduleLayout();
}

function layoutTiles(main, tileElements, width, galleryLayout) {
    const tiles = tileElements.map(element => {
        const img = element.querySelector('img');
        const ratio = img && img.naturalWidth && img.naturalHeight
            ? img.naturalWidth / img.naturalHeight
            : 1.5;
        return { element, ratio };
    });

    const place = (tile, left, top, tileWidth, height) => {
        Object.assign(tile.element.style, {
            left: `${left}px`,
            top: `${top}px`,
            width: `${tileWidth}px`,
            height: `${height}px`
        });
    };

    if (galleryLayout === 'masonry') {
        const gap = 8;
        const columns = Math.min(4, Math.max(1, Math.floor((width + gap) / (320 + gap))));
        const columnWidth = (width - gap * (columns - 1)) / columns;
        const heights = new Array(columns).fill(0);

        for (const tile of tiles) {
            const shortest = heights.indexOf(Math.min(...heights));
            const height = columnWidth / tile.ratio;
            place(tile, shortest * (columnWidth + gap), heights[shortest], columnWidth, height);
            heights[shortest] += height + gap;
        }

        main.style.height = `${Math.max(0, Math.max(...heights) - gap)}px`;
        return;
    }

    const rowGap = 4;
    const targetHeight = Math.min(Math.max(220, width / 4), width * 0.4);
    let row = [];
    let ratioSum = 0;
    let top = 0;

    const rowHeight = (count, sum) => (width - rowGap * (count - 1)) / sum;

    const finishRow = height => {
        let left = 0;
        for (const tile of row) {
            const tileWidth = tile.ratio * height;
            place(tile, left, top, tileWidth, height);
            left += tileWidth + rowGap;
        }
        top += height + rowGap;
        row = [];
        ratioSum = 0;
    };

    for (const tile of tiles) {
        if (tile.ratio * targetHeight >= width) {
            if (row.length) finishRow(Math.min(targetHeight, rowHeight(row.length, ratioSum)));
            row = [tile];
            finishRow(width / tile.ratio);
            continue;
        }

        const withTile = rowHeight(row.length + 1, ratioSum + tile.ratio);
        if (row.length && withTile < targetHeight) {
            const withoutTile = rowHeight(row.length, ratioSum);
            if (withoutTile - targetHeight <= targetHeight - withTile) {
                finishRow(withoutTile);
            } else {
                row.push(tile);
                finishRow(withTile);
                continue;
            }
        }

        row.push(tile);
        ratioSum += tile.ratio;
    }

    if (row.length) finishRow(Math.min(targetHeight, rowHeight(row.length, ratioSum)));
    main.style.height = `${Math.max(0, top - rowGap)}px`;
}

function initCarousel(main, tiles) {
    const count = tiles.length;
    if (!count) return;

    const viewport = document.createElement('div');
    viewport.className = 'carousel-viewport';
    const track = document.createElement('div');
    track.className = 'carousel-track';
    track.append(...tiles);
    viewport.append(track);
    main.append(viewport);

    main.tabIndex = 0;
    main.setAttribute('role', 'region');
    main.setAttribute('aria-roledescription', 'carousel');
    main.setAttribute('aria-label', 'Photo gallery');

    tiles.forEach((tile, i) => {
        tile.setAttribute('role', 'group');
        tile.setAttribute('aria-roledescription', 'slide');
        tile.setAttribute('aria-label', `${i + 1} / ${count}`);
    });

    let index = 0;
    let previous = null;
    let next = null;
    let counter = null;
    let dots = [];

    function syncUi() {
        tiles.forEach((tile, i) => {
            tile.setAttribute('aria-hidden', i !== index ? 'true' : 'false');
            const anchor = tile.querySelector('a');
            if (anchor) anchor.tabIndex = i === index ? 0 : -1;
        });

        if (!previous || !next || !counter) return;

        const prevDisabled = index === 0;
        const nextDisabled = index === count - 1;
        const active = document.activeElement;

        previous.disabled = prevDisabled;
        next.disabled = nextDisabled;

        if (prevDisabled && active === previous && !nextDisabled) {
            next.focus({ preventScroll: true });
        } else if (nextDisabled && active === next && !prevDisabled) {
            previous.focus({ preventScroll: true });
        }

        counter.textContent = `${index + 1} / ${count}`;
        dots.forEach((dot, i) => {
            if (i === index) dot.setAttribute('aria-current', 'true');
            else dot.removeAttribute('aria-current');
        });
    }

    function goTo(nextIndex, { instant = false } = {}) {
        index = Math.max(0, Math.min(count - 1, nextIndex));
        syncUi();
        const width = track.clientWidth;
        if (width > 0) {
            track.scrollTo({
                left: index * width,
                behavior: instant || reducedMotion() ? 'instant' : 'smooth'
            });
        }
    }

    if (count > 1) {
        previous = document.createElement('button');
        previous.type = 'button';
        previous.className = 'carousel-nav previous';
        previous.setAttribute('aria-label', 'Previous image');
        previous.textContent = '\u276E';

        next = document.createElement('button');
        next.type = 'button';
        next.className = 'carousel-nav next';
        next.setAttribute('aria-label', 'Next image');
        next.textContent = '\u276F';

        counter = document.createElement('div');
        counter.className = 'carousel-counter';
        counter.setAttribute('aria-live', 'polite');
        counter.setAttribute('aria-atomic', 'true');

        previous.addEventListener('click', () => goTo(index - 1));
        next.addEventListener('click', () => goTo(index + 1));
        viewport.append(previous, next, counter);

        if (count <= 12) {
            const indicators = document.createElement('div');
            indicators.className = 'carousel-indicators';
            dots = tiles.map((_, i) => {
                const dot = document.createElement('button');
                dot.type = 'button';
                dot.className = 'carousel-dot';
                dot.setAttribute('aria-label', `Go to image ${i + 1}`);
                dot.addEventListener('click', () => goTo(i));
                indicators.append(dot);
                return dot;
            });
            main.append(indicators);
        }
    }

    const syncFromScroll = () => {
        const width = track.clientWidth;
        if (!width) return;
        const settled = Math.max(0, Math.min(count - 1, Math.round(track.scrollLeft / width)));
        if (settled !== index) {
            index = settled;
            syncUi();
        }
    };

    track.addEventListener('scrollend', syncFromScroll, { passive: true });

    new ResizeObserver(() => {
        const width = track.clientWidth;
        if (width > 0) {
            track.scrollTo({ left: index * width, behavior: 'instant' });
        }
    }).observe(track);

    main.addEventListener('keydown', event => {
        if (document.body.classList.contains('modal-active') || document.body.classList.contains('content-active')) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            goTo(index + (event.key === 'ArrowLeft' ? -1 : 1));
        }
    });

    goTo(0, { instant: true });
}

function renderExifItems(caption, meta) {
    caption.replaceChildren();
    if (!meta) {
        caption.hidden = true;
        return;
    }

    const fields = [
        meta.model ? { icon: 'icon-camera', text: String(meta.model) } : null,
        meta.aperture !== undefined ? { icon: 'icon-aperture', text: `f/${meta.aperture}` } : null,
        meta.shutterSpeed ? { icon: 'icon-clock', text: String(meta.shutterSpeed) } : null,
        meta.iso !== undefined ? { icon: 'icon-info', text: `ISO ${meta.iso}` } : null
    ].filter(Boolean);

    if (!fields.length) {
        caption.hidden = true;
        return;
    }

    for (const field of fields) {
        const badge = document.createElement('span');
        badge.className = `lightbox-meta-item icon ${field.icon}`;
        badge.textContent = field.text;
        caption.append(badge);
    }
    caption.hidden = false;
}

function initLightbox(main) {
    const anchors = Array.from(main.querySelectorAll('.thumb > a.image'));
    if (!anchors.length) return;

    const dialog = document.createElement('dialog');
    dialog.id = 'lightbox';
    dialog.className = 'lightbox';
    dialog.tabIndex = -1;
    dialog.setAttribute('closedby', 'any');
    dialog.setAttribute('aria-label', 'Photo viewer');

    const frame = document.createElement('div');
    frame.className = 'lightbox-frame';

    const loader = document.createElement('div');
    loader.className = 'lightbox-loader';
    loader.setAttribute('aria-hidden', 'true');

    const figure = document.createElement('figure');
    figure.className = 'lightbox-figure';

    const image = document.createElement('img');
    image.className = 'lightbox-img';
    image.decoding = 'async';

    const caption = document.createElement('figcaption');
    caption.className = 'lightbox-caption';
    caption.hidden = true;

    const prevButton = document.createElement('button');
    prevButton.type = 'button';
    prevButton.className = 'lightbox-nav previous';
    prevButton.setAttribute('aria-label', 'Previous photo');
    prevButton.hidden = anchors.length <= 1;

    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'lightbox-nav next';
    nextButton.setAttribute('aria-label', 'Next photo');
    nextButton.hidden = anchors.length <= 1;

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'lightbox-close';
    closeButton.setAttribute('aria-label', 'Close photo viewer');

    figure.append(image, caption);
    frame.append(loader, figure, prevButton, nextButton, closeButton);
    dialog.append(frame);
    document.body.append(dialog);

    let currentIndex = 0;
    let loadToken = 0;
    let returnFocus = null;

    async function showAt(nextIndex) {
        currentIndex = (nextIndex + anchors.length) % anchors.length;
        const anchor = anchors[currentIndex];
        const thumbImg = anchor.querySelector('img');
        const src = anchor.href;
        const token = ++loadToken;

        dialog.classList.add('is-loading');
        caption.hidden = true;
        caption.replaceChildren();

        const exifPromise = readPhotoMetadata(src);
        const preload = new Image();
        preload.decoding = 'async';
        preload.src = src;
        await preload.decode().catch(() => {});
        if (token !== loadToken) return;

        image.alt = thumbImg?.alt || 'Photo';
        image.src = src;
        dialog.classList.remove('is-loading');

        const meta = await exifPromise;
        if (token !== loadToken) return;
        renderExifItems(caption, meta);
    }

    function openFrom(index, invoker) {
        const active = document.activeElement;
        returnFocus = active && active !== document.body ? active : invoker;
        if (!dialog.open) {
            image.removeAttribute('src');
            dialog.showModal();
            document.body.classList.add('modal-active');
        }
        showAt(index);
    }

    anchors.forEach((anchor, index) => {
        anchor.addEventListener('click', event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            openFrom(index, anchor);
        });
    });

    prevButton.addEventListener('click', () => showAt(currentIndex - 1));
    nextButton.addEventListener('click', () => showAt(currentIndex + 1));
    closeButton.addEventListener('click', () => dialog.close());

    document.addEventListener('keydown', event => {
        if (!dialog.open || anchors.length <= 1) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            showAt(currentIndex + (event.key === 'ArrowLeft' ? -1 : 1));
        }
    });

    dialog.addEventListener('close', () => {
        loadToken++;
        document.body.classList.remove('modal-active');
        if (returnFocus?.isConnected) {
            returnFocus.focus({ preventScroll: true });
        }
        returnFocus = null;
    });
}

const main = document.getElementById('main');
initPanels();
if (main) {
    initGalleryLayout(main);
    initLightbox(main);
}
