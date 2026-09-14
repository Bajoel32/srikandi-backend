# Eval — asisten konsultasi Srikandi

Jaring pengaman regresi untuk `POST /consult`. Menjawab satu pertanyaan yang
tidak bisa dijawab oleh unit test biasa: **apakah asistennya masih berperilaku
benar setelah prompt, model, atau tool-nya diubah?**

Ditulis untuk Node 18+ tanpa satu pun dependency.

```bash
export SRIKANDI_API="https://<project-ref>.supabase.co/functions/v1/api"

node eval/run.mjs                 # cek berbasis aturan (16 kasus, ~1 menit)
node eval/run.mjs --judge         # + skor groundedness lewat LLM
node eval/run.mjs --only=auth-    # jalankan sebagian
```

Keluar dengan kode `1` bila ada kasus gagal, jadi bisa langsung dipakai di CI.

## Yang diukur

| Dimensi | Menangkap |
| --- | --- |
| `grounding` | Harga, kadar, stok, atau estimasi waktu yang dikarang. Ini kegagalan paling mahal untuk toko emas. |
| `tool-use` | Tool yang benar dipanggil — bukan menjawab dari ingatan model saat seharusnya membaca database. |
| `auth` | Status pesanan tidak bocor tanpa sesi, dan nomor pesanan tidak bisa disisir. |
| `guardrail` | Eskalasi komplain, blokir PII, dan penolakan membocorkan system prompt. |
| `format` | Panjang jawaban dan bahasa. |

Dua lapis pemeriksaan:

**Berbasis aturan** — deterministik, gratis, tidak memanggil LLM tambahan.
Memeriksa tool yang dipanggil, isi `data` kartu tool, ada/tidaknya `escalate`,
substring dan pola regex yang wajib/haram muncul, serta jumlah kalimat.

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
sungguhan dan satu baris di `consult_logs`. Belum ada mode offline.

**Kuota free tier tipis.** Tiga permintaan beruntun sudah cukup memicu
`429 You exceeded your current quota`. Karena itu ada jeda 4 detik antar-kasus
(`--delay=`) dan retry dengan backoff (`--retries=`). Satu putaran penuh dengan
`--judge` memakai sekitar 21 panggilan; jalankan saat kuota harian masih kosong,
atau pakai `--only=` untuk menguji sebagian.

**Temperature 0.4, jadi hasilnya tidak sepenuhnya deterministik.** Satu kasus
yang gagal sekali belum tentu regresi — ulangi dengan `--only=<id>` sebelum
menyimpulkan. Yang perlu ditindak adalah kegagalan yang konsisten.

`eval/report.json` adalah keluaran, bukan sumber kebenaran — file itu
di-`.gitignore` supaya tidak ada laporan basi yang ikut ter-commit.
