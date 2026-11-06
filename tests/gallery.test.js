const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { readFile, stat } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Liquid } = require('liquidjs');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const liquid = new Liquid({ root: path.join(root, '_includes'), dynamicPartials: false });
// Portrait, landscape, square, panorama, and a short final row.
const sizes = [[300, 600], [800, 400], [500, 500], [600, 400], [1600, 200], [400, 600], [600, 400]];
let browser, server, origin;

async function render(layout, count = sizes.length, missing = false) {
    const config = await readFile(path.join(root, '_config.yml'), 'utf8');
    const site = {
        gallery_layout: layout === 'configured' ? config.match(/^gallery_layout:\s*(.*)$/m)[1] : layout,
        title: 'Gallery test', header: {}, footer: {}, social_urls: {},
        baseurl: '/photos', image_fulls_loc: '/images/fulls', image_thumbs_loc: '/images/thumbs',
        static_files: Array.from({ length: count }, (_, i) => ({ path: '/images/fulls/' + i + '.jpg', name: i + '.jpg' }))
    };
    if (missing) site.static_files.splice(1, 0, { path: '/images/fulls/missing.jpg', name: 'missing.jpg' });
    const template = (await readFile(path.join(root, 'index.html'), 'utf8')).replace(/^---[\s\S]*?---/, '');
    const content = await liquid.parseAndRender(template, { site });
    return liquid.parseAndRender(await readFile(path.join(root, '_layouts/default.html'), 'utf8'), { site, content });
}

before(async () => {
    server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://localhost');
            if (url.pathname === '/') {
                response.setHeader('Content-Type', 'text/html');
                response.end(await render(url.searchParams.has('layout') ? url.searchParams.get('layout') : undefined,
                    Number(url.searchParams.get('count') ?? sizes.length), url.searchParams.has('missing')));
                return;
            }
            const image = url.pathname.match(/^\/photos\/images\/(thumbs|fulls)\/(\d+)\.jpg$/);
            if (image) {
                if (url.searchParams.has('broken')) {
                    response.writeHead(404).end();
                    return;
                }
                const [width, height] = image[1] === 'thumbs' ? [512, 512] : sizes[Number(image[2]) % sizes.length];
                response.setHeader('Content-Type', 'image/svg+xml');
                response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#4682b4"/></svg>`);
                return;
            }
            const file = path.resolve(root, '.' + url.pathname);
            if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) {
                response.writeHead(404).end();
                return;
            }
            const types = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
            response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
            response.end(await readFile(file));
        } catch (error) {
            response.writeHead(500).end(String(error));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
        args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
});

after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
});

async function openGallery(t, layout, count = sizes.length, { reducedMotion = 'reduce', hash = '', query = {} } = {}) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, reducedMotion });
    t.after(() => page.close());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], 'no browser errors'));
    await page.route('https://**', route => route.abort());
    // Supply fixture metadata before the gallery's ready callback caches captions.
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('#main img').forEach(img => {
            img.exifdata = { Model: 'Test Camera', FNumber: 2.8, ExposureTime: 0.01, ISOSpeedRatings: 100 };
        });
    }));
    await page.goto(origin + '/?' + new URLSearchParams({ ...(layout === undefined ? {} : { layout }), count, ...query }) + hash);
    await page.waitForFunction(() => !document.body.classList.contains('loading'));
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#main img')).every(img => img.complete));
    return page;
}

async function geometry(page) {
    return page.locator('#main').evaluate(main => ({
        width: main.clientWidth,
        height: main.clientHeight,
        tiles: Array.from(main.querySelectorAll('.thumb')).map(tile => {
            const img = tile.querySelector('img');
            return {
                left: tile.offsetLeft, top: tile.offsetTop, width: tile.getBoundingClientRect().width,
                height: tile.getBoundingClientRect().height, ratio: img.naturalWidth / img.naturalHeight || 1.5
            };
        })
    }));
}

function assertUncropped(gallery) {
    for (const tile of gallery.tiles) {
        assert.ok(tile.width > 0 && tile.height > 0);
        assert.ok(Math.abs(tile.width / tile.height - tile.ratio) < 0.02, 'natural image ratio');
        assert.ok(tile.left >= 0 && tile.left + tile.width <= gallery.width + 1, 'fits gallery width');
        assert.ok(tile.top + tile.height <= gallery.height + 1, 'fits gallery height');
    }
}

test('configuration normalizes layout names and defaults to the original Thumbnail', async t => {
    const config = await readFile(path.join(root, '_config.yml'), 'utf8');
    const configuredLayout = config.match(/^gallery_layout:\s*(.*)$/m)[1].trim().toLowerCase();
    const configuredExpected = ['masonry', 'justified', 'carousel'].includes(configuredLayout) ? configuredLayout : 'thumbnail';
    for (const [input, expected] of [
        [undefined, 'thumbnail'], ['', 'thumbnail'], ['configured', configuredExpected], ['unknown', 'thumbnail'],
        ['Thumbnail', 'thumbnail'], [' MaSoNrY ', 'masonry'], ['JUSTIFIED', 'justified'], ['Carousel', 'carousel']
    ]) {
        const page = await openGallery(t, input);
        assert.equal(await page.locator('#main').getAttribute('data-layout'), expected);
        const imageFolder = ['masonry', 'justified'].includes(expected) ? 'fulls' : 'thumbs';
        const sources = await page.locator('#main img').evaluateAll(imgs => imgs.map(img => img.getAttribute('src')));
        assert.deepEqual(sources, sizes.map((_, i) => `/photos/images/${imageFolder}/${i}.jpg`));
        if (expected === 'thumbnail') {
            assert.equal(await page.locator('#main').evaluate(main => main.classList.contains('gallery-ready')), false);
            assert.equal(await page.locator('#main img').first().evaluate(img => getComputedStyle(img).display), 'none');
            assert.match(await page.locator('#main a.image').first().evaluate(a => a.style.backgroundImage), /thumbs\/0.jpg/);
        }
    }
});

for (const layout of ['Masonry', 'Justified']) {
    test(layout + ' preserves ratios and adapts to desktop and mobile widths', async t => {
        const page = await openGallery(t, layout);
        for (const [width, expectedColumns] of [[1100, 3], [375, 1], [768, 2], [1680, 4], [1920, 4], [2560, 4], [3840, 4]]) {
            await page.setViewportSize({ width, height: 800 });
            await page.waitForFunction(() => {
                const main = document.querySelector('#main');
                return Array.from(main.querySelectorAll('.thumb')).every(tile => tile.style.width);
            });
            // Let the ResizeObserver and animation frame finish after the viewport change.
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const gallery = await geometry(page);
            assertUncropped(gallery);
            if (layout === 'Masonry') {
                assert.equal(new Set(gallery.tiles.map(tile => tile.left)).size, expectedColumns,
                    'desktop column count stays limited while mobile remains responsive');
                const heights = new Map();
                for (const tile of gallery.tiles) {
                    const shortest = Math.min(...Array.from({ length: expectedColumns }, (_, i) => heights.get(i) || 0));
                    assert.ok(Math.abs(tile.top - shortest) <= 1, 'placed into shortest column');
                    const column = Math.round(tile.left / (tile.width + 8));
                    heights.set(column, tile.top + tile.height + 8);
                }
            } else {
                const rows = new Map();
                for (const tile of gallery.tiles) {
                    if (!rows.has(tile.top)) rows.set(tile.top, []);
                    rows.get(tile.top).push(tile);
                }
                for (const row of rows.values()) {
                    assert.ok(row.every(tile => Math.abs(tile.height - row[0].height) < 1), 'equal row heights');
                    const end = row.at(-1).left + row.at(-1).width;
                    assert.ok(Math.abs(end - gallery.width) < 1 || row[0].height <= width * 0.4 + 1,
                        'rows fill width unless intentionally left at target height');
                }
                if (width >= 1680) {
                    assert.ok(Math.max(...gallery.tiles.map(tile => tile.height)) >= width / 5,
                        'desktop rows grow with the gallery instead of keeping small previews');
                }
                if (width === 375) {
                    assert.ok(gallery.tiles.at(-1).height <= 151, 'short mobile rows keep their existing height cap');
                }
            }
        }
    });

    test(layout + ' relayouts after late or failed images', async t => {
        const page = await openGallery(t, layout);
        await page.locator('#main img').first().evaluate(img => { img.src = '/photos/images/fulls/4.jpg'; });
        await page.waitForFunction(() => {
            const tile = document.querySelector('#main .thumb');
            return Math.abs(tile.offsetWidth / tile.offsetHeight - 8) < 0.1;
        });
        assertUncropped(await geometry(page));
        await page.locator('#main img').last().evaluate(img => { img.src += '?broken'; });
        await page.waitForFunction(() => {
            const tile = Array.from(document.querySelectorAll('#main .thumb')).at(-1);
            return Math.abs(tile.offsetWidth / tile.offsetHeight - 1.5) < 0.02;
        });
        assertUncropped(await geometry(page));
    });
}

test('Carousel supports buttons, dots, keyboard, swipe, and boundaries', async t => {
    const page = await openGallery(t, 'Carousel');
    const previous = page.getByRole('button', { name: 'Previous image' });
    const next = page.getByRole('button', { name: 'Next image' });
    assert.equal(await previous.isDisabled(), true);
    assert.equal(await page.locator('.carousel-counter').textContent(), '1 / 7');
    await next.click();
    assert.equal(await page.locator('.carousel-counter').textContent(), '2 / 7');
    await page.locator('#main').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('.carousel-counter').textContent(), '3 / 7');
    await page.getByRole('button', { name: 'Go to image 7', exact: true }).click();
    assert.equal(await next.isDisabled(), true);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('.carousel-counter').textContent(), '7 / 7');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('.carousel-counter').textContent(), '6 / 7');
    assert.equal(await page.locator('.thumb[aria-hidden="false"]').count(), 1);
    assert.equal(await page.locator('.thumb[aria-hidden="true"] a[tabindex="-1"]').count(), 6);
    await page.locator('.carousel-viewport').dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: 200, clientY: 100 }] });
    await page.locator('.carousel-viewport').dispatchEvent('touchend', { changedTouches: [{ identifier: 1, clientX: 100, clientY: 105 }] });
    assert.equal(await page.locator('.carousel-counter').textContent(), '7 / 7');
    await page.locator('.thumb[aria-hidden="false"] a').dispatchEvent('click');
    assert.equal(await page.locator('body').evaluate(body => body.classList.contains('modal-active')), false,
        'swiping does not open the lightbox');
    await page.setViewportSize({ width: 375, height: 700 });
    assert.ok(await page.locator('.thumb[aria-hidden="false"]').isVisible());
    assert.equal(await page.locator('body').evaluate(body => body.scrollWidth <= innerWidth), true);
});

test('empty and single-image galleries work in every layout', async t => {
    for (const layout of ['Thumbnail', 'Masonry', 'Justified', 'Carousel']) {
        for (const count of [0, 1]) {
            const page = await openGallery(t, layout, count);
            assert.equal(await page.locator('#main .thumb').count(), count);
            assert.equal(await page.locator('.carousel-nav, .carousel-dot, .carousel-counter').count(), 0);
        }
    }
    const page = await openGallery(t, 'Carousel', 13);
    assert.equal(await page.locator('.carousel-dot').count(), 0);
    assert.equal(await page.locator('.carousel-counter').textContent(), '1 / 13');
});

test('every layout keeps the lightbox and its navigation independent', async t => {
    for (const layout of ['Thumbnail', 'Masonry', 'Justified', 'Carousel']) {
        const page = await openGallery(t, layout);
        await page.locator('#main .thumb a').first().click();
        await page.waitForFunction(() => document.body.classList.contains('modal-active'));
        await page.waitForFunction(() => document.querySelector('.poptrox-popup .caption').textContent.includes('Test Camera'));
        await page.waitForFunction(() => document.querySelector('.poptrox-popup .pic img')?.getAttribute('src').endsWith('/0.jpg'));
        await page.waitForFunction(() => window.jQuery('.poptrox-popup .pic').is(':visible') && !window.jQuery('.poptrox-popup .pic').is(':animated'));
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => document.querySelector('.poptrox-popup .pic img')?.getAttribute('src').endsWith('/1.jpg'));
        if (layout === 'Carousel') assert.equal(await page.locator('.carousel-counter').textContent(), '1 / 7');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.body.classList.contains('modal-active'));
    }
});

// Display mode is settled once every row reaches both edges and no animation is running.
function displaySettled() {
    const stage = document.querySelector('.display-stage').getBoundingClientRect(),
        rows = Array.from(document.querySelectorAll('.display-row'));
    return rows.length > 0 && !document.querySelector('.display-tile.leaving') &&
        document.getElementById('display').getAnimations({ subtree: true }).length === 0 &&
        rows.every(row => {
            const tiles = Array.from(row.children).map(tile => tile.getBoundingClientRect());
            return tiles.length && Math.min(...tiles.map(r => r.left)) <= stage.left + 10 &&
                Math.max(...tiles.map(r => r.right)) >= stage.right - 10;
        });
}

async function displayState(page) {
    await page.waitForFunction(displaySettled);
    return page.evaluate(() => {
        const stage = document.querySelector('.display-stage').getBoundingClientRect();
        return {
            stage: { left: stage.left, right: stage.right, top: stage.top, bottom: stage.bottom, width: stage.width },
            rows: Array.from(document.querySelectorAll('.display-row')).map(row => ({
                reverse: row.classList.contains('reverse'),
                width: row.clientWidth,
                tiles: Array.from(row.children).map(tile => {
                    const rect = tile.getBoundingClientRect();
                    return {
                        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                        width: rect.width, height: rect.height,
                        images: Array.from(tile.querySelectorAll('img')).map(img => ({
                            path: new URL(img.src).pathname, ratio: img.naturalWidth / img.naturalHeight
                        }))
                    };
                })
            }))
        };
    });
}

function visiblePaths(state) {
    return state.rows.flatMap(row => row.tiles.filter(tile => tile.right > state.stage.left && tile.left < state.stage.right)
        .flatMap(tile => tile.images.map(image => image.path)));
}

function assertDisplayFills(state, count, { uncropped = false } = {}) {
    const { stage } = state;
    for (const [i, row] of state.rows.entries()) {
        assert.equal(row.reverse, i % 2 === 1, 'rows alternate their shifting direction');
        const ordered = row.tiles.slice().sort((a, b) => a.left - b.left);
        if (row.reverse) assert.ok(Math.abs(ordered.at(-1).right - stage.right) <= 9, 'reverse rows start at the right edge');
        else assert.ok(Math.abs(ordered[0].left - stage.left) <= 9, 'rows start at the left edge');
        assert.ok(ordered[0].left <= stage.left + 9 && ordered.at(-1).right >= stage.right - 9, 'rows span the screen');
        ordered.slice(1).forEach((tile, j) => assert.ok(Math.abs(tile.left - ordered[j].right - 8) <= 6, 'tiles sit side by side'));
        for (const tile of row.tiles) {
            assert.ok(tile.top >= stage.top && tile.bottom <= stage.bottom + 1, 'rows fit the screen height');
            assert.ok(Math.abs(tile.height - row.tiles[0].height) < 1, 'equal row heights');
            for (const image of tile.images) assert.match(image.path, new RegExp(`^/photos/images/fulls/([0-9]|[1-9][0-9])\\.jpg$`));
            // Reduced motion swaps photos into existing boxes, so only moving tiles keep exact ratios.
            if (uncropped && tile.images.length === 1 && tile.images[0].ratio >= 0.55 && tile.images[0].ratio <= 2.2 && tile.width < row.width * 0.9 - 1)
                assert.ok(Math.abs(tile.width / tile.height - tile.images[0].ratio) < 0.02, 'single photos are uncropped');
        }
    }
    if (count >= 30) {
        const paths = visiblePaths(state);
        assert.equal(new Set(paths).size, paths.length, 'no photo is shown twice when the gallery is large enough');
    }
}

test('Display mode fills the screen with photos and exits cleanly', async t => {
    for (const layout of ['Thumbnail', 'Justified', 'Carousel']) {
        const page = await openGallery(t, layout, sizes.length, { reducedMotion: 'no-preference' });
        const toggle = page.getByRole('link', { name: 'Display' });
        await toggle.click();
        const display = page.getByRole('dialog', { name: 'Display mode' });
        assert.ok(await display.isVisible());
        assert.equal(await page.evaluate(() => document.fullscreenElement?.id), 'display');
        assert.equal(await page.evaluate(() => document.body.classList.contains('display-active') && document.getElementById('wrapper').inert), true);
        const state = await displayState(page);
        assert.equal(state.rows.length, 2, 'two rows on a desktop screen');
        assertDisplayFills(state, sizes.length, { uncropped: true });
        assert.ok(new Set(state.rows.flatMap(row => row.tiles.map(tile => Math.round(tile.width)))).size > 2,
            'tile widths follow the photos instead of a uniform grid');

        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.activeElement === document.querySelector('a[href="#display"]'));
        assert.equal(await display.isVisible(), false);
        assert.equal(await page.evaluate(() => !document.fullscreenElement && !document.body.classList.contains('display-active') &&
            !document.getElementById('wrapper').inert && !document.querySelector('.display-tile')), true);

        await toggle.click();
        await displayState(page);
        await page.getByRole('button', { name: 'Exit display mode' }).click();
        await page.waitForFunction(() => !document.fullscreenElement && document.getElementById('display').hidden);

        await toggle.click();
        await displayState(page);
        await page.evaluate(() => document.exitFullscreen());
        await page.waitForFunction(() => document.getElementById('display').hidden, null, { timeout: 2000 });
    }
});

test('Display mode shifts tiles in alternating directions without repeating on-screen photos', async t => {
    const count = 40;
    const page = await openGallery(t, 'Justified', count, { reducedMotion: 'no-preference' });
    await page.getByRole('link', { name: 'Display' }).click();
    let state = await displayState(page);
    assertDisplayFills(state, count, { uncropped: true });
    for (const shifted of [0, 1]) {
        const before = state.rows.map(row => row.tiles.map(tile => tile.images.map(image => image.path).join('+')));
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.locator('.display-row').nth(shifted).locator('.display-tile.leaving').count(), 1);
        assert.ok(await page.evaluate(() => document.getElementById('display').getAnimations({ subtree: true }).length > 1),
            'the row slides into the gap');
        state = await displayState(page);
        assertDisplayFills(state, count, { uncropped: true });
        const after = state.rows.map(row => row.tiles.map(tile => tile.images.map(image => image.path).join('+')));
        const kept = before[shifted].filter(tile => after[shifted].includes(tile));
        assert.equal(kept.length, before[shifted].length - 1, 'one photo leaves the shifted row');
        assert.deepEqual(after[shifted].slice(0, kept.length), kept, 'the remaining photos keep their order');
        assert.deepEqual(after[1 - shifted], before[1 - shifted], 'the other row stays still');
    }

    await page.waitForSelector('.display-tile.leaving', { timeout: 8000 });
    await page.waitForFunction(displaySettled);
    await page.keyboard.press(' ');
    assert.ok(await page.getByRole('button', { name: 'Play', exact: true }).isVisible());
    const paused = await displayState(page);
    await page.waitForTimeout(4000);
    assert.deepEqual(await displayState(page), paused, 'nothing moves while paused');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    assert.ok(await page.getByRole('button', { name: 'Pause', exact: true }).isVisible());
});

test('Display mode cross-fades in place when motion is reduced', async t => {
    const count = 40;
    const page = await openGallery(t, 'Thumbnail', count);
    await page.getByRole('link', { name: 'Display' }).click();
    const before = await displayState(page);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('.display-swap').count(), 1);
    await page.waitForFunction(() => !document.querySelector('.display-swap'));
    const after = await displayState(page);
    assertDisplayFills(after, count);
    const boxes = state => state.rows.map(row => row.tiles.map(({ left, top, width, height }) => [left, top, width, height]));
    assert.deepEqual(boxes(after), boxes(before), 'no tile moves');
    const changed = visiblePaths(after).filter((path, i) => path !== visiblePaths(before)[i]);
    assert.equal(changed.length, 1, 'one photo is replaced');
});

test('Display mode adapts to the screen and opens from a link', async t => {
    const page = await openGallery(t, 'Masonry', sizes.length, { reducedMotion: 'no-preference', hash: '#display' });
    assert.ok(await page.getByRole('dialog', { name: 'Display mode' }).isVisible());
    for (const [width, height, rows] of [[1100, 800, 2], [375, 700, 4], [700, 375, 2], [1920, 1080, 2], [1080, 1920, 4]]) {
        await page.setViewportSize({ width, height });
        await page.waitForFunction(rows => document.querySelectorAll('.display-row').length === rows, rows);
        assertDisplayFills(await displayState(page), sizes.length, { uncropped: true });
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => location.hash), '');
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
});

test('Display mode handles empty, single-image, and broken galleries', async t => {
    let page = await openGallery(t, 'Thumbnail', 0);
    assert.equal(await page.getByRole('link', { name: 'Display' }).count(), 0);
    assert.equal(await page.locator('#header nav li').count(), 1);

    page = await openGallery(t, 'Justified', 1);
    await page.getByRole('link', { name: 'Display' }).click();
    const state = await displayState(page);
    assertDisplayFills(state, 1);
    assert.deepEqual(new Set(visiblePaths(state)), new Set(['/photos/images/fulls/0.jpg']));

    page = await openGallery(t, 'Thumbnail', 3, { query: { missing: '' } });
    assert.equal(await page.locator('#main .thumb').count(), 4);
    await page.getByRole('link', { name: 'Display' }).click();
    const broken = await displayState(page);
    assertDisplayFills(broken, 3);
    assert.ok(visiblePaths(broken).every(path => /\/[0-2]\.jpg$/.test(path)), 'missing photos are skipped');
});
