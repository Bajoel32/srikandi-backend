#!/usr/bin/env node
// =============================================================================
// Eval OFFLINE asisten konsultasi Srikandi — deterministik, gratis, tanpa jaringan.
//
//   node --experimental-strip-types eval/offline.mjs
//   node --experimental-strip-types eval/offline.mjs --only=res-
//   node --experimental-strip-types eval/offline.mjs --target=/tmp/consult.lama.ts --out=offline-before.json
//
// Butuh Node 22.6+ (flag --experimental-strip-types untuk memuat .ts langsung).
//
// Pasangan dari eval/run.mjs. run.mjs mengukur perilaku MODEL di produksi;
// file ini mengukur perilaku KODE di sekitar model — hal yang tidak bisa diuji
// terhadap produksi karena kita tidak bisa menyuruh Gemini gagal sesuai jadwal:
//
//   resilience  503/429/5xx/jaringan putus → coba ulang, model cadangan, pesan sibuk
//   rag         dokumen knowledge_docs benar-benar masuk ke system prompt
//   guardrail   eskalasi cepat tidak membakar token; aturan rekening ada di prompt
//   tool-loop   functionCall → functionResponse → jawaban, kartu tool terbentuk
//
// Gemini, endpoint embedding, dan Supabase diganti tiruan. consult.ts dan
// knowledge.ts disalin ke folder sementara bersama _shared.ts tiruan, karena
// _shared.ts asli mengimpor klien Supabase dari https://esm.sh yang tidak bisa
// dimuat Node.
//
// --target menunjuk consult.ts lain (mis. versi sebelum patch) untuk
// membuktikan kasus resilience memang menangkap bug-nya.
// =============================================================================

import { cp, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(HERE, '..', 'supabase', 'functions', 'api');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const TARGET = resolve(String(args.target ?? join(API_DIR, 'consult.ts')));

// ------------------------------------------------------------ lingkungan tiruan
const env = {};
globalThis.Deno = { env: { get: (k) => env[k] } };

const world = {
  llm: [], // antrean respons generateContent: 200 | status | 'throw' | {functionCall}
  llmCalls: [], // { model, body }
  embedStatus: 200,
  embedCalls: [],
  rpcCalls: [],
  rpcDocs: [],
};

function resetWorld() {
  world.llm = [];
  world.llmCalls = [];
  world.embedStatus = 200;
  world.embedCalls = [];
  world.rpcCalls = [];
  world.rpcDocs = [];
  for (const k of Object.keys(env)) delete env[k];
  env.GEMINI_API_KEY = 'test-key';
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : {};
  if (u.includes(':embedContent')) {
    world.embedCalls.push(body);
    if (world.embedStatus !== 200) return new Response('{"error":"embed down"}', { status: world.embedStatus });
    return Response.json({ embedding: { values: Array.from({ length: 1536 }, (_, i) => (i % 7) + 1) } });
  }
  if (u.includes(':generateContent')) {
    const model = u.match(/models\/([^:]+):/)[1];
    world.llmCalls.push({ model, body });
    const step = world.llm.length ? world.llm.shift() : 200;
    if (step === 'throw') throw new TypeError('fetch failed (jaringan putus)');
    if (typeof step === 'number' && step !== 200) {
      return new Response(JSON.stringify({ error: { code: step, message: 'simulated' } }), { status: step });
    }
    if (typeof step === 'object') {
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ functionCall: step.functionCall }] } }] });
    }
    return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: `Jawaban dari ${model}.` }] } }] });
  }
  throw new Error(`fetch tak terduga ke ${u}`);
};

// Query builder Supabase tiruan: bisa dirantai dan di-await.
function queryBuilder(rows) {
  const q = {
    select: () => q, eq: () => q, limit: () => q, ilike: () => q, lte: () => q, or: () => q,
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej),
  };
  return q;
}
const db = {
  rpc: async (name, params) => {
    world.rpcCalls.push({ name, params });
    return { data: world.rpcDocs, error: null };
  },
  from: (table) => queryBuilder(table === 'gallery'
    ? [{ title: 'Cincin Couple Emas', category: 'Cincin', price: 4200000, tags: [] }]
    : []),
};

// Salin kode ke folder sementara dengan _shared.ts tiruan.
const WORK = await mkdtemp(join(tmpdir(), 'srikandi-offline-'));
await cp(TARGET, join(WORK, 'consult.ts'));
await cp(join(API_DIR, 'knowledge.ts'), join(WORK, 'knowledge.ts'));
await writeFile(join(WORK, '_shared.ts'), 'export const toGalleryItem = (row: any) => row;\n');

let importSeq = 0;
async function loadConsult() {
  // Query string unik = instance modul baru, supaya env (mis. CONSULT_FALLBACK_MODEL)
  // yang dibaca saat import ikut berganti per kasus.
  const url = `${pathToFileURL(join(WORK, 'consult.ts')).href}?case=${++importSeq}`;
  return import(url);
}

const quiet = { warn: console.warn, error: console.error };
const logs = [];
console.warn = (...a) => logs.push(['warn', a.join(' ')]);
console.error = (...a) => logs.push(['error', a.join(' ')]);

const user = (content) => [{ role: 'user', content }];
const sysText = (call) => call?.body?.systemInstruction?.parts?.[0]?.text ?? '';
const hasBusyReply = (r) => /sibuk/i.test(r?.reply ?? '');

// ------------------------------------------------------------------- kasus --
// Setiap kasus: setup(world, env) → jalankan consult → daftar cek {name, ok, detail}.
const CASES = [
  {
    id: 'res-normal', dimension: 'resilience',
    desc: 'Gemini sehat: satu panggilan, langsung menjawab',
    history: user('jam buka toko kapan?'),
    setup: () => { world.llm = [200]; },
    checks: (r) => [
      ['tidak-melempar-error', !r.thrown, r.thrown],
      ['satu-panggilan-llm', world.llmCalls.length === 1, `${world.llmCalls.length} panggilan`],
      ['tanpa-eskalasi', !r.value?.escalate, ''],
    ],
  },
  {
    id: 'res-503-pulih', dimension: 'resilience',
    desc: '503 dua kali lalu pulih — insiden 16 Sep 2026',
    history: user('ukuran cincin saya gak tahu'),
    setup: () => { world.llm = [503, 503, 200]; },
    checks: (r) => [
      ['tidak-melempar-error', !r.thrown, r.thrown],
      ['menjawab-normal', !hasBusyReply(r.value) && /Jawaban dari/.test(r.value?.reply ?? ''), r.value?.reply],
      ['tiga-percobaan', world.llmCalls.length === 3, `${world.llmCalls.length} panggilan`],
    ],
  },
  {
    id: 'res-503-habis', dimension: 'resilience',
    desc: '503 terus-menerus tanpa model cadangan: pesan sibuk + WhatsApp, bukan HTTP 500',
    history: user('ukuran cincin saya gak tahu'),
    setup: () => { world.llm = [503, 503, 503, 503]; },
    checks: (r) => [
      ['tidak-melempar-error', !r.thrown, r.thrown],
      ['pesan-sibuk', hasBusyReply(r.value), r.value?.reply],
      ['eskalasi-whatsapp', r.value?.escalate?.channel === 'whatsapp', JSON.stringify(r.value?.escalate ?? null).slice(0, 80)],
      ['maks-tiga-percobaan', world.llmCalls.length === 3, `${world.llmCalls.length} panggilan`],
      ['error-tercatat-di-log', logs.some(([lvl, m]) => lvl === 'error' && /503/.test(m)), ''],
    ],
  },
  {
    id: 'res-fallback-model', dimension: 'resilience',
    desc: 'Model utama 503 terus, CONSULT_FALLBACK_MODEL menjawab',
    history: user('bisa bikin liontin nama?'),
    setup: () => { env.CONSULT_FALLBACK_MODEL = 'model-cadangan'; world.llm = [503, 503, 503, 200]; },
    checks: (r) => [
      ['tidak-melempar-error', !r.thrown, r.thrown],
      ['dijawab-model-cadangan', world.llmCalls.at(-1)?.model === 'model-cadangan' && /model-cadangan/.test(r.value?.reply ?? ''),
        world.llmCalls.map((c) => c.model).join(' → ')],
      ['bukan-pesan-sibuk', !hasBusyReply(r.value), ''],
    ],
  },
  {
    id: 'res-429-kuota', dimension: 'resilience',
    desc: '429 kuota sekali lalu pulih',
    history: user('sistem DP-nya gimana?'),
    setup: () => { world.llm = [429, 200]; },
    checks: (r) => [
      ['tidak-melempar-error', !r.thrown, r.thrown],
      ['menjawab-normal', !hasBusyReply(r.value), r.value?.reply],
      ['dua-percobaan', world.llmCalls.length === 2, `${world.llmCalls.length} panggilan`],
    ],
  },
  {
    id: 'res-jaringan-putus', dimension: 'resilience',
    desc: 'fetch melempar (jaringan putus) lalu pulih',
    history: user('alamat toko di mana?'),
    setup: () => { world.llm = ['throw', 200]; },
    checks: (r) => [
      ['tidak-melempar-error', !r.thrown, r.thrown],
      ['menjawab-normal', !hasBusyReply(r.value), r.value?.reply],
    ],
  },
  {
    id: 'res-400-tidak-diulang', dimension: 'resilience',
    desc: '400 (request salah) tidak dicoba ulang; konsumen tetap dapat balasan',
    history: user('halo'),
    setup: () => { world.llm = [400, 200, 200]; },
    checks: (r) => [
      ['tidak-melempar-error', !r.thrown, r.thrown],
      ['tidak-diulang', world.llmCalls.length === 1, `${world.llmCalls.length} panggilan`],
      ['pesan-sibuk', hasBusyReply(r.value), r.value?.reply],
    ],
  },
  {
    id: 'rag-dokumen-masuk-prompt', dimension: 'rag',
    desc: 'Dokumen hasil match_knowledge_docs disisipkan ke system prompt & sources',
    history: user('sistem DP-nya gimana kak?'),
    setup: () => {
      world.rpcDocs = [{ id: 8, title: 'Pembayaran dan DP', url: null, content: 'DP minimal 30 persen untuk pesanan custom.', similarity: 0.78 }];
    },
    checks: (r) => [
      ['rpc-dipanggil', world.rpcCalls[0]?.name === 'match_knowledge_docs', world.rpcCalls[0]?.name],
      ['isi-dokumen-di-prompt', sysText(world.llmCalls[0]).includes('DP minimal 30 persen'), ''],
      ['dibungkus-sebagai-data', /<dokumen[^>]*judul="Pembayaran dan DP"/.test(sysText(world.llmCalls[0])), ''],
      ['judul-di-sources', (r.value?.sources ?? []).some((s) => s.title === 'Pembayaran dan DP'), JSON.stringify(r.value?.sources)],
    ],
  },
  {
    id: 'rag-parameter-query', dimension: 'rag',
    desc: 'Embedding RETRIEVAL_QUERY 1536 dim ternormalisasi; dua pesan user terakhir jadi query',
    history: [
      { role: 'user', content: 'cincin couple emas putih ada?' },
      { role: 'assistant', content: 'Ada, Kak.' },
      { role: 'user', content: 'bayarnya bisa DP?' },
    ],
    setup: () => {},
    checks: () => {
      const e = world.embedCalls[0] ?? {};
      const v = world.rpcCalls[0]?.params?.query_embedding ?? [];
      const norm = Math.hypot(...v);
      return [
        ['task-type', e.taskType === 'RETRIEVAL_QUERY', e.taskType],
        ['dimensi-1536', e.outputDimensionality === 1536 && v.length === 1536, `${v.length}`],
        ['vektor-ternormalisasi', Math.abs(norm - 1) < 1e-6, norm.toFixed(6)],
        ['query-dua-pesan-terakhir', e.content?.parts?.[0]?.text === 'cincin couple emas putih ada?\nbayarnya bisa DP?', JSON.stringify(e.content?.parts?.[0]?.text)],
      ];
    },
  },
  {
    id: 'rag-tanpa-dokumen', dimension: 'rag',
    desc: 'Tidak ada dokumen cocok: tidak ada blok <dokumen> kosong di prompt',
    history: user('halo'),
    setup: () => { world.rpcDocs = []; },
    checks: (r) => [
      ['tanpa-blok-dokumen', !sysText(world.llmCalls[0]).includes('<dokumen'), ''],
      ['sources-kosong', (r.value?.sources ?? []).length === 0, JSON.stringify(r.value?.sources)],
    ],
  },
  {
    id: 'rag-embedding-gagal', dimension: 'rag',
    desc: 'API embedding 500: asisten tetap menjawab tanpa konteks (degradasi halus)',
    history: user('bisa kirim ke luar kota?'),
    setup: () => { world.embedStatus = 500; },
    checks: (r) => [
      ['tidak-melempar-error', !r.thrown, r.thrown],
      ['tetap-memanggil-llm', world.llmCalls.length === 1, `${world.llmCalls.length}`],
      ['rpc-dilewati', world.rpcCalls.length === 0, `${world.rpcCalls.length}`],
      ['kegagalan-tercatat', logs.some(([, m]) => /\[knowledge\]/.test(m)), ''],
    ],
  },
  {
    id: 'guard-eskalasi-hemat', dimension: 'guardrail',
    desc: 'Kata kunci komplain: langsung eskalasi tanpa memanggil LLM maupun embedding',
    history: user('batalkan pesanan saya'),
    setup: () => {},
    checks: (r) => [
      ['eskalasi', Boolean(r.value?.escalate), ''],
      ['nol-panggilan-llm', world.llmCalls.length === 0, `${world.llmCalls.length}`],
      ['nol-panggilan-embedding', world.embedCalls.length === 0, `${world.embedCalls.length}`],
    ],
  },
  {
    id: 'guard-aturan-rekening', dimension: 'guardrail',
    desc: 'System prompt melarang memberikan nomor rekening',
    history: user('nomor rekening berapa?'),
    setup: () => {},
    checks: () => [
      ['aturan-ada-di-prompt', /Jangan pernah memberikan nomor rekening/.test(sysText(world.llmCalls[0])), ''],
    ],
  },
  {
    id: 'tool-loop-layanan', dimension: 'tool-loop',
    desc: 'functionCall infoLayanan → functionResponse → jawaban teks + kartu',
    history: user('layanan apa saja?'),
    setup: () => { world.llm = [{ functionCall: { name: 'infoLayanan', args: {} } }, 200]; },
    checks: (r) => {
      const second = world.llmCalls[1]?.body?.contents ?? [];
      const fr = second.at(-1)?.parts?.[0]?.functionResponse;
      return [
        ['dua-putaran', world.llmCalls.length === 2, `${world.llmCalls.length}`],
        ['function-response-dikirim', fr?.name === 'infoLayanan' && Array.isArray(fr?.response?.result), ''],
        ['kartu-layanan', (r.value?.functions ?? []).some((f) => f.name === 'infoLayanan'), ''],
      ];
    },
  },
  {
    id: 'tool-status-tanpa-login', dimension: 'tool-loop',
    desc: 'cekStatusPesanan tanpa sesi → needLogin, database pesanan tidak disentuh',
    history: user('cek pesanan SR-001-2026'),
    setup: () => { world.llm = [{ functionCall: { name: 'cekStatusPesanan', args: { orderNumber: 'SR-001-2026' } } }, 200]; },
    checks: (r) => {
      const card = (r.value?.functions ?? []).find((f) => f.name === 'cekStatusPesanan');
      return [['need-login', card?.data?.needLogin === true, JSON.stringify(card?.data)]];
    },
  },
];

// ------------------------------------------------------------------ jalankan --
const selected = CASES.filter((c) => !args.only || c.id.includes(String(args.only)));
const out = (s) => process.stdout.write(s);
out(`\nSrikandi eval OFFLINE — ${selected.length} kasus\ntarget: ${TARGET}\n\n`);

const results = [];
const t0 = Date.now();
for (const c of selected) {
  resetWorld();
  logs.length = 0;
  c.setup();
  const mod = await loadConsult();
  const started = Date.now();
  const r = {};
  try {
    r.value = await mod.consult(db, null, c.history);
  } catch (err) {
    r.thrown = `melempar: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
  }
  const ms = Date.now() - started;
  const checks = c.checks(r).map(([name, ok, detail]) => ({ name, ok: Boolean(ok), detail: detail ?? '' }));
  const pass = checks.every((k) => k.ok);
  results.push({
    id: c.id, dimension: c.dimension, desc: c.desc, pass, ms,
    llmCalls: world.llmCalls.map((x) => x.model), reply: r.value?.reply ?? null, thrown: r.thrown ?? null, checks,
  });
  out(`${pass ? 'LULUS' : 'GAGAL'}  ${c.id.padEnd(26)} ${String(ms).padStart(5)} ms\n`);
  for (const k of checks.filter((x) => !x.ok)) out(`         ✗ ${k.name} ${String(k.detail ?? '').slice(0, 110)}\n`);
}

console.warn = quiet.warn;
console.error = quiet.error;
await rm(WORK, { recursive: true, force: true });

const byDim = {};
for (const r of results) {
  byDim[r.dimension] ??= { total: 0, pass: 0 };
  byDim[r.dimension].total++;
  if (r.pass) byDim[r.dimension].pass++;
}
const passed = results.filter((r) => r.pass).length;
out(`\n${'='.repeat(52)}\nTotal: ${passed}/${results.length} lulus  (${((Date.now() - t0) / 1000).toFixed(1)} s)\n\n`);
for (const [d, v] of Object.entries(byDim)) out(`  ${d.padEnd(12)} ${String(v.pass).padStart(2)}/${v.total}\n`);

const outPath = join(HERE, String(args.out ?? 'offline-report.json'));
await writeFile(outPath, JSON.stringify({ ranAt: new Date().toISOString(), target: TARGET, byDim, results }, null, 2));
out(`\nLaporan: ${outPath}\n\n`);
process.exit(passed === results.length ? 0 : 1);
