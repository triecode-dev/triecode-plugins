/**
 * 布局意图 schema（zod）—— AI 表达语义意图，几何由引擎算
 *
 * 设计原则：LLM 只给「哪个贴哪个脚、哪些是一组、用哪种模式」，
 * 坐标全部由确定性引擎计算，不交给 LLM 算术。
 */
import { z } from 'zod/v3';

/** 贴脚：卫星 C3 的 pin1 贴到 U1 的 RST */
export const anchorIntentSchema = z.object({
  s: z.string().describe('卫星器件位号（如 C3）'),
  p: z.string().describe('卫星引脚号或名（如 1 / pin1）'),
  t: z.string().describe('目标器件位号（如 U1）'),
  tp: z.string().describe('目标引脚号或名（如 RST / 9）'),
});

/** 功能块：一组器件的关系（flow 信号链 / pair 并列 / cluster 簇） */
export const groupIntentSchema = z.object({
  name: z.string().optional().describe('块名（如 晶振电路）'),
  members: z.array(z.string()).describe('成员位号（按序）'),
  kind: z.enum(['flow', 'pair', 'cluster']).optional().describe('关系类型，默认 cluster'),
  direction: z.number().int().optional().describe('flow 方向：1 正向（左→右） / -1 反向，默认 1'),
});

/** 网络标记意图：某网络的标记应向哪个方向引出 */
export const netFlagIntentSchema = z.object({
  net: z.string().describe('网络名（如 GND / +5V）'),
  dir: z.enum(['up', 'down', 'left', 'right']).optional().describe('引出方向，缺省按网络名推断（GND 下、Power 上、信号右）'),
});

export const layoutIntentSchema = z.object({
  mode: z
    .enum(['central-lr', 'functional-zones', 'rearrange'])
    .describe('布局模式：central-lr 单核心芯片左右外设；functional-zones 多模块功能分区；rearrange 原位微调'),
  core: z.string().optional().describe('核心芯片位号（central-lr 必需）'),
  anchors: z.array(anchorIntentSchema).optional().describe('贴脚约束（去耦/负载电容/上拉等）'),
  groups: z.array(groupIntentSchema).optional().describe('功能块（信号链/并列/簇）'),
  netFlags: z.array(netFlagIntentSchema).optional().describe('网络标记引出方向意图'),
  layout: z
    .object({
      clearance: z.number().min(0).optional().describe('最小间距余量（sch 单位，默认 5 = 0.05inch）'),
      spacing: z.number().min(0).optional().describe('信号链/并列间距（sch，默认 8）'),
      page: z.enum(['auto', 'keep']).optional().describe('分页：auto 允许溢出下一页（默认），keep 保持单页'),
      keepDesignators: z.array(z.string()).optional().describe('不移动的位号列表'),
      apply: z.boolean().optional().describe('true=直接落图（移动器件）；false=只返回规划坐标（默认）'),
    })
    .optional(),
});

/** 解析意图（抛错带清晰信息） */
export function parseLayoutIntent(raw) {
  return layoutIntentSchema.parse(raw || {});
}
