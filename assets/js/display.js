/*
 Display mode: a full-screen, photos-only slideshow in the spirit of the
 macOS "Shifting Tiles" screensaver (see hermanbanken/shiftingtiles).

 Rows of uncropped photos fill the screen. Every few seconds one visible
 photo zooms away and its row slides over to close the gap, alternating
 directions between rows, while a new photo enters from off screen.
 */

(function () {
    'use strict';

    var INTERVAL = 3000,
        LOOKAHEAD = 6,
        MIN_RATIO = 0.55,
        MAX_RATIO = 2.2,
        // Two landscape photos may share a column, as in the original screensaver.
        DUAL_MIN_RATIO = 1.3,
        DUAL_CHANCE = 0.35,
        IDLE_DELAY = 2500;

    var main = document.getElementById('main'),
        wrapper = document.getElementById('wrapper'),
        toggles = Array.prototype.slice.call(document.querySelectorAll('a[href="#display"]'));
    if (!main || !toggles.length) return;

    var sources = unique(Array.prototype.map.call(main.querySelectorAll('.thumb > a.image'), function (a) {
        return a.href;
    }));

    if (!sources.length) {
        toggles.forEach(function (toggle) {
            var item = toggle.closest('li') || toggle;
            item.parentNode.removeChild(item);
        });
        return;
    }

    var display, stage, pauseButton,
        rows = [],
        loads = {},
        failed = {},
        // Photos on screen or already drawn for upcoming tiles.
        inUse = {},
        deck = [],
        ready = [],
        pending = 0,
        isOpen = false,
        paused = false,
        busy = false,
        inFullscreen = false,
        generation = 0,
        turn = 0,
        timer, idleTimer, layoutFrame, wakeLock, returnFocus;

    build();

    toggles.forEach(function (toggle) {
        toggle.addEventListener('click', function (event) {
            event.preventDefault();
            open(toggle);
        });
    });

    window.addEventListener('hashchange', function () {
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
        display.innerHTML =
            '<div class="display-stage" aria-hidden="true"></div>' +
            '<div class="display-controls">' +
            '<span class="display-hint">Space to pause &middot; Esc to exit</span>' +
            '<button type="button" class="display-pause"><span class="fa" aria-hidden="true"></span></button>' +
            '<button type="button" class="display-exit" aria-label="Exit display mode">' +
            '<span class="fa fa-times" aria-hidden="true"></span></button>' +
            '</div>';
        document.body.appendChild(display);

        stage = display.querySelector('.display-stage');
        pauseButton = display.querySelector('.display-pause');
        pauseButton.addEventListener('click', togglePause);
        display.querySelector('.display-exit').addEventListener('click', close);

        ['pointermove', 'pointerdown'].forEach(function (type) {
            display.addEventListener(type, showControls);
        });
        document.addEventListener('keydown', onKeydown, true);
        document.addEventListener('fullscreenchange', onFullscreenChange);
        document.addEventListener('webkitfullscreenchange', onFullscreenChange);
        document.addEventListener('visibilitychange', function () {
            if (isOpen && !document.hidden) requestWakeLock();
        });

        if (window.ResizeObserver) new ResizeObserver(scheduleLayout).observe(stage);
        else window.addEventListener('resize', scheduleLayout);
    }

    function open(trigger) {
        if (isOpen) return;
        isOpen = true;
        paused = false;
        returnFocus = trigger || document.activeElement;
        display.hidden = false;
        document.body.classList.add('display-active');
        if (wrapper) wrapper.inert = true;
        // Must run within the click that opened display mode.
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
        if (wrapper) wrapper.inert = false;
        if (wakeLock) {
            ignore(wakeLock.release());
            wakeLock = null;
        }
        if (location.hash === '#display' && window.history.replaceState)
            history.replaceState(null, '', location.pathname + location.search);

        var exiting;
        if (fullscreenElement() === display) {
            inFullscreen = false;
            exiting = (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        }
        // The page stays inert until full screen has been exited.
        if (exiting && exiting.then) exiting.then(restoreFocus, restoreFocus);
        else restoreFocus();
    }

    function restoreFocus() {
        if (isOpen || !returnFocus) return;
        if (returnFocus.focus) returnFocus.focus({ preventScroll: true });
        returnFocus = null;
    }

    function onKeydown(event) {
        if (!isOpen) return;
        showControls();
        if (event.key === 'Escape' || event.key === 'Esc') {
            close();
        } else if ((event.key === ' ' || event.key === 'Spacebar') && !event.target.closest('button')) {
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
        pauseButton.firstChild.className = 'fa ' + (paused ? 'fa-play' : 'fa-pause');
        display.classList.toggle('paused', paused);
    }

    function showControls() {
        display.classList.remove('idle');
        clearTimeout(idleTimer);
        idleTimer = setTimeout(function () {
            if (!paused) display.classList.add('idle');
        }, IDLE_DELAY);
    }

    function schedule() {
        clearTimeout(timer);
        if (isOpen && !paused) timer = setTimeout(tick, INTERVAL);
    }

    function tick() {
        if (document.hidden) schedule();
        else shift().then(schedule);
    }

    // Browser APIs.

    function fullscreenElement() {
        return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    function requestFullscreen() {
        var request = display.requestFullscreen || display.webkitRequestFullscreen;
        if (!request) return;
        try {
            ignore(request.call(display, { navigationUI: 'hide' }));
        } catch (error) {
            // Display mode still covers the window without the Fullscreen API.
        }
    }

    function onFullscreenChange() {
        if (fullscreenElement() === display) {
            inFullscreen = true;
            return;
        }
        if (inFullscreen) {
            // Leaving full screen (e.g. Esc, which browsers keep for themselves) ends display mode.
            inFullscreen = false;
            close();
        }
        restoreFocus();
    }

    function requestWakeLock() {
        if (wakeLock || !navigator.wakeLock) return;
        navigator.wakeLock.request('screen').then(function (lock) {
            if (!isOpen) return ignore(lock.release());
            wakeLock = lock;
            lock.addEventListener('release', function () {
                if (wakeLock === lock) wakeLock = null;
            });
        }, function () {});
    }

    function reducedMotion() {
        return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    // Photos.

    function prefetch() {
        while (ready.length + pending < LOOKAHEAD) {
            var src = draw();
            if (!src) return;
            fetchPhoto(src);
        }
    }

    function fetchPhoto(src) {
        pending++;
        use(src, 1);
        loads[src] = loads[src] || load(src);
        loads[src].then(function (photo) {
            pending--;
            if (photo) {
                ready.push(photo);
            } else {
                failed[src] = true;
                use(src, -1);
            }
            if (isOpen) {
                fillRows(true);
                prefetch();
            }
        });
    }

    function load(src) {
        return new Promise(function (resolve) {
            var image = new Image();
            function done() {
                resolve(image.naturalWidth && image.naturalHeight ?
                    { src: src, ratio: image.naturalWidth / image.naturalHeight, image: image } : null);
            }
            image.onload = function () {
                if (image.decode) image.decode().then(done, done);
                else done();
            };
            image.onerror = function () { resolve(null); };
            image.decoding = 'async';
            image.src = src;
        });
    }

    // Shuffle without repeats, preferring photos that are not already showing.
    function draw() {
        var candidates = sources.filter(function (src) { return !failed[src]; });
        if (!candidates.length) return null;
        deck = deck.filter(function (src) { return !failed[src]; });
        var index = firstUnused(deck);
        if (index < 0) {
            deck = shuffle(candidates);
            // Small galleries need repeats to fill the screen.
            index = Math.max(0, firstUnused(deck));
        }
        return deck.splice(index, 1)[0];
    }

    function firstUnused(list) {
        for (var i = 0; i < list.length; i++) {
            if (!inUse[list[i]]) return i;
        }
        return -1;
    }

    function use(src, delta) {
        inUse[src] = (inUse[src] || 0) + delta;
    }

    function take(index) {
        var photo = ready.splice(index || 0, 1)[0];
        if (photo) use(photo.src, -1);
        return photo;
    }

    function imageFor(photo) {
        var image = photo.image.parentNode ? photo.image.cloneNode(false) : photo.image;
        image.alt = '';
        image.draggable = false;
        image.className = '';
        image.removeAttribute('style');
        use(photo.src, 1);
        return image;
    }

    function release(element) {
        Array.prototype.forEach.call(element.querySelectorAll('img'), function (image) {
            use(image.src, -1);
        });
    }

    // Layout.

    function scheduleLayout() {
        if (!isOpen || layoutFrame) return;
        layoutFrame = window.requestAnimationFrame(function () {
            layoutFrame = null;
            if (isOpen) layout();
        });
    }

    function rowCount() {
        var width = stage.clientWidth,
            height = stage.clientHeight;
        // Two rows on desktop, like the screensaver; more on tall or portrait screens.
        return Math.max(2, Math.min(5, Math.ceil(height / Math.min(width * 0.6, 560))));
    }

    function layout() {
        var count = rowCount();
        if (count !== rows.length) {
            clearRows();
            for (var i = 0; i < count; i++) {
                var row = document.createElement('div');
                row.className = 'display-row' + (i % 2 ? ' reverse' : '');
                stage.appendChild(row);
                rows.push(row);
            }
            schedule();
        }
        fillRows(true);
    }

    function clearRows() {
        generation++;
        busy = false;
        rows.forEach(function (row) {
            release(row);
            Array.prototype.forEach.call(row.querySelectorAll('*'), function (element) {
                if (element.getAnimations) element.getAnimations().forEach(function (animation) { animation.cancel(); });
            });
        });
        stage.textContent = '';
        rows = [];
    }

    function tilesOf(row) {
        return Array.prototype.filter.call(row.children, function (tile) {
            return !tile.classList.contains('leaving');
        });
    }

    function gapOf(row) {
        return parseFloat(window.getComputedStyle(row).columnGap) || 0;
    }

    function rowNeeds(row) {
        var width = stage.clientWidth;
        // Keep up to one photo's width hidden beyond the far edge, ready to slide in.
        return width + Math.min(row.clientHeight * MAX_RATIO, width * 0.9);
    }

    function rowWidth(row, tiles, gap) {
        return tiles.reduce(function (sum, tile) { return sum + tile.offsetWidth + gap; }, -gap);
    }

    // Fill the emptiest rows first so every row grows while photos load.
    function fillRows(animate) {
        var added;
        do {
            added = false;
            rows.slice().sort(function (a, b) {
                return rowWidth(a, tilesOf(a), gapOf(a)) / rowNeeds(a) - rowWidth(b, tilesOf(b), gapOf(b)) / rowNeeds(b);
            }).some(function (row) {
                if (rowWidth(row, tilesOf(row), gapOf(row)) >= rowNeeds(row)) return false;
                var tile = createTile();
                if (!tile) return true;
                row.appendChild(tile);
                if (animate) enter(tile, tilesOf(row).length);
                added = true;
                return true;
            });
        } while (added);
        rows.forEach(trim);
        prefetch();
    }

    // Drop hidden tiles beyond what the row needs, e.g. after a window shrinks.
    function trim(row) {
        var tiles = tilesOf(row),
            gap = gapOf(row),
            width = rowWidth(row, tiles, gap),
            needed = rowNeeds(row);
        while (tiles.length > 1 && width - tiles[tiles.length - 1].offsetWidth - gap >= needed) {
            var last = tiles.pop();
            width -= last.offsetWidth + gap;
            release(last);
            row.removeChild(last);
        }
    }

    function createTile() {
        var first = take();
        if (!first) return null;
        var photos = [first];
        if (first.ratio >= DUAL_MIN_RATIO && Math.random() < DUAL_CHANCE) {
            for (var i = 0; i < ready.length; i++) {
                if (ready[i].ratio >= DUAL_MIN_RATIO) {
                    photos.push(take(i));
                    break;
                }
            }
        }
        var tile = document.createElement('div');
        tile.className = 'display-tile' + (photos.length > 1 ? ' dual' : '');
        // Single photos keep their own shape; only extreme panoramas or portraits are cropped.
        tile.style.aspectRatio = String(photos.length > 1 ?
            (photos[0].ratio + photos[1].ratio) / 4 :
            Math.max(MIN_RATIO, Math.min(MAX_RATIO, first.ratio)));
        photos.forEach(function (photo) { tile.appendChild(imageFor(photo)); });
        return tile;
    }

    function enter(tile, index) {
        if (!tile.animate) return;
        var keyframes = reducedMotion() ?
            [{ opacity: 0 }, { opacity: 1 }] :
            [{ opacity: 0, transform: 'scale(0.94)' }, { opacity: 1, transform: 'none' }];
        tile.animate(keyframes, {
            duration: 700,
            delay: Math.min(index, 8) * 70,
            easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
            fill: 'backwards'
        });
    }

    // Shifting.

    function shift() {
        if (!isOpen || busy || !rows.length || !ready.length) return Promise.resolve();
        if (reducedMotion() || !stage.animate) return crossfade();

        var row = rows[turn++ % rows.length],
            tiles = tilesOf(row),
            candidates = visibleTiles(tiles);
        if (!candidates.length) return Promise.resolve();

        var leaving = candidates[Math.floor(Math.random() * candidates.length)],
            reverse = row.classList.contains('reverse'),
            gap = gapOf(row),
            before = tiles.map(function (tile) { return tile.offsetLeft; }),
            from = tiles.indexOf(leaving),
            distance = (leaving.offsetWidth + gap) * (reverse ? -1 : 1),
            gen = generation,
            animations = [];

        busy = true;
        // Take the photo out of the flow so the rest of the row can take its place.
        leaving.style.left = leaving.offsetLeft + 'px';
        leaving.style.width = leaving.offsetWidth + 'px';
        leaving.classList.add('leaving');
        animations.push(leaving.animate([
            { opacity: 1, transform: 'scale(1)' },
            { opacity: 0.6, transform: 'scale(0.5)', offset: 0.6 },
            { opacity: 0, transform: 'scale(0)' }
        ], { duration: 600, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' }));

        fillRows(false);

        tilesOf(row).forEach(function (tile, i) {
            var index = tiles.indexOf(tile),
                dx = index < 0 ? distance : before[index] - tile.offsetLeft;
            if (Math.abs(dx) < 0.5) return;
            animations.push(tile.animate(spring(dx), {
                duration: 1200,
                // A slight ripple: tiles farther from the gap follow a moment later.
                delay: 350 + Math.min(Math.abs(i - from), 6) * 20,
                fill: 'backwards'
            }));
        });

        return settle(animations, function () {
            release(leaving);
            if (leaving.parentNode) leaving.parentNode.removeChild(leaving);
            fillRows(false);
        }, gen);
    }

    // With reduced motion, photos fade in place instead of moving.
    function crossfade() {
        var images = [];
        rows.forEach(function (row) {
            visibleTiles(tilesOf(row)).forEach(function (tile) {
                images.push.apply(images, tile.querySelectorAll('img'));
            });
        });
        if (!images.length) return Promise.resolve();

        var old = images[Math.floor(Math.random() * images.length)],
            ratio = old.clientWidth / old.clientHeight,
            best = 0;
        ready.forEach(function (photo, i) {
            if (Math.abs(Math.log(photo.ratio / ratio)) < Math.abs(Math.log(ready[best].ratio / ratio))) best = i;
        });

        var image = imageFor(take(best)),
            gen = generation;
        busy = true;
        image.className = 'display-swap';
        image.style.left = old.offsetLeft + 'px';
        image.style.top = old.offsetTop + 'px';
        image.style.width = old.offsetWidth + 'px';
        image.style.height = old.offsetHeight + 'px';
        old.parentNode.appendChild(image);
        var animation = image.animate ?
            [image.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1200, easing: 'ease-in-out' })] : [];

        return settle(animation, function () {
            use(old.src, -1);
            image.className = '';
            image.removeAttribute('style');
            old.parentNode.replaceChild(image, old);
            prefetch();
        }, gen);
    }

    function settle(animations, finish, gen) {
        return new Promise(function (resolve) {
            function done() {
                if (gen === generation) {
                    busy = false;
                    finish();
                }
                resolve();
            }
            Promise.all(animations.map(function (animation) { return animation.finished; })).then(done, done);
        });
    }

    function visibleTiles(tiles) {
        var bounds = stage.getBoundingClientRect(),
            visible = tiles.filter(function (tile) {
                var rect = tile.getBoundingClientRect();
                return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
            });
        return visible.length ? visible : tiles.filter(function (tile) {
            var rect = tile.getBoundingClientRect();
            return rect.right > bounds.left && rect.left < bounds.right;
        });
    }

    // Keyframes for a damped spring from dx to rest, with a small overshoot.
    function spring(dx) {
        var frames = [];
        for (var i = 0; i < 40; i++) {
            var t = i / 40;
            frames.push({ transform: 'translateX(' + (dx * Math.exp(-7 * t) * Math.cos(8.5 * t)).toFixed(2) + 'px)' });
        }
        frames.push({ transform: 'translateX(0)' });
        return frames;
    }

    // Utilities.

    function ignore(promise) {
        if (promise && promise.then) promise.then(null, function () {});
    }

    function unique(list) {
        return list.filter(function (item, i) { return list.indexOf(item) === i; });
    }

    function shuffle(list) {
        list = list.slice();
        for (var i = list.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1)),
                item = list[i];
            list[i] = list[j];
            list[j] = item;
        }
        return list;
    }

})();
