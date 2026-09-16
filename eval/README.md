# Eval — asisten konsultasi Srikandi

Jaring pengaman regresi untuk `POST /consult`. Menjawab satu pertanyaan yang
tidak bisa dijawab oleh unit test biasa: **apakah asistennya masih berperilaku
benar setelah prompt, model, atau tool-nya diubah?**

Tanpa satu pun dependency. Ada dua harness yang saling melengkapi:

| | `run.mjs` (live) | `offline.mjs` |
| --- | --- | --- |
| Yang diuji | Perilaku **model** di produksi | Perilaku **kode** di sekitar model |
| Gemini & Supabase | Sungguhan | Tiruan, deterministik |
| Biaya | 1 panggilan Gemini + 1 baris `consult_logs` per kasus | Gratis, ±10 detik |
| Bisa menyuntikkan kegagalan (503, 429, jaringan putus) | Tidak | Ya |
| Node | 18+ | 22.6+ (memuat `.ts` langsung) |

```bash
# live — 20 kasus, beberapa menit
export SRIKANDI_API="https://<project-ref>.supabase.co/functions/v1/api"
node eval/run.mjs                 # cek berbasis aturan
node eval/run.mjs --judge         # + skor groundedness lewat LLM
node eval/run.mjs --only=rag-     # jalankan sebagian

# offline — 15 kasus
node --experimental-strip-types eval/offline.mjs
node --experimental-strip-types eval/offline.mjs --only=res-

# buktikan kasus offline menangkap bug: jalankan terhadap versi lama
git show <commit-lama>:supabase/functions/api/consult.ts > /tmp/consult.lama.ts
node --experimental-strip-types eval/offline.mjs --target=/tmp/consult.lama.ts --out=offline-report.lama.json
```

Keduanya keluar dengan kode `1` bila ada kasus gagal, jadi bisa langsung dipakai di CI.
Hasil terakhir dan perbandingan sebelum/sesudah perbaikan ada di [`RESULTS.md`](RESULTS.md).

## Yang diukur

| Dimensi | Menangkap |
| --- | --- |
| `grounding` | Harga, kadar, stok, atau estimasi waktu yang dikarang. Ini kegagalan paling mahal untuk toko emas. |
| `tool-use` | Tool yang benar dipanggil — bukan menjawab dari ingatan model saat seharusnya membaca database. |
| `auth` | Status pesanan tidak bocor tanpa sesi, dan nomor pesanan tidak bisa disisir. |
| `guardrail` | Eskalasi komplain, blokir PII, dan penolakan membocorkan system prompt. |
| `format` | Panjang jawaban dan bahasa. |
| `rag` | Fakta dari `knowledge_docs` (DP 30 %, rekening lewat admin, liontin nama, ukuran cincin) benar-benar sampai ke jawaban. |

Dimensi tambahan di `offline.mjs`:

| Dimensi | Menangkap |
| --- | --- |
| `resilience` | 503/429/5xx/jaringan putus → coba ulang, model cadangan, lalu pesan "asisten sibuk" + WhatsApp — bukan HTTP 500. |
| `rag` | Dokumen hasil `match_knowledge_docs` masuk ke system prompt; parameter embedding benar; embedding gagal tidak menjatuhkan jawaban. |
| `guardrail` | Eskalasi cepat tidak memanggil LLM maupun embedding; aturan rekening ada di prompt. |
| `tool-loop` | `functionCall` → `functionResponse` → jawaban; kartu tool terbentuk. |

Dua lapis pemeriksaan:

**Berbasis aturan** — deterministik, gratis, tidak memanggil LLM tambahan.
Memeriksa tool yang dipanggil, isi `data` kartu tool, ada/tidaknya `escalate`,
substring dan pola regex yang wajib/haram muncul, serta jumlah kalimat. Cek
`llm-menjawab` menggagalkan kasus bila balasannya pesan "asisten sibuk" — tanpa
itu, kasus berbasis `mustNotMatch` bisa lulus padahal model tidak pernah menjawab.

**LLM judge** (`--judge`, butuh `GEMINI_API_KEY`) — menilai groundedness:
apakah jawaban hanya memuat klaim yang didukung hasil tool atau daftar fakta
toko di `cases.json`. Ini yang menangkap halusinasi yang lolos dari regex.
Mengarahkan ke staf atau WhatsApp tidak dihitung sebagai klaim.

## Kasus yang paling berharga

Dua kasus ini ada karena bug sungguhan, bukan karena enak dilihat:

`auth-status-tanpa-login` dan `auth-status-nomor-acak` memakai nomor pesanan
yang ada dan yang tidak ada. Keduanya **harus menghasilkan balasan yang tidak
bisa dibedakan**. Sebelum diperbaiki, yang satu dijawab `notFound` dan yang lain
`needVerification` — selisih itu saja sudah cukup untuk menyisir `SR-001` sampai
`SR-999` dan memetakan berapa banyak pesanan yang ada di toko, tanpa perlu tahu
nama siapa pun. Kalau suatu hari kedua kasus ini gagal bersamaan, oracle itu
terbuka lagi.

`rag-ukuran-cincin` (live) dan `res-503-pulih` / `res-503-habis` (offline)
berasal dari [insiden 2026-09-16](../docs/incidents/2026-09-16-gemini-503.md):
Gemini 503 membuat situs menampilkan daftar harga cincin untuk pertanyaan
"ukuran cincin saya gak tahu". Versi `consult.ts` sebelum perbaikan lulus
9/15 kasus offline; sesudahnya 15/15.

## Menambah kasus

Setiap kali ada bug perilaku yang diperbaiki, tambahkan satu entri di
`cases.json`. Field yang tersedia:

| Field | Arti |
| --- | --- |
| `ask` | Pertanyaan yang dikirim |
| `expectTools` | Daftar tool yang harus dipanggil, persis (`[]` = tidak boleh ada) |
| `forbidTools` | Tool yang tidak boleh dipanggil |
| `expectToolData` | Pasangan nilai yang harus ada di `data` kartu tool |
| `expectEscalate` | `true`/`false` untuk keberadaan field `escalate` |
| `expectPiiBlock` | Balasan harus berupa penolakan PII |
| `mustInclude` / `mustIncludeAny` / `mustNotInclude` | Substring, tidak peka huruf besar-kecil |
| `mustNotMatch` | Daftar regex yang tidak boleh cocok |
| `maxSentences` | Batas jumlah kalimat |
| `judge` | Ikut dinilai groundedness saat `--judge` aktif |

## Catatan yang perlu dibaca sebelum menjalankan

**Ini memanggil produksi.** Setiap kasus berarti satu panggilan Gemini
sungguhan dan satu baris di `consult_logs`. Untuk menguji kode tanpa
menyentuh produksi, pakai `offline.mjs`.

**Kuota free tier tipis.** Tiga permintaan beruntun sudah cukup memicu
`429 You exceeded your current quota`. Karena itu ada jeda 4 detik antar-kasus
(`--delay=`) dan retry dengan backoff (`--retries=`). Satu putaran penuh dengan
`--judge` memakai sekitar 21 panggilan; jalankan saat kuota harian masih kosong,
atau pakai `--only=` untuk menguji sebagian.

**Rate limit backend: 30 konsultasi per jam per IP.** Semua percobaan ulang
ikut dihitung, termasuk uji manual dari jaringan yang sama. Begitu `/consult`
membalas `429 Kuota tanya-jawab tercapai`, `run.mjs` berhenti dan menandai sisa
kasus sebagai *tidak terukur* — mengulang hanya menghabiskan jatah dan membuat
chatbot di situs ikut menolak pengunjung dari IP itu selama satu jam. Dengan
20 kasus, sisakan ruang: `--retries=1`, atau pecah per awalan dengan `--only=`.

**Temperature 0.4, jadi hasilnya tidak sepenuhnya deterministik.** Satu kasus
yang gagal sekali belum tentu regresi — ulangi dengan `--only=<id>` sebelum
menyimpulkan. Yang perlu ditindak adalah kegagalan yang konsisten.

**Balasan "asisten sibuk" juga diulang.** Sejak `consult.ts` membalas Gemini
yang sibuk dengan HTTP 200 + pesan "asisten sibuk", `run.mjs` memperlakukan
balasan itu seperti 429/500: diulang dengan backoff, dan bila tetap sibuk,
kasusnya gagal di cek `llm-menjawab`.

`eval/report.json` dan `eval/offline-report*.json` adalah keluaran, bukan sumber
kebenaran — keduanya di-`.gitignore` supaya tidak ada laporan basi yang ikut
ter-commit. Ringkasan yang sengaja disimpan ada di `RESULTS.md`.
