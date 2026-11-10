import i18n from "i18next";
import { FALLBACK_LANGUAGE } from "../locales";

/** An error worded by a locale key where it is shown; its message is the English. */
export class KeyedError extends Error {
  constructor(
    readonly key: string,
    readonly params: Record<string, string> = {},
  ) {
    super(i18n.t(key, { ...params, lng: FALLBACK_LANGUAGE }));
  }
}
