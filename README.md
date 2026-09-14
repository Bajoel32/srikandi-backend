# Srikandi — Backend

Backend untuk storefront [Srikandi](https://bajoel32.github.io/bajoel32/)
(repo frontend: [`Bajoel32/bajoel32`](https://github.com/Bajoel32/bajoel32)).

Isinya **PostgreSQL + satu Edge Function `api`** di Supabase. Frontend tetap
statis di GitHub Pages dan hanya memanggil endpoint di sini lewat `fetch`.

```
Browser (GitHub Pages)
        │  fetch()  — tanpa kunci rahasia apa pun
        ▼
Edge Function `api`  ── service-role key (hanya hidup di server)
        ▼
PostgreSQL (RLS aktif, tanpa policy → tidak bisa diakses langsung dari browser)
```

Kenapa lewat Edge Function dan bukan `supabase-js` langsung di browser?

- Login konsumen memakai **nomor HP + kode akses**, bukan email/password
  Supabase Auth.
- API key asisten AI tidak boleh ikut ke bundle JavaScript.
- Validasi, rate limit, dan honeypot form perlu tempat yang tidak bisa
  dimatikan dari sisi klien.

---

## Struktur

```
supabase/
  config.toml                       verify_jwt = false untuk function `api`
  migrations/20260912000000_init.sql  tabel + RLS + RPC
  seed.sql                          data awal (galeri, konsumen & pesanan contoh)
  functions/api/
    index.ts                        router semua endpoint
    _shared.ts                      CORS, klien service-role, sesi, rate limit
    consult.ts                      asisten AI + tool use
```

## 1. Siapkan project Supabase

1. Buat/buka project di dashboard Supabase, pastikan statusnya **Active**
   (project free-tier otomatis *paused* setelah ±7 hari menganggur).
2. Catat **Project ref** — deretan huruf di URL dashboard.

## 2. Buat tabel

**Lewat SQL Editor** (tanpa install apa pun): tempel isi
`supabase/migrations/20260912000000_init.sql`, Run. Lalu query baru, tempel
`supabase/seed.sql`, Run.

**Lewat CLI:**

```bash
npm i -g supabase
supabase link --project-ref <project-ref>
supabase db push
psql "$(supabase db url)" -f supabase/seed.sql   # opsional
```

Yang dibuat:

| Tabel          | Isi                                                           |
| -------------- | ------------------------------------------------------------- |
| `gallery`      | katalog perhiasan                                              |
| `customers`    | konsumen + kode akses (hash bcrypt, bukan teks asli)           |
| `orders`       | pesanan & progresnya                                           |
| `bookings`     | kiriman formulir "Booking Layanan"                             |
| `sessions`     | token login konsumen (yang disimpan hanya SHA-256-nya)         |
| `consult_logs` | riwayat tanya-jawab asisten AI                                 |
| `rate_limits`  | pembatas laju per-IP                                           |

**RLS aktif di semua tabel dan sengaja tanpa policy.** `anon key` sekalipun
tidak bisa membaca apa pun secara langsung — semua harus lewat Edge Function.

## 3. Set secret

Dashboard → Edge Functions → Secrets, atau:

```bash
cp .env.example .env      # isi, JANGAN di-commit
supabase secrets set --env-file .env --project-ref <project-ref>
```

| Secret              | Wajib              | Isi                                                    |
| ------------------- | ------------------ | ------------------------------------------------------ |
| `SALES_KEY_SHA256`  | untuk upload sales | hash-dari-hash kata sandi sales, lihat di bawah         |
| `GEMINI_API_KEY` | untuk asisten AI   | API key dari aistudio.google.com/apikey                      |
| `CONSULT_MODEL`     | tidak              | default `gemini-3.5-flash`                             |
| `ALLOWED_ORIGINS`   | tidak              | default sudah mencakup GitHub Pages + localhost         |
| `WHATSAPP_URL`      | tidak              | link WhatsApp admin untuk tombol eskalasi               |

`SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` otomatis tersedia di dalam
function — jangan diset manual.

### Menghitung kunci sales

Gerbang sales di halaman Galeri mengirim **SHA-256 dari kata sandi**, bukan kata
sandinya. Server menyimpan hash dari hash itu, jadi bocornya secret di Supabase
tidak langsung membuka pintu.

```bash
PASS='ganti-sandi-ini'
H1=$(node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$PASS")
H2=$(node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$H1")
echo "VITE_SALES_PASSPHRASE_SHA256 (secret repo frontend) = $H1"
echo "SALES_KEY_SHA256             (secret Supabase)      = $H2"
```

## 4. Deploy Edge Function

**Otomatis** — push ke `main` menjalankan `.github/workflows/deploy.yml`.
Butuh dua secret di repo ini (Settings → Secrets and variables → Actions):

```
SUPABASE_ACCESS_TOKEN   # Account Settings -> Access Tokens di dashboard Supabase
SUPABASE_PROJECT_REF    # deretan huruf di URL dashboard project
```

**Manual:**

```bash
supabase functions deploy api --no-verify-jwt
```

`--no-verify-jwt` penting: tanpa itu Supabase mewajibkan anon key di setiap
request, padahal otorisasi sudah diurus di dalam function.

Cek:

```bash
curl https://<project-ref>.supabase.co/functions/v1/api/health
# {"ok":true,"service":"srikandi-api","llm":true}
```

## 5. Sambungkan frontend

Di repo **frontend**, Settings → Secrets and variables → Actions → **Variables**:

```
SUPABASE_FUNCTIONS_URL = https://<project-ref>.supabase.co/functions/v1/api
```

Workflow build di sana menurunkan keempat `VITE_*_API` dari variabel itu. Kalau
dikosongkan, situs tetap ter-build dan jatuh ke data statis.

---

## Endpoint

Base URL: `https://<project-ref>.supabase.co/functions/v1/api`

| Method | Path            | Auth                    | Balasan                                     |
| ------ | --------------- | ----------------------- | ------------------------------------------- |
| GET    | `/gallery`      | –                       | `{ items: [...] }`                          |
| POST   | `/gallery`      | header `x-sales-key`    | `{ item }`                                  |
| POST   | `/auth/login`   | –                       | `{ token, customer }` / 401                 |
| GET    | `/my-orders`    | `Authorization: Bearer` | `{ orders: [...], customer }`               |
| POST   | `/bookings`     | –                       | `{ ok: true, id }`                          |
| POST   | `/consult`      | Bearer (opsional)       | `{ reply, functions, sources, escalate? }`  |
| GET    | `/health`       | –                       | status singkat                              |

Bentuk datanya mengikuti kontrak yang sudah dipakai frontend
(`src/config/gallery.js`, `orders.js`, `consultation.js`) — camelCase, bukan
nama kolom database.

Batas laju per IP: login 10×/10 menit, booking 8×/jam, konsultasi 30×/jam,
upload sales 30×/jam.

Token sesi konsumen berlaku 12 jam. Yang tersimpan di database hanya SHA-256
dari token, jadi isi tabel `sessions` bocor pun tidak bisa dipakai login.

## Asisten konsultasi

`/consult` memanggil Gemini dengan empat tool yang membaca database:

| Tool                | Gunanya                                                     |
| ------------------- | ----------------------------------------------------------- |
| `infoLayanan`       | daftar layanan toko                                          |
| `rekomendasiGaleri` | cari perhiasan (kata kunci, kategori, batas harga)           |
| `cekStatusPesanan`  | progres pesanan — butuh login, atau nama pemesan yang cocok  |
| `hubungiAdmin`      | eskalasi ke WhatsApp saat butuh manusia                      |

Kata kunci komplain/refund dicegat sebelum sampai ke LLM, jadi eskalasi tidak
membakar token. Input yang mengandung PII (nomor kartu, NIK, email, nomor HP)
ditolak dengan pesan, bukan diteruskan.

---

## Operasional harian

```sql
-- tambah konsumen + kode aksesnya
select public.upsert_customer('Nama Konsumen', '081234567890', '482915');

-- ganti kode akses
select public.set_customer_passcode('081234567890', '901233');

-- buat pesanan baru
insert into public.orders (order_number, customer_id, service_name, gold_purity, status, progress)
select public.next_order_number(), id, 'Cuci Emas', 75, 'Sedang Dikerjakan', 20
from public.customers where phone = '081234567890';

-- perbarui progres
update public.orders
   set progress = 80, status = 'Sedang Dikerjakan', updated_at = now()
 where order_number = 'SR-006-2026';

-- booking yang masuk
select created_at, customer_name, phone_number, service_name, status
from public.bookings order by created_at desc limit 50;

-- bersihkan sesi kedaluwarsa (jalankan berkala / pasang pg_cron)
select public.purge_expired();
```

## Catatan keamanan

- Kode akses di `supabase/seed.sql` tertulis terbuka. **Ganti atau hapus**
  sebelum dipakai sungguhan.
- Gerbang sales bersifat *shared secret* — cocok untuk beberapa staf, bukan
  pengganti akun per-orang. Kalau nanti perlu jejak siapa mengunggah apa,
  naikkan ke Supabase Auth dengan satu akun per sales.
- `service_role key` hanya hidup di Edge Function. Jangan pernah menaruhnya di
  variabel `VITE_*` — semua `VITE_*` ikut ter-bundle ke browser.
