/*
 Map view: the gallery's photos placed on a map by the GPS coordinates in
 their EXIF metadata. Leaflet is loaded the first time the map opens, and
 only the start of each photo, where EXIF lives, is downloaded.
 */

(function () {
    'use strict';

    var TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_{layer}/MapServer/tile/{z}/{y}/{x}',
        TILE_MAX_ZOOM = 16,
        ATTRIBUTION = 'Tiles &copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, HERE, Garmin, ' +
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        // A JPEG's EXIF segment comes first and is limited to 64 KB.
        HEAD_BYTES = 131072,
        CONCURRENCY = 6,
        // Pin size in pixels; pins closer than this are grouped.
        PIN = 56,
        MAX_ZOOM = 18,
        FIT_MAX_ZOOM = 12;

    var main = document.getElementById('main'),
        toggles = Array.prototype.slice.call(document.querySelectorAll('a[href="#map"]')),
        script = document.currentScript;
    if (!main || !toggles.length) return;

    // Read now: the lightbox clears these links once the page is ready.
    var photos = Array.prototype.map.call(main.querySelectorAll('.thumb > a.image'), function (anchor, index) {
        var image = anchor.querySelector('img');
        return {
            index: index,
            anchor: anchor,
            src: anchor.href,
            preview: image ? image.src : anchor.href,
            position: null
        };
    });

    if (!photos.length) {
        toggles.forEach(function (toggle) {
            var item = toggle.closest('li') || toggle;
            item.parentNode.removeChild(item);
        });
        return;
    }

    var view, canvas, status, notice, map, markers = {},
        isOpen = false,
        located = false,
        locating = null,
        interacted = false,
        pendingFit = false,
        leaflet, renderFrame, returnFocus, lightboxOpen;

    build();

    toggles.forEach(function (toggle) {
        toggle.addEventListener('click', function (event) {
            event.preventDefault();
            if (isOpen) leave();
            else enter();
        });
    });

    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    sync();

    function build() {
        view = document.createElement('section');
        view.id = 'map-view';
        view.hidden = true;
        view.setAttribute('aria-label', 'Photo map');
        view.innerHTML =
            '<div class="map-canvas"></div>' +
            '<div class="map-status" role="status" aria-live="polite"></div>' +
            '<div class="map-notice" hidden><span class="fa fa-map-o" aria-hidden="true"></span>' +
            '<h2></h2><p></p></div>';
        document.body.appendChild(view);
        canvas = view.querySelector('.map-canvas');
        status = view.querySelector('.map-status');
        notice = view.querySelector('.map-notice');

        ['pointerdown', 'wheel', 'keydown'].forEach(function (type) {
            canvas.addEventListener(type, function () { interacted = true; }, { passive: true });
        });

        // Return focus to the pin once the lightbox it opened has closed.
        new MutationObserver(function () {
            var modal = document.body.classList.contains('modal-active');
            if (modal) {
                lightboxOpen = true;
            } else if (lightboxOpen) {
                lightboxOpen = false;
                if (isOpen && returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
                returnFocus = null;
            }
        }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    // Navigation. The map has its own history entry, so Back returns to the gallery.

    function enter() {
        if (location.hash !== '#map' && window.history.pushState) history.pushState({ mapView: true }, '', '#map');
        open();
    }

    function leave() {
        if (history.state && history.state.mapView) {
            history.back();
            return;
        }
        if (location.hash === '#map' && window.history.replaceState)
            history.replaceState(null, '', location.pathname + location.search);
        close();
    }

    function sync() {
        if (location.hash === '#map') open();
        else close();
    }

    function open() {
        if (isOpen) return;
        isOpen = true;
        view.hidden = false;
        document.body.classList.add('map-active');
        updateToggles();
        loadLeaflet().then(function (L) {
            if (!isOpen) return;
            // Clear a failed attempt's notice.
            if (!located) hideNotice();
            if (map) map.invalidateSize();
            else createMap(L);
            if (pendingFit) {
                pendingFit = false;
                fitAll(false);
            }
            locate();
        }, function () {
            showNotice('Map unavailable', 'The map could not be loaded. Check your connection and try again.');
        });
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        view.hidden = true;
        document.body.classList.remove('map-active');
        if (map) map.closePopup();
        updateToggles();
    }

    function updateToggles() {
        toggles.forEach(function (toggle) {
            toggle.textContent = isOpen ? 'Gallery' : 'Map';
            toggle.title = isOpen ? 'Back to the gallery' : 'Map view';
            toggle.classList.toggle('fa-map-o', !isOpen);
            toggle.classList.toggle('fa-th-large', isOpen);
        });
    }

    function loadLeaflet() {
        if (window.L) return Promise.resolve(window.L);
        if (!leaflet) {
            var base = script ? script.src : location.href;
            leaflet = Promise.all([
                attach('link', { rel: 'stylesheet', href: new URL('../css/leaflet.css', base).href }).then(null, function () {}),
                attach('script', { src: new URL('leaflet.js', base).href })
            ]).then(function () {
                if (!window.L) throw new Error('Leaflet did not load');
                return window.L;
            });
            leaflet.then(null, function () { leaflet = null; });
        }
        return leaflet;
    }

    function attach(tag, attributes) {
        return new Promise(function (resolve, reject) {
            var element = document.createElement(tag);
            for (var name in attributes) element[name] = attributes[name];
            element.onload = resolve;
            element.onerror = function () {
                element.parentNode.removeChild(element);
                reject();
            };
            document.head.appendChild(element);
        });
    }

    // Map.

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

        var zoom = L.control.zoom({ position: 'topright', zoomInTitle: 'Zoom in', zoomOutTitle: 'Zoom out' }).addTo(map),
            fit = L.DomUtil.create('a', 'map-fit', zoom.getContainer());
        fit.href = '#';
        fit.title = 'Show all photos';
        fit.setAttribute('role', 'button');
        fit.setAttribute('aria-label', 'Show all photos');
        fit.innerHTML = '<span class="fa fa-crosshairs" aria-hidden="true"></span>';
        L.DomEvent.disableClickPropagation(fit);
        L.DomEvent.on(fit, 'click', function (event) {
            L.DomEvent.preventDefault(event);
            fitAll(true);
        });

        map.on('zoomend', scheduleRender);
    }

    function locate() {
        if (locating) return;
        setStatus('<span class="fa fa-circle-o-notch fa-spin" aria-hidden="true"></span> Locating photos');
        var queue = photos.slice(),
            workers = [];
        function work() {
            var photo = queue.shift();
            if (!photo) return Promise.resolve();
            return readPosition(photo.src).then(function (position) {
                photo.position = position;
                if (position) scheduleRender();
            }).then(work);
        }
        for (var i = 0; i < Math.min(CONCURRENCY, queue.length); i++) workers.push(work());
        locating = Promise.all(workers).then(function () {
            located = true;
            finish();
        });
    }

    function finish() {
        var count = mapped().length,
            missing = photos.length - count;
        if (!count) {
            showNotice('No locations yet', 'Photos appear here when their metadata includes GPS coordinates.');
            return;
        }
        setStatus(count + (count === 1 ? ' photo' : ' photos') +
            (missing ? '<span class="map-status-detail">' + missing + ' without location</span>' : ''));
        if (interacted) return;
        if (isOpen) fitAll(true);
        else pendingFit = true;
    }

    function fitAll(animate) {
        var points = mapped().map(function (photo) { return photo.position; });
        if (!map || !points.length) return;
        map.closePopup();
        var options = { padding: [PIN * 1.5, PIN * 1.5], maxZoom: FIT_MAX_ZOOM, duration: 1.2 };
        if (animate && !reducedMotion()) map.flyToBounds(points, options);
        else map.fitBounds(points, { padding: options.padding, maxZoom: FIT_MAX_ZOOM, animate: false });
    }

    function setStatus(html) {
        status.innerHTML = html;
        status.hidden = !html;
    }

    function showNotice(title, text) {
        setStatus('');
        notice.querySelector('h2').textContent = title;
        notice.querySelector('p').textContent = text;
        notice.hidden = false;
        view.classList.add('quiet');
    }

    function hideNotice() {
        notice.hidden = true;
        view.classList.remove('quiet');
    }

    function mapped() {
        return photos.filter(function (photo) { return photo.position; });
    }

    // Pins.

    function scheduleRender() {
        if (!map || renderFrame) return;
        renderFrame = window.requestAnimationFrame(function () {
            renderFrame = null;
            render();
        });
    }

    // Photos whose pins would overlap share one pin, placed at their centre.
    function render() {
        var L = window.L,
            zoom = map.getZoom(),
            groups = [],
            next = {};
        mapped().forEach(function (photo) {
            var point = map.project(photo.position, zoom);
            for (var i = 0; i < groups.length; i++) {
                if (groups[i].seed.distanceTo(point) < PIN) {
                    groups[i].photos.push(photo);
                    groups[i].sum = groups[i].sum.add(point);
                    return;
                }
            }
            groups.push({ seed: point, sum: point, photos: [photo] });
        });

        groups.forEach(function (group) {
            var key = group.photos.map(function (photo) { return photo.index; }).join(','),
                position = map.unproject(group.sum.divideBy(group.photos.length), zoom);
            next[key] = markers[key] || createMarker(L, group.photos);
            next[key].setLatLng(position);
            delete markers[key];
        });
        for (var key in markers) markers[key].remove();
        for (key in next) if (!map.hasLayer(next[key])) next[key].addTo(map);
        markers = next;
    }

    function createMarker(L, group) {
        var count = group.length,
            pin = document.createElement('span'),
            frame = document.createElement('span');
        pin.className = 'map-pin';
        frame.className = 'map-pin-frame';
        frame.appendChild(thumbnail(group[0]));
        pin.appendChild(frame);
        if (count > 1) {
            var badge = document.createElement('span');
            badge.className = 'map-pin-count';
            badge.textContent = count;
            pin.appendChild(badge);
        }

        var marker = L.marker([0, 0], {
            icon: L.divIcon({
                className: 'map-marker' + (count > 1 ? ' group' : ''),
                html: pin,
                iconSize: [PIN, PIN],
                // The pin's tip sits below the photo.
                iconAnchor: [PIN / 2, PIN + 8]
            }),
            title: count > 1 ? count + ' photos' : 'View photo',
            riseOnHover: true
        });
        marker.on('click', function () {
            if (count === 1) show(group[0], marker.getElement());
            else expand(L, group, marker);
        });
        return marker;
    }

    function thumbnail(photo) {
        var image = document.createElement('img');
        image.alt = '';
        image.draggable = false;
        image.decoding = 'async';
        image.src = photo.preview;
        return image;
    }

    // Zoom in until a group separates; photos taken at the same spot are listed instead.
    function expand(L, group, marker) {
        var bounds = L.latLngBounds(group.map(function (photo) { return photo.position; })),
            maxZoom = map.getMaxZoom(),
            spread = map.project(bounds.getNorthEast(), maxZoom).distanceTo(map.project(bounds.getSouthWest(), maxZoom));
        if (spread >= PIN && map.getZoom() < maxZoom) {
            var options = { padding: [PIN * 1.5, PIN * 1.5], maxZoom: maxZoom };
            if (reducedMotion()) map.fitBounds(bounds, options);
            else map.flyToBounds(bounds, L.extend({ duration: 0.8 }, options));
            return;
        }

        var list = document.createElement('div'),
            title = document.createElement('p'),
            grid = document.createElement('div');
        list.className = 'map-group';
        title.className = 'map-group-title';
        title.textContent = group.length + ' photos here';
        grid.className = 'map-group-grid';
        grid.style.setProperty('--columns', Math.min(group.length, 3));
        group.forEach(function (photo, i) {
            var button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('aria-label', 'View photo ' + (i + 1) + ' of ' + group.length);
            button.appendChild(thumbnail(photo));
            button.addEventListener('click', function () { show(photo, marker.getElement()); });
            grid.appendChild(button);
        });
        list.appendChild(title);
        list.appendChild(grid);
        L.popup({
            className: 'map-popup',
            maxWidth: 360,
            offset: [0, -PIN - 4],
            autoPanPadding: [PIN, PIN]
        }).setLatLng(marker.getLatLng()).setContent(list).openOn(map);
        var first = grid.querySelector('button');
        if (first) first.focus({ preventScroll: true });
    }

    function show(photo, from) {
        returnFocus = from || document.activeElement;
        // Otherwise the map would also pan with the lightbox's arrow keys.
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        photo.anchor.click();
    }

    // EXIF.

    function readPosition(src) {
        return fetch(src, { headers: { Range: 'bytes=0-' + (HEAD_BYTES - 1) } }).then(function (response) {
            if (!response.ok) return null;
            return readHead(response).then(function (buffer) {
                return positionOf(window.EXIF.readFromBinaryFile(buffer));
            });
        }).then(null, function () { return null; });
    }

    // Servers that ignore Range send the whole photo; stop reading once the head has arrived.
    function readHead(response) {
        if (!response.body || !response.body.getReader) return response.arrayBuffer();
        var reader = response.body.getReader(),
            chunks = [],
            size = 0;
        function pump() {
            return reader.read().then(function (result) {
                if (!result.done) {
                    chunks.push(result.value);
                    size += result.value.length;
                    if (size < HEAD_BYTES) return pump();
                    reader.cancel().then(null, function () {});
                }
                var bytes = new Uint8Array(size),
                    offset = 0;
                chunks.forEach(function (chunk) {
                    bytes.set(chunk, offset);
                    offset += chunk.length;
                });
                return bytes.buffer;
            });
        }
        return pump();
    }

    function positionOf(tags) {
        if (!tags) return null;
        var lat = degrees(tags.GPSLatitude, tags.GPSLatitudeRef),
            lng = degrees(tags.GPSLongitude, tags.GPSLongitudeRef);
        if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
        // Cameras without a fix sometimes record 0, 0.
        if (lat === 0 && lng === 0) return null;
        return [lat, lng];
    }

    function degrees(value, ref) {
        if (!value || value.length !== 3) return null;
        var result = Number(value[0]) + Number(value[1]) / 60 + Number(value[2]) / 3600;
        if (!isFinite(result)) return null;
        return /^[SW]/i.test(String(ref)) ? -result : result;
    }

    function reducedMotion() {
        return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

})();
