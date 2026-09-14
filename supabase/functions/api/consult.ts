// Asisten konsultasi: RAG ringan (galeri + layanan dari database) + tool use.
//
// Backend LLM: Gemini API (generativelanguage.googleapis.com), endpoint
// `:generateContent`. Bentuk tool-nya beda dari Anthropic — `functionDeclarations`
// untuk deklarasi, `functionCall` di balasan model, `functionResponse` untuk
// mengirim hasil tool kembali.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { toGalleryItem } from './_shared.ts';

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
- Jawab HANYA dari data yang kamu peroleh lewat tool atau yang tertulis di sini. Jangan mengarang harga, estimasi waktu, kadar, atau ketersediaan.
- Harga & lama pengerjaan layanan bersifat penawaran; selalu katakan dikonfirmasi staf setelah barang dilihat langsung.
- Untuk status pesanan, WAJIB pakai tool cekStatusPesanan. Jangan menebak.
- Kalau pengguna belum login, minta nama pemesan DULU sebelum memanggil cekStatusPesanan.
- Jangan pernah menyatakan sebuah nomor pesanan "ada" atau "tidak ditemukan". Bila verifikasi gagal, katakan nomor pesanan atau nama pemesan tidak cocok, lalu tawarkan bantuan lewat WhatsApp.
- Jangan pernah meminta atau menampilkan data pribadi (NIK, nomor kartu, alamat lengkap) di chat.
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
          'Cek progres pesanan berdasarkan nomor pesanan (format SR-001-2026). Jika pengguna belum login, nama pemesan WAJIB disertakan — jangan panggil tool ini tanpa nama. Tool ini tidak pernah memberi tahu apakah sebuah nomor pesanan terdaftar atau tidak.',
        parameters: {
          type: 'object',
          properties: {
            orderNumber: { type: 'string' },
            customerName: { type: 'string', description: 'Nama pemesan, untuk verifikasi bila belum login' },
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

    // Satu balasan penolakan untuk SEMUA kegagalan: nomor tidak terdaftar,
    // format ngawur, nama tidak cocok, atau pesanan milik orang lain. Kalau
    // "tidak ditemukan" dibedakan dari "perlu verifikasi", nomor pesanan bisa
    // disisir SR-001 s/d SR-999 untuk memetakan isi tabel orders.
    const denied = () => {
      const data = session
        ? { notYours: true, orderNumber }
        : { needVerification: true, orderNumber };
      return { result: data, card: { name: 'cekStatusPesanan', label: 'Status Pesanan', data } };
    };

    // Format divalidasi lebih dulu supaya tebakan asal tidak menyentuh database.
    if (!/^SR-\d{3}-\d{4}$/.test(orderNumber)) return denied();

    const { data: order } = await db
      .from('orders')
      .select('order_number, service_name, status, progress, gold_purity, customer_id, customers ( name )')
      .eq('order_number', orderNumber)
      .maybeSingle();

    const customerName = (order?.customers as unknown as { name: string } | null)?.name ?? '';
    const loggedInOwner = Boolean(order && session && session.id === order.customer_id);
    const normalizeName = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
    const claimed = normalizeName(String(input.customerName ?? ''));
    const nameOk = Boolean(order) && claimed.length > 2 && claimed === normalizeName(customerName);

    if (!order || (!loggedInOwner && !nameOk)) return denied();

    const data = {
      orderNumber: order.order_number,
      customerName,
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

  for (let round = 0; round < 3; round++) {
    const res = await fetch(endpoint(MODEL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': API_KEY,
      },
      body: JSON.stringify({
        contents,
        systemInstruction: {
          parts: [{ text: session ? `${SYSTEM}\n\nPengguna sudah login sebagai ${session.name}.` : SYSTEM }],
        },
        tools: TOOLS,
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.4 },
      }),
    });

    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();

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

  return {
    reply: reply || 'Maaf, saya belum bisa menjawab itu. Boleh dijelaskan lebih spesifik?',
    functions: cards,
    sources,
    ...(escalate ? { escalate } : {}),
  };
}
