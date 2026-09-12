// Utilitas bersama untuk Edge Function `api`.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';

const env = (k: string, fallback = '') => Deno.env.get(k) ?? fallback;

/** Origin yang boleh memanggil API. Set lewat secret ALLOWED_ORIGINS (dipisah koma). */
const ALLOWED_ORIGINS = env(
  'ALLOWED_ORIGINS',
  'https://bajoel32.github.io,http://localhost:5173,http://localhost:4173',
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allow = ALLOWED_ORIGINS.includes('*')
    ? '*'
    : ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0] ?? '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-sales-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export const fail = (req: Request, status: number, error: string) => json(req, { error }, status);

/** Klien service-role: melewati RLS. JANGAN pernah dikirim ke browser. */
export function admin(): SupabaseClient {
  const url = env('SUPABASE_URL') || env('SB_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY') || env('SB_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum tersedia');
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Perbandingan yang tidak bocor lewat waktu eksekusi. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function clientKey(req: Request, scope: string): string {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('cf-connecting-ip') ||
    'unknown';
  return `${scope}:${ip}`;
}

/** true = permintaan masih dalam kuota. */
export async function rateLimit(
  db: SupabaseClient,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const { data, error } = await db.rpc('bump_rate_limit', {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) return true; // jangan kunci pintu kalau tabel rate-limit bermasalah
  return data !== false;
}

export function normalizePhone(input: unknown): string {
  let p = String(input ?? '').replace(/[\s-]/g, '');
  if (p.startsWith('+62')) p = `0${p.slice(3)}`;
  else if (p.startsWith('62')) p = `0${p.slice(2)}`;
  return p;
}

export const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

/** Ambil sesi konsumen dari header Authorization: Bearer <token>. */
export async function sessionFromRequest(
  db: SupabaseClient,
  req: Request,
): Promise<{ id: number; name: string; phone: string } | null> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token || token.length < 20) return null;

  const hash = await sha256Hex(token);
  const { data } = await db
    .from('sessions')
    .select('customer_id, expires_at, customers ( id, name, phone, is_active )')
    .eq('token_hash', hash)
    .maybeSingle();

  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) {
    await db.from('sessions').delete().eq('token_hash', hash);
    return null;
  }
  const c = data.customers as unknown as { id: number; name: string; phone: string; is_active: boolean } | null;
  if (!c?.is_active) return null;

  await db.from('sessions').update({ last_used_at: new Date().toISOString() }).eq('token_hash', hash);
  return { id: c.id, name: c.name, phone: c.phone };
}

/** Bentuk item galeri seperti yang diharapkan frontend (camelCase). */
// deno-lint-ignore no-explicit-any
export function toGalleryItem(row: any) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    image: row.image,
    category: row.category,
    price: row.price === null ? undefined : Number(row.price),
    tags: row.tags ?? [],
    details: row.details ?? undefined,
    uploadedBy: row.uploaded_by,
    uploadedDate: row.uploaded_date,
  };
}

/** Bentuk pesanan seperti yang diharapkan OrderCard. */
// deno-lint-ignore no-explicit-any
export function toOrder(row: any) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    serviceName: row.service_name,
    goldPurity: row.gold_purity,
    progress: row.progress,
    status: row.status,
    createdDate: row.created_date,
  };
}
