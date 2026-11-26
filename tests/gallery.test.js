import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Liquid } from 'liquidjs';
import { chromium } from 'playwright';
import { parseExifBuffer } from '../assets/js/exif-reader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const liquid = new Liquid({ root: path.join(root, '_includes'), dynamicPartials: false });
// Portrait, landscape, square, panorama, and a short final row.
const sizes = [[300, 600], [800, 400], [500, 500], [600, 400], [1600, 200], [400, 600], [600, 400]];
let browser;
let server;
let origin;

async function render(layout, count = sizes.length, missing = false) {
    const config = await readFile(path.join(root, '_config.yml'), 'utf8');
    const site = {
        gallery_layout: layout === 'configured' ? config.match(/^gallery_layout:\s*(.*)$/m)[1] : layout,
        title: 'Gallery test',
        header: { title: 'Shots', subtitle: 'by Test' },
        footer: { name: 'About', bio: 'Modern web gallery' },
        social_urls: { github: 'https://github.com/example', instagram: 'https://instagram.com/example' },
        author: 'Test Author',
        baseurl: '/photos',
        image_fulls_loc: '/images/fulls',
        image_thumbs_loc: '/images/thumbs',
        static_files: Array.from({ length: count }, (_, i) => ({ path: `/images/fulls/${i}.jpg`, name: `${i}.jpg` }))
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
                response.setHeader('Content-Type', 'text/html; charset=utf-8');
                response.end(await render(
                    url.searchParams.has('layout') ? url.searchParams.get('layout') : undefined,
                    Number(url.searchParams.get('count') ?? sizes.length),
                    url.searchParams.has('missing')
                ));
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
            const file = path.resolve(root, `.${url.pathname}`);
            if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) {
                response.writeHead(404).end();
                return;
            }
            const types = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
            response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
            response.end(await readFile(file));
        } catch (error) {
            response.writeHead(500).end(String(error));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
        args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
});

after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
});

// Builds a minimal JPEG APP1 EXIF block containing camera metadata and/or GPS coordinates.
function exifJpeg({ gps = null, model = 'Test Camera', fNumber = [28, 10], exposure = [1, 100], iso = 100, padding = 0 } = {}) {
    const tiff = Buffer.alloc(320);
    const entry = (offset, tag, type, count, value) => {
        tiff.writeUInt16LE(tag, offset);
        tiff.writeUInt16LE(type, offset + 2);
        tiff.writeUInt32LE(count, offset + 4);
        tiff.writeUInt32LE(value, offset + 8);
    };
    const ref = (offset, tag, letter) => {
        entry(offset, tag, 2, 2, 0);
        tiff.write(letter, offset + 8, 'latin1');
    };

    tiff.write('II', 0, 'latin1');
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);

    const modelBytes = Buffer.from(`${model}\0`, 'utf8');
    const modelOffset = 220;
    modelBytes.copy(tiff, modelOffset);

    const ifd0Count = gps ? 3 : 2;
    tiff.writeUInt16LE(ifd0Count, 8);
    entry(10, 0x0110, 2, modelBytes.length, modelBytes.length <= 4 ? 0 : modelOffset);
    if (modelBytes.length <= 4) modelBytes.copy(tiff, 18);
    entry(22, 0x8769, 4, 1, 56); // Exif SubIFD at 56
    if (gps) entry(34, 0x8825, 4, 1, 120); // GPS SubIFD at 120

    // Exif SubIFD at offset 56: ExposureTime, FNumber, ISOSpeedRatings
    tiff.writeUInt16LE(3, 56);
    entry(58, 0x829a, 5, 1, 100);
    entry(70, 0x829d, 5, 1, 108);
    entry(82, 0x8827, 3, 1, iso);
    tiff.writeUInt32LE(exposure[0], 100);
    tiff.writeUInt32LE(exposure[1], 104);
    tiff.writeUInt32LE(fNumber[0], 108);
    tiff.writeUInt32LE(fNumber[1], 112);

    if (gps) {
        const [lat, lng] = gps;
        tiff.writeUInt16LE(4, 120);
        ref(122, 1, lat < 0 ? 'S' : 'N');
        entry(134, 2, 5, 3, 172);
        ref(146, 3, lng < 0 ? 'W' : 'E');
        entry(158, 4, 5, 3, 196);
        [lat, lng].forEach((value, i) => {
            const hundredths = Math.round(Math.abs(value) * 360000);
            [[Math.floor(hundredths / 360000), 1], [Math.floor(hundredths / 6000) % 60, 1], [hundredths % 6000, 100]]
                .forEach(([numerator, denominator], j) => {
                    tiff.writeUInt32LE(numerator, 172 + i * 24 + j * 8);
                    tiff.writeUInt32LE(denominator, 176 + i * 24 + j * 8);
                });
        });
    }

    const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(app1.length + 2);
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), length, app1, Buffer.alloc(padding), Buffer.from([0xff, 0xd9])]);
}

async function openGallery(
    t,
    layout,
    count = sizes.length,
    { reducedMotion = 'reduce', hash = '', query = {}, locations = {}, ignoreRange = [], exifModel = 'Test Camera', includeCameraExif = true } = {}
) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, reducedMotion });
    t.after(() => page.close());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], 'no browser errors'));
    await page.route('https://**', route => route.abort());

    page.metadataRequests = [];
    await page.route(/\/photos\/images\/fulls\/\d+\.jpg$/, route => {
        const request = route.request();
        const index = Number(request.url().match(/(\d+)\.jpg$/)[1]);
        if (request.resourceType() !== 'fetch') return route.continue();
        page.metadataRequests.push({ index, range: request.headers().range });
        const gps = locations[index] || null;
        if (!gps && !includeCameraExif) return route.continue();
        const jpeg = exifJpeg({
            gps,
            model: exifModel,
            padding: ignoreRange.includes(index) ? 1 << 20 : 0
        });
        if (ignoreRange.includes(index)) {
            return route.fulfill({ status: 200, contentType: 'image/jpeg', body: jpeg });
        }
        return route.fulfill({
            status: 206,
            contentType: 'image/jpeg',
            body: jpeg,
            headers: { 'Content-Range': `bytes 0-${jpeg.length - 1}/${jpeg.length + 4000000}` }
        });
    });

    await page.goto(`${origin}/?${new URLSearchParams({ ...(layout === undefined ? {} : { layout }), count, ...query })}${hash}`);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#main img'))
        .filter(img => img.loading !== 'lazy')
        .every(img => img.complete));
    return page;
}

async function geometry(page) {
    return page.locator('#main').evaluate(main => ({
        width: main.clientWidth,
        height: main.clientHeight,
        tiles: Array.from(main.querySelectorAll('.thumb')).map(tile => {
            const img = tile.querySelector('img');
            return {
                left: tile.offsetLeft,
                top: tile.offsetTop,
                width: tile.getBoundingClientRect().width,
                height: tile.getBoundingClientRect().height,
                ratio: img.naturalWidth / img.naturalHeight || 1.5
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

test('native DataView EXIF parser extracts camera tags and signed GPS coordinates without third-party libraries', () => {
    const buffer = exifJpeg({ gps: [-35.2809, 149.13], model: 'ILCE-7RM3A', fNumber: [71, 10], exposure: [1, 250], iso: 400 });
    const parsed = parseExifBuffer(buffer);
    assert.equal(parsed.model, 'ILCE-7RM3A');
    assert.equal(parsed.aperture, 7.1);
    assert.equal(parsed.shutterSpeed, '1/250');
    assert.equal(parsed.iso, 400);
    assert.ok(Math.abs(parsed.position[0] - (-35.2809)) < 0.001);
    assert.ok(Math.abs(parsed.position[1] - 149.13) < 0.001);
});

test('modernized document metadata, lazy loading, fetchpriority, and zero legacy globals', async t => {
    const page = await openGallery(t, 'Thumbnail', 10);
    const docMeta = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        viewport: document.querySelector('meta[name="viewport"]')?.content,
        colorScheme: document.querySelector('meta[name="color-scheme"]')?.content,
        hasJQuery: 'jQuery' in window || '$' in window,
        hasSkel: 'skel' in window,
        hasGlobalExif: 'EXIF' in window,
        mainTag: document.getElementById('main')?.tagName
    }));
    assert.equal(docMeta.lang, 'en');
    assert.ok(!docMeta.viewport.includes('user-scalable=no'), 'pinch-to-zoom remains enabled');
    assert.equal(docMeta.colorScheme, 'dark');
    assert.equal(docMeta.hasJQuery, false);
    assert.equal(docMeta.hasSkel, false);
    assert.equal(docMeta.hasGlobalExif, false);
    assert.equal(docMeta.mainTag, 'MAIN');

    const imgAttrs = await page.locator('#main img').evaluateAll(imgs => imgs.map(img => ({
        fetchPriority: img.getAttribute('fetchpriority'),
        loading: img.getAttribute('loading'),
        decoding: img.getAttribute('decoding'),
        alt: img.getAttribute('alt')
    })));
    assert.equal(imgAttrs[0].fetchPriority, 'high');
    assert.equal(imgAttrs[0].loading, null);
    assert.equal(imgAttrs[6].loading, 'lazy');
    assert.ok(imgAttrs.every(attr => attr.decoding === 'async' && attr.alt.length > 0));
});

test('configuration normalizes layout names and defaults to CSS Grid Thumbnail with real <img> elements', async t => {
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
            assert.equal(await page.locator('#main').evaluate(main => getComputedStyle(main).display), 'grid');
            assert.equal(await page.locator('#main img').first().evaluate(img => getComputedStyle(img).objectFit), 'cover');
            assert.equal(await page.locator('#main img').first().isVisible(), true);
        }
    }
});

for (const layout of ['Masonry', 'Justified']) {
    test(`${layout} preserves ratios and adapts to desktop and mobile widths`, async t => {
        const page = await openGallery(t, layout);
        await page.evaluate(() => Promise.all(Array.from(document.querySelectorAll('#main img'), img => {
            img.loading = 'eager';
            return img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; img.onerror = r; });
        })));
        for (const [width, expectedColumns] of [[1100, 3], [375, 1], [768, 2], [1680, 4], [1920, 4], [2560, 4], [3840, 4]]) {
            await page.setViewportSize({ width, height: 800 });
            await page.waitForFunction(() => {
                const main = document.querySelector('#main');
                return Array.from(main.querySelectorAll('.thumb')).every(tile => tile.style.width);
            });
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

    test(`${layout} relayouts after late or failed images`, async t => {
        const page = await openGallery(t, layout);
        await page.evaluate(() => Promise.all(Array.from(document.querySelectorAll('#main img'), img => {
            img.loading = 'eager';
            return img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; img.onerror = r; });
        })));
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

test('Carousel uses native CSS Scroll Snap, accessible 24px+ dot targets, keyboard, and focus management', async t => {
    const page = await openGallery(t, 'Carousel');
    const previous = page.getByRole('button', { name: 'Previous image' });
    const next = page.getByRole('button', { name: 'Next image' });
    assert.equal(await previous.isDisabled(), true);
    assert.equal(await page.locator('.carousel-counter').textContent(), '1 / 7');
    assert.match(await page.locator('.carousel-track').evaluate(el => getComputedStyle(el).scrollSnapType), /^x/);

    const dotBox = await page.locator('.carousel-dot').first().boundingBox();
    assert.ok(dotBox.width >= 24 && dotBox.height >= 24, 'indicator targets meet 24x24 CSS px minimum');

    await next.click();
    assert.equal(await page.locator('.carousel-counter').textContent(), '2 / 7');
    await page.locator('#main').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('.carousel-counter').textContent(), '3 / 7');
    await page.getByRole('button', { name: 'Go to image 6', exact: true }).click();
    await next.focus();
    await next.click();
    assert.equal(await next.isDisabled(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Previous image',
        'focus moves off a newly disabled end button');

    await page.locator('#main').focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('.carousel-counter').textContent(), '6 / 7');

    // Simulate native horizontal scroll + scrollend event on the scroll-snap track.
    await page.locator('.carousel-track').evaluate(track => {
        track.scrollTo({ left: track.clientWidth * 3, behavior: 'instant' });
        track.dispatchEvent(new Event('scrollend'));
    });
    assert.equal(await page.locator('.carousel-counter').textContent(), '4 / 7');

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

test('native <dialog> lightbox, About drawer, and XSS-safe EXIF captions work across every layout', async t => {
    for (const layout of ['Thumbnail', 'Masonry', 'Justified', 'Carousel']) {
        const maliciousModel = 'Test Camera <img src=x onerror="window.__xss=1">';
        const page = await openGallery(t, layout, sizes.length, { exifModel: maliciousModel });

        // Test About <dialog> drawer.
        const aboutBtn = page.getByRole('button', { name: 'About', exact: true });
        await aboutBtn.click();
        const aboutDialog = page.getByRole('dialog', { name: 'About' });
        assert.ok(await aboutDialog.isVisible());
        assert.equal(await page.locator('[data-panel-open="footer"]').getAttribute('aria-expanded'), 'true');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('footer').open && !document.body.classList.contains('content-active'));
        assert.equal(await aboutBtn.getAttribute('aria-expanded'), 'false');

        // Test Lightbox <dialog>.
        await page.locator('#main .thumb a').first().click();
        const lightbox = page.getByRole('dialog', { name: 'Photo viewer' });
        assert.ok(await lightbox.isVisible());
        await page.waitForFunction(() => document.querySelector('#lightbox .lightbox-caption')?.textContent.includes('Test Camera'));
        assert.equal(await page.evaluate(() => Boolean(window.__xss)), false, 'EXIF metadata is rendered safely without HTML injection');
        await page.waitForFunction(() => document.querySelector('#lightbox .lightbox-img')?.getAttribute('src').endsWith('/0.jpg'));

        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => document.querySelector('#lightbox .lightbox-img')?.getAttribute('src').endsWith('/1.jpg'));
        if (layout === 'Carousel') assert.equal(await page.locator('.carousel-counter').textContent(), '1 / 7');

        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.body.classList.contains('modal-active') && !document.getElementById('lightbox').open);
    }
});

// Display mode is settled once every row reaches both edges and no animation is running.
function displaySettled() {
    const stage = document.querySelector('.display-stage').getBoundingClientRect();
    const rows = Array.from(document.querySelectorAll('.display-row'));
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
                        left: rect.left,
                        right: rect.right,
                        top: rect.top,
                        bottom: rect.bottom,
                        width: rect.width,
                        height: rect.height,
                        images: Array.from(tile.querySelectorAll('img')).map(img => ({
                            path: new URL(img.src).pathname,
                            ratio: img.naturalWidth / img.naturalHeight
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
            for (const image of tile.images) assert.match(image.path, /^\/photos\/images\/fulls\/([0-9]|[1-9][0-9])\.jpg$/);
            if (uncropped && tile.images.length === 1 && tile.images[0].ratio >= 0.55 && tile.images[0].ratio <= 2.2 && tile.width < row.width * 0.9 - 1) {
                assert.ok(Math.abs(tile.width / tile.height - tile.images[0].ratio) < 0.02, 'single photos are uncropped');
            }
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
    const changed = visiblePaths(after).filter((p, i) => p !== visiblePaths(before)[i]);
    assert.equal(changed.length, 1, 'one photo is replaced');
});

test('Display mode adapts to the screen and opens from a link', async t => {
    const page = await openGallery(t, 'Masonry', sizes.length, { reducedMotion: 'no-preference', hash: '#display' });
    assert.ok(await page.getByRole('dialog', { name: 'Display mode' }).isVisible());
    for (const [width, height, rows] of [[1100, 800, 2], [375, 700, 4], [700, 375, 2], [1920, 1200, 2], [820, 1180, 3], [2560, 1440, 3]]) {
        await page.setViewportSize({ width, height });
        await page.waitForFunction(expectedRows => document.querySelectorAll('.display-row').length === expectedRows, rows);
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
    assert.ok(visiblePaths(broken).every(p => /\/[0-2]\.jpg$/.test(p)), 'missing photos are skipped');
});

const mapLocations = {
    0: [35.6595, 139.7005],
    2: [-33.8688, 151.2093],
    4: [-33.8688, 151.2093],
    5: [-36.8485, 174.7633]
};

async function mapPins(page) {
    return page.locator('.map-marker').evaluateAll(markers => markers.map(marker => {
        const rect = marker.getBoundingClientRect();
        return {
            photo: new URL(marker.querySelector('img').src).pathname,
            count: Number(marker.querySelector('.map-pin-count')?.textContent || 1),
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom
        };
    }));
}

async function lightboxShows(page, photo) {
    await page.waitForFunction(expected => {
        const dialog = document.getElementById('lightbox');
        const img = dialog?.querySelector('.lightbox-img');
        return Boolean(dialog?.open && !dialog.classList.contains('is-loading') && img?.getAttribute('src')?.endsWith(expected));
    }, photo);
}

test('Map view places photos by their GPS metadata and opens them in the native <dialog> lightbox', async t => {
    const page = await openGallery(t, 'Justified', sizes.length, { locations: mapLocations, ignoreRange: [5], includeCameraExif: false });
    const toggle = page.locator('#header a[href="#map"]');
    assert.equal(await toggle.textContent(), 'Map');
    await toggle.click();
    const map = page.getByRole('region', { name: 'Photo map' });
    assert.ok(await map.isVisible());
    assert.equal(await page.evaluate(() => location.hash), '#map');
    assert.equal(await toggle.textContent(), 'Gallery');
    assert.equal(await page.locator('#main').evaluate(main => getComputedStyle(main).visibility), 'hidden');

    await page.waitForFunction(() => /^4 photos/i.test(document.querySelector('.map-status').textContent));
    assert.match(await page.locator('.map-status').textContent(), /3 without location/i);
    assert.deepEqual(page.metadataRequests.map(request => request.index).sort(), [0, 1, 2, 3, 4, 5, 6]);
    assert.ok(page.metadataRequests.every(request => request.range === 'bytes=0-131071'), 'only the EXIF block is requested');

    await page.waitForFunction(() => document.querySelectorAll('.map-marker').length === 3);
    const bounds = await map.boundingBox();
    const pins = await mapPins(page);
    const [tokyo, sydney, auckland] = [0, 2, 5].map(i => pins.find(pin => pin.photo === `/photos/images/fulls/${i}.jpg`));
    assert.equal(sydney.count, 2, 'photos taken at the same spot share a pin');
    assert.equal(tokyo.count + auckland.count, 2);
    assert.ok(tokyo.bottom < sydney.bottom && tokyo.left < sydney.left && auckland.left > sydney.left && auckland.bottom > sydney.bottom,
        'pins follow latitude and longitude, including southern and eastern references');
    for (const pin of pins) {
        assert.ok(pin.left >= bounds.x && pin.right <= bounds.x + bounds.width && pin.top >= bounds.y && pin.bottom <= bounds.y + bounds.height,
            'the map frames every located photo');
    }

    await page.locator('.map-marker', { has: page.locator('img[src$="/fulls/0.jpg"]') }).click();
    await lightboxShows(page, '/0.jpg');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.classList.contains('modal-active'));
    await page.waitForFunction(() => document.activeElement?.matches('.map-marker') &&
        document.activeElement.querySelector('img').src.endsWith('/0.jpg'));

    await page.locator('.map-marker.group').click();
    assert.match(await page.locator('.map-popup').textContent(), /2 photos here/i);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'View photo 1 of 2');
    await page.getByRole('button', { name: 'View photo 2 of 2' }).click();
    await lightboxShows(page, '/4.jpg');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.classList.contains('modal-active'));

    await page.getByRole('link', { name: 'Display' }).click();
    assert.equal(await page.evaluate(() => document.getElementById('map-view').inert), true, 'display mode covers the map');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('display').hidden && !document.getElementById('map-view').inert);
    assert.ok(await map.isVisible());

    await page.getByRole('link', { name: 'Gallery' }).click();
    await page.waitForFunction(() => document.getElementById('map-view').hidden);
    assert.equal(await page.evaluate(() => location.hash), '');
    assert.equal(await toggle.textContent(), 'Map');
    assert.equal(await page.locator('#main').evaluate(main => getComputedStyle(main).visibility), 'visible');

    await toggle.click();
    assert.ok(await map.isVisible());
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('map-view').hidden);
    await page.goForward();
    await page.waitForFunction(() => !document.getElementById('map-view').hidden);
    assert.equal(await page.locator('.map-marker').count(), 3);
    assert.equal(page.metadataRequests.length, sizes.length, 'EXIF metadata is shared across map and lightbox and read once');
});

test('Map view opens from a link and handles missing locations and galleries', async t => {
    let page = await openGallery(t, 'Thumbnail', sizes.length, { hash: '#map', includeCameraExif: false });
    await page.getByRole('heading', { name: 'No locations yet' }).waitFor();
    assert.equal(await page.locator('.map-status').isHidden(), true);
    assert.equal(await page.locator('.map-marker').count(), 0);
    await page.getByRole('link', { name: 'Gallery' }).click();
    assert.equal(await page.locator('#map-view').isHidden(), true);
    assert.equal(await page.evaluate(() => location.hash), '');

    page = await openGallery(t, 'Carousel', sizes.length, { locations: { 3: mapLocations[5] }, includeCameraExif: false });
    await page.getByRole('link', { name: 'Map' }).click();
    await page.waitForFunction(() => /^1 photo/i.test(document.querySelector('.map-status').textContent));
    assert.match(await page.locator('.map-status').textContent(), /6 without location/i);
    assert.deepEqual((await mapPins(page)).map(pin => pin.photo), ['/photos/images/thumbs/3.jpg'], 'pins reuse the gallery image');

    page = await openGallery(t, 'Justified', sizes.length, { locations: { 0: mapLocations[0] }, includeCameraExif: false });
    await page.route('**/assets/js/leaflet.js', route => route.abort());
    await page.getByRole('link', { name: 'Map' }).click();
    await page.getByRole('heading', { name: 'Map unavailable' }).waitFor();
    assert.equal(page.metadataRequests.length, 0);
    await page.unroute('**/assets/js/leaflet.js');
    await page.getByRole('link', { name: 'Gallery' }).click();
    await page.getByRole('link', { name: 'Map' }).click();
    await page.waitForFunction(() => /^1 photo/i.test(document.querySelector('.map-status').textContent));
    assert.equal(await page.locator('.map-notice').isHidden(), true, 'opening the map again retries');

    page = await openGallery(t, 'Thumbnail', 0, { includeCameraExif: false });
    assert.equal(await page.getByRole('link', { name: 'Map' }).count(), 0);
});

test('The header keeps every button beside the title on phones', async t => {
    const page = await openGallery(t, 'Justified');
    for (const label of ['Map', 'Gallery']) {
        if (label === 'Gallery') await page.getByRole('link', { name: 'Map' }).click();
        for (const width of [320, 375, 414, 480, 736, 1100]) {
            await page.setViewportSize({ width, height: 700 });
            const [title, nav] = await page.evaluate(() => ['#header h1', '#header nav'].map(selector =>
                document.querySelector(selector).getBoundingClientRect().toJSON()));
            assert.ok(title.right <= nav.left, `the ${label} button fits at ${width}px`);
            assert.ok(await page.getByRole('link', { name: label }).isVisible());
        }
    }
});
