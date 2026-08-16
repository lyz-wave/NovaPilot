/**
 * Bitable (多维表格) sync — NovaPilot 系统数据双写。
 * 凭证缺失时全部 no-op;失败静默(不阻塞主流程,保持离线不变式)。
 */
import type { DecisionCard } from "@/domain/consultation-journey";
import { feishuEnabled, feishuRequest } from "./client";

export interface BitableFieldDef {
  field_name: string;
  /** 1 文本 · 2 数字 · 4 多选 · 5 日期 · 7 复选 */
  type: number;
}

const CARD_FIELDS: BitableFieldDef[] = [
  { field_name: "卡片ID", type: 1 },
  { field_name: "标题", type: 1 },
  { field_name: "状态", type: 1 },
  { field_name: "风险", type: 1 },
  { field_name: "客户目标", type: 1 },
  { field_name: "证据引用", type: 1 },
  { field_name: "更新时间", type: 1 },
];

const EVENT_FIELDS: BitableFieldDef[] = [
  { field_name: "事件ID", type: 1 },
  { field_name: "门禁", type: 1 },
  { field_name: "数值", type: 1 },
  { field_name: "责任人", type: 1 },
  { field_name: "状态", type: 1 },
  { field_name: "关闭证据", type: 1 },
  { field_name: "是否模拟", type: 7 },
];

/** Find a table by name inside the configured Bitable app, or create it. */
export async function ensureTable(
  appToken: string,
  name: string,
  fields: BitableFieldDef[],
): Promise<string | null> {
  const list = await feishuRequest<{
    items?: Array<{ table_id: string; name: string }>;
    has_more?: boolean;
    page_token?: string;
  }>("GET", "/bitable/v1/apps/" + appToken + "/tables?page_size=100");
  const existing = list?.data?.items?.find((t) => t.name === name);
  if (existing) return existing.table_id;
  const created = await feishuRequest<{ table_id?: string }>(
    "POST",
    "/bitable/v1/apps/" + appToken + "/tables",
    { table: { name, fields } },
  );
  return created?.data?.table_id ?? null;
}

/** Idempotent record upsert keyed on a text field value. */
export async function upsertRecord(
  appToken: string,
  tableId: string,
  idField: string,
  idValue: string,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const search = await feishuRequest<{ items?: Array<{ record_id: string }> }>(
    "POST",
    "/bitable/v1/apps/" + appToken + "/tables/" + tableId + "/records/search",
    {
      filter: {
        conjunction: "and",
        conditions: [{ field_name: idField, operator: "is", value: [idValue] }],
      },
    },
  );
  const existingId = search?.data?.items?.[0]?.record_id;
  const payload = { fields };
  if (existingId) {
    const res = await feishuRequest(
      "PUT",
      "/bitable/v1/apps/" + appToken + "/tables/" + tableId + "/records/batch_update",
      { records: [{ record_id: existingId, fields }] },
    );
    return res?.code === 0;
  }
  const res = await feishuRequest(
    "POST",
    "/bitable/v1/apps/" + appToken + "/tables/" + tableId + "/records",
    payload,
  );
  return res?.code === 0;
}

export function bitableConfig(): { appToken: string | null; cardsTable: string; eventsTable: string } {
  return {
    appToken: process.env.FEISHU_BITABLE_APP_TOKEN ?? null,
    cardsTable: process.env.FEISHU_BITABLE_TABLE_CARDS ?? "决策卡",
    eventsTable: process.env.FEISHU_BITABLE_TABLE_EVENTS ?? "质量事件",
  };
}

/** Fire-and-forget: sync a decision card into Bitable (no-op offline). */
export async function syncDecisionCard(card: DecisionCard): Promise<void> {
  if (!feishuEnabled()) return;
  const cfg = bitableConfig();
  if (!cfg.appToken) return;
  const tableId = await ensureTable(cfg.appToken, cfg.cardsTable, CARD_FIELDS);
  if (!tableId) return;
  await upsertRecord(cfg.appToken, tableId, "卡片ID", card.id, {
    "卡片ID": card.id,
    "标题": card.title,
    "状态": card.status,
    "风险": card.risk.level,
    "客户目标": card.customerGoal,
    "证据引用": card.recommendations.flatMap((r) => r.evidenceIds).join("; "),
    "更新时间": new Date().toISOString(),
  });
}

export interface BitableQualityEvent {
  id: string;
  gateKey: string;
  label: string;
  value: string;
  owner: string;
  evidence: string;
  status: string;
  simulated: boolean;
}

/** Fire-and-forget: sync a quality event into Bitable (no-op offline). */
export async function syncQualityEvent(event: BitableQualityEvent): Promise<void> {
  if (!feishuEnabled()) return;
  const cfg = bitableConfig();
  if (!cfg.appToken) return;
  const tableId = await ensureTable(cfg.appToken, cfg.eventsTable, EVENT_FIELDS);
  if (!tableId) return;
  await upsertRecord(cfg.appToken, tableId, "事件ID", event.id, {
    "事件ID": event.id,
    "门禁": event.label,
    "数值": event.value,
    "责任人": event.owner,
    "状态": event.status === "resolved" ? "已关闭" : "OPEN",
    "关闭证据": event.evidence,
    "是否模拟": event.simulated,
  });
}
