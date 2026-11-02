// What a run keeps of its pictures, so a shard's report stays small: evidence crops of failing findings, then the
// key-moment crops a judge packet asks for, up to the evidence cap in bytes. Everything else is deleted, and what the
// cap dropped is recorded in report.json's `evidence`.
import fs from 'node:fs';
import path from 'node:path';

/** The default evidence cap per run (per shard): 1 MiB. */
export const DEFAULT_EVIDENCE_MAX = 1024 * 1024;

const UNITS = { '': 1, b: 1, k: 1024, kb: 1024, kib: 1024, m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2 };

/** Bytes from "1048576", "512KB", "2MB" or "none" (no cap); throws on anything else. */
export function parseBytes(text) {
  if (typeof text === 'number' && text >= 0) return text;
  const s = String(text ?? '').trim().toLowerCase();
  if (s === 'none') return Infinity;
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(s);
  if (!m || !(m[2] in UNITS)) throw new Error(`evidence cap ${text} is not a size: bytes, or a number with KB or MB, or none`);
  return Math.round(Number(m[1]) * UNITS[m[2]]);
}

/**
 * Keeps, in this order and while they fit under maxBytes: each failing finding's evidence crop, then each capture's
 * crop that a judge packet names (`judged`). Passing findings and unjudged captures lose theirs. Removes the `evidence`
 * and `crop` fields it drops (in place) and every file under evidence/ and moments/ that nothing keeps. Returns what it
 * kept and what the cap dropped.
 */
export function keepEvidence({ outDir, findings, captures, judged, maxBytes = DEFAULT_EVIDENCE_MAX }) {
  const kept = new Set();
  const refused = new Set();
  let bytes = 0;
  const dropped = { evidence: 0, moments: 0, bytes: 0 };
  const size = (rel) => { try { return fs.statSync(path.join(outDir, rel)).size; } catch { return null; } };
  const keep = (rel, kind) => {
    if (kept.has(rel)) return true;
    if (refused.has(rel)) return false;
    const n = size(rel);
    if (n === null) return false;
    if (bytes + n > maxBytes) {
      refused.add(rel);
      dropped[kind]++;
      dropped.bytes += n;
      return false;
    }
    kept.add(rel);
    bytes += n;
    return true;
  };
  let findingsChanged = false;
  for (const f of findings) {
    if (f.evidence && (f.pass || !keep(f.evidence, 'evidence'))) { delete f.evidence; findingsChanged = true; }
  }
  let unjudged = 0;
  for (const c of captures) {
    if (!c.crop) continue;
    if (!judged.has(c.crop)) { unjudged++; delete c.crop; } else if (!keep(c.crop, 'moments')) delete c.crop;
  }
  for (const sub of ['evidence', 'moments']) {
    const dir = path.join(outDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) if (!kept.has(`${sub}/${name}`)) fs.rmSync(path.join(dir, name), { force: true });
    if (!fs.readdirSync(dir).length) fs.rmSync(dir, { recursive: true, force: true });
  }
  return { findingsChanged, evidence: { maxBytes: Number.isFinite(maxBytes) ? maxBytes : null, bytes, files: kept.size, dropped, unjudgedMoments: unjudged } };
}
