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

async function render(layout, count = sizes.length) {
    const config = await readFile(path.join(root, '_config.yml'), 'utf8');
    const site = {
        gallery_layout: layout === 'configured' ? config.match(/^gallery_layout:\s*(.*)$/m)[1] : layout,
        title: 'Gallery test', header: {}, footer: {}, social_urls: {},
        baseurl: '/photos', image_fulls_loc: '/images/fulls', image_thumbs_loc: '/images/thumbs',
        static_files: Array.from({ length: count }, (_, i) => ({ path: '/images/fulls/' + i + '.jpg', name: i + '.jpg' }))
    };
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
                    Number(url.searchParams.get('count') ?? sizes.length)));
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

async function openGallery(t, layout, count = sizes.length) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, reducedMotion: 'reduce' });
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
    await page.goto(origin + '/?' + new URLSearchParams({ ...(layout === undefined ? {} : { layout }), count }));
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
        for (const width of [1100, 375, 1680]) {
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
                const heights = new Map();
                for (const tile of gallery.tiles) {
                    const shortest = Math.min(...Array.from({ length: Math.max(1, Math.floor((width + 8) / 228)) }, (_, i) => heights.get(i) || 0));
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
                    assert.ok(Math.abs(end - gallery.width) < 1 || row[0].height <= Math.min(220, width * 0.4) + 1,
                        'rows fill width unless intentionally left at target height');
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
