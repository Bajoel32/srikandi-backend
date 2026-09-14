#!/usr/bin/env node
// =============================================================================
// Eval harness asisten konsultasi Srikandi.
//
//   node eval/run.mjs                      # cek berbasis aturan saja
//   node eval/run.mjs --judge              # + skor groundedness lewat LLM
//   node eval/run.mjs --only=auth-         # jalankan sebagian kasus
//
// Wajib: SRIKANDI_API  = https://<project-ref>.supabase.co/functions/v1/api
// Untuk --judge:       GEMINI_API_KEY (boleh key yang sama dengan backend)
//
// Tidak ada dependency. Butuh Node 18+ (fetch bawaan).
//
// CATATAN: harness ini memanggil endpoint produksi. Setiap kasus = satu
// panggilan Gemini sungguhan dan satu baris di consult_logs. Di free tier
// kuotanya tipis, karena itu ada jeda antar-kasus dan retry saat 429.
// =============================================================================

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const API = process.env.SRIKANDI_API || args.api;
const DELAY_MS = Number(args.delay ?? 4000);
const RETRIES = Number(args.retries ?? 2);
const JUDGE_MODEL = process.env.GEMINI_JUDGE_MODEL || 'gemini-3.5-flash';
const USE_JUDGE = Boolean(args.judge);

if (!API) {
  console.error('SRIKANDI_API belum diset. Contoh:\n' +
    '  SRIKANDI_API=https://<project-ref>.supabase.co/functions/v1/api node eval/run.mjs');
  process.exit(2);
}
if (USE_JUDGE && !process.env.GEMINI_API_KEY) {
  console.error('--judge butuh GEMINI_API_KEY.');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Satu giliran tanya ke /consult, dengan retry khusus 429. */
async function ask(question) {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const res = await fetch(`${API}/consult`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 200) }; }

    // 503 = ANTHROPIC/GEMINI key belum diset; 500 sering berarti 429 dari Gemini
    // yang tertelan error handler. Keduanya layak dicoba ulang sekali dua kali.
    const retryable = res.status === 429 || res.status === 500 || res.status === 503;
    if (!retryable || attempt === RETRIES) return { status: res.status, body };

    const backoff = DELAY_MS * (attempt + 2);
    process.stdout.write(`  (HTTP ${res.status}, tunggu ${backoff}ms lalu ulangi) `);
    await sleep(backoff);
  }
}

const sentences = (s) =>
  String(s || '').split(/[.!?]+(?:\s|$)/).map((x) => x.trim()).filter(Boolean).length;

const toolNames = (body) => (body?.functions || []).map((f) => f.name).sort();

/** Cek berbasis aturan — murah, deterministik, tidak memanggil LLM. */
function ruleChecks(c, status, body) {
  const out = [];
  const reply = String(body?.reply ?? '');
  const add = (name, ok, detail) => out.push({ name, ok, detail });

  if (c.expectPiiBlock) {
    add('pii-diblokir', /jangan bagikan/i.test(reply), reply.slice(0, 120));
    return out; // jalur PII berhenti sebelum tool, cek lain tidak relevan
  }

  add('http-200', status === 200, `HTTP ${status}${body?.error ? ` — ${body.error}` : ''}`);
  if (status !== 200) return out;

  add('reply-tidak-kosong', reply.trim().length > 0, `${reply.length} char`);

  if (Array.isArray(c.expectTools)) {
    const got = toolNames(body);
    const want = [...c.expectTools].sort();
    add('tool-sesuai', JSON.stringify(got) === JSON.stringify(want),
      `dipanggil [${got.join(', ')}], diharapkan [${want.join(', ')}]`);
  }

  for (const t of c.forbidTools || []) {
    add(`tool-dilarang:${t}`, !toolNames(body).includes(t), '');
  }

  if (c.expectToolData) {
    for (const [tool, want] of Object.entries(c.expectToolData)) {
      const fn = (body.functions || []).find((f) => f.name === tool);
      const data = fn?.data ?? {};
      const ok = Object.entries(want).every(([k, v]) => data[k] === v);
      add(`data-tool:${tool}`, ok, JSON.stringify(data).slice(0, 140));
    }
  }

  if (c.expectEscalate !== undefined) {
    add('eskalasi', Boolean(body.escalate) === c.expectEscalate,
      body.escalate ? 'ada escalate' : 'tidak ada escalate');
  }

  for (const s of c.mustInclude || []) {
    add(`memuat:${s}`, reply.toLowerCase().includes(String(s).toLowerCase()), '');
  }
  if (c.mustIncludeAny) {
    const ok = c.mustIncludeAny.some((s) => reply.toLowerCase().includes(String(s).toLowerCase()));
    add(`memuat-salah-satu:${c.mustIncludeAny.join('|')}`, ok, reply.slice(0, 120));
  }
  for (const s of c.mustNotInclude || []) {
    add(`tanpa:${s}`, !reply.toLowerCase().includes(String(s).toLowerCase()), '');
  }
  for (const re of c.mustNotMatch || []) {
    const rx = new RegExp(re, 'i');
    const hit = rx.exec(reply);
    add(`tanpa-pola:${re}`, !hit, hit ? `cocok "${hit[0]}"` : '');
  }
  if (c.maxSentences) {
    const n = sentences(reply);
    add('panjang-jawaban', n <= c.maxSentences, `${n} kalimat (maks ${c.maxSentences})`);
  }

  return out;
}

/**
 * Groundedness: apakah jawaban hanya memakai fakta dari hasil tool + fakta toko
 * yang sudah disepakati? Ini yang menangkap halusinasi harga, kadar, dan stok —
 * hal yang tidak bisa ditangkap regex.
 */
async function judgeGrounded(facts, c, body) {
  const evidence = JSON.stringify((body.functions || []).map((f) => ({ tool: f.name, data: f.data })));
  const prompt =
    `Kamu penilai yang ketat. Tentukan apakah JAWABAN hanya memuat klaim yang didukung BUKTI atau FAKTA TOKO.\n` +
    `Klaim yang tidak didukung (harga, berat, kadar, stok, estimasi waktu, janji pengiriman) = tidak grounded.\n` +
    `Mengatakan sesuatu perlu dikonfirmasi staf, atau mengarahkan ke WhatsApp/portal, TIDAK dihitung klaim.\n\n` +
    `FAKTA TOKO:\n${facts.map((f) => `- ${f}`).join('\n')}\n\n` +
    `PERTANYAAN: ${c.ask}\n\nBUKTI (hasil tool): ${evidence || '[]'}\n\nJAWABAN: ${body.reply}\n\n` +
    `Balas HANYA JSON: {"grounded": true|false, "reason": "<satu kalimat>"}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${JUDGE_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 2048, temperature: 0 },
      }),
    },
  );
  if (!res.ok) return { ok: null, detail: `judge HTTP ${res.status}` };

  const data = await res.json();
  const raw = (data.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => typeof p.text === 'string').map((p) => p.text).join('');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { ok: null, detail: 'judge tidak mengembalikan JSON' };
  try {
    const v = JSON.parse(m[0]);
    return { ok: Boolean(v.grounded), detail: String(v.reason || '').slice(0, 160) };
  } catch {
    return { ok: null, detail: 'judge JSON tidak terbaca' };
  }
}

// ----------------------------------------------------------------- jalankan --
const suite = JSON.parse(await readFile(join(HERE, 'cases.json'), 'utf8'));
const cases = suite.cases.filter((c) => !args.only || c.id.includes(String(args.only)));

console.log(`\nSrikandi eval — ${cases.length} kasus → ${API}`);
console.log(`judge: ${USE_JUDGE ? JUDGE_MODEL : 'mati'} · jeda ${DELAY_MS}ms\n`);

const results = [];
for (const [i, c] of cases.entries()) {
  process.stdout.write(`[${i + 1}/${cases.length}] ${c.id} … `);
  const { status, body } = await ask(c.ask);
  const checks = ruleChecks(c, status, body);

  if (USE_JUDGE && c.judge && status === 200) {
    await sleep(DELAY_MS);
    const g = await judgeGrounded(suite.facts, c, body);
    checks.push({ name: 'groundedness', ok: g.ok, detail: g.detail });
  }

  const hard = checks.filter((k) => k.ok !== null);
  const pass = hard.length > 0 && hard.every((k) => k.ok);
  results.push({ id: c.id, dimension: c.dimension, ask: c.ask, status, pass, checks, reply: body?.reply ?? '' });
  console.log(pass ? 'LULUS' : 'GAGAL');
  for (const k of checks.filter((k) => k.ok === false)) console.log(`      ✗ ${k.name} ${k.detail}`);
  for (const k of checks.filter((k) => k.ok === null)) console.log(`      ? ${k.name} ${k.detail}`);

  if (i < cases.length - 1) await sleep(DELAY_MS);
}

// -------------------------------------------------------------------- hasil --
const byDim = {};
for (const r of results) {
  byDim[r.dimension] ??= { total: 0, pass: 0 };
  byDim[r.dimension].total++;
  if (r.pass) byDim[r.dimension].pass++;
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${'='.repeat(52)}`);
console.log(`Total: ${passed}/${results.length} lulus\n`);
for (const [dim, v] of Object.entries(byDim)) {
  console.log(`  ${dim.padEnd(12)} ${String(v.pass).padStart(2)}/${v.total}`);
}
const failed = results.filter((r) => !r.pass);
if (failed.length) console.log(`\nGagal: ${failed.map((r) => r.id).join(', ')}`);

const outPath = join(HERE, String(args.out ?? 'report.json'));
await writeFile(outPath, JSON.stringify(
  { ranAt: new Date().toISOString(), api: API, judge: USE_JUDGE ? JUDGE_MODEL : null, byDim, results },
  null, 2,
));
console.log(`\nLaporan lengkap: ${outPath}\n`);

process.exit(failed.length ? 1 : 0);
