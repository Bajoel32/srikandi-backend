// Asisten konsultasi: RAG ringan (galeri + layanan dari database) + tool use.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { toGalleryItem } from './_shared.ts';

const API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const MODEL = Deno.env.get('CONSULT_MODEL') ?? 'claude-sonnet-4-5';
const WHATSAPP = Deno.env.get('WHATSAPP_URL') ?? 'https://wa.me/6281234567890';

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
- Jangan pernah meminta atau menampilkan data pribadi (NIK, nomor kartu, alamat lengkap) di chat.
- Kalau pertanyaannya di luar cakupan toko, komplain, atau butuh tindakan admin (ubah/batalkan pesanan, refund), panggil tool hubungiAdmin.

Alamat toko: Jl. Sumatra, Pahandut, Kota Palangka Raya. Buka Senin–Sabtu 09.00–16.00, Minggu 10.00–16.00.`;

const TOOLS = [
  {
    name: 'infoLayanan',
    description: 'Daftar layanan yang tersedia di Srikandi beserta deskripsinya.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'rekomendasiGaleri',
    description:
      'Cari perhiasan di galeri toko. Pakai saat pengguna minta rekomendasi, menanyakan koleksi, kategori, atau rentang harga.',
    input_schema: {
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
      'Cek progres pesanan berdasarkan nomor pesanan (format SR-001-2026). Jika pengguna belum login, nama pemesan wajib disebutkan untuk verifikasi.',
    input_schema: {
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
    input_schema: {
      type: 'object',
      properties: { alasan: { type: 'string' } },
      required: ['alasan'],
    },
  },
];

type Session = { id: number; name: string; phone: string } | null;
type FnCard = { name: string; label: string; data: unknown };

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
    const { data: order } = await db
      .from('orders')
      .select('order_number, service_name, status, progress, gold_purity, customer_id, customers ( name )')
      .eq('order_number', orderNumber)
      .maybeSingle();

    if (!order) {
      return {
        result: { notFound: true, orderNumber },
        card: { name: 'cekStatusPesanan', label: 'Status Pesanan', data: { notFound: true, orderNumber } },
      };
    }

    const customerName = (order.customers as unknown as { name: string } | null)?.name ?? '';
    const loggedInOwner = session && session.id === order.customer_id;
    const claimed = String(input.customerName ?? '').toLowerCase().trim();
    const nameOk =
      claimed.length > 2 && customerName.toLowerCase().split(' ').every((t) => claimed.includes(t));

    if (!loggedInOwner && !nameOk) {
      const data = { needVerification: true, orderNumber };
      return {
        result: data,
        card: { name: 'cekStatusPesanan', label: 'Status Pesanan', data },
      };
    }

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

  // deno-lint-ignore no-explicit-any
  const messages: any[] = history.map((m) => ({ role: m.role, content: m.content }));
  const cards: FnCard[] = [];
  const sources: Array<{ title: string; snippet?: string }> = [];
  let escalate: ReturnType<typeof buildEscalation> | undefined;
  let reply = '';

  for (let round = 0; round < 3; round++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: session ? `${SYSTEM}\n\nPengguna sudah login sebagai ${session.name}.` : SYSTEM,
        tools: TOOLS,
        messages,
      }),
    });

    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();

    reply = (data.content ?? [])
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('\n')
      .trim();

    const toolUses = (data.content ?? []).filter((b: { type: string }) => b.type === 'tool_use');
    if (data.stop_reason !== 'tool_use' || toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: data.content });

    const results = [];
    for (const tu of toolUses) {
      const { result, card, source } = await runTool(db, session, tu.name, tu.input ?? {});
      if (card) cards.push(card);
      if (source) sources.push(source);
      if (tu.name === 'hubungiAdmin') {
        escalate = buildEscalation(String(tu.input?.alasan ?? 'Perlu tindakan admin'), lastUser.slice(0, 200));
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: results });
  }

  return {
    reply: reply || 'Maaf, saya belum bisa menjawab itu. Boleh dijelaskan lebih spesifik?',
    functions: cards,
    sources,
    ...(escalate ? { escalate } : {}),
  };
}
