// Asisten konsultasi: RAG (dasar pengetahuan di knowledge_docs + galeri + layanan) + tool use.
//
// Backend LLM: Gemini API (generativelanguage.googleapis.com), endpoint
// `:generateContent`. Bentuk tool-nya beda dari Anthropic — `functionDeclarations`
// untuk deklarasi, `functionCall` di balasan model, `functionResponse` untuk
// mengirim hasil tool kembali.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { toGalleryItem } from './_shared.ts';
import { knowledgePrompt, retrieveKnowledge } from './knowledge.ts';

const API_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const MODEL = Deno.env.get('CONSULT_MODEL') ?? 'gemini-3.5-flash';
const WHATSAPP = Deno.env.get('WHATSAPP_URL') ?? 'https://wa.me/6281234567890';

const endpoint = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// Model Gemini berpikir dulu sebelum menjawab, dan token "thinking" itu ikut
// dihitung ke maxOutputTokens. Jadi plafonnya dilonggarkan; panjang jawaban
// tetap dijaga lewat instruksi "maksimal 4 kalimat" di SYSTEM.
const MAX_OUTPUT_TOKENS = 2048;

export const hasLLM = () => Boolean(API_KEY);

// Ketahanan saat Gemini sibuk (503 "high demand", 429 kuota, 5xx lain, timeout):
// coba ulang dengan jeda, lalu (opsional) pindah ke model cadangan. Kalau semua
// gagal, konsumen mendapat pesan jujur + tombol WhatsApp, bukan error 500 yang
// membuat frontend menampilkan jawaban statis yang tidak nyambung.
const FALLBACK_MODEL = Deno.env.get('CONSULT_FALLBACK_MODEL') ?? '';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [800, 2000];
const LLM_CALL_TIMEOUT_MS = 20_000;
const LLM_BUDGET_MS = 30_000; // batas total per panggilan, termasuk semua percobaan
const BUSY_REPLY =
  'Maaf, asisten kami sedang sibuk melayani banyak pertanyaan. ' +
  'Silakan coba lagi sebentar lagi, atau langsung hubungi admin kami lewat WhatsApp.';

class LLMUnavailableError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// deno-lint-ignore no-explicit-any
async function callGemini(body: string): Promise<any> {
  const models = FALLBACK_MODEL && FALLBACK_MODEL !== MODEL ? [MODEL, FALLBACK_MODEL] : [MODEL];
  const deadline = Date.now() + LLM_BUDGET_MS;
  let lastError = 'tidak ada percobaan';

  for (const model of models) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
      const remaining = deadline - Date.now();
      if (remaining < 1000) throw new LLMUnavailableError(`batas waktu habis; terakhir: ${lastError}`);

      let res: Response;
      try {
        res = await fetch(endpoint(model), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': API_KEY },
          body,
          signal: AbortSignal.timeout(Math.min(LLM_CALL_TIMEOUT_MS, remaining)),
        });
      } catch (err) {
        // Jaringan putus atau timeout: layak dicoba ulang.
        lastError = `${model}: ${err instanceof Error ? err.message : String(err)}`;
        console.warn(`[consult] ${lastError} (percobaan ${attempt + 1})`);
        continue;
      }

      if (res.ok) return await res.json();

      lastError = `${model} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
      console.warn(`[consult] ${lastError} (percobaan ${attempt + 1})`);
      // 400/401/403/404 tidak akan membaik dengan dicoba ulang; langsung ke model berikutnya.
      if (!RETRYABLE_STATUS.has(res.status)) break;
    }
  }
  throw new LLMUnavailableError(lastError);
}

const SERVICES = [
  { id: 1, name: 'Cuci Emas', icon: '✨', description: 'Pembersihan emas hingga bersih dan berkilau seperti baru' },
  { id: 2, name: 'Pasang Berlian', icon: '💎', description: 'Pemasangan berlian dan batu mulia dengan presisi tinggi' },
  { id: 3, name: 'Patri Emas', icon: '🔥', description: 'Penyambungan dan perbaikan emas menggunakan teknik patri profesional' },
  { id: 4, name: 'Chrome Putih', icon: '🩶', description: 'Pelapisan chrome putih untuk perhiasan dengan durabilitas maksimal' },
  { id: 6, name: 'Pemurnian Emas', icon: '⚗️', description: 'Pemurnian emas untuk menaikkan kadar dan memisahkan campuran logam lain' },
  { id: 5, name: 'Pesanan', icon: '💍', description: 'Buat perhiasan baru sesuai desain Anda' },
];

const ESCALATE_RE =
  /\b(admin|manusia|staf|staff|petugas|customer service|komplain|keluhan|refund|pengembalian dana|batalkan pesanan|ubah pesanan|ganti jadwal|rusak|bermasalah|bicara dengan)\b/i;

export function buildEscalation(reason: string, ringkasan?: string) {
  const text = encodeURIComponent(`Halo admin Srikandi, saya butuh bantuan.\n${ringkasan || reason}`);
  return {
    reason,
    channel: 'whatsapp' as const,
    contact: WHATSAPP ? `${WHATSAPP}${WHATSAPP.includes('?') ? '&' : '?'}text=${text}` : null,
  };
}

const SYSTEM = `Kamu "Asisten Srikandi", asisten toko emas & perhiasan Srikandi di Palangka Raya.

Aturan:
- Jawab dalam Bahasa Indonesia yang ramah, ringkas (maksimal 4 kalimat), tanpa emoji berlebihan.
- Jawab HANYA dari data yang kamu peroleh lewat tool, dari bagian "Dasar pengetahuan toko", atau yang tertulis di sini. Jangan mengarang harga, estimasi waktu, kadar, atau ketersediaan.
- Harga & lama pengerjaan layanan bersifat penawaran; selalu katakan dikonfirmasi staf setelah barang dilihat langsung.
- Untuk status pesanan, WAJIB pakai tool cekStatusPesanan. Jangan menebak.
- Status pesanan hanya untuk pengguna yang sudah masuk. Kalau belum masuk, minta pengguna masuk lewat portal pesanan di situs, atau tawarkan bantuan lewat WhatsApp.
- JANGAN PERNAH meminta nomor HP, kode akses, atau kata sandi di chat ini. Proses masuk hanya lewat halaman portal pesanan.
- Jangan pernah menyatakan sebuah nomor pesanan "ada" atau "tidak ditemukan". Bila pesanan bukan milik pengguna yang sedang masuk, cukup katakan nomor itu tidak ada pada akunnya.
- Jangan pernah meminta atau menampilkan data pribadi (NIK, nomor kartu, alamat lengkap) di chat.
- Jangan pernah memberikan nomor rekening. Pembayaran dan rekening hanya dikonfirmasi admin lewat WhatsApp resmi.
- Kalau pertanyaannya di luar cakupan toko, komplain, atau butuh tindakan admin (ubah/batalkan pesanan, refund), panggil tool hubungiAdmin.

Alamat toko: Jl. Sumatra, Pahandut, Kota Palangka Raya. Buka Senin–Sabtu 09.00–16.00, Minggu 10.00–16.00.`;

// Gemini: satu entri `tools` berisi daftar `functionDeclarations`.
// Fungsi tanpa argumen sengaja tidak menyertakan `parameters` sama sekali —
// schema object dengan properties kosong ditolak sebagian versi API.
const TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'infoLayanan',
        description: 'Daftar layanan yang tersedia di Srikandi beserta deskripsinya.',
      },
      {
        name: 'rekomendasiGaleri',
        description:
          'Cari perhiasan di galeri toko. Pakai saat pengguna minta rekomendasi, menanyakan koleksi, kategori, atau rentang harga.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Kata kunci bebas, mis. "cincin berlian"' },
            category: { type: 'string', description: 'Cincin | Kalung | Gelang | Anting | Liontin' },
            maxPrice: { type: 'number', description: 'Batas harga maksimum dalam rupiah' },
          },
        },
      },
      {
        name: 'cekStatusPesanan',
        description:
          'Cek progres pesanan milik pengguna yang sedang masuk, berdasarkan nomor pesanan (format SR-001-2026). Hanya melayani pengguna yang sudah masuk; tidak ada cara memverifikasi lewat chat. Tool ini tidak pernah memberi tahu apakah sebuah nomor pesanan terdaftar atau tidak.',
        parameters: {
          type: 'object',
          properties: {
            orderNumber: { type: 'string' },
          },
          required: ['orderNumber'],
        },
      },
      {
        name: 'hubungiAdmin',
        description: 'Panggil bila pengguna butuh admin/manusia: komplain, refund, ubah atau batalkan pesanan, di luar cakupan.',
        parameters: {
          type: 'object',
          properties: { alasan: { type: 'string' } },
          required: ['alasan'],
        },
      },
    ],
  },
];

type Session = { id: number; name: string; phone: string } | null;
type FnCard = { name: string; label: string; data: unknown };
// deno-lint-ignore no-explicit-any
type Part = Record<string, any>;

async function runTool(
  db: SupabaseClient,
  session: Session,
  name: string,
  input: Record<string, unknown>,
): Promise<{ result: unknown; card: FnCard | null; source?: { title: string; snippet?: string } }> {
  if (name === 'infoLayanan') {
    return {
      result: SERVICES,
      card: { name: 'infoLayanan', label: 'Layanan Srikandi', data: SERVICES },
      source: { title: 'Daftar layanan Srikandi', snippet: `${SERVICES.length} layanan aktif` },
    };
  }

  if (name === 'rekomendasiGaleri') {
    let q = db.from('gallery').select('*').eq('is_published', true).limit(6);
    if (typeof input.category === 'string' && input.category) q = q.ilike('category', input.category);
    if (typeof input.maxPrice === 'number') q = q.lte('price', input.maxPrice);
    if (typeof input.query === 'string' && input.query.trim()) {
      const term = input.query.trim().replace(/[%,]/g, ' ');
      q = q.or(`title.ilike.%${term}%,description.ilike.%${term}%`);
    }
    const { data } = await q;
    const items = (data ?? []).map(toGalleryItem);
    return {
      result: items.map((i) => ({ title: i.title, category: i.category, price: i.price, tags: i.tags })),
      card: items.length ? { name: 'rekomendasiGaleri', label: 'Dari Galeri', data: items } : null,
      source: { title: 'Katalog galeri Srikandi', snippet: `${items.length} item cocok` },
    };
  }

  if (name === 'cekStatusPesanan') {
    const orderNumber = String(input.orderNumber ?? '').toUpperCase().trim();

    // Status pesanan hanya untuk sesi yang sudah masuk. Verifikasi lewat chat
    // (nama, apalagi nomor HP) tidak dipakai: nomor HP justru diblokir filter
    // PII di index.ts sebelum sampai ke sini, dan nama pemesan terlalu mudah
    // ditebak untuk dijadikan kunci.
    if (!session) {
      const data = { needLogin: true };
      return { result: data, card: { name: 'cekStatusPesanan', label: 'Status Pesanan', data } };
    }

    // Satu balasan penolakan untuk SEMUA kegagalan: nomor tidak terdaftar,
    // format ngawur, atau pesanan milik akun lain. Kalau "tidak ditemukan"
    // dibedakan dari "bukan milikmu", nomor pesanan bisa disisir SR-001 s/d
    // SR-999 untuk memetakan isi tabel orders.
    const denied = () => {
      const data = { notYours: true, orderNumber };
      return { result: data, card: { name: 'cekStatusPesanan', label: 'Status Pesanan', data } };
    };

    // Format divalidasi lebih dulu supaya tebakan asal tidak menyentuh database.
    if (!/^SR-\d{3}-\d{4}$/.test(orderNumber)) return denied();

    // Difilter langsung ke customer_id sesi: pesanan milik orang lain tidak
    // pernah terbaca, bukan sekadar tidak ditampilkan.
    const { data: order } = await db
      .from('orders')
      .select('order_number, service_name, status, progress, gold_purity, customer_id')
      .eq('order_number', orderNumber)
      .eq('customer_id', session.id)
      .maybeSingle();

    if (!order) return denied();

    const data = {
      orderNumber: order.order_number,
      customerName: session.name,
      serviceName: order.service_name,
      status: order.status,
      progress: order.progress,
      goldPurity: order.gold_purity,
    };
    return {
      result: data,
      card: { name: 'cekStatusPesanan', label: 'Status Pesanan', data },
      source: { title: `Pesanan ${order.order_number}`, snippet: `${order.status} — ${order.progress}%` },
    };
  }

  if (name === 'hubungiAdmin') {
    return { result: { escalate: true }, card: null };
  }

  return { result: { error: 'tool tidak dikenal' }, card: null };
}

export async function consult(
  db: SupabaseClient,
  session: Session,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
) {
  const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';

  // Eskalasi cepat — tidak perlu membakar token LLM untuk ini.
  if (ESCALATE_RE.test(lastUser)) {
    return {
      reply:
        'Untuk hal ini Anda perlu terhubung langsung dengan admin kami. ' +
        'Silakan lanjutkan lewat WhatsApp — tim kami akan membantu.',
      escalate: buildEscalation('Perlu tindakan admin', lastUser.slice(0, 200)),
    };
  }

  // Gemini memakai role 'model' untuk balasan asisten, dan giliran pertama
  // wajib dari 'user' — pesan asisten yang menggantung di depan dibuang.
  const contents: Array<{ role: 'user' | 'model'; parts: Part[] }> = [];
  for (const m of history) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (contents.length === 0 && role === 'model') continue;
    contents.push({ role, parts: [{ text: m.content }] });
  }
  if (contents.length === 0) {
    return { reply: 'Maaf, saya belum bisa menjawab itu. Boleh dijelaskan lebih spesifik?' };
  }

  const cards: FnCard[] = [];
  const sources: Array<{ title: string; snippet?: string }> = [];
  let escalate: ReturnType<typeof buildEscalation> | undefined;
  let reply = '';
  let llmDown = false;

  // RAG: ambil dokumen dasar pengetahuan yang paling mirip. Dua pesan pengguna
  // terakhir digabung supaya balasan pendek ("yang putih ada?") tetap punya konteks.
  const recentUser = history
    .filter((m) => m.role === 'user')
    .slice(-2)
    .map((m) => m.content)
    .join('\n');
  const knowledge = await retrieveKnowledge(db, recentUser);
  for (const d of knowledge) {
    sources.push({ title: d.title, snippet: `kemiripan ${d.similarity.toFixed(2)}` });
  }
  const systemText = [
    SYSTEM,
    session ? `Pengguna sudah login sebagai ${session.name}.` : '',
    knowledgePrompt(knowledge),
  ]
    .filter(Boolean)
    .join('\n\n');

  for (let round = 0; round < 3; round++) {
    // deno-lint-ignore no-explicit-any
    let data: any;
    try {
      data = await callGemini(
        JSON.stringify({
          contents,
          systemInstruction: {
            parts: [{ text: systemText }],
          },
          tools: TOOLS,
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.4 },
        }),
      );
    } catch (err) {
      if (!(err instanceof LLMUnavailableError)) throw err;
      console.error('[consult] LLM tidak tersedia:', err.message);
      llmDown = true;
      break;
    }

    const candidate = data.candidates?.[0];
    const parts: Part[] = candidate?.content?.parts ?? [];

    const text = parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n')
      .trim();
    if (text) reply = text;

    const calls = parts
      .filter((p) => p.functionCall)
      .map((p) => p.functionCall as { name: string; args?: Record<string, unknown> });
    if (calls.length === 0) break;

    // Giliran model (berisi functionCall) harus ikut dikirim balik apa adanya.
    contents.push({ role: 'model', parts });

    const responses: Part[] = [];
    for (const call of calls) {
      const { result, card, source } = await runTool(db, session, call.name, call.args ?? {});
      if (card) cards.push(card);
      if (source) sources.push(source);
      if (call.name === 'hubungiAdmin') {
        escalate = buildEscalation(String(call.args?.alasan ?? 'Perlu tindakan admin'), lastUser.slice(0, 200));
      }
      // functionResponse.response wajib berupa objek, jadi hasil dibungkus.
      responses.push({ functionResponse: { name: call.name, response: { result } } });
    }
    contents.push({ role: 'user', parts: responses });
  }

  if (llmDown && !reply) {
    reply = BUSY_REPLY;
    escalate ??= buildEscalation('Asisten AI sedang sibuk', lastUser.slice(0, 200));
  }

  return {
    reply: reply || 'Maaf, saya belum bisa menjawab itu. Boleh dijelaskan lebih spesifik?',
    functions: cards,
    sources,
    ...(escalate ? { escalate } : {}),
  };
}
