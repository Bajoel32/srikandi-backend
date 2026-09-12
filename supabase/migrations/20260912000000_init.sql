-- =============================================================================
-- Srikandi — skema backend Supabase
-- =============================================================================
-- Semua tabel memakai RLS TANPA policy: artinya kunci `anon` (yang ikut terbawa
-- ke browser) tidak bisa membaca/menulis apa pun. Satu-satunya pintu masuk
-- adalah Edge Function `api` yang memakai service-role key di sisi server.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------------------ galeri --
create table if not exists public.gallery (
  id            uuid primary key default gen_random_uuid(),
  title         text        not null check (char_length(title) between 1 and 120),
  description   text        not null default '' check (char_length(description) <= 800),
  image         text        not null check (image ~ '^https?://' and char_length(image) <= 2000),
  category      text        not null check (char_length(category) between 1 and 40),
  price         numeric(14,2) check (price >= 0),
  tags          text[]      not null default '{}',
  details       jsonb       not null default '{}'::jsonb,
  uploaded_by   text        not null default 'Tim Sales' check (char_length(uploaded_by) <= 80),
  uploaded_date date        not null default current_date,
  is_published  boolean     not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists gallery_published_idx on public.gallery (is_published, created_at desc);
create index if not exists gallery_category_idx  on public.gallery (category);

-- --------------------------------------------------------------- konsumen --
create table if not exists public.customers (
  id            bigint generated always as identity primary key,
  name          text        not null check (char_length(name) between 1 and 100),
  phone         text        not null unique check (phone ~ '^0[0-9]{8,14}$'),
  passcode_hash text        not null,
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------- pesanan --
create table if not exists public.orders (
  id            bigint generated always as identity primary key,
  order_number  text        not null unique check (order_number ~ '^SR-[0-9]{3,}-[0-9]{4}$'),
  customer_id   bigint      not null references public.customers(id) on delete cascade,
  service_name  text        not null check (char_length(service_name) between 1 and 80),
  gold_purity   int         not null default 70 check (gold_purity between 0 and 100),
  progress      int         not null default 0 check (progress between 0 and 100),
  status        text        not null default 'Belum Dimulai'
                check (status in ('Belum Dimulai','Menunggu Approval','Sedang Dikerjakan','Selesai','Dibatalkan')),
  notes         text        not null default '' check (char_length(notes) <= 1000),
  created_date  date        not null default current_date,
  updated_at    timestamptz not null default now()
);

create index if not exists orders_customer_idx on public.orders (customer_id, created_date desc);

-- Nomor pesanan otomatis: SR-007-2026
create sequence if not exists public.order_number_seq start 1;

create or replace function public.next_order_number()
returns text
language sql
volatile
set search_path = public
as $$
  select 'SR-' || lpad(nextval('public.order_number_seq')::text, 3, '0')
      || '-' || to_char(current_date, 'YYYY');
$$;

-- --------------------------------------------------------------- booking ---
create table if not exists public.bookings (
  id                bigint generated always as identity primary key,
  customer_name     text        not null check (char_length(customer_name) between 1 and 100),
  phone_number      text        not null check (char_length(phone_number) between 7 and 20),
  email             text        not null check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and char_length(email) <= 150),
  service_id        int         not null,
  service_name      text        not null default '' check (char_length(service_name) <= 80),
  service_details   text        not null default '' check (char_length(service_details) <= 1000),
  quantity          int         not null default 1 check (quantity between 1 and 100),
  estimated_date    date,
  notes             text        not null default '' check (char_length(notes) <= 1000),
  preferred_payment text        not null default 'DP' check (preferred_payment in ('DP','Lunas','Cicilan')),
  status            text        not null default 'Baru' check (status in ('Baru','Diproses','Selesai','Dibatalkan')),
  created_at        timestamptz not null default now()
);

create index if not exists bookings_created_idx on public.bookings (created_at desc);

-- ------------------------------------------------------------ sesi login ---
-- Token opaque (bukan JWT). Yang disimpan hanya SHA-256 dari token, jadi isi
-- tabel ini bocor pun tidak bisa dipakai untuk login.
create table if not exists public.sessions (
  token_hash   text        primary key,
  customer_id  bigint      not null references public.customers(id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '12 hours'
);

create index if not exists sessions_expiry_idx on public.sessions (expires_at);

-- ------------------------------------------------------- log konsultasi ----
create table if not exists public.consult_logs (
  id          bigint generated always as identity primary key,
  customer_id bigint references public.customers(id) on delete set null,
  question    text        not null default '',
  answer      text        not null default '',
  escalated   boolean     not null default false,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------ rate limit ---
create table if not exists public.rate_limits (
  key          text        primary key,
  hits         int         not null default 0,
  window_start timestamptz not null default now()
);

-- =============================================================================
-- RPC — dipanggil Edge Function dengan service-role key
-- =============================================================================

-- Verifikasi nomor HP + kode akses (bcrypt). Kembalikan konsumen bila cocok.
create or replace function public.verify_customer(p_phone text, p_pass text)
returns table (id bigint, name text, phone text)
language sql
security definer
set search_path = public, extensions
as $$
  select c.id, c.name, c.phone
  from public.customers c
  where c.phone = p_phone
    and c.is_active
    and c.passcode_hash = extensions.crypt(p_pass, c.passcode_hash);
$$;

-- Set / ganti kode akses konsumen (dipakai admin lewat SQL editor).
create or replace function public.set_customer_passcode(p_phone text, p_pass text)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  update public.customers
     set passcode_hash = extensions.crypt(p_pass, extensions.gen_salt('bf', 10))
   where phone = p_phone;
$$;

-- Tambah konsumen sekaligus kode aksesnya.
create or replace function public.upsert_customer(p_name text, p_phone text, p_pass text)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_id bigint;
begin
  insert into public.customers (name, phone, passcode_hash)
  values (p_name, p_phone, extensions.crypt(p_pass, extensions.gen_salt('bf', 10)))
  on conflict (phone) do update
    set name = excluded.name,
        passcode_hash = excluded.passcode_hash
  returning id into v_id;
  return v_id;
end;
$$;

-- Rate limit sederhana berbasis jendela waktu. true = masih boleh.
create or replace function public.bump_rate_limit(p_key text, p_limit int, p_window_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_hits int;
begin
  insert into public.rate_limits (key, hits, window_start)
  values (p_key, 1, now())
  on conflict (key) do update
    set hits = case
                 when rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
                 then 1
                 else rate_limits.hits + 1
               end,
        window_start = case
                 when rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
                 then now()
                 else rate_limits.window_start
               end
  returning hits into v_hits;

  return v_hits <= p_limit;
end;
$$;

-- Bersih-bersih sesi & rate limit kedaluwarsa (panggil dari cron kalau mau).
create or replace function public.purge_expired()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.sessions where expires_at < now();
  delete from public.rate_limits where window_start < now() - interval '1 day';
$$;

-- =============================================================================
-- RLS — aktif tanpa policy: anon & authenticated tidak punya akses sama sekali
-- =============================================================================
alter table public.gallery      enable row level security;
alter table public.customers    enable row level security;
alter table public.orders       enable row level security;
alter table public.bookings     enable row level security;
alter table public.sessions     enable row level security;
alter table public.consult_logs enable row level security;
alter table public.rate_limits  enable row level security;

alter table public.gallery      force row level security;
alter table public.customers    force row level security;
alter table public.orders       force row level security;
alter table public.bookings     force row level security;
alter table public.sessions     force row level security;
alter table public.consult_logs force row level security;
alter table public.rate_limits  force row level security;

-- Cabut akses langsung lewat PostgREST untuk kunci publik.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

revoke execute on function public.verify_customer(text, text)        from public;
revoke execute on function public.set_customer_passcode(text, text)  from public;
revoke execute on function public.upsert_customer(text, text, text)  from public;
revoke execute on function public.bump_rate_limit(text, int, int)    from public;
revoke execute on function public.purge_expired()                    from public;

grant execute on function public.verify_customer(text, text)       to service_role;
grant execute on function public.set_customer_passcode(text, text) to service_role;
grant execute on function public.upsert_customer(text, text, text) to service_role;
grant execute on function public.bump_rate_limit(text, int, int)   to service_role;
grant execute on function public.purge_expired()                   to service_role;
grant execute on function public.next_order_number()               to service_role;
