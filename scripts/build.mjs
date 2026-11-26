import { watch } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import * as sass from 'sass';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watchMode = process.argv.includes('--watch');

const jsEntries = [
    'exif-reader.js',
    'main.js',
    'display.js',
    'map.js'
];

const sharedExifPlugin = {
    name: 'shared-exif-module',
    setup(build) {
        build.onResolve({ filter: /^\.\/exif-reader\.js$/ }, () => ({
            path: './exif-reader.min.js',
            external: true
        }));
    }
};

async function compileCss() {
    const result = sass.compile(path.join(root, 'assets/sass/main.scss'), {
        style: 'compressed',
        loadPaths: [path.join(root, 'assets/sass')]
    });
    const outDir = path.join(root, 'assets/css');
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'main.min.css'), result.css);
}

async function minifyJs() {
    await Promise.all(jsEntries.map(async file => {
        const infile = path.join(root, 'assets/js', file);
        const outfile = path.join(root, 'assets/js', file.replace(/\.js$/, '.min.js'));
        await esbuild.build({
            entryPoints: [infile],
            outfile,
            bundle: true,
            plugins: file === 'exif-reader.js' ? [] : [sharedExifPlugin],
            format: 'esm',
            target: 'es2022',
            minify: true,
            legalComments: 'none'
        });
    }));
}

async function buildAll() {
    await Promise.all([compileCss(), minifyJs()]);
}

await buildAll();

if (watchMode) {
    let timer = null;
    const trigger = label => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
            try {
                await buildAll();
                process.stdout.write(`Rebuilt assets (${label})\n`);
            } catch (error) {
                process.stderr.write(`${error.stack || error}\n`);
            }
        }, 80);
    };
    watch(path.join(root, 'assets/sass'), { recursive: true }, (_, name) => trigger(name || 'sass'));
    watch(path.join(root, 'assets/js'), (_, name) => {
        if (name && !name.endsWith('.min.js')) trigger(name);
    });
}
