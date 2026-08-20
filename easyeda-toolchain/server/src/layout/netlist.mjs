/**
 * 网表解析（EasyEDA JSON 网表 → 每引脚网络名）
 *
 * 背景：getAllPinsByPrimitiveId 返回的引脚对象没有 getState_Net（类型定义确认），
 * 连通性的可靠来源是 sch_ManufactureData.getNetlistFile('netlist.json') 的 JSON 网表。
 * 兼容两种结构：
 *   A. autoLayout 网表形状：{ component: { [uniqueId]: { pinInfoMap: { [pinKey]: {name,number,net} } } } }
 *   B. 扁平：{ components: [{ uniqueId, pinInfoMap: {...} }] }
 * 匹配到组件后，把每引脚网络名写回 pins[].net（供布局引擎推断贴脚）。
 */

/**
 * @param {Array<{uniqueId?:string, pins?:Array<{number,name}>}>} comps
 * @param {string|object|null} netlistRaw
 * @returns {Array} 原数组（原地补 net 字段）
 */
export function attachPinNetsFromNetlist(comps, netlistRaw) {
  if (!netlistRaw || !comps) return comps;
  let parsed = null;
  try {
    parsed = typeof netlistRaw === 'string' ? JSON.parse(netlistRaw) : netlistRaw;
  } catch {
    return comps;
  }
  const byUid = new Map();
  const compMap = parsed && typeof parsed === 'object' && parsed.component ? parsed.component : null;
  if (compMap) {
    for (const [uid, info] of Object.entries(compMap)) {
      const pm = info && info.pinInfoMap;
      if (!pm) continue;
      const pinNets = new Map();
      for (const [pk, pin] of Object.entries(pm)) {
        const net = pin && (pin.net || pin.netName);
        const num = pin && (pin.number ?? pin.pinNumber ?? pk);
        if (net) pinNets.set(String(num), net);
      }
      byUid.set(uid, pinNets);
    }
  } else {
    const arr = (parsed && parsed.components) || (parsed && parsed.netlist && parsed.netlist.components);
    if (Array.isArray(arr)) {
      for (const c of arr) {
        const pm = c && c.pinInfoMap;
        if (!pm) continue;
        const pinNets = new Map();
        for (const [pk, pin] of Object.entries(pm)) {
          const net = pin && (pin.net || pin.netName);
          const num = pin && (pin.number ?? pin.pinNumber ?? pk);
          if (net) pinNets.set(String(num), net);
        }
        byUid.set(c.uniqueId || c.id, pinNets);
      }
    }
  }
  if (!byUid.size) return comps;
  for (const c of comps) {
    const pinNets = c.uniqueId ? byUid.get(c.uniqueId) : null;
    if (!pinNets || !pinNets.size || !c.pins) continue;
    for (const p of c.pins) {
      const net = pinNets.get(String(p.number)) || pinNets.get(String(p.name));
      if (net) p.net = net;
    }
  }
  return comps;
}

const POWER_NET_RE = /^(GND|VSS|VCC|VDD|\+[0-9A-Z.]*V|-?[0-9.]+V)$/i;

/**
 * 网络布线排序：端点少的先布、信号网先布、电源/地网后布（冲突从源头少一半）。
 * @param {Array<{net:string, pins:Array}>} nets
 * @returns {Array<{net, pins}>} 排序后的网络
 */
export function netOrder(nets) {
  return (nets || []).slice().sort((a, b) => {
    const sa = POWER_NET_RE.test(a.net) ? 1 : 0;
    const sb = POWER_NET_RE.test(b.net) ? 1 : 0;
    if (sa !== sb) return sa - sb; // 信号网在前
    return (a.pins || []).length - (b.pins || []).length; // 端点少在前
  });
}
