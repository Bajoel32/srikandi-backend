-- =============================================================================
-- Data awal Srikandi — pindahan dari src/config/site.js (galeri statis)
-- plus 3 konsumen demo beserta pesanannya.
-- Aman dijalankan ulang: seluruhnya idempoten.
-- =============================================================================

-- ------------------------------------------------------------------ galeri --
insert into public.gallery (title, description, image, category, price, tags, details, uploaded_by, uploaded_date)
select * from (values
  ('Gelang Emas Klasik',
   'Gelang emas putih dengan desain klasik yang elegan dan timeless',
   'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=800&h=800&fit=crop',
   'Gelang', 2500000::numeric, array['Emas Putih','Klasik','Wanita'],
   '{"Berat Emas":"5 gram","Kadar":"75 Karat","Ukuran":"Free Size"}'::jsonb,
   'Budi Sales', date '2026-08-10'),

  ('Cincin Berlian Solitaire',
   'Cincin berlian solitaire dengan batu berkualitas VVS1',
   'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=800&h=800&fit=crop',
   'Cincin', 15000000::numeric, array['Berlian','Premium','Wanita'],
   '{"Batu":"Berlian 1.5 Carat","Kadar Emas":"70 Karat","Sertifikat":"GIA"}'::jsonb,
   'Siti Sales', date '2026-08-09'),

  ('Kalung Emas Panjang',
   'Kalung emas kuning dengan desain mewah dan artistik',
   'https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?w=800&h=800&fit=crop',
   'Kalung', 3500000::numeric, array['Emas Kuning','Mewah','Wanita'],
   '{"Panjang":"45 cm","Berat":"8 gram","Kadar":"70 Karat"}'::jsonb,
   'Rina Sales', date '2026-08-08'),

  ('Anting Mutiara Elegan',
   'Anting emas dengan mutiara asli dari laut',
   'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=800&h=800&fit=crop',
   'Anting', 1800000::numeric, array['Mutiara','Elegan','Wanita'],
   '{"Batu":"Mutiara Asli","Ukuran Mutiara":"10mm","Kadar":"75 Karat"}'::jsonb,
   'Maya Sales', date '2026-08-07'),

  ('Liontin Salib Emas',
   'Liontin salib dengan detail ukiran halus',
   'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=800&h=800&fit=crop',
   'Liontin', 950000::numeric, array['Salib','Religius','Unisex'],
   '{"Tinggi":"3 cm","Berat":"2 gram","Kadar":"70 Karat"}'::jsonb,
   'Andi Sales', date '2026-08-06'),

  ('Gelang Berlian Modern',
   'Gelang tennis dengan berlian berlapis sempurna',
   'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=800&h=800&fit=crop',
   'Gelang', 8500000::numeric, array['Berlian','Modern','Wanita'],
   '{"Batu":"20 Berlian Total 2 Carat","Kadar":"75 Karat","Panjang":"18 cm"}'::jsonb,
   'Budi Sales', date '2026-08-05'),

  ('Cincin Couple Emas',
   'Cincin pasangan dengan desain matching yang romantis',
   'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=800&h=800&fit=crop',
   'Cincin', 4200000::numeric, array['Couple','Romantis','Pria & Wanita'],
   '{"Jumlah":"2 Buah (Pria & Wanita)","Berat":"4 gram per cincin","Kadar":"70 Karat"}'::jsonb,
   'Siti Sales', date '2026-08-04'),

  ('Kalung Perak Antik',
   'Kalung perak dengan motif tradisional dan artistik',
   'https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?w=800&h=800&fit=crop',
   'Kalung', 650000::numeric, array['Perak','Tradisional','Unisex'],
   '{"Material":"Perak 925","Panjang":"50 cm","Berat":"12 gram"}'::jsonb,
   'Rina Sales', date '2026-08-03')
) as v(title, description, image, category, price, tags, details, uploaded_by, uploaded_date)
where not exists (select 1 from public.gallery g where g.title = v.title);

-- --------------------------------------------------- konsumen + pesanan ----
-- GANTI kode akses di bawah sebelum dipakai sungguhan:
--   select public.set_customer_passcode('0812XXXXXXXX', 'kode-baru');
select public.upsert_customer('Siti Nurhaliza', '081234567001', '481562');
select public.upsert_customer('Rini Sulistyo',  '081234567002', '739104');
select public.upsert_customer('Maya Kusuma',    '081234567003', '206853');

insert into public.orders (order_number, customer_id, service_name, gold_purity, progress, status, created_date)
select v.order_number, c.id, v.service_name, v.gold_purity, v.progress, v.status, v.created_date
from (values
  ('SR-001-2026', '081234567001', 'Cuci Emas',      75, 75,  'Sedang Dikerjakan',  date '2026-08-01'),
  ('SR-002-2026', '081234567001', 'Pasang Berlian', 70, 100, 'Selesai',            date '2026-07-28'),
  ('SR-003-2026', '081234567002', 'Patri Emas',     80, 50,  'Sedang Dikerjakan',  date '2026-08-05'),
  ('SR-004-2026', '081234567003', 'Chrome Putih',   75, 25,  'Belum Dimulai',      date '2026-08-10'),
  ('SR-005-2026', '081234567003', 'Custom Cincin',  70, 90,  'Menunggu Approval',  date '2026-08-03')
) as v(order_number, phone, service_name, gold_purity, progress, status, created_date)
join public.customers c on c.phone = v.phone
where not exists (select 1 from public.orders o where o.order_number = v.order_number);

-- Geser sequence supaya nomor berikutnya tidak bentrok dengan seed.
select setval('public.order_number_seq',
              greatest((select coalesce(max(substring(order_number from 4 for 3)::int), 0) from public.orders), 1));
