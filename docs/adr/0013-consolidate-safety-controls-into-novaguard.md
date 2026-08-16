# 安全机制收敛为具名 NovaGuard 可信控制层

初赛方案文档中的 NovaGuard（证据、风险、权限与智能体轨迹监管）在代码中长期是分散实现：引用白名单在 actor-critic、风险分级审批在编排图、写契约在 API 层，缺少一个具名、可测试、可演示的统一控制面。现将其收敛为 `src/server/guards/novaguard.ts`：

- evidence-bound：引用白名单（PMID/DOI/NV-SOP/E-* 形状 token 必须命中检索集，编造即拦截）；
- risk-tier approval：风险分级审批决策（ADR-0012），编排图 risk-gate 节点调用并把 verdict 写入检查点（checkpoints 表与 SSE 流可见）；
- write contract：认证 + 租户 + 幂等 + 乐观并发版本，由 api/write-context.ts 强制，在门禁清单中登记。

全部为纯函数，离线确定性可复现；运营看板（/operations）增加聚合门禁行「NovaGuard 可信控制」。

## Consequences

- 评委/答辩可直接定位 NovaGuard 的代码与测试（novaguard.test.ts），不再存在"文档有、代码无"的落差；
- 编排路径新增 risk-gate 检查点节点，SSE 与 checkpoints 表同步可见；
- 后续新增安全机制（如工具调用拦截）先落入 NovaGuard 再接入编排，避免再次分散。
