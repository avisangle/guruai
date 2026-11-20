import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { en } from './strings/en';
import { mr, type StringKey } from './strings/mr';

export type UiLang = 'mr' | 'en';

const tables: Record<UiLang, Record<StringKey, string>> = { mr, en };

/** `values` fill {name} placeholders in the string. */
type Translate = (key: StringKey, values?: Record<string, string | number>) => string;

type I18n = { lang: UiLang; setLang: (lang: UiLang) => void; t: Translate };

const I18nContext = createContext<I18n | null>(null);

type Props = {
  /** Starting language; Marathi when absent. */
  initial?: UiLang;
  /** Called on every setLang, so the caller can persist the choice. */
  onChange: (lang: UiLang) => void;
  children?: ReactNode;
};

export function LanguageProvider({ initial = 'mr', onChange, children }: Props) {
  const [lang, setLangState] = useState<UiLang>(initial);
  const setLang = useCallback(
    (next: UiLang) => {
      setLangState(next);
      onChange(next);
    },
    [onChange],
  );
  const value = useMemo<I18n>(
    () => ({
      lang,
      setLang,
      t: (key, values) => (values ? tables[lang][key].replace(/\{(\w+)\}/g, (m, name: string) => String(values[name] ?? m)) : tables[lang][key]),
    }),
    [lang, setLang],
  );
  return createElement(I18nContext.Provider, { value }, children);
}

export function useT(): I18n {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useT() needs a LanguageProvider above it');
  return value;
}
