# Perekam suara HireNote

Situs statis untuk mengumpulkan rekaman suara (kalimat wawancara IT yang dibacakan) sebagai dataset fine-tune Whisper bahasa Indonesia. Bagian dari proyek [HireNote](https://github.com/MichLoverz/hrd-speech-web-final-project); dokumentasi lengkap ada di `tools/README.md` repo itu.

- Tanpa build dan tanpa backend: rekaman disimpan di browser pembicara (IndexedDB), lalu diunduh sebagai ZIP berisi WAV 16 kHz mono 16-bit, `transkrip.tsv`, dan `pembicara.json`.
- Tautan per pembicara: `/?kode=P03&blok=L2`.
- Coba lokal: `python -m http.server 8099`, lalu buka `http://localhost:8099/?kode=P99&blok=L1`. Mikrofon hanya jalan di `localhost` atau HTTPS.
- Deploy ke Vercel: impor repo ini, Framework Preset *Other*, tanpa build command.

Repo ini hasil `git subtree split` dari folder `tools/recorder` di monorepo HireNote. Ubah kodenya di sana, bukan di sini.
