const HEAD_BYTES = 131072;
const metadataCache = new Map();

const TYPE_SIZES = {
    1: 1, // BYTE
    2: 1, // ASCII
    3: 2, // SHORT
    4: 4, // LONG
    5: 8, // RATIONAL
    7: 1, // UNDEFINED
    9: 4, // SLONG
    10: 8 // SRATIONAL
};

const IFD0_TAGS = {
    0x010f: 'Make',
    0x0110: 'Model',
    0x8769: 'ExifIFDPointer',
    0x8825: 'GPSInfoIFDPointer'
};

const EXIF_TAGS = {
    0x829a: 'ExposureTime',
    0x829d: 'FNumber',
    0x8827: 'ISOSpeedRatings'
};

const GPS_TAGS = {
    0x0001: 'GPSLatitudeRef',
    0x0002: 'GPSLatitude',
    0x0003: 'GPSLongitudeRef',
    0x0004: 'GPSLongitude'
};

const asciiDecoder = new TextDecoder('utf-8');

function readTagValue(view, tiffOffset, entryOffset, littleEndian) {
    if (entryOffset + 12 > view.byteLength) return undefined;
    const type = view.getUint16(entryOffset + 2, littleEndian);
    const count = view.getUint32(entryOffset + 4, littleEndian);
    const unitSize = TYPE_SIZES[type];
    if (!unitSize || count === 0) return undefined;

    const byteLength = count * unitSize;
    const valueOffset = byteLength <= 4
        ? entryOffset + 8
        : tiffOffset + view.getUint32(entryOffset + 8, littleEndian);

    if (valueOffset < 0 || valueOffset + byteLength > view.byteLength) return undefined;

    if (type === 2) {
        const bytes = new Uint8Array(view.buffer, view.byteOffset + valueOffset, byteLength);
        const nul = bytes.indexOf(0);
        return asciiDecoder.decode(nul >= 0 ? bytes.subarray(0, nul) : bytes).trim();
    }

    const readSingle = index => {
        const pos = valueOffset + index * unitSize;
        switch (type) {
            case 1:
            case 7:
                return view.getUint8(pos);
            case 3:
                return view.getUint16(pos, littleEndian);
            case 4:
                return view.getUint32(pos, littleEndian);
            case 9:
                return view.getInt32(pos, littleEndian);
            case 5: {
                const numerator = view.getUint32(pos, littleEndian);
                const denominator = view.getUint32(pos + 4, littleEndian);
                return { value: denominator ? numerator / denominator : 0, numerator, denominator };
            }
            case 10: {
                const numerator = view.getInt32(pos, littleEndian);
                const denominator = view.getInt32(pos + 4, littleEndian);
                return { value: denominator ? numerator / denominator : 0, numerator, denominator };
            }
            default:
                return undefined;
        }
    };

    if (count === 1) return readSingle(0);
    const values = [];
    for (let i = 0; i < count; i++) values.push(readSingle(i));
    return values;
}

function readIfd(view, tiffOffset, ifdOffset, tagMap, littleEndian) {
    const out = {};
    if (ifdOffset + 2 > view.byteLength) return out;
    const entries = view.getUint16(ifdOffset, littleEndian);
    for (let i = 0; i < entries; i++) {
        const entryOffset = ifdOffset + 2 + i * 12;
        if (entryOffset + 12 > view.byteLength) break;
        const tagId = view.getUint16(entryOffset, littleEndian);
        const name = tagMap[tagId];
        if (!name) continue;
        const val = readTagValue(view, tiffOffset, entryOffset, littleEndian);
        if (val !== undefined) out[name] = val;
    }
    return out;
}

function formatExposureTime(raw) {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === 'object' && 'numerator' in raw) {
        const { numerator, denominator } = raw;
        if (!denominator || !numerator) return undefined;
        if (denominator === 1) return `${numerator}s`;
        if (numerator >= denominator && numerator % denominator === 0) return `${numerator / denominator}s`;
        return `${numerator}/${denominator}`;
    }
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) return undefined;
    return num >= 1 ? `${num}s` : `1/${Math.round(1 / num)}`;
}

function formatAperture(raw) {
    const num = typeof raw === 'object' && raw !== null ? raw.value : Number(raw);
    if (!Number.isFinite(num) || num <= 0) return undefined;
    return Math.round(num * 10) / 10;
}

function toDegrees(values, ref) {
    if (!Array.isArray(values) || values.length !== 3) return null;
    const parts = values.map(v => (typeof v === 'object' && v !== null ? v.value : Number(v)));
    const result = parts[0] + parts[1] / 60 + parts[2] / 3600;
    if (!Number.isFinite(result)) return null;
    return /^[SW]/i.test(String(ref || '')) ? -result : result;
}

export function extractGpsPosition(tags) {
    if (!tags) return null;
    const lat = toDegrees(tags.GPSLatitude, tags.GPSLatitudeRef);
    const lng = toDegrees(tags.GPSLongitude, tags.GPSLongitudeRef);
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    if (lat === 0 && lng === 0) return null;
    return [lat, lng];
}

export function parseExifBuffer(input) {
    const view = input instanceof DataView
        ? input
        : input instanceof Uint8Array
            ? new DataView(input.buffer, input.byteOffset, input.byteLength)
            : new DataView(input);

    if (view.byteLength < 12 || view.getUint16(0, false) !== 0xffd8) return null;

    let offset = 2;
    while (offset + 4 <= view.byteLength) {
        if (view.getUint8(offset) !== 0xff) break;
        while (offset < view.byteLength && view.getUint8(offset) === 0xff) offset++;
        if (offset >= view.byteLength) break;

        const marker = view.getUint8(offset);
        offset++;

        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > view.byteLength) break;

        const segmentLength = view.getUint16(offset, false);
        if (segmentLength < 2) break;

        if (
            marker === 0xe1 &&
            offset + 8 <= view.byteLength &&
            view.getUint32(offset + 2, false) === 0x45786966 &&
            view.getUint16(offset + 6, false) === 0x0000
        ) {
            const tiffOffset = offset + 8;
            if (tiffOffset + 8 > view.byteLength) return null;
            const endianMarker = view.getUint16(tiffOffset, false);
            if (endianMarker !== 0x4949 && endianMarker !== 0x4d4d) return null;
            const littleEndian = endianMarker === 0x4949;
            if (view.getUint16(tiffOffset + 2, littleEndian) !== 0x002a) return null;

            const firstIfd = view.getUint32(tiffOffset + 4, littleEndian);
            const ifd0 = readIfd(view, tiffOffset, tiffOffset + firstIfd, IFD0_TAGS, littleEndian);
            const exif = ifd0.ExifIFDPointer
                ? readIfd(view, tiffOffset, tiffOffset + ifd0.ExifIFDPointer, EXIF_TAGS, littleEndian)
                : {};
            const gps = ifd0.GPSInfoIFDPointer
                ? readIfd(view, tiffOffset, tiffOffset + ifd0.GPSInfoIFDPointer, GPS_TAGS, littleEndian)
                : {};

            const rawIso = Array.isArray(exif.ISOSpeedRatings) ? exif.ISOSpeedRatings[0] : exif.ISOSpeedRatings;
            return {
                model: ifd0.Model || undefined,
                aperture: formatAperture(exif.FNumber),
                shutterSpeed: formatExposureTime(exif.ExposureTime),
                iso: Number.isFinite(Number(rawIso)) && Number(rawIso) > 0 ? Number(rawIso) : undefined,
                position: extractGpsPosition(gps)
            };
        }

        offset += segmentLength;
    }

    return null;
}

async function readHead(response) {
    if (!response.body?.getReader) return response.arrayBuffer();
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;

    while (size < HEAD_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
        if (size >= HEAD_BYTES) {
            reader.cancel().catch(() => {});
            break;
        }
    }

    const bytes = new Uint8Array(size);
    let pos = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, pos);
        pos += chunk.byteLength;
    }
    return bytes.buffer;
}

export function readPhotoMetadata(src) {
    if (!src) return Promise.resolve(null);
    const cached = metadataCache.get(src);
    if (cached) return cached;

    const request = fetch(src, {
        headers: { Range: `bytes=0-${HEAD_BYTES - 1}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(10000)
    })
        .then(async response => {
            if (!response.ok) return null;
            const buffer = await readHead(response);
            return parseExifBuffer(buffer);
        })
        .catch(() => null);

    metadataCache.set(src, request);
    return request;
}
