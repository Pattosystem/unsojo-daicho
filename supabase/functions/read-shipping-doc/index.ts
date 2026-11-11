// =========================================================
// 運送状台帳  書類読み取り機能（Supabase Edge Function）
// 運送状（送り状・ラベル）か運送用インボイスかを判別し、項目を読み取って返します。
// =========================================================

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-5-5";

const N = (d?: string) => ({ type: ["number", "null"], ...(d ? { description: d } : {}) });
const S = (d?: string) => ({ type: ["string", "null"], ...(d ? { description: d } : {}) });

const TOOL = {
  name: "record_shipping_document",
  description: "Record the data read from a shipping document (carrier waybill/label, or commercial invoice for shipment).",
  input_schema: {
    type: "object",
    properties: {
      doc_type: {
        type: "string",
        enum: ["waybill", "invoice", "other"],
        description: "waybill = carrier shipping label / air waybill (DHL, FedEx, UPS, EMS...). invoice = commercial / proforma invoice with product lines. other = anything else.",
      },
      awb_no:     S("Air waybill / tracking number. Remove spaces and hyphens, e.g. 'WAYBILL 35 3917 3433' -> '3539173433'."),
      carrier:    S("Carrier name, e.g. DHL, FedEx, UPS, Japan Post. null if unknown."),

      // waybill
      service:    S("Waybill only: service name, e.g. EXPRESS WORLDWIDE."),
      ship_date:  S("Waybill only: shipment / label date, YYYY-MM-DD."),
      ref_no:     S("Waybill only: reference number (Ref No)."),
      weight_kg:  N("Waybill only: shipment weight in kg."),
      pieces:     S("Waybill only: piece count as printed, e.g. '1 / 1'."),
      content:    S("Waybill only: content / description text exactly as printed."),

      // both
      shipper:    S("Shipper / ship-from company name."),
      consignee:  S("Consignee / ship-to company name (and contact person if printed)."),

      // invoice
      invoice_no:      S("Invoice only: invoice number."),
      invoice_date:    S("Invoice only: invoice date, YYYY-MM-DD."),
      currency:        S("Invoice only: ISO currency code."),
      total_amount:    N("Invoice only: total invoice amount."),
      incoterm:        S("Invoice only: terms of trade, e.g. DAP."),
      total_units:     N("Invoice only: total units as printed."),
      net_weight_kg:   N("Invoice only: total net weight in kg."),
      gross_weight_kg: N("Invoice only: total gross weight in kg."),
      items: {
        type: "array",
        description: "Invoice only: one entry per product line. Empty array for waybills.",
        items: {
          type: "object",
          properties: {
            description:    { type: "string" },
            hs_code:        S(),
            quantity:       N(),
            unit:           S(),
            unit_price:     N(),
            subtotal:       N(),
            unit_weight_kg: N("Weight per unit in kg as printed (net)."),
            origin:         S("Country of origin code."),
          },
          required: ["description", "quantity"],
        },
      },
      notes: {
        type: "array",
        items: { type: "string" },
        description: "Japanese notes about anything unclear, unreadable or inconsistent. Empty if none.",
      },
    },
    required: ["doc_type", "awb_no", "items", "notes"],
  },
};

const PROMPT = `This PDF is a shipping document for goods sent to us (LIAS, an importer in Japan) by an overseas supplier.
It is either a carrier waybill / shipping label, or a commercial invoice that accompanies the shipment.
Decide which it is, read it, and call the record_shipping_document tool exactly once. Do not answer in plain text.

Rules:
- Transcribe exactly what is visibly printed. Never guess, round, convert, or fill in values that are not on the document. Use null when missing.
- If the PDF's embedded text differs from what is visibly printed on the page (for example a different product name), use the visibly printed text and add a Japanese note quoting both versions.
- Numbers must be plain numbers. Dates must be YYYY-MM-DD.
- Fill only the fields that belong to the detected document type; leave the others null (items = [] for a waybill).
- If anything is unreadable, ambiguous, or the numbers do not add up, write it in notes in Japanese.`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POSTのみ対応しています" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY が設定されていません" }, 500);

  let pdf_base64: string;
  try {
    ({ pdf_base64 } = await req.json());
    if (!pdf_base64) throw new Error();
  } catch {
    return json({ error: "PDFが送られていません" }, 400);
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      tools: [TOOL],
      tool_choice: { type: "auto" },
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf_base64 } },
          { type: "text", text: PROMPT },
        ],
      }],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    return json({ error: "読み取りに失敗しました: " + (data?.error?.message ?? res.status) }, 502);
  }
  const tu = (data.content ?? []).find((c: { type: string }) => c.type === "tool_use");
  if (tu) return json({ doc: tu.input });

  const text = (data.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return json({ doc: JSON.parse(m[0]) }); } catch { /* 下へ */ }
  }
  return json({ error: "読み取り結果が返りませんでした" }, 502);
});
