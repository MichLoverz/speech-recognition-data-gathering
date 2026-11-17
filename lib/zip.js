/**
 * Minimal ZIP writer (store method, no compression).
 *
 * WAV speech barely compresses, so "store" loses almost nothing and keeps this
 * dependency-free. Names are flagged UTF-8. Limits: < 4 GB, < 65,535 files —
 * far beyond one speaker's ~75 takes (~15 MB).
 */
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/** @param {{name: string, data: Uint8Array}[]} files */
export function makeZip(files, date = new Date()) {
    const enc = new TextEncoder();
    const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xFFFF;
    const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF;
    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
        const name = enc.encode(f.name);
        const crc = crc32(f.data);
        const size = f.data.length;

        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true);
        lh.setUint16(4, 20, true);       // version needed
        lh.setUint16(6, 0x0800, true);   // UTF-8 names
        lh.setUint16(8, 0, true);        // store
        lh.setUint16(10, dosTime, true);
        lh.setUint16(12, dosDate, true);
        lh.setUint32(14, crc, true);
        lh.setUint32(18, size, true);
        lh.setUint32(22, size, true);
        lh.setUint16(26, name.length, true);
        lh.setUint16(28, 0, true);
        parts.push(lh.buffer, name, f.data);

        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true);
        ch.setUint16(4, 20, true);
        ch.setUint16(6, 20, true);
        ch.setUint16(8, 0x0800, true);
        ch.setUint16(10, 0, true);
        ch.setUint16(12, dosTime, true);
        ch.setUint16(14, dosDate, true);
        ch.setUint32(16, crc, true);
        ch.setUint32(20, size, true);
        ch.setUint32(24, size, true);
        ch.setUint16(28, name.length, true);
        // extra len, comment len, disk no, internal attrs, external attrs = 0
        ch.setUint32(42, offset, true);
        central.push(ch.buffer, name);

        offset += 30 + name.length + size;
    }

    const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
