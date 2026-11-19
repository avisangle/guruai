// Port of tools/stt_bench/evaluator.py normalise() (rules N1 to N9 are documented there).
// Checked against the Python output by judge.test.ts.
const TAGS = /\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|<[^>]*>|[♪♫]/g;
const INVISIBLE = /[​‌‍﻿­ऽ]/g;
const NUKTA = /़/g;
const NASAL_VIRAMA = /[ङञणनम]्(?=[क-हळ])/g;
const NON_LETTER = /[\p{P}\p{S}\p{Z}\p{C}]/gu;
const LATIN: Record<string, string> = {
  a: 'अ', aa: 'आ', ā: 'आ', i: 'इ', ii: 'ई', ee: 'ई', ī: 'ई', u: 'उ', uu: 'ऊ', oo: 'ऊ', ū: 'ऊ',
};

export function normalise(text: string): string {
  let s = (text ?? '').normalize('NFC');
  s = s.replace(TAGS, ' ').replace(INVISIBLE, '');
  s = s.normalize('NFD').replace(NUKTA, '').normalize('NFC');
  s = s.replace(/ँ/g, 'ं').replace(NASAL_VIRAMA, 'ं').replace(NON_LETTER, ' ');
  const tokens = s.toLowerCase().split(/\s+/).filter(Boolean).map((t) => LATIN[t] ?? t);
  return tokens.filter((t, i) => i === 0 || t !== tokens[i - 1]).join(' ');
}
