/**
 * Bitable (多维表格) sync — NovaPilot 系统数据双写。
 * 凭证缺失时全部保留本地 Mock 记录并优雅降级，保持离线确定性。
 */
import type { DecisionCard, ProjectFacts } from "@/domain/consultation-journey";
import { feishuEnabled, feishuRequest } from "./client";

export interface BitableFieldDef {
  field_name: string;
  /** 1 文本 · 2 数字 · 4 多选 · 5 日期 · 7 复选 */
  type: number;
}

export const CARD_FIELDS: BitableFieldDef[] = [
  { field_name: "卡片ID", type: 1 },
  { field_name: "项目ID", type: 1 },
  { field_name: "标题", type: 1 },
  { field_name: "物种", type: 1 },
  { field_name: "推荐方案", type: 1 },
  { field_name: "风险分级", type: 1 },
  { field_name: "引用的SOP", type: 1 },
  { field_name: "质检状态", type: 1 },
  { field_name: "客户目标", type: 1 },
  { field_name: "证据引用", type: 1 },
  { field_name: "状态", type: 1 },
  { field_name: "更新时间", type: 1 },
];

export const EVENT_FIELDS: BitableFieldDef[] = [
  { field_name: "事件ID", type: 1 },
  { field_name: "门禁", type: 1 },
  { field_name: "数值", type: 1 },
  { field_name: "责任人", type: 1 },
  { field_name: "状态", type: 1 },
  { field_name: "关闭证据", type: 1 },
  { field_name: "是否模拟", type: 7 },
];

export interface MockBitableRecord {
  recordId: string;
  table: string;
  fields: Record<string, unknown>;
  syncedAt: string;
}

const mockBitableStore: MockBitableRecord[] = [];

/** 获取所有离线同步的 Mock 多维表格记录 */
export function getMockBitableRecords(): readonly MockBitableRecord[] {
  return [...mockBitableStore];
}

/** 清理 Mock 多维表格记录（测试用） */
export function clearMockBitableRecords(): void {
  mockBitableStore.length = 0;
}

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
): Promise<{ success: boolean; recordId?: string }> {
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
  if (existingId) {
    const res = await feishuRequest(
      "PUT",
      "/bitable/v1/apps/" + appToken + "/tables/" + tableId + "/records/batch_update",
      { records: [{ record_id: existingId, fields }] },
    );
    return { success: res?.code === 0, recordId: existingId };
  }
  const res = await feishuRequest<{ record?: { record_id: string } }>(
    "POST",
    "/bitable/v1/apps/" + appToken + "/tables/" + tableId + "/records",
    { fields },
  );
  return { success: res?.code === 0, recordId: res?.data?.record?.record_id };
}

export function bitableConfig(): { appToken: string | null; cardsTable: string; eventsTable: string } {
  return {
    appToken: process.env.FEISHU_BITABLE_APP_TOKEN ?? null,
    cardsTable: process.env.FEISHU_BITABLE_TABLE_CARDS ?? "决策卡",
    eventsTable: process.env.FEISHU_BITABLE_TABLE_EVENTS ?? "质量事件",
  };
}

export interface SyncDecisionResult {
  success: boolean;
  mock: boolean;
  recordId: string;
  tableId: string;
  fields: Record<string, unknown>;
}

/**
 * 将决策卡同步到飞书多维表格（Bitable）标准科研记录
 * 包含：项目 ID、物种、推荐方案、风险分级、引用的 SOP 文献编号、质检状态
 */
export async function syncDecisionCard(
  card: DecisionCard,
  projectId?: string,
  facts?: ProjectFacts,
): Promise<SyncDecisionResult> {
  const pId = projectId ?? card.id.replace(/^CARD-/, "");

  // 物种字段提取
  const species =
    facts?.species ||
    card.confirmedConditions.find((c) => c.field === "species")?.value ||
    "未指明物种";

  // 推荐方案摘要
  const recommendedPlan =
    card.recommendations.map((r) => r.title).join("； ") || card.title;

  // SOP 引用提取
  const sopCitations =
    card.recommendations
      .flatMap((r) => r.evidenceIds)
      .filter((id) => id.toUpperCase().includes("SOP") || id.toUpperCase().includes("PMID"))
      .join("; ") || "SOP-042";

  const fields: Record<string, unknown> = {
    "卡片ID": card.id,
    "项目ID": pId,
    "标题": card.title,
    "物种": String(species),
    "推荐方案": recommendedPlan,
    "风险分级": card.risk.level,
    "引用的SOP": sopCitations,
    "质检状态": "待质检",
    "客户目标": card.customerGoal || "—",
    "证据引用": card.recommendations.flatMap((r) => r.evidenceIds).join("; "),
    "状态": card.status,
    "更新时间": new Date().toISOString(),
  };

  const cfg = bitableConfig();
  if (!feishuEnabled() || !cfg.appToken) {
    // 离线/未配置时存储到 Mock Store
    const mockId = `rec_mock_${pId}_${Date.now().toString(36)}`;
    const mockRecord: MockBitableRecord = {
      recordId: mockId,
      table: cfg.cardsTable,
      fields,
      syncedAt: new Date().toISOString(),
    };
    mockBitableStore.unshift(mockRecord);
    if (mockBitableStore.length > 100) mockBitableStore.pop();
    return {
      success: true,
      mock: true,
      recordId: mockId,
      tableId: "tbl_mock_cards",
      fields,
    };
  }

  const tableId = await ensureTable(cfg.appToken, cfg.cardsTable, CARD_FIELDS);
  if (!tableId) {
    return {
      success: false,
      mock: false,
      recordId: "",
      tableId: "",
      fields,
    };
  }

  const upsert = await upsertRecord(cfg.appToken, tableId, "卡片ID", card.id, fields);
  return {
    success: upsert.success,
    mock: false,
    recordId: upsert.recordId ?? "",
    tableId,
    fields,
  };
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
