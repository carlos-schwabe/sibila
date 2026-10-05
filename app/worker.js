// Roda o motor fora da thread principal. Mensagens:
//   { id, kind: "backtest", proj }               -> { snaps } ao longo de toda a apuração
//   { id, kind: "live", proj, fraction, points } -> { curve, snap } em um ponto da apuração
import { loadData, realOrder, project, rawCurve } from "./engine.js";

let D = null, order = null;

self.onmessage = async ({ data }) => {
  const { id, kind, proj } = data;
  try {
    if (!D) {
      const [buf, meta] = await Promise.all([loadSections(), fetch("data/meta.json").then((r) => r.json())]);
      D = loadData(buf, meta);
      order = realOrder(D);
      self.postMessage({ type: "meta", final: D.final, ufNames: D.ufNames, ufFinal: D.ufFinal, N: D.N });
    }
    if (kind === "live") {
      const done = Math.max(1, Math.round(D.N * data.fraction));
      const targets = Array.from({ length: data.points }, (_, k) => Math.round((done * (k + 1)) / data.points));
      const curve = rawCurve(D, order, targets);
      const [snap] = project(D, order, { ...proj, targets: [done] });
      self.postMessage({ type: "result", id, curve, snap });
    } else {
      self.postMessage({ type: "result", id, snaps: project(D, order, proj) });
    }
  } catch (e) {
    self.postMessage({ type: "error", id, message: String(e?.message ?? e) });
  }
};

// Hospedagens que não servem binário recebem uma cópia em base64 (sections.b64.txt)
async function loadSections() {
  const r = await fetch("data/sections.bin");
  if (r.ok) return r.arrayBuffer();
  const b64 = await (await fetch("data/sections.b64.txt")).text();
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
