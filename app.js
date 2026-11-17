/**
 * HireNote recorder — collects read-speech for fine-tuning Whisper.
 *
 * One speaker reads one block of sentences from kalimat.tsv. Each take is
 * stored in this browser (IndexedDB) as a 16 kHz mono 16-bit WAV together
 * with the exact text that was on screen, so the label always matches what
 * was read even if kalimat.tsv is edited later. "Unduh semua" packs the takes,
 * a transcript TSV and the speaker metadata into one ZIP.
 *
 * Link format: index.html?kode=P03&blok=L2  (both optional; the form asks otherwise)
 */
import { openMic, concat, resample, encodeWav, stats, meterPercent, TARGET_RATE } from './lib/audio.js';
import { makeZip } from './lib/zip.js';
import * as store from './lib/store.js';

const APP_VERSION = '1';
const CONSENT_VERSION = 1;
const PREROLL_S = 0.3;   // audio kept from just before "Rekam" so the first syllable is never cut
const TAIL_S = 0.35;     // audio kept after "Berhenti" so the last syllable is never cut
const MAX_S = 30;        // auto-stop

const $ = (id) => document.getElementById(id);

const state = {
    sentences: [],   // all rows of kalimat.tsv
    blocks: [],      // distinct block ids, in file order
    profile: null,
    list: [],        // sentences of the speaker's block
    idx: 0,
    index: new Map(), // id → take metadata (no audio) for the current speaker
    mic: null,
    ring: [], ringLen: 0,
    rec: null,       // { phase: 'rec'|'tail'|'saving', ... }
    playing: null,
    gridBuilt: false,
};

/* ---------- boot ---------- */

init();

async function init() {
    try {
        state.sentences = await loadSentences();
    } catch {
        return fail('Daftar kalimat tidak bisa dimuat. Periksa koneksi internet, lalu muat ulang halaman.');
    }
    state.blocks = [...new Set(state.sentences.map((s) => s.blok))];

    try {
        state.profile = (await store.getKv('profil')) || null;
    } catch {
        return fail('Browser ini tidak bisa menyimpan rekaman. Biasanya karena mode penyamaran (private). Buka tautan ini di jendela biasa Chrome atau Safari.');
    }

    const p = linkParams();
    const linkMatches = !p.kode || (state.profile && p.kode === state.profile.kode);
    const blokMatches = !p.blok || (state.profile && p.blok === state.profile.blok);
    if (state.profile && linkMatches && blokMatches) return startRecordView();
    showSetup(p);
}

async function loadSentences() {
    const res = await fetch('kalimat.tsv', { cache: 'no-cache' });
    if (!res.ok) throw new Error('tsv');
    const lines = (await res.text()).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
    const head = lines.shift().split('\t');
    const col = (n) => head.indexOf(n);
    return lines.map((l) => {
        const c = l.split('\t');
        return {
            id: c[col('id')], set: c[col('set')], blok: c[col('blok')],
            peran: c[col('peran')], gaya: c[col('gaya')], teks: (c[col('teks')] || '').trim(),
        };
    });
}

function linkParams() {
    const q = new URLSearchParams(location.search);
    const kode = (q.get('kode') || '').trim().toUpperCase();
    const blok = (q.get('blok') || '').trim().toUpperCase();
    return { kode: kode || null, blok: blok || null };
}

function show(view) {
    for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== view;
    window.scrollTo(0, 0);
}

function fail(msg) {
    $('error-text').textContent = msg;
    show('v-error');
}

/* ---------- setup ---------- */

function showSetup(p = {}) {
    const f = $('setup-form');
    // A link for another speaker code on a shared device must not inherit the previous speaker's answers.
    const prof = (state.profile && (!p.kode || p.kode === state.profile.kode)) ? state.profile : {};

    const sel = $('f-blok');
    sel.innerHTML = '<option value="">Pilih…</option>';
    for (const b of state.blocks) {
        const n = state.sentences.filter((s) => s.blok === b).length;
        const o = document.createElement('option');
        o.value = b;
        o.textContent = `${b} (${n} kalimat)`;
        sel.appendChild(o);
    }

    f.kode.value = p.kode || prof.kode || '';
    f.blok.value = p.blok || prof.blok || '';
    f.kode.readOnly = Boolean(p.kode);
    f.blok.disabled = Boolean(p.blok && state.blocks.includes(p.blok));
    f.jenis_kelamin.value = prof.jenis_kelamin || '';
    f.daerah.value = prof.daerah || '';
    f.perangkat.value = prof.perangkat || '';
    f.ruangan.value = prof.ruangan || '';
    f.setuju.checked = false;
    $('setup-error').hidden = true;
    $('whoami').textContent = '';
    show('v-setup');
}

$('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const kode = f.kode.value.trim().toUpperCase();
    const blok = f.blok.value;
    const errors = [];
    if (!/^[A-Z0-9-]{2,12}$/.test(kode)) errors.push('Isi kode pembicara (2–12 huruf/angka, mis. P03).');
    if (!state.blocks.includes(blok)) errors.push('Pilih blok kalimat.');
    if (!f.jenis_kelamin.value) errors.push('Pilih jenis kelamin (atau “Tidak ingin menyebut”).');
    if (!f.perangkat.value) errors.push('Pilih mic yang dipakai.');
    if (!f.ruangan.value) errors.push('Pilih kondisi ruangan.');
    if (!f.setuju.checked) errors.push('Centang persetujuan untuk melanjutkan.');
    if (errors.length) {
        $('setup-error').textContent = errors.join(' ');
        $('setup-error').hidden = false;
        return;
    }

    state.profile = {
        kode, blok,
        jenis_kelamin: f.jenis_kelamin.value,
        daerah: f.daerah.value.trim(),
        perangkat: f.perangkat.value,
        ruangan: f.ruangan.value,
        persetujuan: { versi: CONSENT_VERSION, waktu: new Date().toISOString() },
    };
    try {
        await store.setKv('profil', state.profile);
    } catch {
        return fail('Data tidak bisa disimpan di browser ini. Coba Chrome atau Safari biasa (bukan mode penyamaran).');
    }
    // Ask the browser not to evict our storage under pressure (best effort).
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
    startRecordView();
});

/* ---------- record view ---------- */

async function startRecordView() {
    const { kode, blok } = state.profile;
    state.list = state.sentences.filter((s) => s.blok === blok);
    state.index = await store.indexOf(kode);
    const firstOpen = state.list.findIndex((s) => takeState(s) === 'none' || takeState(s) === 'changed');
    state.idx = firstOpen === -1 ? 0 : firstOpen;
    state.gridBuilt = false;
    $('grid').hidden = true;
    $('whoami').textContent = `Kode ${kode} · blok ${blok}`;
    $('mic-gate').hidden = Boolean(state.mic);
    show('v-record');
    render();
    renderExport();
}

function takeState(s) {
    const t = state.index.get(s.id);
    if (!t) return 'none';
    if (t.teks !== s.teks) return 'changed';
    if (t.peringatan && t.peringatan.length) return 'warn';
    return 'done';
}

function render() {
    const s = state.list[state.idx];
    const t = state.index.get(s.id);
    const ts = takeState(s);
    const n = state.list.length;
    const recording = state.rec !== null;

    const done = state.list.filter((x) => ['done', 'warn'].includes(takeState(x))).length;
    $('prog-text').textContent = `${done} dari ${n} kalimat terekam`;
    $('prog-bar').style.width = `${(done / n) * 100}%`;

    $('s-num').textContent = `Kalimat ${state.idx + 1} dari ${n}`;
    $('s-peran').textContent = s.peran === 'pewawancara' ? 'kamu sebagai pewawancara' : 'kamu sebagai kandidat';
    $('s-teks').textContent = s.teks;
    $('s-hint').textContent = s.gaya === 'lisan'
        ? 'Gaya lisan: ucapkan kata pengisi (eee, hmm, eh) dan ralatnya persis seperti tertulis.'
        : 'Baca dengan wajar, seperti sedang menjawab wawancara.';
    $('s-changed').hidden = ts !== 'changed';

    const rec = $('b-rec');
    rec.disabled = !state.mic || (state.rec && state.rec.phase !== 'rec');
    rec.classList.toggle('is-recording', Boolean(state.rec && state.rec.phase === 'rec'));
    rec.textContent = state.rec
        ? (state.rec.phase === 'rec' ? 'Berhenti' : 'Menyimpan…')
        : (t ? 'Rekam ulang' : 'Rekam');
    // Once a sentence is recorded, "next" becomes the main action.
    rec.classList.toggle('btn-primary', !t || recording);
    rec.classList.toggle('btn-quiet', Boolean(t) && !recording);
    $('b-next').classList.toggle('btn-primary', Boolean(t) && !recording && ts !== 'changed');
    $('b-next').classList.toggle('btn-quiet', !(t && !recording && ts !== 'changed'));

    $('b-play').disabled = !t || recording;
    $('b-play').textContent = state.playing ? 'Berhenti putar' : 'Putar';
    $('b-prev').disabled = recording || state.idx === 0;
    $('b-next').disabled = recording || state.idx === n - 1;

    const status = $('s-status');
    status.classList.remove('ok');
    if (state.rec && state.rec.phase === 'rec') status.textContent = 'Merekam… baca kalimatnya sekarang.';
    else if (state.rec) status.textContent = '';
    else if (t) { status.textContent = `Terekam · ${t.durasi.toFixed(1)} detik`; status.classList.add('ok'); }
    else status.textContent = 'Belum direkam';

    const warn = $('s-warn');
    warn.innerHTML = '';
    if (t && !recording) for (const w of t.peringatan || []) {
        const li = document.createElement('li');
        li.textContent = w;
        warn.appendChild(li);
    }

    $('meter').parentElement.classList.toggle('live', Boolean(state.rec && state.rec.phase === 'rec'));
    renderGrid();
}

function renderGrid() {
    const grid = $('grid');
    if (!state.gridBuilt) {
        grid.innerHTML = '';
        state.list.forEach((s, i) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = String(i + 1);
            b.addEventListener('click', () => go(i));
            grid.appendChild(b);
        });
        state.gridBuilt = true;
    }
    const recording = state.rec !== null;
    [...grid.children].forEach((b, i) => {
        const ts = takeState(state.list[i]);
        b.className = ts === 'done' ? 'done' : (ts === 'warn' || ts === 'changed') ? 'warn' : '';
        if (i === state.idx) b.classList.add('current');
        b.disabled = recording;
        b.title = { none: 'belum direkam', done: 'terekam', warn: 'terekam, ada peringatan', changed: 'kalimat berubah, rekam ulang' }[ts];
    });
}

$('b-toggle-grid').addEventListener('click', () => {
    const g = $('grid');
    g.hidden = !g.hidden;
    $('b-toggle-grid').textContent = g.hidden ? 'Lihat semua kalimat' : 'Sembunyikan daftar';
});

function go(i) {
    if (state.rec) return;
    stopPlayback();
    state.idx = Math.max(0, Math.min(state.list.length - 1, i));
    render();
}
$('b-prev').addEventListener('click', () => go(state.idx - 1));
$('b-next').addEventListener('click', () => go(state.idx + 1));

/* ---------- microphone ---------- */

$('b-mic').addEventListener('click', enableMic);

async function enableMic() {
    $('mic-error').hidden = true;
    $('b-mic').disabled = true;
    try {
        state.mic = await openMic(onBlock, onMicEnded);
        $('mic-gate').hidden = true;
    } catch (e) {
        $('mic-error').textContent = micMessage(e);
        $('mic-error').hidden = false;
    } finally {
        $('b-mic').disabled = false;
        render();
    }
}

function onMicEnded() {
    // Device unplugged, permission revoked, or the OS took the mic away.
    state.mic = null;
    if (state.rec) state.rec = null;
    $('mic-gate').hidden = false;
    $('mic-error').textContent = 'Mikrofon terputus. Nyalakan lagi untuk melanjutkan.';
    $('mic-error').hidden = false;
    render();
}

function micMessage(e) {
    if (e.code === 'no-media' || !window.isSecureContext) {
        return 'Browser ini tidak memberi akses mikrofon. Buka tautan di Chrome atau Safari, bukan dari dalam WhatsApp atau Instagram.';
    }
    switch (e.name) {
        case 'NotAllowedError':
        case 'SecurityError':
            return 'Izin mikrofon ditolak. Buka pengaturan situs (ikon di sebelah alamat web), izinkan Mikrofon, lalu muat ulang halaman.';
        case 'NotFoundError':
        case 'OverconstrainedError':
            return 'Tidak ada mikrofon yang terdeteksi. Sambungkan mic, atau pakai perangkat lain.';
        case 'NotReadableError':
            return 'Mikrofon sedang dipakai aplikasi lain (mis. Zoom atau Meet). Tutup aplikasi itu lalu coba lagi.';
        default:
            return `Mikrofon tidak bisa dinyalakan (${e.name || e.message}). Coba muat ulang halaman.`;
    }
}

function onBlock(block) {
    $('meter').style.width = `${meterPercent(block)}%`;
    const r = state.rec;
    if (r && (r.phase === 'rec' || r.phase === 'tail')) {
        r.blocks.push(block);
        r.len += block.length;
        if (r.phase === 'rec' && r.len - r.trim >= MAX_S * state.mic.rate) stopRec();
        else if (r.phase === 'tail' && r.len >= r.tailUntil) finishRec();
        return;
    }
    // Idle: keep a short ring buffer for the pre-roll.
    state.ring.push(block);
    state.ringLen += block.length;
    const need = PREROLL_S * state.mic.rate;
    while (state.ring.length > 1 && state.ringLen - state.ring[0].length >= need) {
        state.ringLen -= state.ring.shift().length;
    }
}

/* ---------- recording ---------- */

$('b-rec').addEventListener('click', toggleRec);

async function toggleRec() {
    if (!state.mic) return;
    if (state.rec) {
        if (state.rec.phase === 'rec') stopRec();
        return;
    }
    stopPlayback();
    try { await state.mic.resume(); } catch {}
    const s = state.list[state.idx];
    const need = Math.round(PREROLL_S * state.mic.rate);
    state.rec = {
        phase: 'rec',
        sentence: s,
        blocks: state.ring.slice(),
        len: state.ringLen,
        trim: Math.max(0, state.ringLen - need), // ring may hold a little more than the pre-roll
    };
    state.ring = [];
    state.ringLen = 0;
    render();
}

function stopRec() {
    const r = state.rec;
    if (!r || r.phase !== 'rec') return;
    r.phase = 'tail';
    r.tailUntil = r.len + TAIL_S * state.mic.rate;
    render();
    // If audio stops arriving (tab suspended), save what we have.
    r.fallback = setTimeout(finishRec, 1500);
}

async function finishRec() {
    const r = state.rec;
    if (!r || r.phase === 'saving') return;
    r.phase = 'saving';
    clearTimeout(r.fallback);
    const s = r.sentence;
    const { kode } = state.profile;
    let message = null;
    try {
        const raw = concat(r.blocks).subarray(r.trim);
        if (raw.length < state.mic.rate * 0.2) throw new Error('empty');
        const pcm = await resample(raw, state.mic.rate);
        const st = stats(pcm, TARGET_RATE);
        const wav = encodeWav(pcm, TARGET_RATE);
        const prev = state.index.get(s.id);
        const take = {
            kode, id: s.id, set: s.set, blok: s.blok, peran: s.peran, gaya: s.gaya,
            teks: s.teks, // the text that was on screen = the label
            wav, bytes: wav.byteLength,
            ...st,
            peringatan: checkTake(st, s.teks),
            percobaan: ((prev && prev.percobaan) || 0) + 1,
            direkam_pada: new Date().toISOString(),
            laju_asal_hz: state.mic.rate,
            mic: state.mic.settings,
        };
        await store.putTake(take);
        const { wav: _omit, ...light } = take;
        state.index.set(s.id, light);
    } catch (e) {
        message = e.message === 'empty'
            ? 'Tidak ada suara yang tertangkap. Coba matikan dan nyalakan lagi mikrofonnya (muat ulang halaman).'
            : `Rekaman gagal disimpan (${e.name || e.message}). Coba rekam lagi.`;
    }
    state.rec = null;
    render();
    renderExport();
    if (message) {
        const li = document.createElement('li');
        li.textContent = message;
        $('s-warn').appendChild(li);
    }
}

/** Warnings are advice, not blocks: the speaker decides whether to re-record. */
function checkTake(st, teks) {
    const w = [];
    const words = teks.split(/\s+/).filter(Boolean).length;
    if (st.durasi < Math.max(1.2, words * 0.22 + PREROLL_S + TAIL_S)) {
        w.push('Rekaman ini terlalu pendek untuk kalimatnya. Pastikan seluruh kalimat terbaca, lalu rekam ulang kalau perlu.');
    }
    if (st.puncak < 0.05) w.push('Suaramu sangat pelan. Dekatkan mic atau bicara sedikit lebih keras, lalu rekam ulang.');
    if (st.sampel_klip > 50) w.push('Suaramu pecah karena terlalu keras. Jauhkan mic sedikit, lalu rekam ulang.');
    if (st.durasi >= MAX_S) w.push('Rekaman berhenti otomatis setelah 30 detik. Kalau kalimatnya selesai jauh sebelum itu, rekam ulang.');
    return w;
}

/* ---------- playback ---------- */

$('b-play').addEventListener('click', togglePlay);

async function togglePlay() {
    if (state.playing) { stopPlayback(); render(); return; }
    const s = state.list[state.idx];
    const t = await store.getTake(state.profile.kode, s.id);
    if (!t) return;
    const url = URL.createObjectURL(new Blob([t.wav], { type: 'audio/wav' }));
    const audio = new Audio(url);
    state.playing = { audio, url };
    audio.addEventListener('ended', () => { stopPlayback(); render(); });
    render();
    try { await audio.play(); } catch { stopPlayback(); render(); }
}

function stopPlayback() {
    if (!state.playing) return;
    try { state.playing.audio.pause(); } catch {}
    URL.revokeObjectURL(state.playing.url);
    state.playing = null;
}

/* ---------- keyboard ---------- */

const typing = (el) => el && el.matches && el.matches('input, select, textarea');

document.addEventListener('keydown', (e) => {
    if ($('v-record').hidden || typing(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) toggleRec(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (!$('b-next').disabled) go(state.idx + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (!$('b-prev').disabled) go(state.idx - 1); }
    else if (e.key === 'p' || e.key === 'P') { if (!$('b-play').disabled) togglePlay(); }
});
// A focused button would otherwise also "click" on Space keyup.
document.addEventListener('keyup', (e) => {
    if (!$('v-record').hidden && e.code === 'Space' && !typing(e.target)) e.preventDefault();
});

window.addEventListener('beforeunload', (e) => {
    if (state.rec) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- export ---------- */

async function renderExport() {
    const { kode } = state.profile;
    const count = state.index.size;
    const bytes = [...state.index.values()].reduce((n, t) => n + (t.bytes || 0), 0);
    $('export-count').textContent = count
        ? `${count} rekaman tersimpan di browser ini (± ${(bytes / 1048576).toFixed(1)} MB).`
        : 'Belum ada rekaman.';
    $('b-zip').disabled = count === 0;
    $('b-share').hidden = !canShareZip();
    $('b-share').disabled = count === 0;
    let last = null;
    try { last = await store.getKv(`ekspor/${kode}`); } catch {}
    $('export-status').textContent = last
        ? `Terakhir diunduh ${new Date(last.waktu).toLocaleString('id-ID')} (${last.jumlah} rekaman).`
        : '';
}

function canShareZip() {
    try {
        const f = new File([new Uint8Array(1)], 'x.zip', { type: 'application/zip' });
        return Boolean(navigator.canShare && navigator.canShare({ files: [f] }));
    } catch { return false; }
}

const tsvCell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');

async function buildZip() {
    const p = state.profile;
    const order = new Map(state.sentences.map((s, i) => [s.id, i]));
    const current = new Map(state.sentences.map((s) => [s.id, s]));
    const takes = (await store.takesOf(p.kode))
        .sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));

    const files = [];
    const rows = [[
        'file', 'id', 'kode_pembicara', 'set', 'blok', 'peran', 'gaya', 'teks', 'teks_sama_dengan_terkini',
        'durasi_detik', 'puncak', 'rms_dbfs', 'sampel_klip', 'peringatan', 'percobaan', 'direkam_pada', 'laju_asal_hz',
    ]];
    for (const t of takes) {
        const name = `${p.kode}_${t.id}.wav`;
        files.push({ name, data: new Uint8Array(t.wav) });
        const cur = current.get(t.id);
        rows.push([
            name, t.id, p.kode, t.set, t.blok, t.peran, t.gaya, t.teks,
            cur ? (cur.teks === t.teks ? 'ya' : 'tidak') : 'dihapus',
            t.durasi.toFixed(3), t.puncak.toFixed(4), t.rms_dbfs.toFixed(1), t.sampel_klip,
            (t.peringatan || []).length, t.percobaan, t.direkam_pada, t.laju_asal_hz,
        ]);
    }
    const enc = new TextEncoder();
    files.push({ name: 'transkrip.tsv', data: enc.encode(rows.map((r) => r.map(tsvCell).join('\t')).join('\n') + '\n') });

    const now = new Date();
    const meta = {
        kode: p.kode,
        blok: p.blok,
        jenis_kelamin: p.jenis_kelamin,
        daerah: p.daerah || null,
        perangkat: p.perangkat,
        ruangan: p.ruangan,
        persetujuan: p.persetujuan,
        jumlah_rekaman: takes.length,
        diekspor_pada: now.toISOString(),
        format_audio: { sample_rate: TARGET_RATE, bit: 16, kanal: 1, wadah: 'WAV PCM' },
        pemrosesan_browser_diminta: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        pemrosesan_browser_diterapkan: takes.length ? takes[takes.length - 1].mic : null,
        pre_roll_detik: PREROLL_S,
        tail_detik: TAIL_S,
        versi_aplikasi: APP_VERSION,
    };
    files.push({ name: 'pembicara.json', data: enc.encode(JSON.stringify(meta, null, 2) + '\n') });

    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    return { blob: makeZip(files, now), name: `rekaman-${p.kode}-${p.blok}-${stamp}.zip`, count: takes.length };
}

async function markExported(count) {
    try { await store.setKv(`ekspor/${state.profile.kode}`, { waktu: new Date().toISOString(), jumlah: count }); } catch {}
    renderExport();
}

$('b-zip').addEventListener('click', async () => {
    const btn = $('b-zip');
    btn.disabled = true;
    $('export-status').textContent = 'Menyiapkan ZIP…';
    try {
        const { blob, name, count } = await buildZip();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        await markExported(count);
    } catch (e) {
        $('export-status').textContent = `ZIP gagal dibuat (${e.name || e.message}).`;
    } finally {
        btn.disabled = state.index.size === 0;
    }
});

$('b-share').addEventListener('click', async () => {
    try {
        const { blob, name, count } = await buildZip();
        const file = new File([blob], name, { type: 'application/zip' });
        await navigator.share({ files: [file], title: 'Rekaman suara HireNote' });
        await markExported(count);
    } catch (e) {
        if (e.name !== 'AbortError') $('export-status').textContent = 'Tidak bisa membagikan langsung. Pakai “Unduh semua (ZIP)”.';
    }
});

$('b-profile').addEventListener('click', () => {
    if (state.rec) return;
    stopPlayback();
    showSetup({});
});

$('b-wipe').addEventListener('click', async () => {
    if (state.rec) return;
    const ok = confirm('Semua rekaman di browser ini akan dihapus permanen dan tidak bisa dikembalikan.\n\nSudah mengunduh dan mengirim ZIP-nya?');
    if (!ok) return;
    stopPlayback();
    await store.clearAll();
    location.reload();
});
