// =============================================================================
// Edge Function tunggal `api` — backend Srikandi di atas Supabase.
//
//   GET  /api/gallery     -> { items: [...] }            (publik)
//   POST /api/gallery     -> { item }                    (header x-sales-key)
//   POST /api/auth/login  -> { token, customer }
//   GET  /api/my-orders   -> { orders: [...] }           (Authorization: Bearer)
//   POST /api/bookings    -> { ok: true, id }
//   POST /api/consult     -> { reply, functions, sources, escalate? }
//
// Deploy: supabase functions deploy api --no-verify-jwt
// (Tanpa --no-verify-jwt, browser wajib mengirim anon key di setiap request.)
// =============================================================================
import {
  admin, clientKey, corsHeaders, fail, json, normalizePhone, rateLimit,
  sessionFromRequest, sha256Hex, str, timingSafeEqual, toGalleryItem, toOrder,
} from './_shared.ts';
import { consult, hasLLM } from './consult.ts';

const SALES_KEY_SHA256 = Deno.env.get('SALES_KEY_SHA256') ?? '';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9()+\-\s]{7,20}$/;

// PII yang tidak boleh ditempel ke chat publik (cermin src/config/guardrails.js).
const PII = [
  { re: /\b\d{16}\b/, label: 'nomor 16 digit' },
  { re: /(?:\d[ -]?){13,19}/, label: 'nomor kartu' },
  { re: /[^\s@]+@[^\s@]+\.[^\s@]{2,}/, label: 'alamat email' },
  { re: /(?:\+?62|0)8\d[\d -]{6,}\d/, label: 'nomor HP' },
];

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1/, '').replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  const db = admin();

  try {
    /* ------------------------------------------------------------ galeri -- */
    if (path === '/gallery' && req.method === 'GET') {
      const { data, error } = await db
        .from('gallery')
        .select('*')
        .eq('is_published', true)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return json(req, { items: (data ?? []).map(toGalleryItem) });
    }

    if (path === '/gallery' && req.method === 'POST') {
      if (!SALES_KEY_SHA256) return fail(req, 503, 'Upload sales belum diaktifkan (SALES_KEY_SHA256 kosong).');

      const sent = (req.headers.get('x-sales-key') ?? '').trim().toLowerCase();
      const ok = sent.length === 64 && timingSafeEqual(await sha256Hex(sent), SALES_KEY_SHA256);
      if (!ok) return fail(req, 401, 'Kunci sales tidak valid.');

      if (!(await rateLimit(db, clientKey(req, 'gallery-post'), 30, 3600)))
        return fail(req, 429, 'Terlalu banyak upload. Coba lagi nanti.');

      const body = await readJson(req);
      const title = str(body.title, 120);
      const image = str(body.image, 2000);
      const category = str(body.category, 40);
      if (!title || !category) return fail(req, 400, 'Judul dan kategori wajib diisi.');
      if (!/^https?:\/\//.test(image)) return fail(req, 400, 'URL gambar harus diawali http(s)://');

      const priceRaw = Number(body.price);
      const tags = Array.isArray(body.tags)
        ? body.tags.map((t) => str(t, 30)).filter(Boolean).slice(0, 10)
        : [];

      const { data, error } = await db
        .from('gallery')
        .insert({
          title,
          description: str(body.description, 800),
          image,
          category,
          price: Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null,
          tags,
          details: body.details && typeof body.details === 'object' ? body.details : {},
          uploaded_by: str(body.uploadedBy, 80) || 'Tim Sales',
        })
        .select()
        .single();
      if (error) throw error;
      return json(req, { item: toGalleryItem(data) }, 201);
    }

    /* -------------------------------------------------------------- auth -- */
    if (path === '/auth/login' && req.method === 'POST') {
      if (!(await rateLimit(db, clientKey(req, 'login'), 10, 600)))
        return fail(req, 429, 'Terlalu banyak percobaan masuk. Coba lagi 10 menit lagi.');

      const body = await readJson(req);
      const phone = normalizePhone(body.phone);
      const password = str(body.password, 64);
      if (!phone || !password) return fail(req, 400, 'Nomor HP dan kata sandi wajib diisi.');

      const { data, error } = await db.rpc('verify_customer', { p_phone: phone, p_pass: password });
      if (error) throw error;
      const customer = Array.isArray(data) ? data[0] : data;
      if (!customer) return fail(req, 401, 'Nomor HP atau kata sandi salah.');

      const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
      const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      const { error: sErr } = await db.from('sessions').insert({
        token_hash: await sha256Hex(token),
        customer_id: customer.id,
        expires_at: expires,
      });
      if (sErr) throw sErr;

      return json(req, {
        token,
        customer: { id: customer.id, name: customer.name, phone: customer.phone },
      });
    }

    /* --------------------------------------------------------- pesanan --- */
    if (path === '/my-orders' && req.method === 'GET') {
      const session = await sessionFromRequest(db, req);
      if (!session) return fail(req, 401, 'Sesi berakhir. Silakan masuk kembali.');

      const { data, error } = await db
        .from('orders')
        .select('*')
        .eq('customer_id', session.id)
        .order('created_date', { ascending: false });
      if (error) throw error;
      return json(req, { orders: (data ?? []).map(toOrder), customer: session });
    }

    /* --------------------------------------------------------- booking --- */
    if (path === '/bookings' && req.method === 'POST') {
      if (!(await rateLimit(db, clientKey(req, 'booking'), 8, 3600)))
        return fail(req, 429, 'Terlalu banyak pengiriman. Coba lagi nanti.');

      const body = await readJson(req);
      if (str(body.website, 10)) return json(req, { ok: true }); // honeypot: pura-pura sukses

      const customerName = str(body.customerName, 100);
      const phoneNumber = str(body.phoneNumber, 20);
      const email = str(body.email, 150);
      const serviceId = Number(body.selectedService ?? body.serviceId);
      const quantity = Number(body.quantity ?? 1);

      if (!customerName) return fail(req, 400, 'Nama lengkap wajib diisi.');
      if (!PHONE_RE.test(phoneNumber)) return fail(req, 400, 'Nomor telepon tidak valid.');
      if (!EMAIL_RE.test(email)) return fail(req, 400, 'Alamat email tidak valid.');
      if (!Number.isInteger(serviceId)) return fail(req, 400, 'Layanan tidak valid.');
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100)
        return fail(req, 400, 'Jumlah item harus antara 1 dan 100.');

      const payment = str(body.preferredPayment, 20);
      const { data, error } = await db
        .from('bookings')
        .insert({
          customer_name: customerName,
          phone_number: phoneNumber,
          email,
          service_id: serviceId,
          service_name: str(body.serviceName, 80),
          service_details: str(body.serviceDetails, 1000),
          quantity,
          estimated_date: str(body.estimatedDate, 10) || null,
          notes: str(body.notes, 1000),
          preferred_payment: ['DP', 'Lunas', 'Cicilan'].includes(payment) ? payment : 'DP',
        })
        .select('id')
        .single();
      if (error) throw error;
      return json(req, { ok: true, id: data.id }, 201);
    }

    /* -------------------------------------------------------- konsultasi -- */
    if (path === '/consult' && req.method === 'POST') {
      if (!hasLLM()) return fail(req, 503, 'Asisten AI belum aktif (GEMINI_API_KEY belum diset).');
      if (!(await rateLimit(db, clientKey(req, 'consult'), 30, 3600)))
        return fail(req, 429, 'Kuota tanya-jawab tercapai. Coba lagi satu jam lagi.');

      const body = await readJson(req);
      const raw = Array.isArray(body.messages) ? body.messages : [];
      const history = raw
        .filter((m: unknown): m is { role: string; content: unknown } =>
          Boolean(m) && typeof m === 'object' && 'role' in (m as object))
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-20)
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: str(m.content, 1000) }))
        .filter((m) => m.content.length > 0);

      if (history.length === 0) return fail(req, 400, 'Pesan kosong.');

      const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
      const hit = PII.find((p) => p.re.test(lastUser));
      if (hit) {
        return json(req, {
          reply: `Demi keamanan, jangan bagikan ${hit.label} di chat ini. Untuk hal yang butuh data pribadi, hubungi kami lewat WhatsApp.`,
        });
      }

      const session = await sessionFromRequest(db, req);
      const result = await consult(db, session, history);

      await db.from('consult_logs').insert({
        customer_id: session?.id ?? null,
        question: lastUser.slice(0, 1000),
        answer: String(result.reply).slice(0, 2000),
        escalated: Boolean((result as { escalate?: unknown }).escalate),
      });

      return json(req, result);
    }

    /* ------------------------------------------------------------- misc -- */
    if (path === '/' || path === '/health') {
      return json(req, { ok: true, service: 'srikandi-api', llm: hasLLM() });
    }

    return fail(req, 404, 'Endpoint tidak ditemukan.');
  } catch (err) {
    console.error('api error', path, err);
    return fail(req, 500, 'Terjadi kesalahan di server.');
  }
});
