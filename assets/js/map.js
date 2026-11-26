import { readPhotoMetadata } from './exif-reader.js';

const TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_{layer}/MapServer/tile/{z}/{y}/{x}';
const TILE_MAX_ZOOM = 16;
const ATTRIBUTION = 'Tiles &copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const CONCURRENCY = 6;
const PIN = 56;
const MAX_ZOOM = 18;
const FIT_MAX_ZOOM = 12;

const main = document.getElementById('main');
const toggles = Array.from(document.querySelectorAll('a[href="#map"]'));

if (main && toggles.length) {
    const photos = Array.from(main.querySelectorAll('.thumb > a.image'), (anchor, index) => {
        const image = anchor.querySelector('img');
        return {
            index,
            anchor,
            src: anchor.href,
            preview: image ? image.src : anchor.href,
            position: null
        };
    });

    if (!photos.length) {
        for (const toggle of toggles) {
            (toggle.closest('li') || toggle).remove();
        }
    } else {
        initMapView(photos);
    }
}

function initMapView(photos) {
    let view;
    let canvas;
    let status;
    let notice;
    let noticeHeading;
    let noticeBody;
    let map = null;
    let markers = new Map();
    let isOpen = false;
    let located = false;
    let locating = null;
    let interacted = false;
    let pendingFit = false;
    let leafletPromise = null;
    let renderFrame = null;

    build();

    for (const toggle of toggles) {
        toggle.addEventListener('click', event => {
            event.preventDefault();
            if (isOpen) leave();
            else enter();
        });
    }

    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    sync();

    function build() {
        view = document.createElement('section');
        view.id = 'map-view';
        view.hidden = true;
        view.setAttribute('aria-label', 'Photo map');

        canvas = document.createElement('div');
        canvas.className = 'map-canvas';

        status = document.createElement('div');
        status.className = 'map-status';
        status.hidden = true;
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');

        notice = document.createElement('div');
        notice.className = 'map-notice';
        notice.hidden = true;

        const noticeIcon = document.createElement('span');
        noticeIcon.className = 'map-notice-icon icon icon-map';
        noticeIcon.setAttribute('aria-hidden', 'true');
        noticeHeading = document.createElement('h2');
        noticeBody = document.createElement('p');
        notice.append(noticeIcon, noticeHeading, noticeBody);

        view.append(canvas, status, notice);
        document.body.append(view);

        for (const type of ['pointerdown', 'wheel', 'keydown']) {
            canvas.addEventListener(type, () => { interacted = true; }, { passive: true });
        }
    }

    function enter() {
        if (location.hash !== '#map') history.pushState({ mapView: true }, '', '#map');
        open();
    }

    function leave() {
        if (history.state?.mapView) {
            history.back();
            return;
        }
        if (location.hash === '#map') {
            history.replaceState(null, '', location.pathname + location.search);
        }
        close();
    }

    function sync() {
        if (location.hash === '#map') open();
        else close();
    }

    async function open() {
        if (isOpen) return;
        isOpen = true;
        view.hidden = false;
        document.body.classList.add('map-active');
        updateToggles();

        try {
            const L = await loadLeaflet();
            if (!isOpen) return;
            if (!located) hideNotice();
            if (map) map.invalidateSize();
            else createMap(L);
            if (pendingFit) {
                pendingFit = false;
                fitAll(false);
            }
            locate();
        } catch {
            if (isOpen) {
                showNotice('Map unavailable', 'The map could not be loaded. Check your connection and try again.');
            }
        }
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        view.hidden = true;
        document.body.classList.remove('map-active');
        map?.closePopup();
        updateToggles();
    }

    function updateToggles() {
        for (const toggle of toggles) {
            const label = toggle.querySelector('.nav-label') || toggle;
            label.textContent = isOpen ? 'Gallery' : 'Map';
            toggle.classList.toggle('icon-map', !isOpen);
            toggle.classList.toggle('icon-grid', isOpen);
        }
    }

    function loadLeaflet() {
        if (window.L) return Promise.resolve(window.L);
        if (!leafletPromise) {
            leafletPromise = Promise.all([
                attach('link', { rel: 'stylesheet', href: new URL('../css/leaflet.css', import.meta.url).href }).catch(() => {}),
                attach('script', { src: new URL('./leaflet.js', import.meta.url).href })
            ]).then(() => {
                if (!window.L) throw new Error('Leaflet did not load');
                return window.L;
            });
            leafletPromise.catch(() => { leafletPromise = null; });
        }
        return leafletPromise;
    }

    function attach(tag, attributes) {
        return new Promise((resolve, reject) => {
            const element = document.createElement(tag);
            Object.assign(element, attributes);
            element.onload = resolve;
            element.onerror = () => {
                element.remove();
                reject(new Error(`Failed to load ${tag}`));
            };
            document.head.append(element);
        });
    }

    function createMap(L) {
        map = L.map(canvas, {
            center: [20, 0],
            zoom: 2,
            minZoom: 2,
            maxZoom: MAX_ZOOM,
            maxBounds: [[-85, -100000], [85, 100000]],
            maxBoundsViscosity: 1,
            worldCopyJump: true,
            zoomControl: false,
            zoomSnap: 0.25,
            zoomDelta: 0.5,
            wheelPxPerZoomLevel: 120
        });
        map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
        L.tileLayer(TILES, { layer: 'Base', attribution: ATTRIBUTION, maxNativeZoom: TILE_MAX_ZOOM }).addTo(map);
        L.tileLayer(TILES, { layer: 'Reference', maxNativeZoom: TILE_MAX_ZOOM }).addTo(map);

        const zoom = L.control.zoom({ position: 'topright', zoomInTitle: 'Zoom in', zoomOutTitle: 'Zoom out' }).addTo(map);
        const fit = L.DomUtil.create('a', 'map-fit', zoom.getContainer());
        fit.href = '#';
        fit.setAttribute('role', 'button');
        fit.setAttribute('aria-label', 'Show all photos');
        const fitIcon = document.createElement('span');
        fitIcon.className = 'icon icon-crosshairs';
        fitIcon.setAttribute('aria-hidden', 'true');
        fit.append(fitIcon);
        L.DomEvent.disableClickPropagation(fit);
        L.DomEvent.on(fit, 'click', event => {
            L.DomEvent.preventDefault(event);
            fitAll(true);
        });

        map.on('zoomend', scheduleRender);
    }

    function locate() {
        if (locating) return;
        showLocatingStatus();
        const queue = photos.slice();

        async function worker() {
            while (queue.length) {
                const photo = queue.shift();
                if (!photo) break;
                const meta = await readPhotoMetadata(photo.src);
                photo.position = meta?.position ?? null;
                if (photo.position) scheduleRender();
            }
        }

        locating = Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker())
        ).then(() => {
            located = true;
            finish();
        });
    }

    function finish() {
        const count = mapped().length;
        const missing = photos.length - count;
        if (!count) {
            showNotice('No locations yet', 'Photos appear here when their metadata includes GPS coordinates.');
            return;
        }
        showLocatedStatus(count, missing);
        if (interacted) return;
        if (isOpen) fitAll(true);
        else pendingFit = true;
    }

    function fitAll(animate) {
        const points = mapped().map(photo => photo.position);
        if (!map || !points.length) return;
        map.closePopup();
        const options = { padding: [PIN * 1.5, PIN * 1.5], maxZoom: FIT_MAX_ZOOM, duration: 1.2 };
        if (animate && !reducedMotion()) map.flyToBounds(points, options);
        else map.fitBounds(points, { padding: options.padding, maxZoom: FIT_MAX_ZOOM, animate: false });
    }

    function clearStatus() {
        status.replaceChildren();
        status.hidden = true;
    }

    function showLocatingStatus() {
        const spinner = document.createElement('span');
        spinner.className = 'icon icon-spinner icon-spin';
        spinner.setAttribute('aria-hidden', 'true');
        status.replaceChildren(spinner, document.createTextNode(' Locating photos'));
        status.hidden = false;
    }

    function showLocatedStatus(count, missing) {
        const nodes = [document.createTextNode(`${count} ${count === 1 ? 'photo' : 'photos'}`)];
        if (missing) {
            const detail = document.createElement('span');
            detail.className = 'map-status-detail';
            detail.textContent = `${missing} without location`;
            nodes.push(detail);
        }
        status.replaceChildren(...nodes);
        status.hidden = false;
    }

    function showNotice(title, text) {
        clearStatus();
        noticeHeading.textContent = title;
        noticeBody.textContent = text;
        notice.hidden = false;
        view.classList.add('quiet');
    }

    function hideNotice() {
        notice.hidden = true;
        view.classList.remove('quiet');
    }

    function mapped() {
        return photos.filter(photo => photo.position);
    }

    function scheduleRender() {
        if (!map || renderFrame) return;
        renderFrame = window.requestAnimationFrame(() => {
            renderFrame = null;
            render();
        });
    }

    function render() {
        const L = window.L;
        const zoom = map.getZoom();
        const groups = [];
        const next = new Map();

        for (const photo of mapped()) {
            const point = map.project(photo.position, zoom);
            const existing = groups.find(group => group.seed.distanceTo(point) < PIN);
            if (existing) {
                existing.photos.push(photo);
                existing.sum = existing.sum.add(point);
            } else {
                groups.push({ seed: point, sum: point, photos: [photo] });
            }
        }

        for (const group of groups) {
            const key = group.photos.map(photo => photo.index).join(',');
            const position = map.unproject(group.sum.divideBy(group.photos.length), zoom);
            const marker = markers.get(key) || createMarker(L, group.photos);
            marker.setLatLng(position);
            next.set(key, marker);
            markers.delete(key);
        }

        for (const stale of markers.values()) stale.remove();
        for (const marker of next.values()) {
            if (!map.hasLayer(marker)) marker.addTo(map);
        }
        markers = next;
    }

    function createMarker(L, group) {
        const count = group.length;
        const pin = document.createElement('span');
        pin.className = 'map-pin';
        const frame = document.createElement('span');
        frame.className = 'map-pin-frame';
        frame.append(thumbnail(group[0]));
        pin.append(frame);

        if (count > 1) {
            const badge = document.createElement('span');
            badge.className = 'map-pin-count';
            badge.textContent = String(count);
            pin.append(badge);
        }

        const marker = L.marker([0, 0], {
            icon: L.divIcon({
                className: `map-marker${count > 1 ? ' group' : ''}`,
                html: pin,
                iconSize: [PIN, PIN],
                iconAnchor: [PIN / 2, PIN + 8]
            }),
            title: count > 1 ? `${count} photos` : 'View photo',
            riseOnHover: true
        });
        marker.on('click', () => {
            if (count === 1) show(group[0], marker.getElement());
            else expand(L, group, marker);
        });
        return marker;
    }

    function thumbnail(photo) {
        const image = document.createElement('img');
        image.alt = '';
        image.draggable = false;
        image.decoding = 'async';
        image.src = photo.preview;
        return image;
    }

    function expand(L, group, marker) {
        const bounds = L.latLngBounds(group.map(photo => photo.position));
        const maxZoom = map.getMaxZoom();
        const spread = map.project(bounds.getNorthEast(), maxZoom).distanceTo(map.project(bounds.getSouthWest(), maxZoom));
        if (spread >= PIN && map.getZoom() < maxZoom) {
            const options = { padding: [PIN * 1.5, PIN * 1.5], maxZoom };
            if (reducedMotion()) map.fitBounds(bounds, options);
            else map.flyToBounds(bounds, { duration: 0.8, ...options });
            return;
        }

        const list = document.createElement('div');
        list.className = 'map-group';
        const title = document.createElement('p');
        title.className = 'map-group-title';
        title.textContent = `${group.length} photos here`;
        const grid = document.createElement('div');
        grid.className = 'map-group-grid';
        grid.style.setProperty('--columns', String(Math.min(group.length, 3)));

        group.forEach((photo, i) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('aria-label', `View photo ${i + 1} of ${group.length}`);
            button.append(thumbnail(photo));
            button.addEventListener('click', () => show(photo, button));
            grid.append(button);
        });

        list.append(title, grid);
        L.popup({
            className: 'map-popup',
            maxWidth: 360,
            offset: [0, -PIN - 4],
            autoPanPadding: [PIN, PIN]
        }).setLatLng(marker.getLatLng()).setContent(list).openOn(map);

        grid.querySelector('button')?.focus({ preventScroll: true });
    }

    function show(photo, from) {
        from?.focus({ preventScroll: true });
        photo.anchor.click();
    }

    function reducedMotion() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
}
