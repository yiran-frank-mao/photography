import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imagesDir = path.join(root, 'images');
const fullsDir = path.join(imagesDir, 'fulls');
const thumbsDir = path.join(imagesDir, 'thumbs');
const supportedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff']);

async function recompressThumbs() {
    const entries = await readdir(thumbsDir, { withFileTypes: true });
    const files = entries.filter(entry => entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase()));
    let processed = 0;

    for (const entry of files) {
        const target = path.join(thumbsDir, entry.name);
        const temp = `${target}.tmp`;
        await sharp(target)
            .rotate()
            .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 82, mozjpeg: true })
            .toFile(temp);
        await rename(temp, target);
        processed++;
    }
    process.stdout.write(`Optimized ${processed} thumbnails in images/thumbs/\n`);
}

async function ingestNewImages() {
    await mkdir(fullsDir, { recursive: true });
    await mkdir(thumbsDir, { recursive: true });

    const entries = await readdir(imagesDir, { withFileTypes: true });
    const files = entries.filter(entry => entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase()));

    for (const entry of files) {
        const source = path.join(imagesDir, entry.name);
        const outName = `${path.parse(entry.name).name}.jpg`;

        await sharp(source)
            .rotate()
            .resize({ width: 2048, withoutEnlargement: true })
            .keepExif()
            .jpeg({ quality: 86, mozjpeg: true })
            .toFile(path.join(fullsDir, outName));

        await sharp(source)
            .rotate()
            .resize({ width: 640, height: 640, fit: 'cover', position: 'attention', withoutEnlargement: true })
            .jpeg({ quality: 82, mozjpeg: true })
            .toFile(path.join(thumbsDir, outName));

        await rm(source);
    }
    process.stdout.write(`Processed ${files.length} source images into images/fulls/ and images/thumbs/\n`);
}

if (process.argv.includes('--recompress-thumbs')) {
    await recompressThumbs();
} else {
    await ingestNewImages();
}
