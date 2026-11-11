-- =========================================================
-- 運送状台帳  データベース定義
-- INVOICE台帳と同じSupabaseプロジェクトの「SQL Editor」に全文を貼り付けて「Run」
-- 新しい表を追加するだけで、INVOICE台帳の表（invoices / invoice_items）には触れません
-- =========================================================

-- ---------- 荷物（AWB番号ごとに1件） ----------
create table if not exists public.shipments (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  awb_no         text not null unique,            -- AWB番号（空白・ハイフンなしで保存）
  carrier        text,                            -- 運送会社（DHL など）

  -- 運送状から
  wb_service     text,                            -- サービス（EXPRESS WORLDWIDE など）
  wb_ship_date   date,                            -- 発送日
  wb_shipper     text,                            -- 発送元
  wb_consignee   text,                            -- 送り先
  wb_ref_no      text,                            -- 参照番号（Ref No）
  wb_weight      numeric(10,3),                   -- 重量（kg）
  wb_pieces      text,                            -- 個数（1 / 1 など）
  wb_content     text,                            -- 内容（Content）

  -- 運送用インボイスから
  inv_no         text,                            -- インボイス番号
  inv_date       date,                            -- インボイス日付
  inv_shipper    text,                            -- 発送元
  inv_consignee  text,                            -- 送り先
  currency       text,                            -- 通貨
  total_amount   numeric(14,2),                   -- 合計金額
  incoterm       text,                            -- 取引条件
  total_units    numeric(14,3),                   -- 合計数量
  net_weight     numeric(10,3),                   -- 正味重量（kg）
  gross_weight   numeric(10,3),                   -- 総重量（kg）

  -- 到着・確認
  arrival_date   date,                            -- 到着日
  confirmed_at   timestamptz,                     -- 確認済にした日時
  confirmed_by   uuid,
  memo           text,
  created_by     uuid default auth.uid()
);

create index if not exists shipments_ship_date_idx on public.shipments (wb_ship_date desc);
create index if not exists shipments_inv_no_idx    on public.shipments (inv_no);

-- ---------- 書類（PDF） ----------
create table if not exists public.shipment_docs (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  shipment_id    uuid not null references public.shipments(id) on delete cascade,
  doc_type       text not null check (doc_type in ('waybill','invoice')),
  pdf_path       text,
  pdf_name       text,
  notes          text,                            -- 読み取り時のメモ
  warning_note   text,                            -- 取込時の警告（PDF文字データの食い違いなど）
  unique (shipment_id, doc_type)                  -- 1つの荷物に運送状・インボイスは1枚ずつ
);

-- ---------- 明細（インボイスの商品行＋到着時の確認） ----------
create table if not exists public.shipment_items (
  id             uuid primary key default gen_random_uuid(),
  shipment_id    uuid not null references public.shipments(id) on delete cascade,
  line_no        int  not null default 1,
  description    text not null,                   -- 商品名
  hs_code        text,
  quantity       numeric(14,3),                   -- インボイスの数量
  unit           text,
  unit_price     numeric(14,4),
  subtotal       numeric(14,2),
  unit_weight    numeric(10,3),                   -- 1個あたり重量（kg）
  origin         text,
  received_qty   numeric(14,3),                   -- 実際に届いた数量
  check_note     text                             -- 確認メモ（破損・ロットなど）
);
create index if not exists shipment_items_sid_idx on public.shipment_items (shipment_id);

-- ---------- アクセス制限（ログインした人だけ） ----------
alter table public.shipments      enable row level security;
alter table public.shipment_docs  enable row level security;
alter table public.shipment_items enable row level security;

drop policy if exists "auth_all_shipments" on public.shipments;
create policy "auth_all_shipments" on public.shipments
  for all to authenticated using (true) with check (true);

drop policy if exists "auth_all_shipment_docs" on public.shipment_docs;
create policy "auth_all_shipment_docs" on public.shipment_docs
  for all to authenticated using (true) with check (true);

drop policy if exists "auth_all_shipment_items" on public.shipment_items;
create policy "auth_all_shipment_items" on public.shipment_items
  for all to authenticated using (true) with check (true);

-- ---------- PDF保存場所（非公開・INVOICE台帳とは別） ----------
insert into storage.buckets (id, name, public)
values ('shipping-docs', 'shipping-docs', false)
on conflict (id) do nothing;

drop policy if exists "auth_read_shipping_docs" on storage.objects;
create policy "auth_read_shipping_docs" on storage.objects
  for select to authenticated using (bucket_id = 'shipping-docs');

drop policy if exists "auth_insert_shipping_docs" on storage.objects;
create policy "auth_insert_shipping_docs" on storage.objects
  for insert to authenticated with check (bucket_id = 'shipping-docs');

drop policy if exists "auth_delete_shipping_docs" on storage.objects;
create policy "auth_delete_shipping_docs" on storage.objects
  for delete to authenticated using (bucket_id = 'shipping-docs');
